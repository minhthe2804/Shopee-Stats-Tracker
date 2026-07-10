import express from "express";
import axios from "axios";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, getDocsFromServer, query } from "firebase/firestore";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

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
            const rest  = await Promise.all(pages.map(p => fetchCreatorSessions(spcSt, p, 50).catch(() => null)));
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
            const rest  = await Promise.all(pages.map(p => fetchCommissionPage(spcSt, p, start, end).catch(() => null)));
            for (const r of rest) {
                if (r?.data?.list) orders = [...orders, ...r.data.list];
            }
        }

        return {
            key: account.key,
            error: null,
            commission: calcCommission(orders),
            totalOrders: totalCount,
            orders: orders.map(o => ({
                orderId:        o.order_sn,
                status:         o.conversion_status,
                commission:     Number(o.linked_mcn_commission_rate) === 100000
                                    ? Math.round(o.estimated_total_commission_with_mcn / 100000)
                                    : Math.round(o.estimated_total_commission / 100000),
                itemValue:      Math.round((o.item_price_after_discount || 0) / 100000),
                purchaseTime:   o.purchase_time,
                productName:    o.product_name || "",
                mcnRate:        o.linked_mcn_commission_rate,
            })),
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
        const settled = await Promise.all(accounts.map(fetchAccount));
        const results = settled.filter(Boolean);
        console.log(`✅ Stats: ${results.length} accounts in ${Date.now() - t0}ms`);
        statsCache.data = results; statsCache.at = Date.now();
        res.json({ success: true, data: results, fetchedAt: statsCache.at, cached: false });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Hoa hồng affiliate — ?date=YYYY-MM-DD (mặc định hôm nay theo GMT+7)
app.get("/api/commission", async (req, res) => {
    try {
        // Ngày mặc định: hôm nay theo GMT+7
        const todayVN = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
        const dateStr  = req.query.date || todayVN;
        const force    = req.query.refresh === "1";

        const cacheKey = dateStr;
        if (!force && commCache[cacheKey] && Date.now() - commCache[cacheKey].at < COMM_CACHE_TTL) {
            return res.json({ success: true, data: commCache[cacheKey].data, fetchedAt: commCache[cacheKey].at, cached: true, date: dateStr });
        }

        const { start, end } = dayRange(dateStr);
        const accounts = await getAccountsFromFirestore();
        const t0 = Date.now();
        const settled = await Promise.all(accounts.map(a => fetchAccountCommission(a, start, end)));
        const results = settled.filter(Boolean);
        console.log(`✅ Commission [${dateStr}]: ${results.length} accounts in ${Date.now() - t0}ms`);

        commCache[cacheKey] = { data: results, at: Date.now() };
        res.json({ success: true, data: results, fetchedAt: commCache[cacheKey].at, cached: false, date: dateStr });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => console.log(`\n✅ Server tại: http://localhost:${PORT}\n`));