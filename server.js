import express from "express";
import axios from "axios";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query } from "firebase/firestore";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Firebase config — ưu tiên biến môi trường, fallback sang file local
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
    // fallback khi chạy local
    const mod = await import("./firebase-config.js");
    firebaseConfig = mod.default;
}

// Khởi tạo Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Lấy danh sách tài khoản từ Firestore
async function getAccountsFromFirestore() {
    const snapshot = await getDocs(query(collection(db, "cookies")));
    const accounts = [];
    snapshot.forEach((doc) => accounts.push(doc.data()));
    return accounts;
}

// Tìm giá trị cookie SPC_ST từ tài khoản
function getSpcStCookie(account) {
    if (!account.value || account.value.length < 2) return null;
    const cookie = account.value.find(
        (c) => c.name === "SPC_ST" && c.domain && c.domain.includes("shopee.vn")
    );
    return cookie ? cookie.value : null;
}

// Gọi API Shopee Creator để lấy danh sách phiên live
async function fetchCreatorSessions(spcStCookie, page = 1, pageSize = 50) {
    const url =
        `https://creator.shopee.vn/supply/api/lm/sellercenter/realtime/sessionList` +
        `?page=${page}&pageSize=${pageSize}`;

    const { data } = await axios.get(url, {
        headers: {
            cookie: `SPC_ST=${spcStCookie}`,
            referer: "https://creator.shopee.vn/",
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
            accept: "application/json, text/plain, */*",
            "accept-language": "vi-VN,vi;q=0.9,en;q=0.8",
        },
        timeout: 10000,
    });

    return data;
}

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// API endpoint: lấy stats tất cả tài khoản
app.get("/api/stats", async (req, res) => {
    try {
        const accounts = await getAccountsFromFirestore();
        const results = [];

        for (const account of accounts) {
            if (account.deactive === true) continue;

            const spcSt = getSpcStCookie(account);
            if (!spcSt) {
                results.push({ key: account.key, error: "Không tìm thấy cookie SPC_ST", sessions: [] });
                continue;
            }

            try {
                const firstResponse = await fetchCreatorSessions(spcSt, 1, 50);

                if (firstResponse.code !== 0) {
                    const errorMsg =
                        firstResponse.code === 30001
                            ? "Cookie hết hạn — cần cập nhật lại"
                            : `Lỗi API (code ${firstResponse.code})`;
                    results.push({ key: account.key, error: errorMsg, sessions: [] });
                    continue;
                }

                let sessions = firstResponse.data.list || [];
                const totalPage = firstResponse.data.totalPage || 1;

                for (let page = 2; page <= totalPage; page++) {
                    const nextResponse = await fetchCreatorSessions(spcSt, page, 50);
                    if (nextResponse.code === 0 && nextResponse.data.list) {
                        sessions = [...sessions, ...nextResponse.data.list];
                    }
                }

                results.push({
                    key: account.key,
                    error: null,
                    total: firstResponse.data.total,
                    sessions,
                });
            } catch (err) {
                const errorMsg = err.response ? `HTTP ${err.response.status}` : "Lỗi kết nối";
                results.push({ key: account.key, error: errorMsg, sessions: [] });
            }
        }

        res.json({ success: true, data: results, fetchedAt: Date.now() });
    } catch (err) {
        console.error("Server error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n✅ Server đang chạy tại: http://localhost:${PORT}\n`);
});
