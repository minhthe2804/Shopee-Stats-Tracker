// newOrderModel.js
// ════════════════════════════════════════════════════════════════════
// Model Mongoose lưu các đơn hàng mới phát hiện ("đơn nổ") — phục vụ thông
// báo trên dashboard. DÙNG KẾT NỐI MONGO RIÊNG (biến môi trường
// NEW_ORDER_MONGODB_URI) — KHÁC với MONGODB_URI đang dùng cho Live Cart
// (liveCartModel.js) và 2 loại cookie (cookieModels.js). Mục đích: quản lý
// phần dữ liệu thông báo đơn ở một cluster/database riêng, độc lập hoàn
// toàn với 2 tính năng kia (không chung kết nối, không chung connection pool).
//
// orderId có index unique -> khi insertMany({ordered:false}) gặp đơn đã tồn
// tại sẽ bị MongoDB từ chối (lỗi E11000), nhờ vậy biết chính xác đơn nào THỰC
// SỰ mới mà không cần tự quản lý Set trong RAM — và dữ liệu "đã biết đơn nào
// rồi" được LƯU LẠI, không mất khi server restart.

import mongoose from "mongoose";

const newOrderSchema = new mongoose.Schema(
    {
        orderId:     { type: String, required: true, unique: true, index: true },
        account:     { type: String, default: "" },
        owner:       { type: String, default: "" },
        productName: { type: String, default: "" },
        itemValue:   { type: Number, default: 0 }, // doanh thu đơn (giá trị bán được)
        commission:  { type: Number, default: 0 }, // hoa hồng — giữ để tham khảo
        source:      { type: String, default: "" },
        detectedAt:  { type: Date, default: Date.now, index: true },
    },
    { collection: "newOrders", versionKey: false }
);

// Kết nối riêng (không phải mongoose.connect() mặc định dùng cho Live
// Cart/cookies) — tạo bằng mongoose.createConnection() để tách biệt hoàn
// toàn connection pool.
const newOrderConn = mongoose.createConnection();

export const NewOrder = newOrderConn.model("NewOrder", newOrderSchema);

let connected = false;

/**
 * Kết nối MongoDB RIÊNG cho tính năng "đơn mới" — gọi 1 lần lúc server khởi
 * động. Cần biến môi trường NEW_ORDER_MONGODB_URI. Nếu không set, tính năng
 * tự vô hiệu (log cảnh báo, /api/new-orders trả về rỗng) — không làm sập
 * server, giống cách connectLiveCartDb() xử lý MONGODB_URI.
 */
// ⚠️ Chuỗi kết nối được gắn cứng làm giá trị mặc định theo yêu cầu — vẫn ưu
// tiên đọc từ biến môi trường NEW_ORDER_MONGODB_URI nếu có set. Vì server.js
// sẽ được commit lên repo, bất kỳ ai đọc được code (kể cả repo riêng tư, các
// bản backup, hay khi dán code đi hỏi ở đâu đó) cũng thấy được user/pass này
// — nên đổi mật khẩu Mongo Atlas này sớm nếu coi đây là rủi ro.
const HARDCODED_NEW_ORDER_URI =
    "mongodb://minhthe2804:Minhthe2804@ac-tnn6cy5-shard-00-00.ejumh09.mongodb.net:27017,ac-tnn6cy5-shard-00-01.ejumh09.mongodb.net:27017,ac-tnn6cy5-shard-00-02.ejumh09.mongodb.net:27017/new_orders?ssl=true&replicaSet=atlas-xz8co7-shard-0&authSource=admin&appName=Cluster0";

export async function connectNewOrderDb() {
    const uri = process.env.NEW_ORDER_MONGODB_URI || HARDCODED_NEW_ORDER_URI;
    if (!uri) {
        console.warn("⚠️  Không có NEW_ORDER_MONGODB_URI — tính năng thông báo đơn mới sẽ không hoạt động");
        return false;
    }
    try {
        await newOrderConn.openUri(uri);
        connected = true;
        console.log("✅ Đã kết nối MongoDB (Đơn mới)");
        return true;
    } catch (err) {
        console.error("❌ Lỗi kết nối MongoDB (Đơn mới):", err.message);
        return false;
    }
}

export function isNewOrderDbConnected() {
    return connected;
}