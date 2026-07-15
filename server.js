import express from "express";
import axios from "axios";
import https from "https";
import cron from "node-cron";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, getDocsFromServer, query } from "firebase/firestore";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { syncCommissionToSheet, syncCommissionToPhuTrachSheet, formatDayLabel } from "./sheetSync.js";

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
        `?page_size=500&page_num=${pageNum}&referrer=live` +
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

function calcCommission(orders) {
    let sum = 0;
    for (const o of orders) {
        if (o.conversion_status === 4) continue; // bỏ đơn huỷ
        sum += Number(o.linked_mcn_commission_rate) === 100000
            ? Math.round(o.estimated_total_commission_with_mcn / 100000)
            : Math.round(o.estimated_total_commission / 100000);
    }
    return sum;
}

async function fetchAccountCommission(account, start, end) {
    if (account.deactive === true) return null;
    const spcSt = getSpcStCookie(account);
    if (!spcSt) return { key: account.key, error: "Không tìm thấy cookie SPC_ST", commission: 0, orders: [] };

    try {
        const first = await fetchCommissionPage(spcSt, 1, start, end);
        if (!first?.data || first.data.total_count == null) {
            return { key: account.key, error: "Cookie hết hạn hoặc phản hồi không hợp lệ", commission: 0, orders: [] };
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

            if (o.orders && o.orders.length > 0) {
                for (const ord of o.orders) {
                    const firstItem = ord.items?.[0];
                    flatOrders.push({
                        orderId:      ord.order_sn,
                        status:       o.conversion_status,
                        commission,
                        itemValue:    Math.round((ord.items?.reduce((a, i) => a + (i.actual_amount || 0), 0) || 0) / 100000),
                        purchaseTime: o.purchase_time,
                        productName:  firstItem?.item_name || "",
                        mcnRate:      o.linked_mcn_commission_rate,
                    });
                }
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
                });
            }
        }

        return {
            key: account.key,
            error: null,
            commission: calcCommission(orders),
            totalOrders: totalCount,
            orders: flatOrders,
        };
    } catch (err) {
        return { key: account.key, error: err.response ? `HTTP ${err.response.status}` : "Lỗi kết nối", commission: 0, orders: [] };
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
    const results = settled.filter(Boolean).map(r => ({ ...r, owner: getOwner(r.key) }));

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
        value: acc.error ? acc.error : (acc.commission ?? 0),
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

app.listen(PORT, () => console.log(`\n✅ Server tại: http://localhost:${PORT}\n`));