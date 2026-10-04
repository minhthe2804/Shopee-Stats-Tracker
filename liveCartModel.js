// liveCartModel.js
// ════════════════════════════════════════════════════════════════════
// Model Mongoose lưu số sản phẩm trong giỏ hàng live — dữ liệu đẩy lên
// từ live_monitor.py / tray_app.py (app chạy nền trên PC quét thiết bị
// Android). TÁCH RIÊNG khỏi Firestore (đang dùng cho cookies/hoa hồng/
// productSnapshots) — đây là một nguồn dữ liệu độc lập, chỉ phục vụ
// tính năng "Live Cart Monitor".

import mongoose from "mongoose";

const liveCartSchema = new mongoose.Schema(
    {
        // "<pc_name>-<serial>" — khoá duy nhất cho 1 thiết bị vật lý trên 1 PC,
        // khớp với field "device_id" mà live_monitor.py gửi lên.
        deviceId:      { type: String, required: true, unique: true, index: true },
        pcName:        { type: String, default: "" },
        serial:        { type: String, default: "" },
        shopeeAccount: { type: String, default: "", index: true },
        owner:         { type: String, default: null }, // ưu tiên getOwner() (sync từ Sheet mỗi 10'), fallback owner PC gửi
        // isLive=true  -> đang live, cartCount là số thật của phiên hiện tại.
        // isLive=false -> PC đã xác nhận máy KHÔNG còn live (vừa rời màn
        //   hình live) -> cartCount=null, không còn ý nghĩa, tránh hiểu nhầm
        //   là giỏ hàng hiện tại.
        // isLive=null  -> bản ghi cũ từ trước khi có field này (PC chưa cập
        //   nhật) — giữ cartCount cũ, dashboard tự coi là "chưa rõ".
        isLive:        { type: Boolean, default: null },
        cartCount:     { type: Number, default: null }, // null khi isLive=false; luôn là số khi isLive=true
        capturedAt:    { type: Date, default: Date.now }, // thời điểm live_monitor.py chụp số liệu (hoặc xác nhận hết live)
    },
    {
        timestamps: { createdAt: false, updatedAt: true }, // chỉ cần updatedAt (lần đồng bộ gần nhất)
    }
);

// Mỗi thiết bị chỉ giữ 1 bản ghi mới nhất (upsert theo deviceId) — đây là
// bảng "trạng thái hiện tại", không phải log lịch sử từng lần quét.
export const LiveCart = mongoose.model("LiveCart", liveCartSchema);

let connected = false;

/**
 * Kết nối MongoDB (Mongoose) — gọi 1 lần lúc server khởi động.
 * Cần biến môi trường MONGODB_URI (vd MongoDB Atlas connection string).
 * Nếu không set, tính năng Live Cart sẽ vô hiệu (log cảnh báo, các route
 * /api/live-cart trả lỗi 503) — không làm sập toàn bộ server vì các tính
 * năng khác (Firestore) vẫn hoạt động bình thường.
 */
export async function connectLiveCartDb() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.warn("⚠️  Không có MONGODB_URI — tính năng Live Cart (giỏ hàng live) sẽ không hoạt động");
        return false;
    }
    try {
        await mongoose.connect(uri);
        connected = true;
        console.log("✅ Đã kết nối MongoDB (Live Cart)");
        return true;
    } catch (err) {
        console.error("❌ Lỗi kết nối MongoDB:", err.message);
        return false;
    }
}

export function isLiveCartDbConnected() {
    return connected;
}