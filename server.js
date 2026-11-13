import "dotenv/config";
import express from "express";
import axios from "axios";
import https from "https";
import cron from "node-cron";
import nodemailer from "nodemailer";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, getDocsFromServer, query, doc, setDoc, where } from "firebase/firestore";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { syncCommissionToSheet, syncCommissionToPhuTrachSheet, formatDayLabel, readPhuTrachHistory, readOwnersFromSheet, getMissingCommissionAccounts, fillMissingCommissionValues } from "./sheetSync.js";
import { LiveCart, connectLiveCartDb, isLiveCartDbConnected } from "./liveCartModel.js";
import { NotificationCookie, ViolationCookie } from "./cookieModels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Cần để đọc JSON body cho POST /api/live-cart (live_monitor.py gửi JSON).
// Các route POST khác hiện có (/api/sync-sheet) chỉ dùng req.query nên
// không bị ảnh hưởng bởi middleware này.
app.use(express.json());

// LIVE_CART_TOKEN (tuỳ chọn) — nếu set, mọi request POST /api/live-cart phải
// kèm header Authorization: Bearer <token> đúng giá trị này. Khớp với
// TRACKER_TOKEN trong .env của live_monitor.py/tray_app.py trên các PC.
const LIVE_CART_TOKEN = process.env.LIVE_CART_TOKEN || "";

await connectLiveCartDb();

// ── Cảnh báo email khi phiên live sắp chạm 24h ───────────────────────────────
// Cần set các biến môi trường SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// ALERT_EMAIL_TO. Thiếu biến nào thì tính năng tự vô hiệu (chỉ log cảnh báo
// 1 lần lúc khởi động), không làm sập server — giống cách xử lý MONGODB_URI.
const LIVE_ALERT_HOURS = Number(process.env.LIVE_ALERT_HOURS || 23); // ngưỡng báo (giờ)
const LIVE_ALERT_TO    = (process.env.ALERT_EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);

let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && LIVE_ALERT_TO.length) {
    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "1", // true nếu dùng port 465
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log(`✅ Cảnh báo live ${LIVE_ALERT_HOURS}h: đã cấu hình, gửi tới ${LIVE_ALERT_TO.join(", ")}`);
} else {
    console.warn("⚠️  Thiếu SMTP_HOST/SMTP_USER/SMTP_PASS/ALERT_EMAIL_TO — tính năng cảnh báo live sắp 24h sẽ không hoạt động");
}

// key = `${accountKey}__${sessionId}` của các phiên ĐÃ gửi cảnh báo quá giờ —
// chặn gửi trùng nhiều lần cho cùng 1 phiên. Chỉ ở trong RAM (mất khi restart
// server), chấp nhận được vì trong trường hợp hiếm đó chỉ gửi lại tối đa 1 lần.
const liveAlertSent = new Set();

// alertKey -> {account, owner, title, startMs} của các phiên ĐANG live ở lần
// quét TRƯỚC — dùng để so sánh với lần quét hiện tại, phát hiện phiên nào vừa
// kết thúc (biến mất khỏi danh sách live) để báo "vừa xuống live". Cũng chỉ ở
// RAM — sau khi restart server, lần quét đầu tiên sẽ không báo "vừa xuống live"
// cho phiên nào (vì chưa có dữ liệu lần trước để so sánh), chỉ từ lần quét thứ 2 trở đi.
let previousLiveMap = new Map();

