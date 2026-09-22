# Shopee Creator Stats Tracker

Dashboard theo dõi thống kê phiên live Shopee Creator — nhiều tài khoản, realtime.

## Cấu trúc

```
├── server.js          # Express server + Shopee API
├── firebase-config.js # Config Firebase (local only, không commit)
├── public/
│   └── index.html     # Frontend React
└── package.json
```

## Chạy local

```bash
npm install
node server.js
# → http://localhost:3000
```

## Deploy Railway

Xem hướng dẫn deploy bên dưới. Cần set các biến môi trường Firebase trong Railway dashboard.

## Live Cart Monitor (giỏ hàng live)

Tính năng riêng nhận dữ liệu số sản phẩm trong giỏ hàng live, đẩy lên từ app
chạy nền `live_monitor.py`/`tray_app.py` trên các PC — lưu ở **MongoDB**
(qua Mongoose), tách biệt với Firebase Firestore đang dùng cho các tính năng
khác. Cần set thêm 2 biến môi trường:

- `MONGODB_URI` — connection string MongoDB (vd MongoDB Atlas). Thiếu biến
  này thì mọi request tới `/api/live-cart` sẽ trả lỗi 503, các tính năng
  khác của server vẫn hoạt động bình thường.
- `LIVE_CART_TOKEN` — tuỳ chọn, nếu set thì các PC phải gửi đúng token này
  qua header `Authorization: Bearer <token>` (khớp với `TRACKER_TOKEN`
  trong file `.env` của app trên từng PC).

Route:
- `POST /api/live-cart` — PC đẩy số liệu lên (1 thiết bị = 1 bản ghi, tự
  ghi đè bản cũ theo `device_id`).
- `GET /api/live-cart` — dashboard đọc lại danh sách trạng thái hiện tại.