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
