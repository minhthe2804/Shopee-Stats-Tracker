// cookieModels.js
// ════════════════════════════════════════════════════════════════════
// Model Mongoose cho 2 loại cookie dán tay qua UI: "notificationCookies"
// (tính năng Mất Đã Thích) và "violationCheckCookies" (tính năng Gậy Vi
// Phạm). Trước đây 2 loại này lưu ở Firestore; giờ chuyển sang MongoDB —
// CÙNG kết nối Mongo đang dùng cho Live Cart (connectLiveCartDb() ở
// liveCartModel.js) nhưng MỖI LOẠI LÀ 1 COLLECTION RIÊNG, tách biệt với
// collection "livecarts" (và tách biệt với nhau), để không trộn dữ liệu.
// Vẫn độc lập với Firestore — collection "cookies" (SPC_ST, creator/
// affiliate) và "productSnapshots" tiếp tục nằm ở Firestore như cũ.

import mongoose from "mongoose";

// Schema dùng chung cho cả 2 loại — chỉ khác tên collection.
function makeCookieSchema(collectionName) {
    return new mongoose.Schema(
        {
            // Tên tài khoản Shopee — khoá duy nhất, tương đương doc id cũ bên Firestore.
            account:   { type: String, required: true, unique: true, index: true, trim: true },
            cookie:    { type: String, required: true },
            // Giữ kiểu String (ISO string) giống field cũ của Firestore để không phải
            // đổi gì ở phần frontend (vẫn new Date(c.updatedAt) được bình thường).
            updatedAt: { type: String, required: true },
        },
        { collection: collectionName, versionKey: false }
    );
}

export const NotificationCookie = mongoose.model(
    "NotificationCookie",
    makeCookieSchema("notificationCookies")
);

export const ViolationCookie = mongoose.model(
    "ViolationCookie",
    makeCookieSchema("violationCheckCookies")
);