function fmtHM(ms) {
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h} giờ ${m} phút`;
}

async function checkLiveAlerts() {
    if (!mailTransporter) return;

    const accounts = await getAccountsFromFirestore();
    const settled  = await runPool(accounts, fetchAccount, CONCURRENCY, statsBackoff);
    const now      = Date.now();
    const thresholdMs = LIVE_ALERT_HOURS * 3_600_000;

    const currentLiveMap = new Map(); // alertKey -> info, các phiên ĐANG live ở lần quét này
    const toAlert = []; // phiên vượt ngưỡng LIVE_ALERT_HOURS

    for (const r of settled) {
        if (!r || r.error) continue;
        const owner = getOwner(r.key);
        if (!owner) continue; // chưa có người phụ trách -> không báo
        for (const s of r.sessions || []) {
            if (s.status !== 1 || !s.startTime) continue; // chỉ xét phiên ĐANG live
            const alertKey = `${r.key}__${s.sessionId || s.id || s.startTime}`;
            const startMs = s.startTime < 1e12 ? s.startTime * 1000 : s.startTime;
            const info = { account: r.key, owner, title: s.title || "Phiên live", startMs };
            currentLiveMap.set(alertKey, info);

            const elapsedMs = now - startMs;
            if (elapsedMs >= thresholdMs && !liveAlertSent.has(alertKey)) {
                toAlert.push({ ...info, elapsedMs });
                liveAlertSent.add(alertKey);
            }
        }
    }

    // Dọn các key không còn đang live nữa (phiên đã kết thúc) để nếu tài khoản
    // đó mở phiên MỚI sau này và lại chạm ngưỡng thì vẫn được báo lại.
    for (const key of liveAlertSent) {
        if (!currentLiveMap.has(key)) liveAlertSent.delete(key);
    }

    // Phiên nào có ở lần quét TRƯỚC nhưng không còn ở lần quét này -> vừa kết
    // thúc live (rớt live/chủ động tắt live) giữa 2 lần quét (tối đa 10 phút trễ).
    const justEnded = [];
    for (const [key, info] of previousLiveMap) {
        if (!currentLiveMap.has(key)) {
            justEnded.push({ ...info, elapsedMs: now - info.startMs });
        }
    }
    previousLiveMap = currentLiveMap;

    if (!toAlert.length && !justEnded.length) return;

    const sections = [];
    if (toAlert.length) {
        const rows = toAlert
            .map(a => `• ${a.account}${a.owner ? ` (${a.owner})` : ""} — "${a.title}" — đã live ${fmtHM(a.elapsedMs)}`)
            .join("\n");
        sections.push(`⚠️ ${toAlert.length} tài khoản live liên tục quá ${LIVE_ALERT_HOURS} giờ:\n\n${rows}`);
    }
    if (justEnded.length) {
        const rows = justEnded
            .map(a => `• ${a.account}${a.owner ? ` (${a.owner})` : ""} — "${a.title}" — vừa xuống live, đã live được ${fmtHM(a.elapsedMs)}`)
            .join("\n");
        sections.push(`🔴 ${justEnded.length} tài khoản vừa xuống live:\n\n${rows}`);
    }

    const subjectParts = [];
    if (toAlert.length) subjectParts.push(`${toAlert.length} quá ${LIVE_ALERT_HOURS}h`);
    if (justEnded.length) subjectParts.push(`${justEnded.length} vừa xuống live`);

    try {
        await mailTransporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: LIVE_ALERT_TO.join(","),
            subject: `⚠️ Cảnh báo live: ${subjectParts.join(", ")}`,
            text: sections.join("\n\n──────────\n\n"),
        });
        console.log(`📧 Đã gửi mail: ${toAlert.length} quá giờ (${toAlert.map(a=>a.account).join(", ")}), ${justEnded.length} vừa xuống live (${justEnded.map(a=>a.account).join(", ")})`);
    } catch (err) {
        console.error("❌ Lỗi gửi mail cảnh báo live:", err.message);
    }
}

// Quét mỗi 10 phút. Có thể đổi qua biến môi trường LIVE_ALERT_CRON (cú pháp cron).
cron.schedule(process.env.LIVE_ALERT_CRON || "*/10 * * * *", () => {
    checkLiveAlerts().catch(err => console.error("❌ Lỗi kiểm tra cảnh báo live:", err.message));
}, { timezone: "Asia/Ho_Chi_Minh" });

// Kích hoạt thủ công để test ngay — không cần chờ chu kỳ cron.
app.get("/api/live-alerts/test", async (req, res) => {
    try { await checkLiveAlerts(); res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Người phụ trách (owner) theo từng tài khoản ──────────────────────────────
// Nguồn THẬT là tab "PHỤ TRÁCH" trên Google Sheet (cột PHỤ TRÁCH + ACCOUNT) —
// đọc lại định kỳ bên dưới (refreshOwnersFromSheet) nên khi có tài khoản mới
// hoặc đổi người phụ trách trên sheet, server tự cập nhật, KHÔNG cần sửa tay
// owners.json nữa. owners.json chỉ còn dùng làm dữ liệu tạm lúc mới khởi động
// server (trước khi lần đọc sheet đầu tiên hoàn tất) hoặc khi sheet lỗi.
let OWNERS = {};
let CARTS  = {}; // { account: "100" | "500" | ... } — cột GIỎ trên tab PHỤ TRÁCH
let ownersSource = "file"; // "file" (owners.json, tạm) | "sheet" (đã đồng bộ từ Google Sheet)
let ownersLastSync = null;
try {
    OWNERS = JSON.parse(fs.readFileSync(path.join(__dirname, "owners.json"), "utf-8"));
    console.log(`✅ Đã tải ${Object.keys(OWNERS).length} mapping người phụ trách (owners.json, tạm — sẽ được thay bằng dữ liệu từ Sheet)`);
} catch {
    console.warn("⚠️  Không tìm thấy owners.json — bỏ qua, chờ đồng bộ từ Sheet");
}
// Khớp owner không phân biệt hoa/thường và bỏ khoảng trắng thừa (sheet & Firestore hay lệch kiểu này)
const normKey = (k) => String(k || "").trim().toLowerCase();
let _normFor = null, _normMap = {};
function ownersNormMap() {
    if (_normFor !== OWNERS) {
        _normMap = {};
        for (const [k, v] of Object.entries(OWNERS)) _normMap[normKey(k)] = v;
        _normFor = OWNERS;
    }
    return _normMap;
}
const getOwner = (key) => OWNERS[key] || ownersNormMap()[normKey(key)] || null;
let _cartNormFor = null, _cartNorm = {};
const getCart = (key) => {
    if (CARTS[key] != null) return CARTS[key];
    if (_cartNormFor !== CARTS) { _cartNorm = {}; for (const [k, c] of Object.entries(CARTS)) _cartNorm[normKey(k)] = c; _cartNormFor = CARTS; }
    return _cartNorm[normKey(key)] ?? null;
};

// Đọc lại mapping owner từ tab PHỤ TRÁCH trên Google Sheet và GHI ĐÈ toàn bộ
// OWNERS trong bộ nhớ. Nếu đọc sheet lỗi (mất mạng, sheet đổi cấu trúc, v.v.)
// thì GIỮ NGUYÊN mapping cũ đang có (không xoá dữ liệu tốt vì 1 lần lỗi).
async function refreshOwnersFromSheet() {
    try {
        const { map, carts, count, skipped, cartColFound } = await readOwnersFromSheet();
        OWNERS = map;
        CARTS  = carts || {};
        if (!cartColFound) console.warn("⚠️  [Owners] Không thấy cột \"GIỎ\" trong tab PHỤ TRÁCH — bỏ qua bộ lọc giỏ");
        ownersSource = "sheet";
        ownersLastSync = new Date();
        console.log(`✅ [Owners] Đồng bộ ${count} mapping từ tab PHỤ TRÁCH (bỏ qua ${skipped} dòng placeholder: Hợp Tác Live.../ACC MỚI)`);
    } catch (err) {
        console.warn(`⚠️  [Owners] Lỗi đồng bộ từ Sheet, giữ nguyên mapping hiện có (${Object.keys(OWNERS).length} tài khoản):`, err.message);
    }
}
// Đọc ngay lúc khởi động (không chặn server nếu sheet chậm/lỗi — request đầu
// tiên vẫn dùng tạm owners.json cho tới khi lần đồng bộ này xong).
refreshOwnersFromSheet();
// Rồi tự làm mới mỗi 10 phút — sheet đổi thì tối đa 10 phút sau server khớp theo,
// không cần deploy lại hay sửa file.
setInterval(() => { refreshOwnersFromSheet(); }, 10 * 60 * 1000);

// Kích hoạt thủ công để test ngay, không cần chờ chu kỳ 10 phút.
app.post("/api/sync-owners", async (req, res) => {
    try {
        await refreshOwnersFromSheet();
        res.json({ success: true, source: ownersSource, count: Object.keys(OWNERS).length, lastSync: ownersLastSync });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Chẩn đoán: vì sao account không có owner? GET /api/owners-debug
app.get("/api/owners-debug", async (req, res) => {
    try {
        const accounts = await getAccountsFromFirestore();
        const fsKeys = accounts.map(a => a.key).filter(Boolean);
        const fsNorm = new Set(fsKeys.map(normKey));
        const noOwner = fsKeys.filter(k => !getOwner(k));
        const sheetNotInFirestore = Object.keys(OWNERS).filter(k => !fsNorm.has(normKey(k)));
        const dup = {};
        for (const k of Object.keys(OWNERS)) { const n = normKey(k); (dup[n] = dup[n] || []).push(k); }
        const duplicates = Object.values(dup).filter(v => v.length > 1);
        const byOwner = {};
        for (const k of fsKeys) { const o = getOwner(k) || "(chưa gán)"; byOwner[o] = (byOwner[o] || 0) + 1; }
        res.json({
            success: true, ownersSource, ownersLastSync,
            ownersMappingCount: Object.keys(OWNERS).length,
            firestoreAccounts: fsKeys.length,
            firestoreByOwner: byOwner,
            firestoreWithoutOwnerCount: noOwner.length,
            sheetNotInFirestoreCount: sheetNotInFirestore.length,
            sheetNotInFirestore,
            duplicateKeysInSheet: duplicates,
            firestoreWithoutOwnerSample: noOwner.slice(0, 50),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Người phụ trách tài khoản Shopee Video ───────────────────────────────────
// owners_video.json: { "accountKey": "TÊN NGƯỜI PHỤ TRÁCH VIDEO", ... }
// Đây là mapping RIÊNG cho phần hoa hồng đến từ nguồn "Shopee Video" — tách biệt
// với OWNERS (người phụ trách hoa hồng livestream) ở trên.
let OWNERS_VIDEO = {};
try {
    OWNERS_VIDEO = JSON.parse(fs.readFileSync(path.join(__dirname, "owners_video.json"), "utf-8"));
    console.log(`✅ Đã tải ${Object.keys(OWNERS_VIDEO).length} mapping người phụ trách Shopee Video`);
} catch {
    console.warn("⚠️  Không tìm thấy owners_video.json — bỏ qua, mọi tài khoản sẽ không có người phụ trách video");
}
const getOwnerVideo = (key) => OWNERS_VIDEO[key] || null;

// ── Firebase config ──────────────────────────────────────────────────────────
let firebaseConfig;
if (process.env.FIREBASE_API_KEY) {
    firebaseConfig = {
        apiKey:            process.env.FIREBASE_API_KEY,
        authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
        projectId:         process.env.FIREBASE_PROJECT_ID,
        storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId:             process.env.FIREBASE_APP_ID,
    };
} else {
    const mod = await import("./firebase-config.js");
    firebaseConfig = mod.default;
}

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ── Cache ────────────────────────────────────────────────────────────────────
const statsCache     = { data: null, at: 0 };
const commCache      = {};          // key: "YYYY-MM-DD" → { data, at }
const CACHE_TTL      = 30_000;
const COMM_CACHE_TTL = 60_000;     // hoa hồng cache 60s

const sessionProductsCache      = {}; // key: "accountKey::sessionId" → { data, total, at }
const SESSION_PRODUCTS_CACHE_TTL = 30_000;

// Cache cho tab Gậy Vi Phạm — API bên thứ ba, cache 60s để tránh gọi liên tục
const violationsCache = { data: null, at: 0 };
const VIOLATIONS_CACHE_TTL = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function getAccountsFromFirestore() {
    const snapshot = await getDocsFromServer(query(collection(db, "cookies")));
    const accounts = [];
    snapshot.forEach((doc) => accounts.push(doc.data()));
    return accounts;
}

function getSpcStCookie(account) {
    if (!account.value?.length) return null;
    const cookie = account.value.find(
        (c) => c.name === "SPC_ST" && c.domain && c.domain.includes("shopee.vn")
    );
    return cookie ? cookie.value : null;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Cấu hình concurrency / jitter / backoff ─────────────────────────────────
const CONCURRENCY   = Number(process.env.SHOPEE_CONCURRENCY || 20);   // số request đồng thời tối đa
const JITTER_MIN_MS = Number(process.env.JITTER_MIN_MS || 150);
const JITTER_MAX_MS = Number(process.env.JITTER_MAX_MS || 450);
const jitter = () => JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);

// Tái sử dụng kết nối TCP/TLS thay vì mở mới liên tục
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: CONCURRENCY });
axios.defaults.httpsAgent = keepAliveAgent;

// Backoff thích ứng: theo dõi tỉ lệ lỗi gần đây, tự chậm lại nếu nghi ngờ bị chặn
class AdaptiveBackoff {
    constructor() { this.recentErrors = 0; this.recentTotal = 0; this.extraDelay = 0; }
    record(isError) {
        this.recentTotal++;
        if (isError) this.recentErrors++;
        // Cứ mỗi 30 request thì đánh giá lại 1 lần
        if (this.recentTotal >= 30) {
            const errorRate = this.recentErrors / this.recentTotal;
            if (errorRate > 0.3) {
                this.extraDelay = Math.min(this.extraDelay + 500, 5000); // tăng dần, tối đa +5s
                console.warn(`⚠️  Tỉ lệ lỗi cao (${(errorRate * 100).toFixed(0)}%) — tăng delay thêm ${this.extraDelay}ms`);
            } else if (errorRate < 0.05 && this.extraDelay > 0) {
                this.extraDelay = Math.max(this.extraDelay - 250, 0); // giảm dần khi ổn định lại
            }
            this.recentErrors = 0; this.recentTotal = 0;
        }
    }
    getDelay() { return jitter() + this.extraDelay; }
}
const statsBackoff = new AdaptiveBackoff();
const commBackoff   = new AdaptiveBackoff();

// Chạy danh sách task với concurrency giới hạn (thay cho Promise.all không giới hạn
// hoặc for-loop tuần tự quá chậm). backoff (tuỳ chọn) sẽ tự điều chỉnh delay giữa các lần dispatch.
async function runPool(items, worker, concurrency, backoff) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (true) {
            const i = nextIndex++;
            if (i >= items.length) return;
            if (backoff) await sleep(backoff.getDelay());
            try {
                results[i] = await worker(items[i]);
                if (backoff) backoff.record(false);
            } catch (err) {
                results[i] = null;
                if (backoff) backoff.record(true);
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
    await Promise.all(workers);
    return results;
}

// ── Creator Sessions API ─────────────────────────────────────────────────────
async function fetchCreatorSessions(spcSt, page = 1, pageSize = 50) {
    const { data } = await axios.get(
        `https://creator.shopee.vn/supply/api/lm/sellercenter/realtime/sessionList?page=${page}&pageSize=${pageSize}`,
        {
            headers: {
                cookie: `SPC_ST=${spcSt}`,
                referer: "https://creator.shopee.vn/",
                "user-agent": UA,
                accept: "application/json, text/plain, */*",
                "accept-language": "vi-VN,vi;q=0.9,en;q=0.8",
            },
            timeout: 10000,
        }
    );
    return data;
}

async function fetchAccount(account) {
    if (account.deactive === true) return null;
    const spcSt = getSpcStCookie(account);
    if (!spcSt) return { key: account.key, error: "Không tìm thấy cookie SPC_ST", sessions: [] };

    try {
        const first = await fetchCreatorSessions(spcSt, 1, 50);
        if (first.code !== 0) {
            const msg = first.code === 30001 ? "Cookie hết hạn — cần cập nhật lại" : `Lỗi API (code ${first.code})`;
            return { key: account.key, error: msg, sessions: [] };
        }

        let sessions = first.data.list || [];
        const totalPage = first.data.totalPage || 1;

        if (totalPage > 1) {
            const pages = Array.from({ length: totalPage - 1 }, (_, i) => i + 2);
            const rest = await runPool(pages, (p) => fetchCreatorSessions(spcSt, p, 50), Math.min(4, pages.length), null);
            for (const r of rest) {
                if (r?.code === 0 && r.data?.list) sessions = [...sessions, ...r.data.list];
            }
        }

        return { key: account.key, error: null, total: first.data.total, sessions };
    } catch (err) {
        return { key: account.key, error: err.response ? `HTTP ${err.response.status}` : "Lỗi kết nối", sessions: [] };
    }
}

// Chi tiết sản phẩm đang bán trong 1 phiên live (dashboard realtime)
async function fetchSessionProducts(spcSt, sessionId, page = 1, pageSize = 100) {
    const { data } = await axios.get(
        `https://creator.shopee.vn/supply/api/lm/sellercenter/realtime/dashboard/productList` +
        `?sessionId=${sessionId}&productName=&productListTimeRange=0&sort=desc&page=${page}&pageSize=${pageSize}`,
        {
            headers: {
                cookie: `SPC_ST=${spcSt}`,
                referer: "https://creator.shopee.vn/",
                "user-agent": UA,
                accept: "application/json, text/plain, */*",
                "accept-language": "vi-VN,vi;q=0.9,en;q=0.8",
            },
            timeout: 10000,
        }
    );
    return data;
}

