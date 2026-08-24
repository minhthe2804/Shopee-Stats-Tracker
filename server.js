import "dotenv/config";
import express from "express";
import axios from "axios";
import https from "https";
import cron from "node-cron";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, getDocsFromServer, query, doc, setDoc, where } from "firebase/firestore";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { syncCommissionToSheet, syncCommissionToPhuTrachSheet, formatDayLabel, readPhuTrachHistory } from "./sheetSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Người phụ trách (owner) theo từng tài khoản ──────────────────────────────
// owners.json: { "accountKey": "TÊN NGƯỜI PHỤ TRÁCH", ... } — đặt cùng thư mục với server.js.
// Nếu không có file này, mọi tài khoản sẽ có owner: null (không lỗi).
let OWNERS = {};
try {
    OWNERS = JSON.parse(fs.readFileSync(path.join(__dirname, "owners.json"), "utf-8"));
    console.log(`✅ Đã tải ${Object.keys(OWNERS).length} mapping người phụ trách`);
} catch {
    console.warn("⚠️  Không tìm thấy owners.json — bỏ qua, mọi tài khoản sẽ không có người phụ trách");
}
const getOwner = (key) => OWNERS[key] || null;

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
function calcCommission(orders, filterFn = null) {
    // Cộng dồn giá trị THÔ (chưa làm tròn) trước, chỉ làm tròn 1 LẦN DUY NHẤT ở
    // cuối cùng — thay vì làm tròn từng đơn rồi mới cộng. Làm tròn riêng từng đơn
    // (mỗi đơn sai số tối đa ±0,5đ) rồi cộng hàng trăm đơn có thể để lại dư vài
    // đồng do sai số không triệt tiêu hết; cộng thô trước tránh được việc đó và
    // ĐÃ ĐƯỢC KIỂM CHỨNG khớp chính xác với cách Shopee tự tính tổng trên
    // dashboard của họ (xem lịch sử debug 594.089đ).
    let sumRaw = 0;
    for (const o of orders) {
        if (o.conversion_status === 4) continue; // bỏ đơn huỷ
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
        const flatOrders = [];
        for (const o of orders) {
            const commission = Number(o.linked_mcn_commission_rate) === 100000
                ? Math.round(o.estimated_total_commission_with_mcn / 100000)
                : Math.round(o.estimated_total_commission / 100000);
            const source = classifySource(o);

            if (o.orders && o.orders.length > 0) {
                // Hoa hồng `commission` ở trên là của CẢ checkout, không phải của
                // từng đơn riêng lẻ. Nếu 1 checkout có nhiều đơn (o.orders.length > 1)
                // mà gán nguyên `commission` cho MỖI đơn thì khi cộng tổng theo đơn sẽ
                // bị NHÂN ĐÔI (nhân ba...) hoa hồng thật. Ở đây chia tỉ lệ theo giá trị
                // đơn hàng (itemValue) cho từng đơn, đơn cuối nhận phần dư làm tròn để
                // tổng của các đơn trong checkout luôn khớp CHÍNH XÁC với `commission`.
                const itemValues = o.orders.map(
                    (ord) => Math.round((ord.items?.reduce((a, i) => a + (i.actual_amount || 0), 0) || 0) / 100000)
                );
                const totalItemValue = itemValues.reduce((a, v) => a + v, 0);
                let allocated = 0;
                o.orders.forEach((ord, idx) => {
                    const isLast = idx === o.orders.length - 1;
                    let share;
                    if (isLast) {
                        share = commission - allocated; // phần dư, đảm bảo tổng khớp
                    } else if (totalItemValue > 0) {
                        share = Math.round(commission * (itemValues[idx] / totalItemValue));
                    } else {
                        share = Math.round(commission / o.orders.length);
                    }
                    allocated += share;

                    const firstItem = ord.items?.[0];
                    flatOrders.push({
                        orderId:      ord.order_sn,
                        status:       o.conversion_status,
                        commission:   share,
                        itemValue:    itemValues[idx],
                        purchaseTime: o.purchase_time,
                        productName:  firstItem?.item_name || "",
                        mcnRate:      o.linked_mcn_commission_rate,
                        source,
                    });
                });
            } else {
                // fallback nếu không có orders[]
                flatOrders.push({
                    orderId:      o.checkout_id || "",
                    status:       o.conversion_status,
                    commission,
                    itemValue:    0,
                    purchaseTime: o.purchase_time,
                    productName:  "",
                    mcnRate:      o.linked_mcn_commission_rate,
                    source,
                });
            }
        }

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
        const results = settled.filter(Boolean).map(r => ({ ...r, owner: getOwner(r.key) }));

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

// ── BÁO CÁO ──────────────────────────────────────────────────────────────────

// Trả về thứ Hai (yyyy-mm-dd, GMT+7) của tuần chứa dateStr
function mondayOfWeek(dateStr) {
    const d = new Date(dateStr + "T00:00:00+07:00");
    const dow = d.getDay(); // 0=CN..6=T7
    const diff = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
}
function addDaysStr(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00+07:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
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