// ── Kiểm tra trạng thái mất "Đã Thích" trong giỏ hàng Live (qua thông báo shopee.vn) ──
// Cookie cho tính năng này KHÔNG dùng chung collection "cookies" (dành cho
// creator/affiliate, chỉ cần SPC_ST) — mà lưu riêng ở collection MongoDB
// "notificationCookies" (model NotificationCookie, account -> full cookie dán
// tay từ DevTools), vì endpoint notification cần FULL cookie khác hẳn cấu
// trúc collection cũ. Dùng CHUNG kết nối Mongo với Live Cart nhưng KHÁC
// collection (xem cookieModels.js) — vẫn nằm ngoài Firestore.
function hexDecode(hex) {
    try { return Buffer.from(hex, "hex").toString("utf-8"); }
    catch { return ""; }
}
function extractCsrfToken(cookieStr) {
    const m = String(cookieStr || "").match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? m[1] : null;
}

async function getNotificationCookiesFromMongo() {
    const docs = await NotificationCookie.find({}).lean();
    return docs.map((d) => ({ account: d.account, cookie: d.cookie, updatedAt: d.updatedAt }));
}

// Lưu/cập nhật cookie cho 1 tài khoản — dán tay từ DevTools (dòng "cookie:" trong
// request header), upsert theo account.
app.post("/api/notification-cookie", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const { account, cookie } = req.body || {};
        if (!account || !String(account).trim()) return res.status(400).json({ success: false, error: "Thiếu account" });
        if (!cookie || !String(cookie).trim()) return res.status(400).json({ success: false, error: "Thiếu cookie" });

        const key = String(account).trim();
        const trimmedCookie = String(cookie).trim();
        await NotificationCookie.findOneAndUpdate(
            { account: key },
            { account: key, cookie: trimmedCookie, updatedAt: new Date().toISOString() },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Lưu xong kiểm tra NGAY tài khoản vừa lưu/cập nhật (dù là cookie mới hay
        // sửa cookie cũ) — để người dùng biết liền cookie có dùng được không và
        // tài khoản có đang mất "Đã Thích" hay không, không cần đợi vòng quét kế
        // tiếp hay bấm "Quét lại" thủ công.
        const r = await fetchAccountNotifications(key, trimmedCookie);
        const check = {
            key,
            owner: getOwner(key),
            error: r.error,
            authLoss: r.error ? null : findAuthLossNotice(r.notis),
        };
        res.json({ success: true, account: key, check });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Danh sách account đã lưu cookie (KHÔNG trả nguyên cookie về client để tránh
// lộ lại session token qua network tab của trình duyệt khi xem dashboard).
app.get("/api/notification-cookie", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const list = await getNotificationCookiesFromMongo();
        res.json({
            success: true,
            accounts: list.map((d) => ({ account: d.account, owner: getOwner(d.account), updatedAt: d.updatedAt })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Xoá cookie đã lưu của 1 tài khoản (vd đổi tài khoản khác, tài khoản bị khoá
// hẳn không cần theo dõi nữa...). Để cập nhật cookie (thay vì xoá) chỉ cần
// gọi lại POST /api/notification-cookie với cùng account — tự ghi đè.
app.delete("/api/notification-cookie/:account", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const key = String(req.params.account || "").trim();
        if (!key) return res.status(400).json({ success: false, error: "Thiếu account" });
        const result = await NotificationCookie.deleteOne({ account: key });
        if (result.deletedCount === 0) return res.status(404).json({ success: false, error: "Không tìm thấy tài khoản" });
        res.json({ success: true, account: key });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// LƯU Ý: request thật từ trình duyệt còn kèm af-ac-enc-dat / x-sap-sec / x-sap-ri
// (token chống bot tự sinh bởi JS client) — nếu Shopee bắt đầu chặn (403/lỗi
// lạ) khi THIẾU các header này thì gọi trực tiếp bằng axios sẽ không khả thi nữa.
async function fetchAccountNotifications(key, cookie, actionCate = 6, limit = 10) {
    const csrf = extractCsrfToken(cookie);
    if (!cookie) return { key, error: "Không có cookie", notis: [] };

    try {
        const { data } = await axios.get(
            `https://shopee.vn/api/v4/notification/get_notifications?action_cate=${actionCate}&limit=${limit}`,
            {
                headers: {
                    cookie,
                    referer: "https://shopee.vn/user/notifications/shopee",
                    "user-agent": UA,
                    accept: "application/json, text/plain, */*",
                    "x-requested-with": "XMLHttpRequest",
                    "x-api-source": "pc",
                    "x-shopee-language": "vi",
                    ...(csrf ? { "x-csrftoken": csrf } : {}),
                },
                timeout: 10000,
            }
        );
        if (data?.error) return { key, error: `API lỗi: ${data.error_msg || data.error}`, notis: [] };

        const notis = (data?.data?.actions || []).map((a) => ({
            title: hexDecode(a.title),
            content: hexDecode(a.content),
            createtime: a.createtime,
            action_id: a.action_id,
        }));
        return { key, error: null, notis };
    } catch (err) {
        return { key, error: err.response ? `HTTP ${err.response.status}` : "Lỗi kết nối", notis: [] };
    }
}

// Mẫu thông báo thật (title "Thông báo từ Shopee Live"):
// 'Shopee ghi nhận bạn có hành vi vi phạm Tiêu chuẩn cộng đồng của Shopee
//  Live nên Shopee đã hạn chế tính năng thêm sản phẩm từ mục "Đã Thích"
//  trong giỏ hàng Live của bạn từ ngày 02/11/2026 đến hết ngày 05/11/2026.'
const DATE_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/; // dd/mm/yyyy hoặc dd-mm-yyyy
const FROM_TO_RE = /từ ngày\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})[\s\S]{0,40}?đến hết ngày\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i;

function toIso(d, m, y) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }

function findAuthLossNotice(notis) {
    for (const n of notis) {
        const text = `${n.title} ${n.content}`;
        const lower = text.toLowerCase();
        // Bắt buộc có cả "đã thích" lẫn "giỏ hàng live" + 1 trong các từ chỉ hành
        // động hạn chế — tránh match nhầm thông báo khác chỉ chứa 1 trong 2 từ.
        const isMatch = lower.includes("đã thích") && lower.includes("giỏ hàng live") && (lower.includes("hạn chế") || lower.includes("vi phạm"));
        if (!isMatch) continue;

        let fromDate = null, expiryDate = null;
        const range = text.match(FROM_TO_RE);
        if (range) {
            fromDate   = toIso(range[1], range[2], range[3]);
            expiryDate = toIso(range[4], range[5], range[6]);
        } else {
            const single = text.match(/đến hết ngày\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i) || text.match(DATE_RE);
            if (single) expiryDate = toIso(single[1], single[2], single[3]);
        }
        return { title: n.title, content: n.content, createtime: n.createtime, fromDate, expiryDate };
    }
    return null;
}

// GET /api/auth-status — quét các tài khoản ĐÃ CÓ cookie trong collection
// notificationCookies (nhập thủ công qua dashboard), trả về acc nào có thông
// báo "mất đã thích" (không thêm được sản phẩm vào giỏ live) trong 10 thông
// báo gần nhất (action_cate=6).
app.get("/api/auth-status", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const saved = await getNotificationCookiesFromMongo();
        const settled = await runPool(saved, (d) => fetchAccountNotifications(d.account, d.cookie), CONCURRENCY, statsBackoff);

        const results = settled.filter(Boolean).map((r) => ({
            key: r.key,
            owner: getOwner(r.key),
            error: r.error,
            authLoss: r.error ? null : findAuthLossNotice(r.notis),
        }));

        const withIssue = results.filter((r) => r.authLoss);
        const withError = results.filter((r) => r.error);

        res.json({
            success: true,
            fetchedAt: new Date().toISOString(),
            totalChecked: results.length,
            issueCount: withIssue.length,
            errorCount: withError.length,
            accounts: withIssue,
            errors: withError.map((r) => ({ key: r.key, owner: r.owner, error: r.error })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Kiểm tra gậy vi phạm (penalty point) qua ht.toolshopee.vn/api/check ─────
// Tool bên THỨ BA (không phải domain Shopee chính thức) — trả cấu trúc
// results[0].live_health gồm điểm phạt, trạng thái cấm, danh sách phiên bị
// chấm dứt gần đây. Cookie cho API này cần SPC_F + csrftoken, KHÁC với cookie
// SPC_ST dùng cho creator.shopee.vn và cũng khác full-cookie của
// notificationCookies (domain/scope khác) — nên lưu ở collection MongoDB
// RIÊNG "violationCheckCookies" (model ViolationCookie — dán tay qua UI,
// giống hệt cơ chế của notificationCookies). Cùng kết nối Mongo với Live
// Cart và NotificationCookie nhưng mỗi loại 1 collection riêng biệt.
async function getViolationCookiesFromMongo() {
    const docs = await ViolationCookie.find({}).lean();
    return docs.map((d) => ({ account: d.account, cookie: d.cookie, updatedAt: d.updatedAt }));
}

// Lưu/cập nhật cookie kiểm tra gậy cho 1 tài khoản — dán tay từ DevTools
// (request "check" tới ht.toolshopee.vn → Payload → field "cookies"), upsert
// theo account.
app.post("/api/violation-cookie", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const { account, cookie } = req.body || {};
        if (!account || !String(account).trim()) return res.status(400).json({ success: false, error: "Thiếu account" });
        if (!cookie || !String(cookie).trim()) return res.status(400).json({ success: false, error: "Thiếu cookie" });

        const key = String(account).trim();
        const trimmedCookie = String(cookie).trim();
        await ViolationCookie.findOneAndUpdate(
            { account: key },
            { account: key, cookie: trimmedCookie, updatedAt: new Date().toISOString() },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Lưu xong kiểm tra gậy vi phạm NGAY cho tài khoản vừa lưu/cập nhật —
        // để biết liền cookie dùng được không và điểm phạt hiện tại, không cần
        // đợi vòng quét 60s cache hay bấm "Quét lại" thủ công. Đồng thời cập
        // nhật/thêm vào violationsCache để lần load lại danh sách đầy đủ gần
        // nhất (GET /api/violations trong 60s tới) cũng thấy số liệu mới này
        // ngay, không bị đè lại bằng dữ liệu cache cũ.
        const raw = await fetchViolationCheck(trimmedCookie);
        const check = mapViolationResult(key, raw);
        if (violationsCache.data) {
            const idx = violationsCache.data.findIndex((a) => a.key === key);
            if (idx >= 0) violationsCache.data[idx] = check;
            else violationsCache.data.push(check);
        }
        res.json({ success: true, account: key, check });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Danh sách account đã lưu cookie kiểm tra gậy (không trả nguyên cookie về client).
app.get("/api/violation-cookie", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const list = await getViolationCookiesFromMongo();
        res.json({
            success: true,
            accounts: list.map((d) => ({ account: d.account, owner: getOwner(d.account), updatedAt: d.updatedAt })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Xoá cookie kiểm tra gậy đã lưu của 1 tài khoản. Để cập nhật, gọi lại
// POST /api/violation-cookie với cùng account — tự ghi đè, không cần xoá trước.
app.delete("/api/violation-cookie/:account", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        const key = String(req.params.account || "").trim();
        if (!key) return res.status(400).json({ success: false, error: "Thiếu account" });
        const result = await ViolationCookie.deleteOne({ account: key });
        if (result.deletedCount === 0) return res.status(404).json({ success: false, error: "Không tìm thấy tài khoản" });
        res.json({ success: true, account: key });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Gọi API bên thứ ba ht.toolshopee.vn — trả nguyên cấu trúc { code, results: [...] }
async function fetchViolationCheck(cookie) {
    const csrf = extractCsrfToken(cookie);
    try {
        const { data } = await axios.post(
            "https://ht.toolshopee.vn/api/check",
            { cookies: cookie, country: "vn" },
            {
                headers: {
                    "content-type": "application/json",
                    "user-agent": UA,
                    accept: "application/json, text/plain, */*",
                    ...(csrf ? { "x-csrftoken": csrf } : {}),
                },
                timeout: 15000,
            }
        );
        return data;
    } catch (err) {
        return { error: err.response ? `HTTP ${err.response.status}` : "Lỗi kết nối" };
    }
}

// Chuẩn hoá 1 kết quả thô từ ht.toolshopee.vn thành dạng gọn cho frontend.
function mapViolationResult(account, raw) {
    const d = raw?.results?.[0];
    if (!raw || raw.error || raw.code !== 0 || !d) {
        return { key: account, owner: getOwner(account), error: raw?.error || `Lỗi API (code ${raw?.code ?? "?"})` };
    }
    const lh = d.live_health || {};
    return {
        key: account,
        owner: getOwner(account),
        error: null,
        penaltyPoint: lh.penalty_point ?? 0,
        // LƯU Ý: field "penalty_point_threshold" API trả về (vd 5) KHÔNG khớp
        // với mẫu số thật Shopee hiển thị trên trang Hiệu Quả Livestream của
        // họ (vd "9/15" — đối chiếu trực tiếp bằng screenshot thật của user
        // ngày 09/11/2026). Có vẻ field đó là ngưỡng khác (ngưỡng cấm) chứ
        // không phải thang điểm hiển thị. Dùng cứng 15 để khớp đúng UI gốc
        // Shopee; nếu sau này thấy tài khoản nào hiển thị mẫu số khác 15 thì
        // cần xem lại logic này.
        threshold: 15,
        isBanned: !!lh.is_banned,
        bannedStart: lh.banned_start_time || null,
        bannedEnd: lh.banned_end_time || null,
        riskLevel: lh.risk_type_show || null,
        countTerminated: lh.count_terminated || 0,
        countViolations: lh.count_violations || 0,
        countWarned: lh.count_warned || 0,
        violationTitle: lh.detail?.title || null,
        violationDesc: lh.detail?.desc || null,
        policyLink: lh.detail?.policy_link || null,
        sessions: (lh.sessions || []).map((s) => ({
            title: s.title,
            cover: s.cover || null,
            startTime: s.start_time,
            qcTime: s.qc_time,
            isTerminated: s.is_terminated,
            isWarned: s.is_warned,
            noViolation: s.no_violation,
        })),
    };
}

// GET /api/violations — quét toàn bộ tài khoản đã lưu cookie kiểm tra gậy,
// trả điểm phạt + trạng thái cấm + danh sách phiên bị chấm dứt gần đây.
// Cache 60s (?refresh=1 để bỏ qua cache) vì đây là API bên thứ ba, hạn chế
// gọi liên tục mỗi lần người dùng đổi tab.
app.get("/api/violations", async (req, res) => {
    try {
        const force = req.query.refresh === "1";
        if (!force && violationsCache.data && Date.now() - violationsCache.at < VIOLATIONS_CACHE_TTL) {
            return res.json({ success: true, accounts: violationsCache.data, fetchedAt: violationsCache.at, cached: true });
        }

        if (!isLiveCartDbConnected()) {
            return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
        }
        const saved = await getViolationCookiesFromMongo();
        const settled = await runPool(saved, (d) => fetchViolationCheck(d.cookie), CONCURRENCY, statsBackoff);
        const accounts = settled.map((r, i) => mapViolationResult(saved[i].account, r));

        violationsCache.data = accounts;
        violationsCache.at = Date.now();
        res.json({ success: true, accounts, fetchedAt: violationsCache.at, cached: false });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Affiliate Commission API ─────────────────────────────────────────────────
function dayRange(dateStr) {
    // dateStr: "YYYY-MM-DD"
    const d = new Date(dateStr + "T00:00:00+07:00");
    const start = Math.floor(d.getTime() / 1000);
    return { start, end: start + 86399 };
}

async function fetchCommissionPage(spcSt, pageNum, start, end) {
    const { data } = await axios.get(
        `https://affiliate.shopee.vn/api/v3/report/list` +
        `?page_size=500&page_num=${pageNum}` +
        `&purchase_time_s=${start}&purchase_time_e=${end}&version=1`,
        {
            headers: {
                cookie: `SPC_ST=${spcSt}`,
                referer: "https://affiliate.shopee.vn/report/conversion_report",
                "user-agent": UA,
                accept: "application/json, text/plain, */*",
                "affiliate-program-type": "1",
                "sec-ch-ua-platform": '"Windows"',
                "sec-ch-ua-mobile": "?0",
                dnt: "1",
            },
            timeout: 10000,
        }
    );
    return data;
}

// ── Phân loại nguồn traffic: Shopee Video / Shopee Live / Khác ───────────────
// Mỗi checkout (o) trong response của API affiliate có field internal_source.
// Video  → internal_source = "Shopeevideo-Shopee"
// Live   → internal_source = "Shopeelive-Shopee"
// Khác   → mọi giá trị còn lại (Facebook, untracked, rỗng, v.v.)
function isVideoOrder(o) {
    return o.internal_source === "Shopeevideo-Shopee";
}
function isLiveOrder(o) {
    return o.internal_source === "Shopeelive-Shopee";
}
// Trả về nhãn nguồn chuẩn hoá dùng chung cho cả object đơn lẻ và flatOrders
function classifySource(o) {
    if (isVideoOrder(o)) return "video";
    if (isLiveOrder(o))  return "live";
    return "other";
}

// filterFn (tuỳ chọn): nhận vào 1 checkout `o`, trả về true nếu muốn tính hoa
// hồng của checkout đó. Không truyền filterFn → tính TẤT CẢ (hành vi cũ, không đổi).
//
// ── Chuẩn hoá trạng thái đơn ──────────────────────────────────────────
// BUG ĐÃ PHÁT HIỆN: code cũ dùng `o.conversion_status` (số, ở cấp CHECKOUT)
// rồi gán thẳng cho từng đơn con để hiển thị + lọc huỷ. Đối chiếu dữ liệu
// thật từ Shopee thì conversion_status KHÔNG khớp với ý nghĩa đang gán ở
// frontend (1:Chờ xác nhận, 2:Đã xác nhận, 3:Hoàn thành, 4:Đã huỷ):
//   - checkout_status "Invalid"             + conversion_status=3 + order_status="CANCEL"    (đơn ĐÃ HUỶ)
//   - checkout_status "Waiting for payment" + conversion_status=2 + order_status="COMPLETED" (đơn ĐÃ HOÀN THÀNH)
// => đơn đã huỷ (status=3) bị hiển thị thành "Hoàn thành", đơn đã hoàn
// thành (status=2) bị hiển thị thành "Đã xác nhận". Filter tab "Đã huỷ"
// (chỉ lọc status===4) không bắt được đơn huỷ thật (status=3), còn filter
// "Đã xác nhận" lại vô tình gộp luôn các đơn huỷ đó vào.
// FIX: dùng field `order_status` ở CẤP ĐƠN (string "COMPLETED"/"CANCEL"...)
// — Shopee trả về rõ nghĩa, không cần đoán số — thay vì suy diễn từ
// conversion_status ở cấp checkout.
function normalizeOrderStatus(ord, o) {
    const raw = String(ord?.order_status || o?.checkout_status || "").toUpperCase();
    if (raw.includes("CANCEL") || raw === "INVALID") return "cancelled";
    if (raw.includes("RETURN")) return "returned";
    if (raw === "COMPLETED") return "completed";
    return "pending"; // UNPAID / TO_SHIP / TO_CONFIRM_RECEIVE / giá trị chưa gặp trong mẫu
}

function calcCommission(orders, filterFn = null) {
    // Cộng dồn giá trị THÔ (chưa làm tròn) trước, chỉ làm tròn 1 LẦN DUY NHẤT ở
    // cuối cùng — thay vì làm tròn từng đơn rồi mới cộng. Làm tròn riêng từng đơn
    // (mỗi đơn sai số tối đa ±0,5đ) rồi cộng hàng trăm đơn có thể để lại dư vài
    // đồng do sai số không triệt tiêu hết; cộng thô trước tránh được việc đó và
    // ĐÃ ĐƯỢC KIỂM CHỨNG khớp chính xác với cách Shopee tự tính tổng trên
    // dashboard của họ (xem lịch sử debug 594.089đ).
    let sumRaw = 0;
    for (const o of orders) {
        // Huỷ ở cấp checkout khi TẤT CẢ đơn con trong checkout đều bị huỷ/trả
        // (dùng order_status từng đơn, không còn đoán theo conversion_status).
        const allCancelled = (o.orders?.length ? o.orders : [null])
            .every((ord) => { const s = normalizeOrderStatus(ord, o); return s === "cancelled" || s === "returned"; });
        if (allCancelled) continue; // bỏ đơn huỷ
        if (filterFn && !filterFn(o)) continue;
        sumRaw += Number(o.linked_mcn_commission_rate) === 100000
            ? o.estimated_total_commission_with_mcn
            : o.estimated_total_commission;
    }
    return Math.round(sumRaw / 100000);
}

async function fetchAccountCommission(account, start, end) {
    if (account.deactive === true) return null;
    const spcSt = getSpcStCookie(account);
    if (!spcSt) return { key: account.key, error: "Không tìm thấy cookie SPC_ST", commission: 0, commissionVideo: 0, commissionLive: 0, commissionOther: 0, orders: [] };

    try {
        const first = await fetchCommissionPage(spcSt, 1, start, end);
        if (!first?.data || first.data.total_count == null) {
            return { key: account.key, error: "Cookie hết hạn hoặc phản hồi không hợp lệ", commission: 0, commissionVideo: 0, commissionLive: 0, commissionOther: 0, orders: [] };
        }

        const totalCount = first.data.total_count || 0;
        const totalPages = Math.max(1, Math.ceil(totalCount / 500));
        let orders = first.data.list || [];

        if (totalPages > 1) {
            const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
            const rest = await runPool(pages, (p) => fetchCommissionPage(spcSt, p, start, end), Math.min(4, pages.length), null);
            for (const r of rest) {
                if (r?.data?.list) orders = [...orders, ...r.data.list];
            }
        }

        // Flatten: mỗi checkout (o) có thể chứa nhiều orders[], mỗi order có items[]
        //
        // QUAN TRỌNG: để tổng cộng của các dòng (dùng khi export Excel) khớp
        // CHÍNH XÁC với calcCommission() (tổng thô, chỉ làm tròn 1 lần ở cuối,
        // đã kiểm chứng đúng với dashboard Shopee), KHÔNG được làm tròn hoa hồng
        // ở cấp checkout (Math.round) rồi mới chia cho từng đơn — vì Math.round
        // từng checkout riêng lẻ rồi cộng hàng trăm checkout lại sẽ tích luỹ sai
        // số ±0,5đ/checkout thành lệch vài đồng ở tổng cuối (bug cũ).
        //
        // Cách làm đúng: giữ giá trị THÔ (float) cho từng đơn, chỉ làm tròn
        // MỘT LẦN DUY NHẤT trên toàn bộ danh sách bằng phương pháp "largest
        // remainder" — đảm bảo SUM(flatOrders.commission) === Math.round(SUM(raw))
        // === calcCommission(orders), tuyệt đối không lệch dù chỉ 1đ.
        const rawRows = [];
        for (const o of orders) {
            // Đồng bộ với calcCommission(): huỷ khi TẤT CẢ đơn con bị huỷ/trả
            // (theo order_status từng đơn, không dùng conversion_status nữa).
            const isCancelled = (o.orders?.length ? o.orders : [null])
                .every((ord) => { const s = normalizeOrderStatus(ord, o); return s === "cancelled" || s === "returned"; });
            const commissionRaw = isCancelled
                ? 0
                : (Number(o.linked_mcn_commission_rate) === 100000
                    ? o.estimated_total_commission_with_mcn
                    : o.estimated_total_commission) / 100000; // đồng, CHƯA làm tròn
            const source = classifySource(o);

            if (o.orders && o.orders.length > 0) {
                // Chia tỉ lệ theo giá trị đơn hàng (itemValue) cho từng đơn con,
                // dùng số THÔ (chưa làm tròn) — làm tròn sẽ xử lý ở bước sau,
                // gộp chung với TẤT CẢ các dòng trong toàn bộ khoảng thời gian.
                const itemValuesRaw = o.orders.map(
                    (ord) => (ord.items?.reduce((a, i) => a + (i.actual_amount || 0), 0) || 0) / 100000
                );
                const totalItemValue = itemValuesRaw.reduce((a, v) => a + v, 0);
                o.orders.forEach((ord, idx) => {
                    const shareRaw = totalItemValue > 0
                        ? commissionRaw * (itemValuesRaw[idx] / totalItemValue)
                        : commissionRaw / o.orders.length;

                    const firstItem = ord.items?.[0];
                    rawRows.push({
                        orderId:      ord.order_sn,
                        status:       normalizeOrderStatus(ord, o),
                        commissionRaw: shareRaw,
                        itemValue:    Math.round(itemValuesRaw[idx]),
                        purchaseTime: o.purchase_time,
                        clickTime:    o.click_time,
                        completeTime: o.checkout_complete_time,
                        productName:  firstItem?.item_name || "",
                        mcnRate:      o.linked_mcn_commission_rate,
                        source,
                    });
                });
            } else {
                // fallback nếu không có orders[]
                rawRows.push({
                    orderId:      o.checkout_id || "",
                    status:       normalizeOrderStatus(null, o),
                    commissionRaw,
                    itemValue:    0,
                    purchaseTime: o.purchase_time,
                    clickTime:    o.click_time,
                    completeTime: o.checkout_complete_time,
                    productName:  "",
                    mcnRate:      o.linked_mcn_commission_rate,
                    source,
                });
            }
        }

        // Làm tròn "largest remainder" — QUAN TRỌNG: làm RIÊNG theo từng nhóm
        // nguồn (video / live / other), KHÔNG gộp chung toàn bộ đơn của tài
        // khoản lại rồi làm tròn 1 lần. Lý do: trên frontend, khi người dùng
        // lọc theo 1 nguồn cụ thể (vd chỉ xem "Live"), tổng hiển thị được cộng
        // từ CÁC DÒNG THUỘC NGUỒN ĐÓ — nếu làm tròn gộp chung tất cả nguồn,
        // tổng phụ của riêng "Live" sẽ không còn đảm bảo khớp với commissionLive
        // (vốn được tính độc lập bằng calcCommission(orders, isLiveOrder)).
        // Làm tròn riêng từng nhóm đảm bảo:
        //   sum(rows nguồn video) === commissionVideo
        //   sum(rows nguồn live)  === commissionLive
        //   sum(rows nguồn other) === commissionOther
        // luôn khớp tuyệt đối, dù người dùng lọc theo bất kỳ nguồn nào.
        function largestRemainderRound(rows) {
            const floors = rows.map((r) => Math.floor(r.commissionRaw));
            const totalRaw = rows.reduce((a, r) => a + r.commissionRaw, 0);
            const targetTotal = Math.round(totalRaw);
            const sumFloors = floors.reduce((a, v) => a + v, 0);
            const remainder = Math.min(Math.max(targetTotal - sumFloors, 0), rows.length);
            const byFrac = rows
                .map((r, i) => ({ i, frac: r.commissionRaw - floors[i] }))
                .sort((a, b) => b.frac - a.frac);
            const shares = [...floors];
            for (let k = 0; k < remainder; k++) shares[byFrac[k].i] += 1;
            return shares;
        }

        const finalShares = new Array(rawRows.length);
        for (const src of ["video", "live", "other"]) {
            const idxs = [];
            const groupRows = [];
            rawRows.forEach((r, i) => {
                if (r.source === src) { idxs.push(i); groupRows.push(r); }
            });
            if (groupRows.length === 0) continue;
            const groupShares = largestRemainderRound(groupRows);
            idxs.forEach((origIdx, k) => { finalShares[origIdx] = groupShares[k]; });
        }

        const flatOrders = rawRows.map((r, i) => ({
            orderId:      r.orderId,
            status:       r.status,
            commission:   finalShares[i],
            itemValue:    r.itemValue,
            purchaseTime: r.purchaseTime,
            clickTime:    r.clickTime,
            completeTime: r.completeTime,
            productName:  r.productName,
            mcnRate:      r.mcnRate,
            source:       r.source,
        }));

        return {
            key: account.key,
            error: null,
            commission: calcCommission(orders),           // tổng hoa hồng (mọi nguồn)
            commissionVideo: calcCommission(orders, isVideoOrder),                       // riêng phần Shopee Video
            commissionLive:  calcCommission(orders, isLiveOrder),                        // riêng phần Shopee Live
            commissionOther: calcCommission(orders, (o) => !isVideoOrder(o) && !isLiveOrder(o)), // phần còn lại (Facebook, untracked...)
            totalOrders: totalCount,
            orders: flatOrders,
        };
    } catch (err) {
        return { key: account.key, error: err.response ? `HTTP ${err.response.status}` : "Lỗi kết nối", commission: 0, commissionVideo: 0, commissionLive: 0, commissionOther: 0, orders: [] };
    }
}

// ── Snapshot sản phẩm (cho báo cáo "Top sản phẩm bán chạy") ─────────────────
// Mỗi lần dashboard xem chi tiết 1 phiên live, lưu lại (ghi đè) trạng thái sản
// phẩm mới nhất vào Firestore collection "productSnapshots". Doc ID cố định
// theo account+session nên không bị nhân đôi số liệu khi lưu nhiều lần cùng
// 1 phiên — chỉ giữ lại số liệu tích luỹ mới nhất tại thời điểm lưu.
async function saveProductSnapshot(accountKey, sessionId, products, dateVN, sessionTitle) {
    try {
        const docId = `${accountKey}__${sessionId}`;
        const items = (products || []).map((p) => ({
            id:      p.itemId ?? p.productId ?? null,
            name:    p.title || "(Không tên)",
            revenue: Number(p.confirmedRevenue) || 0,
            qty:     Number(p.confirmedItemSold) || 0,
            orders:  Number(p.confirmedOrderCnt) || 0,
        }));
        await setDoc(doc(db, "productSnapshots", docId), {
            accountKey,
            owner: getOwner(accountKey),
            sessionId: String(sessionId),
            sessionTitle: sessionTitle || "",
            dateVN,
            updatedAt: Date.now(),
            products: items,
        });
    } catch (err) {
        console.warn(`⚠️  Không lưu được snapshot sản phẩm (${accountKey}/${sessionId}):`, err.message);
    }
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── LIVE CART (giỏ hàng live) ────────────────────────────────────────────────
// Nhận dữ liệu đẩy lên từ live_monitor.py/tray_app.py chạy trên các PC (mỗi
// PC quét nhiều máy Android qua ADB), lưu vào MongoDB — mỗi thiết bị 1 bản ghi
// trạng thái mới nhất (upsert theo deviceId = "<pc_name>-<serial>").

// PC đẩy số liệu lên — body: { pc_name, device_id, serial, shopee_account, cart_count, captured_at }
app.post("/api/live-cart", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    if (LIVE_CART_TOKEN) {
        const auth = req.headers.authorization || "";
        if (auth !== `Bearer ${LIVE_CART_TOKEN}`) {
            return res.status(401).json({ success: false, error: "Token không hợp lệ" });
        }
    }
    try {
        const {
            pc_name, device_id, serial, shopee_account,
            owner: bodyOwner, box_name, machine_no, is_live, cart_count, captured_at,
        } = req.body || {};
        if (!device_id) {
            return res.status(400).json({ success: false, error: "Thiếu device_id" });
        }
        // PC bản cũ chưa gửi is_live -> coi như hành vi cũ (có cart_count = đang live).
        const isLive = typeof is_live === "boolean" ? is_live : (cart_count != null);
        // isLive=false là PC chủ động báo "hết live" -> cartCount PHẢI null,
        // không tin cart_count gửi kèm (không nên có, nhưng phòng hờ PC lỗi).
        const cartCount = isLive && cart_count != null ? Number(cart_count) : null;
        await LiveCart.findOneAndUpdate(
            { deviceId: device_id },
            {
                deviceId:      device_id,
                pcName:        pc_name || "",
                serial:        serial || "",
                shopeeAccount: shopee_account || "",
                // getOwner() tự đồng bộ từ tab PHỤ TRÁCH mỗi 10' (xem refreshOwnersFromSheet
                // phía trên) nên là nguồn ưu tiên — không còn phụ thuộc cả 4 PC phải chạy
                // bản mới mới có owner đúng; bodyOwner chỉ còn là dự phòng.
                owner:         getOwner(shopee_account) || (typeof bodyOwner === "string" && bodyOwner.trim()) || null,
                // PC đã khớp qua Xiaowei WS (y het Xiaowei Finder) thì gửi thẳng
                // box/machine thật-time; không khớp (box_name/machine_no rỗng/undefined)
                // thì GIỮ NGUYÊN giá trị cũ trong DB (đừng ghi đè bằng null) — máy
                // tạm thời không lấy được tag không có nghĩa là nó đổi chỗ.
                ...(typeof box_name === "string" && box_name.trim() ? { boxName: box_name.trim() } : {}),
                ...(typeof machine_no === "string" && machine_no.trim() ? { machineNo: machine_no.trim() } : {}),
                isLive,
                cartCount,
                capturedAt:    captured_at ? new Date(captured_at) : new Date(),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Lỗi lưu live-cart:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Dashboard đọc lại danh sách trạng thái hiện tại của mọi thiết bị
app.get("/api/live-cart", async (req, res) => {
    if (!isLiveCartDbConnected()) {
        return res.status(503).json({ success: false, error: "MongoDB chưa kết nối (thiếu MONGODB_URI trên server)" });
    }
    try {
        // Máy đang live lên trước, máy đã hết live rơi xuống dưới — sort thẳng
        // theo cartCount sẽ để số CŨ của máy vừa hết live (cartCount trước khi
        // có field isLive) lẫn vào đầu danh sách như đang live thật.
        const docs = await LiveCart.find({}).sort({ isLive: -1, cartCount: -1, updatedAt: -1 }).lean();
        const data = docs.map((d) => {
            // GIỎ CỐ ĐỊNH của account (cột "GIỎ" tab PHỤ TRÁCH, qua getCart() —
            // CÙNG một bộ nhớ đệm đồng bộ mỗi 10' đang dùng cho tab Thống Kê,
            // KHÔNG đọc/ghi gì thêm vào Sheet — so sánh với số thực tế đọc được
            // từ máy để tính "thiếu", tính và hiển thị TRÊN WEB mà thôi.
            const baselineRaw = getCart(d.shopeeAccount);
            const cartBaseline = baselineRaw != null && baselineRaw !== "" && !isNaN(Number(baselineRaw))
                ? Number(baselineRaw) : null;
            // Chỉ tính thiếu khi ĐANG LIVE (có số thật) và sheet có giỏ cố định
            // cho account đó — máy không live hoặc account chưa gán GIỎ thì
            // không đủ cơ sở để kết luận "thiếu", trả null thay vì đoán.
            const shortage = (d.isLive && d.cartCount != null && cartBaseline != null)
                ? cartBaseline - d.cartCount : null;
            return {
                deviceId:      d.deviceId,
                pcName:        d.pcName,
                serial:        d.serial,
                shopeeAccount: d.shopeeAccount,
                owner:         d.owner,
                boxName:       d.boxName,
                machineNo:     d.machineNo,
                isLive:        d.isLive,
                cartCount:     d.cartCount,
                cartBaseline,
                shortage,
                capturedAt:    d.capturedAt,
                updatedAt:     d.updatedAt,
            };
        });
        res.json({ success: true, data, fetchedAt: Date.now() });
    } catch (err) {
        console.error("❌ Lỗi đọc live-cart:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Phiên live stats
app.get("/api/stats", async (req, res) => {
    try {
        const force = req.query.refresh === "1";
        if (!force && statsCache.data && Date.now() - statsCache.at < CACHE_TTL) {
            return res.json({ success: true, data: statsCache.data, fetchedAt: statsCache.at, cached: true });
        }
        const accounts = await getAccountsFromFirestore();
        const t0 = Date.now();

        // Concurrency giới hạn (không phải tuần tự, không phải song song vô hạn)
        // + jitter ngẫu nhiên + backoff thích ứng nếu tỉ lệ lỗi tăng đột biến
        const settled = await runPool(accounts, fetchAccount, CONCURRENCY, statsBackoff);
        const results = settled.filter(Boolean).map(r => ({ ...r, owner: getOwner(r.key), cart: getCart(r.key) }));

        console.log(`✅ Stats: ${results.length} accounts in ${Date.now() - t0}ms`);
        statsCache.data = results; statsCache.at = Date.now();
        res.json({ success: true, data: results, fetchedAt: statsCache.at, cached: false });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Chi tiết sản phẩm đang bán trong 1 phiên live — ?account=<key>&sessionId=<id>
app.get("/api/session-products", async (req, res) => {
    try {
        const { account, sessionId, sessionTitle, startTime } = req.query;
        if (!account || !sessionId) {
            return res.status(400).json({ success: false, error: "Thiếu tham số account hoặc sessionId" });
        }

        const cacheKey = `${account}::${sessionId}`;
        const cached = sessionProductsCache[cacheKey];
        if (cached && Date.now() - cached.at < SESSION_PRODUCTS_CACHE_TTL) {
            return res.json({ success: true, data: cached.data, total: cached.total, cached: true });
        }

        const accounts = await getAccountsFromFirestore();
        const acc = accounts.find((a) => a.key === account);
        if (!acc) return res.status(404).json({ success: false, error: "Không tìm thấy tài khoản" });

        const spcSt = getSpcStCookie(acc);
        if (!spcSt) return res.status(400).json({ success: false, error: "Không tìm thấy cookie SPC_ST" });

        const first = await fetchSessionProducts(spcSt, sessionId, 1, 100);
        if (first.code !== 0) {
            const msg = first.code === 30001 ? "Cookie hết hạn — cần cập nhật lại" : `Lỗi API (code ${first.code})`;
            return res.status(400).json({ success: false, error: msg });
        }

        let products = first.data.list || [];
        const totalPage = first.data.totalPage || 1;
        if (totalPage > 1) {
            const pages = Array.from({ length: totalPage - 1 }, (_, i) => i + 2);
            const rest = await runPool(pages, (p) => fetchSessionProducts(spcSt, sessionId, p, 100), Math.min(4, pages.length), null);
            for (const r of rest) {
                if (r?.code === 0 && r.data?.list) products = [...products, ...r.data.list];
            }
        }

        sessionProductsCache[cacheKey] = { data: products, total: first.data.total, at: Date.now() };
        res.json({ success: true, data: products, total: first.data.total, cached: false });

        // Lưu snapshot cho báo cáo top sản phẩm — chạy nền, không chặn response.
        const startMs = startTime ? (Number(startTime) < 1e12 ? Number(startTime) * 1000 : Number(startTime)) : Date.now();
        const dateVN = new Date(startMs + 7 * 3600_000).toISOString().slice(0, 10);
        saveProductSnapshot(account, sessionId, products, dateVN, sessionTitle);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.response ? `HTTP ${err.response.status}` : err.message });
    }
});

// Hoa hồng affiliate — ?date=YYYY-MM-DD (mặc định hôm nay theo GMT+7)
// Lấy hoa hồng cho 1 ngày (dùng chung cho route /api/commission và cron đồng bộ Sheet)
async function getCommissionForDate(dateStr, force = false) {
    const cacheKey = dateStr;
    if (!force && commCache[cacheKey] && Date.now() - commCache[cacheKey].at < COMM_CACHE_TTL) {
        return { data: commCache[cacheKey].data, fetchedAt: commCache[cacheKey].at, cached: true };
    }

    const { start, end } = dayRange(dateStr);
    const accounts = await getAccountsFromFirestore();
    const t0 = Date.now();

    const settled = await runPool(accounts, (a) => fetchAccountCommission(a, start, end), CONCURRENCY, commBackoff);
    const results = settled.filter(Boolean).map(r => ({ ...r, owner: getOwner(r.key), ownerVideo: getOwnerVideo(r.key) }));

    console.log(`✅ Commission [${dateStr}]: ${results.length} accounts in ${Date.now() - t0}ms`);

    commCache[cacheKey] = { data: results, at: Date.now() };
    return { data: results, fetchedAt: commCache[cacheKey].at, cached: false };
}

app.get("/api/commission", async (req, res) => {
    try {
        // Ngày mặc định: hôm nay theo GMT+7
        const todayVN = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
        const dateStr  = req.query.date || todayVN;
        const force    = req.query.refresh === "1";

        const { data, fetchedAt, cached } = await getCommissionForDate(dateStr, force);
        res.json({ success: true, data, fetchedAt, cached, date: dateStr });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Hoa hồng theo khoảng thời gian ───────────────────────────────────────────
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (tối đa 31 ngày) — gọi 1 lần API Shopee cho
// toàn bộ khoảng, không lặp theo từng ngày, nên nhanh hơn nhiều so với việc
// tự cộng dồn dữ liệu của N ngày lẻ.
const MAX_RANGE_DAYS = 31;

function daysBetweenInclusive(fromStr, toStr) {
    const a = new Date(fromStr + "T00:00:00+07:00");
    const b = new Date(toStr   + "T00:00:00+07:00");
    return Math.round((b - a) / 86_400_000) + 1;
}

async function getCommissionForRange(fromStr, toStr, force = false) {
    const cacheKey = `${fromStr}_${toStr}`;
    if (!force && commCache[cacheKey] && Date.now() - commCache[cacheKey].at < COMM_CACHE_TTL) {
        return { data: commCache[cacheKey].data, fetchedAt: commCache[cacheKey].at, cached: true };
    }

    const start = dayRange(fromStr).start;
    const end   = dayRange(toStr).end;
    const accounts = await getAccountsFromFirestore();
    const t0 = Date.now();

    const settled = await runPool(accounts, (a) => fetchAccountCommission(a, start, end), CONCURRENCY, commBackoff);
    const results = settled.filter(Boolean).map(r => ({ ...r, owner: getOwner(r.key), ownerVideo: getOwnerVideo(r.key) }));

    console.log(`✅ Commission [${fromStr} → ${toStr}]: ${results.length} accounts in ${Date.now() - t0}ms`);

    commCache[cacheKey] = { data: results, at: Date.now() };
    return { data: results, fetchedAt: commCache[cacheKey].at, cached: false };
}

app.get("/api/commission-range", async (req, res) => {
    try {
        const { from, to } = req.query;
        const force = req.query.refresh === "1";
        if (!from || !to) {
            return res.status(400).json({ success: false, error: "Thiếu tham số from hoặc to (dạng YYYY-MM-DD)" });
        }
        if (new Date(from + "T00:00:00+07:00") > new Date(to + "T00:00:00+07:00")) {
            return res.status(400).json({ success: false, error: "Ngày bắt đầu phải trước ngày kết thúc" });
        }
        const numDays = daysBetweenInclusive(from, to);
        if (numDays > MAX_RANGE_DAYS) {
            return res.status(400).json({ success: false, error: `Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày (đang chọn ${numDays} ngày)` });
        }

        const { data, fetchedAt, cached } = await getCommissionForRange(from, to, force);
        res.json({ success: true, data, fetchedAt, cached, from, to, days: numDays });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Bảng hoa hồng THEO NGÀY cho từng tài khoản (tài khoản × ngày) ───────────
// Khác với getCommissionForRange (cộng dồn TOÀN BỘ khoảng thành 1 số/tài
// khoản), hàm này giữ lại số liệu RIÊNG của từng ngày trong khoảng — dùng cho
// bảng "Theo ngày" ở tab Hoa Hồng, hiển thị y hệt cấu trúc cột trên tab PHỤ
// TRÁCH của Sheet nhưng lấy TRỰC TIẾP từ Shopee API (không qua Sheet), nên
// luôn là số liệu mới nhất kể cả cho hôm nay. Gọi getCommissionForDate() TUẦN
// TỰ từng ngày (không song song nhiều ngày) để không dồn quá nhiều request
// đồng thời lên Shopee — mỗi ngày đã tự chạy CONCURRENCY request song song
// cho các tài khoản, và vẫn tận dụng cache 60s sẵn có của từng ngày.
async function getCommissionMatrixForDays(fromStr, toStr, force = false) {
    const numDays = daysBetweenInclusive(fromStr, toStr);
    if (numDays > MAX_RANGE_DAYS) {
        throw new Error(`Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày (đang chọn ${numDays} ngày)`);
    }
    const dayList = Array.from({ length: numDays }, (_, i) => addDaysStr(fromStr, i));

    const accountsMap = {}; // key -> { key, owner, ownerVideo, byDay: { "yyyy-mm-dd": {...} } }
    const ensureAccount = (key, owner, ownerVideo) => {
        if (!accountsMap[key]) accountsMap[key] = { key, owner: owner || null, ownerVideo: ownerVideo || null, byDay: {} };
        return accountsMap[key];
    };

    for (const day of dayList) {
        const { data } = await getCommissionForDate(day, force);
        for (const r of data) {
            const acc = ensureAccount(r.key, r.owner, r.ownerVideo);
            acc.byDay[day] = r.error
                ? { error: r.error }
                : {
                    commission:      r.commission || 0,
                    commissionLive:  r.commissionLive || 0,
                    commissionVideo: r.commissionVideo || 0,
                    commissionOther: r.commissionOther || 0,
                    totalOrders:     r.totalOrders || 0,
                };
        }
    }

    const accounts = Object.values(accountsMap).sort((a, b) => a.key.localeCompare(b.key));
    return { days: dayList, accounts };
}

app.get("/api/commission-matrix", async (req, res) => {
    try {
        const { from, to } = req.query;
        const force = req.query.refresh === "1";
        if (!from || !to) {
            return res.status(400).json({ success: false, error: "Thiếu tham số from hoặc to (dạng YYYY-MM-DD)" });
        }
        if (new Date(from + "T00:00:00+07:00") > new Date(to + "T00:00:00+07:00")) {
            return res.status(400).json({ success: false, error: "Ngày bắt đầu phải trước ngày kết thúc" });
        }
        const { days, accounts } = await getCommissionMatrixForDays(from, to, force);
        res.json({ success: true, from, to, days, accounts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Đồng bộ hoa hồng lên Google Sheet ────────────────────────────────────────
// Ngày hôm qua theo GMT+7, dạng ISO (yyyy-mm-dd, dùng để gọi API) và dạng hiển
// thị (dd/mm/yyyy, dùng làm tiêu đề cột trên Sheet).
function yesterdayVN() {
    const nowVN = new Date(Date.now() + 7 * 3600_000);
    nowVN.setUTCDate(nowVN.getUTCDate() - 1);
    const iso = nowVN.toISOString().slice(0, 10);           // yyyy-mm-dd
    const [y, m, d] = iso.split("-");
    return { iso, display: `${d}/${m}/${y}` };
}

async function runDailySheetSync(dateOverride = null) {
    const { iso, display } = dateOverride
        ? { iso: dateOverride, display: dateOverride.split("-").reverse().join("/") }
        : yesterdayVN();
    const dayLabel = formatDayLabel(iso); // "dd.mm", vd "13.07" — khớp định dạng cột có sẵn trong tab PHỤ TRÁCH
 
    console.log(`🔄 Đồng bộ Sheet: lấy hoa hồng ngày ${iso} (hiển thị ${display}, nhãn cột ${dayLabel})...`);
    const { data } = await getCommissionForDate(iso, true);
 
    const rows = data.map(acc => ({
        key: acc.key,
        value: acc.error ? acc.error : (acc.commissionLive ?? 0),
    }));
 
    const hhResult = await syncCommissionToSheet(display, rows);
    console.log(`✅ [HH] Đã ghi đè snapshot ngày ${display}: ${hhResult.rows} tài khoản`);
 
    const ptResult = await syncCommissionToPhuTrachSheet(dayLabel);
    console.log(`✅ [PHỤ TRÁCH] Đã dùng cột ${ptResult.column}, tính + đóng băng ${ptResult.rows} dòng (${ptResult.cleared} ô lỗi đã xoá trống)`);
 
    return { date: display, dayLabel, hh: hhResult, phuTrach: ptResult };
}

// Chạy lúc 9h sáng mỗi ngày theo giờ Việt Nam (GMT+7), lấy hoa hồng NGÀY HÔM QUA
cron.schedule("0 9 * * *", () => {
    runDailySheetSync().catch(err => console.error("❌ Lỗi đồng bộ Sheet (cron):", err.message));
}, { timezone: "Asia/Ho_Chi_Minh" });

// Kích hoạt thủ công để test ngay, không cần chờ 9h sáng.
// Gọi: POST /api/sync-sheet  (mặc định lấy hôm qua)
//      POST /api/sync-sheet?date=2026-07-13  (chỉ định ngày cụ thể, dạng yyyy-mm-dd)
app.post("/api/sync-sheet", async (req, res) => {
    try {
        const result = await runDailySheetSync(req.query.date || null);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error("❌ Lỗi đồng bộ Sheet (thủ công):", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Điền hoa hồng CÒN THIẾU cho 1 ngày cụ thể ───────────────────────────────
// Khác với runDailySheetSync (gọi API Shopee cho TOÀN BỘ tài khoản rồi ghi đè
// toàn bộ cột của 1 ngày), hàm này dùng khi 1 ngày ĐÃ đồng bộ xong nhưng một
// vài tài khoản bị trống (cookie hết hạn lúc đó) — sau khi người dùng cập
// nhật lại cookie, chỉ gọi lại API Shopee cho ĐÚNG những tài khoản đang
// trống ở cột ngày đó, rồi điền thẳng vào các ô đó — không đụng tới các tài
// khoản khác đã có số liệu.
async function runMissingCommissionSync(dateStr) {
    if (!dateStr) throw new Error("Thiếu tham số date (dạng yyyy-mm-dd)");
    const dayLabel = formatDayLabel(dateStr);

    const missing = await getMissingCommissionAccounts(dayLabel);
    if (!missing) {
        return { date: dateStr, dayLabel, found: false, message: `Chưa có cột ngày ${dayLabel} trong tab PHỤ TRÁCH — cần đồng bộ đầy đủ ngày đó trước (POST /api/sync-sheet)` };
    }
    if (missing.accounts.length === 0) {
        return { date: dateStr, dayLabel, found: true, missingCount: 0, attempted: 0, filled: 0, stillError: 0, message: "Không có tài khoản nào bị trống ở ngày này" };
    }

    const { start, end } = dayRange(dateStr);
    const allAccounts = await getAccountsFromFirestore();

    // QUAN TRỌNG: khớp account giữa sheet và Firestore theo kiểu CHUẨN HOÁ
    // (bỏ khoảng trắng thừa + không phân biệt hoa/thường) — giống hệt cách
    // getOwner() đang làm, vì sheet & Firestore hay lệch kiểu viết hoa/thường.
    // Nếu so khớp chính xác từng ký tự, một tài khoản lệch case sẽ bị bỏ sót
    // âm thầm (không fetch, không điền, không báo lỗi).
    const byNormKey = new Map();
    for (const a of allAccounts) byNormKey.set(normKey(a.key), a);

    const targets = []; // [{ firestoreAccount, sheetAccount }]
    const notFoundInFirestore = []; // account đang trống trên sheet nhưng không có trong Firestore (kể cả lệch case)
    for (const sheetAccount of missing.accounts) {
        const match = byNormKey.get(normKey(sheetAccount));
        if (match) targets.push({ firestoreAccount: match, sheetAccount });
        else notFoundInFirestore.push(sheetAccount);
    }

    console.log(`🔄 [Điền thiếu] Ngày ${dayLabel}: đang trống ${missing.accounts.length} tài khoản, khớp được ${targets.length} với Firestore (${notFoundInFirestore.length} không khớp)...`);
    const settled = await runPool(targets, (t) => fetchAccountCommission(t.firestoreAccount, start, end), CONCURRENCY, commBackoff);

    // Ghi theo ĐÚNG chuỗi account như trên sheet (sheetAccount), không phải
    // theo key trong Firestore (có thể lệch case) — để fillMissingCommissionValues
    // (so khớp lại với cột ACCOUNT trên sheet) tìm đúng dòng cần điền.
    const valuesByAccount = {};
    let stillError = 0;
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        const sheetAccount = targets[i].sheetAccount;
        if (!r || r.error) { stillError++; continue; } // vẫn lỗi (cookie chưa cập nhật xong) → giữ trống, không ghi gì cả
        valuesByAccount[sheetAccount] = r.commissionLive ?? 0;
    }

    const { filled, notFoundInSheet } = await fillMissingCommissionValues(dayLabel, valuesByAccount);
    console.log(`✅ [Điền thiếu] Ngày ${dayLabel}: điền được ${filled}/${missing.accounts.length}, còn ${stillError} vẫn lỗi, ${notFoundInFirestore.length} không khớp Firestore`);

    return {
        date: dateStr, dayLabel, found: true,
        missingCount: missing.accounts.length,
        attempted: targets.length,
        filled, stillError,
        notFoundInFirestore, // tài khoản trống trên sheet nhưng không khớp được account nào trong Firestore (kể cả sau khi chuẩn hoá) — có thể đã bị xoá/đổi tên hẳn, cần kiểm tra tay
        notFoundInSheet, // trường hợp hiếm: account fetch thành công nhưng lúc ghi lại không còn thấy trên sheet (sheet vừa bị sửa cấu trúc giữa chừng)
    };
}

// Kiểm tra trước (không gọi API Shopee): ngày này đang trống những tài khoản nào?
// GET /api/missing-commission?date=2026-10-09
app.get("/api/missing-commission", async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ success: false, error: "Thiếu tham số date (dạng yyyy-mm-dd)" });
        const dayLabel = formatDayLabel(date);
        const missing = await getMissingCommissionAccounts(dayLabel);
        if (!missing) return res.json({ success: true, date, dayLabel, found: false, count: 0, accounts: [] });

        // Kiểm luôn xem account nào trong số này KHÔNG khớp được với Firestore
        // (dù đã chuẩn hoá hoa/thường + khoảng trắng) — để biết trước account
        // nào gọi "Điền ngay" cũng sẽ không giúp được gì (cần sửa tay).
        const allAccounts = await getAccountsFromFirestore();
        const normSet = new Set(allAccounts.map((a) => normKey(a.key)));
        const notFoundInFirestore = missing.accounts.filter((acc) => !normSet.has(normKey(acc)));

        res.json({
            success: true, date, dayLabel, found: true,
            count: missing.accounts.length,
            accounts: missing.accounts,
            notFoundInFirestore,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Điền hoa hồng còn thiếu — POST /api/sync-sheet-missing?date=2026-10-09
app.post("/api/sync-sheet-missing", async (req, res) => {
    try {
        const result = await runMissingCommissionSync(req.query.date);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error("❌ Lỗi điền hoa hồng còn thiếu:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── BÁO CÁO ──────────────────────────────────────────────────────────────────

// Trả về thứ Hai (yyyy-mm-dd, GMT+7) của tuần chứa dateStr
// LƯU Ý: không dùng d.getDate()/setDate()/getDay() ở đây — các hàm đó đọc
// theo timezone LOCAL của server (vd Render chạy UTC mặc định), không phải
// GMT+7, nên "2026-10-26T00:00:00+07:00" (=2026-10-25 17:00 UTC) sẽ bị hiểu
// nhầm là ngày 25 → mọi phép +N ngày bị lùi 1 ngày. Thay vào đó cộng thẳng
// bằng mili-giây rồi quy đổi lại ngày theo GMT+7.
function addDaysStr(dateStr, n) {
    const instant = new Date(dateStr + "T00:00:00+07:00").getTime() + n * 86_400_000;
    return new Date(instant + 7 * 3600_000).toISOString().slice(0, 10);
}
function mondayOfWeek(dateStr) {
    const vn = new Date(new Date(dateStr + "T00:00:00+07:00").getTime() + 7 * 3600_000);
    const dow = vn.getUTCDay(); // 0=CN..6=T7, đọc theo UTC của instant đã shift +7h = đúng thứ ở GMT+7
    const diff = dow === 0 ? -6 : 1 - dow;
    return addDaysStr(dateStr, diff);
}

function groupByOwner(entries) {
    // entries: [{owner, commission, orders}]
    const map = {};
    for (const e of entries) {
        const key = e.owner || "Chưa phân công";
        if (!map[key]) map[key] = { owner: key, commission: 0, orders: 0, accounts: 0 };
        map[key].commission += e.commission || 0;
        map[key].orders += e.orders || 0;
        map[key].accounts += 1;
    }
    const list = Object.values(map).sort((a, b) => b.commission - a.commission);
    const total = list.reduce((a, r) => a + r.commission, 0);
    return list.map((r) => ({ ...r, share: total > 0 ? r.commission / total : 0 }));
}

// Bảng xếp hạng theo người phụ trách — ?period=day|week&date=YYYY-MM-DD
app.get("/api/reports/ranking", async (req, res) => {
    try {
        const period = req.query.period === "week" ? "week" : "day";
        const todayVN = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
        const dateStr = req.query.date || todayVN;

        if (period === "day") {
            const { data } = await getCommissionForDate(dateStr);
            const entries = data.map((a) => ({ owner: a.owner, commission: a.error ? 0 : (a.commission || 0), orders: a.error ? 0 : (a.totalOrders || 0) }));
            return res.json({ success: true, period, date: dateStr, ranking: groupByOwner(entries) });
        }

        // period === "week" → dùng dữ liệu đã đồng bộ trong tab PHỤ TRÁCH (không gọi lại API Shopee)
        const monday = mondayOfWeek(dateStr);
        const weekDayLabels = Array.from({ length: 7 }, (_, i) => formatDayLabel(addDaysStr(monday, i)));
        const history = await readPhuTrachHistory(60);
        const relevantLabels = history.days.filter((d) => weekDayLabels.includes(d));

        const entries = [];
        for (const key of history.accounts) {
            let sum = 0;
            for (const label of relevantLabels) {
                const v = history.matrix[key]?.[label];
                if (typeof v === "number") sum += v;
            }
            entries.push({ owner: getOwner(key), commission: sum, orders: 0 });
        }
        res.json({ success: true, period, date: dateStr, weekStart: monday, days: relevantLabels, ranking: groupByOwner(entries) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Bảng xếp hạng hoa hồng SHOPEE VIDEO — nhóm theo ownerVideo (owners_video.json).
// Dùng field commissionVideo (đã tách theo internal_source === "Shopeevideo-Shopee")
// thay vì gọi thêm API riêng — vì Shopee trả chung 1 API cho mọi nguồn traffic.
// ?date=YYYY-MM-DD (1 ngày, mặc định hôm nay) HOẶC ?from=...&to=... (khoảng ngày, tối đa 31 ngày)
app.get("/api/reports/ranking-video", async (req, res) => {
    try {
        const { from, to } = req.query;
        const todayVN = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

        let data, rangeInfo;
        if (from && to) {
            if (new Date(from + "T00:00:00+07:00") > new Date(to + "T00:00:00+07:00")) {
                return res.status(400).json({ success: false, error: "Ngày bắt đầu phải trước ngày kết thúc" });
            }
            const numDays = daysBetweenInclusive(from, to);
            if (numDays > MAX_RANGE_DAYS) {
                return res.status(400).json({ success: false, error: `Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày (đang chọn ${numDays} ngày)` });
            }
            ({ data } = await getCommissionForRange(from, to));
            rangeInfo = { from, to, days: numDays };
        } else {
            const dateStr = req.query.date || todayVN;
            ({ data } = await getCommissionForDate(dateStr));
            rangeInfo = { date: dateStr };
        }

        // Chỉ tính những tài khoản THỰC SỰ có hoa hồng từ Shopee Video (>0) hoặc có
        // gán ownerVideo — tránh những tài khoản livestream thuần (commissionVideo=0,
        // ownerVideo=null) làm loãng bảng xếp hạng.
        const entries = data
            .filter((a) => !a.error && (a.ownerVideo || (a.commissionVideo || 0) > 0))
            .map((a) => ({
                owner: a.ownerVideo || "Chưa phân công",
                commission: a.commissionVideo || 0,
                orders: (a.orders || []).filter((o) => o.source === "video").length,
            }));

        res.json({ success: true, ...rangeInfo, ranking: groupByOwner(entries) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Biểu đồ xu hướng hoa hồng nhiều ngày — ?days=14 — đọc từ dữ liệu Sheet đã đồng bộ
app.get("/api/reports/trend", async (req, res) => {
    try {
        const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
        const history = await readPhuTrachHistory(days);

        const owners = [...new Set(history.accounts.map((k) => getOwner(k)).filter(Boolean))].sort();
        const series = history.days.map((label) => {
            let total = 0;
            const byOwner = {};
            for (const o of owners) byOwner[o] = 0;
            for (const key of history.accounts) {
                const v = history.matrix[key]?.[label];
                if (typeof v !== "number") continue;
                total += v;
                const o = getOwner(key);
                if (o) byOwner[o] = (byOwner[o] || 0) + v;
            }
            return { label, total, byOwner };
        });

        res.json({ success: true, days: history.days, owners, series });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Top sản phẩm bán chạy — ?days=7&owner=HIẾU (tuỳ chọn)
app.get("/api/reports/top-products", async (req, res) => {
    try {
        const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
        const ownerFilter = req.query.owner || null;
        const todayVN = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
        const startDate = addDaysStr(todayVN, -(days - 1));

        const snap = await getDocsFromServer(
            query(collection(db, "productSnapshots"), where("dateVN", ">=", startDate))
        );

        const map = {}; // key: tên sản phẩm → { name, revenue, qty, orders, sessions:Set }
        snap.forEach((d) => {
            const s = d.data();
            if (ownerFilter && s.owner !== ownerFilter) return;
            for (const p of s.products || []) {
                const k = p.name;
                if (!map[k]) map[k] = { name: p.name, revenue: 0, qty: 0, orders: 0, sessions: 0 };
                map[k].revenue += p.revenue || 0;
                map[k].qty += p.qty || 0;
                map[k].orders += p.orders || 0;
                map[k].sessions += 1;
            }
        });

        const list = Object.values(map).sort((a, b) => b.revenue - a.revenue);
        res.json({ success: true, days, from: startDate, to: todayVN, products: list.slice(0, 50) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => console.log(`\n✅ Server tại: http://localhost:${PORT}\n`));