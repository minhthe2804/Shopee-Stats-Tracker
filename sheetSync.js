import { google } from "googleapis";

// ── Cấu hình ─────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || "1tCCd-feRDt3eZxbMvm-j7pGnfSxofpTUe-5aLXNF1rQ";
const SHEET_NAME      = process.env.GOOGLE_SHEET_TAB || "HH";

// ── Auth ─────────────────────────────────────────────────────────────────────
// GOOGLE_SERVICE_ACCOUNT_KEY: dán NGUYÊN VĂN nội dung file JSON của service account
// vào biến môi trường này trên Render (Environment → Add Environment Variable).
function loadServiceAccountKey() {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("Thiếu biến môi trường GOOGLE_SERVICE_ACCOUNT_KEY");
    return JSON.parse(raw);
}

let sheetsClient = null;
async function getSheets() {
    if (sheetsClient) return sheetsClient;
    const key = loadServiceAccountKey();
    const auth = new google.auth.JWT(
        key.client_email,
        null,
        key.private_key,
        ["https://www.googleapis.com/auth/spreadsheets"]
    );
    await auth.authorize();
    sheetsClient = google.sheets({ version: "v4", auth });
    return sheetsClient;
}

// ── Helper: số cột → chữ cái cột (1 → A, 2 → B, 27 → AA, ...) ────────────────
function colLetter(n) {
    let s = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

// ── Helper: định dạng ngày dạng "dd.mm" ──────────────────────────────────────
export function formatDayLabel(dateInput) {
    const d = typeof dateInput === "string" ? new Date(dateInput + "T00:00:00") : dateInput;
    const day   = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}`;
}

// ── Helper: rút "ngày.tháng" từ tiêu đề cột (hỗ trợ "13.07", "9/7", "13") ────
function extractDayMonth(header) {
    const s = String(header || "").trim();
    let m = s.match(/^(\d{1,2})[.\/](\d{1,2})$/);
    if (m) return { day: Number(m[1]), month: Number(m[2]) };
    m = s.match(/^(\d{1,2})$/);
    if (m) return { day: Number(m[1]), month: null };
    return null;
}

// ── Helper: nhận diện các thông báo lỗi (cookie hết hạn / không tìm thấy...) ─
// Những giá trị này không phải số hoa hồng thật — cần được XOÁ (để trống) khỏi
// tab PHỤ TRÁCH sau khi đã fill xong, thay vì hiển thị nguyên văn dòng lỗi.
const ERROR_PATTERNS = [
    /cookie hết hạn/i,
    /không tìm thấy cookie/i,
    /không hợp lệ/i,
    /lỗi kết nối/i,
    /lỗi api/i,
];
function isErrorValue(v) {
    if (typeof v !== "string") return false;
    return ERROR_PATTERNS.some((rx) => rx.test(v));
}

// ── Helper: lấy sheetId (số) theo tên tab — cần cho thao tác chèn cột ────────
async function getSheetIdByName(sheets, sheetName) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        fields: "sheets(properties(sheetId,title))",
    });
    const found = meta.data.sheets.find((s) => s.properties.title === sheetName);
    if (!found) throw new Error(`Không tìm thấy tab "${sheetName}" trong file Sheet`);
    return found.properties.sheetId;
}

/**
 * Ghi "snapshot" hoa hồng 1 ngày vào tab HH — GHI ĐÈ mỗi lần chạy (không cộng
 * dồn thêm cột). Cột A = tài khoản, cột B = hoa hồng (hoặc thông báo lỗi).
 * Đây là bảng "nguồn" để tab PHỤ TRÁCH tra cứu (VLOOKUP) mỗi ngày.
 *
 * @param {string} dateStr - ngày hiển thị làm tiêu đề cột B, vd "14/07/2026"
 * @param {Array<{key:string, value:string|number}>} rows
 * @returns {{rows:number}}
 */
export async function syncCommissionToSheet(dateStr, rows) {
    const sheets = await getSheets();

    // Xoá dữ liệu cũ trước (trừ header) để không sót lại tài khoản của ngày
    // trước nếu danh sách tài khoản hôm nay ngắn hơn.
    const colARes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:A` });
    const existingRowCount = (colARes.data.values || []).length;
    if (existingRowCount > 1) {
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:B${existingRowCount}`,
        });
    }

    const values = [["Tài khoản", dateStr], ...rows.map((r) => [r.key, r.value])];
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
    });

    return { rows: rows.length };
}

/**
 * Chèn 1 cột hoa hồng mới vào tab "PHỤ TRÁCH", ngay TRƯỚC cột "Tổng".
 * Với mỗi dòng tài khoản đã có sẵn trong sheet, điền công thức
 *   =IFERROR(VLOOKUP(<ô ACCOUNT dòng đó>, HH!A:B, 2, FALSE), "")
 * để Google Sheets tự tính, sau đó ĐỌC LẠI kết quả đã tính và GHI ĐÈ công thức
 * bằng số tĩnh (đóng băng) — để dữ liệu ngày này không bị đổi khi tab HH được
 * ghi đè bởi ngày hôm sau.
 *
 * Các ô mà kết quả tra cứu được là THÔNG BÁO LỖI (cookie hết hạn, không tìm
 * thấy cookie, v.v. — xem ERROR_PATTERNS) sẽ được để TRỐNG thay vì hiển thị
 * nguyên văn dòng lỗi đó.
 *
 * @param {string} dayLabel - nhãn ngày làm tiêu đề cột, định dạng "dd.mm" (VD: "14.07")
 * @param {string} tabName
 * @param {string} accountHeader - tên cột chứa account key, mặc định "ACCOUNT"
 * @param {string} anchorHeader - cột cố định mà cột mới phải chèn ngay trước
 */
export async function syncCommissionToPhuTrachSheet(
    dayLabel,
    tabName = "PHỤ TRÁCH", accountHeader = "ACCOUNT", anchorHeader = "Tổng"
) {
    const sheets = await getSheets();

    // 1. Tìm vị trí cột ACCOUNT và cột mốc HH HÔM QUA
    const row1Res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!1:1` });
    const row1Values = row1Res.data.values?.[0] || [];
    const accountColIdx0 = row1Values.findIndex((h) => (h || "").trim() === accountHeader);
    const anchorColIdx0  = row1Values.findIndex((h) => (h || "").trim() === anchorHeader);
    if (accountColIdx0 === -1) throw new Error(`Không tìm thấy cột "${accountHeader}" trong tab "${tabName}"`);
    if (anchorColIdx0 === -1)  throw new Error(`Không tìm thấy cột "${anchorHeader}" trong tab "${tabName}"`);
    const accountColLetter = colLetter(accountColIdx0 + 1);

    // Kiểm tra ngày này đã có cột sẵn chưa (tránh chèn trùng khi chạy lại)
    const target = extractDayMonth(dayLabel);
    let existingColIdx0 = -1;
    for (let i = 0; i < row1Values.length; i++) {
        if (i === accountColIdx0 || i === anchorColIdx0) continue;
        const parsed = extractDayMonth(row1Values[i]);
        if (!parsed) continue;
        const sameDay = parsed.day === target.day;
        const sameMonth = parsed.month == null || target.month == null || parsed.month === target.month;
        if (sameDay && sameMonth) { existingColIdx0 = i; break; }
    }

    let newCol;
    if (existingColIdx0 !== -1) {
        newCol = colLetter(existingColIdx0 + 1); // dùng lại cột cũ, không chèn thêm
    } else {
        const sheetId = await getSheetIdByName(sheets, tabName);
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    insertDimension: {
                        range: { sheetId, dimension: "COLUMNS", startIndex: anchorColIdx0, endIndex: anchorColIdx0 + 1 },
                        inheritFromBefore: true,
                    },
                }],
            },
        });
        newCol = colLetter(anchorColIdx0 + 1);
    }

    // 3. Lấy danh sách tài khoản hiện có (cột ACCOUNT, từ dòng 2 trở đi)
    const accountColRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${tabName}!${accountColLetter}2:${accountColLetter}`,
    });
    const accountRows = accountColRes.data.values || [];
    if (accountRows.length === 0) return { column: newCol, rows: 0 };
    const lastRow = 1 + accountRows.length;

    // 4. Ghi header (dạng "dd.mm") + công thức VLOOKUP cho từng dòng có tài khoản
    const formulaData = [{ range: `${tabName}!${newCol}1`, values: [[dayLabel]] }];
    for (let i = 0; i < accountRows.length; i++) {
        const rowNum = i + 2;
        const key = accountRows[i]?.[0];
        if (!key) continue; // dòng trống trong sheet, bỏ qua
        const formula = `=IFERROR(VLOOKUP(${accountColLetter}${rowNum},${SHEET_NAME}!A:B,2,FALSE),"")`;
        formulaData.push({ range: `${tabName}!${newCol}${rowNum}`, values: [[formula]] });
    }
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: "USER_ENTERED", data: formulaData },
    });

    // 5. Đọc lại kết quả Google Sheets đã tự tính từ công thức
    const computedRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!${newCol}2:${newCol}${lastRow}`,
        valueRenderOption: "UNFORMATTED_VALUE",
    });
    const computedValues = computedRes.data.values || [];

    // 6. Ghi đè công thức bằng giá trị tĩnh đã tính được (đóng băng).
    //    Nếu giá trị tra cứu được là thông báo lỗi (cookie hết hạn / không tìm
    //    thấy cookie...) thì để trống thay vì ghi nguyên văn dòng lỗi đó.
    const freezeData = [];
    let clearedCount = 0;
    for (let i = 0; i < accountRows.length; i++) {
        const rowNum = i + 2;
        const rawVal = computedValues[i]?.[0] ?? "";
        const val = isErrorValue(rawVal) ? "" : rawVal;
        if (val === "" && rawVal !== "") clearedCount++;
        freezeData.push({ range: `${tabName}!${newCol}${rowNum}`, values: [[val]] });
    }
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: "USER_ENTERED", data: freezeData },
    });

    return { column: newCol, rows: accountRows.length, cleared: clearedCount };
}

// ── Đọc mapping "Người phụ trách" (owner) trực tiếp từ tab PHỤ TRÁCH ─────────
// Thay cho việc phải sửa tay owners.json mỗi khi sheet có tài khoản mới — server
// gọi hàm này định kỳ (xem server.js) để owner luôn khớp với cột PHỤ TRÁCH /
// ACCOUNT hiện tại trên sheet.
//
// Bỏ qua (không đưa vào mapping):
//   - Dòng có ACCOUNT bắt đầu bằng "Hợp Tác Live" (placeholder nhóm chưa gán
//     tài khoản Shopee thật, vd "Hợp Tác Live_Yến1")
//   - Dòng có PHỤ TRÁCH là "ACC MỚI" (placeholder acc mới chưa phân công)
//   - Dòng thiếu ACCOUNT hoặc PHỤ TRÁCH
const PLACEHOLDER_OWNER_VALUES = ["acc mới", "acc moi"];
function isPlaceholderAccountValue(v) {
    return String(v || "").trim().toLowerCase().startsWith("hợp tác live") ||
           String(v || "").trim().toLowerCase().startsWith("hop tac live");
}
function isPlaceholderOwnerValue(v) {
    return PLACEHOLDER_OWNER_VALUES.includes(String(v || "").trim().toLowerCase());
}

export async function readOwnersFromSheet(
    tabName = "PHỤ TRÁCH", accountHeader = "ACCOUNT", ownerHeader = "PHỤ TRÁCH"
) {
    const sheets = await getSheets();

    const row1Res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!1:1` });
    const row1Values = row1Res.data.values?.[0] || [];
    const accountColIdx0 = row1Values.findIndex((h) => (h || "").trim() === accountHeader);
    const ownerColIdx0   = row1Values.findIndex((h) => (h || "").trim() === ownerHeader);
    if (accountColIdx0 === -1) throw new Error(`Không tìm thấy cột "${accountHeader}" trong tab "${tabName}"`);
    if (ownerColIdx0 === -1)   throw new Error(`Không tìm thấy cột "${ownerHeader}" trong tab "${tabName}"`);

    // Cột GIỎ (tuỳ chọn) — số giỏ hàng của từng tài khoản (100 / 500 ...)
    const cartColIdx0 = row1Values.findIndex((h) => String(h || "").trim().toUpperCase() === "GIỎ");
    const lo = Math.min(accountColIdx0, ownerColIdx0, cartColIdx0 === -1 ? Infinity : cartColIdx0);
    const hi = Math.max(accountColIdx0, ownerColIdx0, cartColIdx0);
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!${colLetter(lo + 1)}2:${colLetter(hi + 1)}`,
    });
    const rows = res.data.values || [];
    const relAccountIdx = accountColIdx0 - lo;
    const relOwnerIdx   = ownerColIdx0 - lo;
    const relCartIdx    = cartColIdx0 === -1 ? -1 : cartColIdx0 - lo;

    const map = {};
    const carts = {};
    let skipped = 0;
    for (const row of rows) {
        const account = (row[relAccountIdx] || "").trim();
        const owner   = (row[relOwnerIdx] || "").trim();
        if (!account || !owner) continue;
        if (isPlaceholderAccountValue(account) || isPlaceholderOwnerValue(owner)) { skipped++; continue; }
        map[account] = owner;
        if (relCartIdx !== -1) { const c = String(row[relCartIdx] ?? "").trim(); if (c) carts[account] = c; }
    }
    return { map, carts, count: Object.keys(map).length, skipped, cartColFound: cartColIdx0 !== -1 };
}


// Dùng cho báo cáo (biểu đồ xu hướng, xếp hạng theo tuần) — tận dụng lại dữ
// liệu đã đồng bộ mỗi ngày thay vì gọi lại API Shopee.
// Trả về: { days: ["dd.mm", ...] (cũ→mới), accounts: [key,...], matrix: { key: { "dd.mm": number|null } } }
export async function readPhuTrachHistory(
    maxDays = 30,
    tabName = "PHỤ TRÁCH", accountHeader = "ACCOUNT", anchorHeader = "Tổng"
) {
    const sheets = await getSheets();

    const row1Res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!1:1` });
    const row1Values = row1Res.data.values?.[0] || [];
    const accountColIdx0 = row1Values.findIndex((h) => (h || "").trim() === accountHeader);
    if (accountColIdx0 === -1) throw new Error(`Không tìm thấy cột "${accountHeader}" trong tab "${tabName}"`);
    const accountColLetter = colLetter(accountColIdx0 + 1);

    // Các cột ngày là những cột có tiêu đề dạng "dd.mm" (khác ACCOUNT / HH HÔM QUA).
    // Nhờ cách chèn cột của syncCommissionToPhuTrachSheet, các cột này đã nằm
    // theo thứ tự thời gian tăng dần từ trái sang phải.
    const dayCols = [];
    for (let i = 0; i < row1Values.length; i++) {
        if (i === accountColIdx0) continue;
        const header = (row1Values[i] || "").trim();
        if (header === anchorHeader) continue;
        if (extractDayMonth(header)) dayCols.push({ label: header, colIdx0: i });
    }
    const selected = dayCols.slice(-maxDays);

    const accountColRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${tabName}!${accountColLetter}2:${accountColLetter}`,
    });
    const accountRows = (accountColRes.data.values || []).map((r) => r[0]).filter(Boolean);
    if (accountRows.length === 0 || selected.length === 0) {
        return { days: selected.map((d) => d.label), accounts: accountRows, matrix: {} };
    }
    const lastRow = 1 + (accountColRes.data.values || []).length;

    // Đọc gộp toàn bộ các cột ngày cần thiết trong 1 lần gọi API
    const ranges = selected.map((d) => `${tabName}!${colLetter(d.colIdx0 + 1)}2:${colLetter(d.colIdx0 + 1)}${lastRow}`);
    const batchRes = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: "UNFORMATTED_VALUE",
    });
    const valueRanges = batchRes.data.valueRanges || [];

    const matrix = {};
    for (let ai = 0; ai < accountRows.length; ai++) {
        const key = accountRows[ai];
        if (!key) continue;
        matrix[key] = {};
        for (let di = 0; di < selected.length; di++) {
            const raw = valueRanges[di]?.values?.[ai]?.[0];
            const num = typeof raw === "number" ? raw : (raw != null && raw !== "" && !isNaN(Number(raw)) ? Number(raw) : null);
            matrix[key][selected[di].label] = num;
        }
    }

    return { days: selected.map((d) => d.label), accounts: accountRows, matrix };
}

// ── Điền hoa hồng CÒN THIẾU cho 1 ngày đã đồng bộ ───────────────────────────
// Khác với syncCommissionToPhuTrachSheet (ghi đè TOÀN BỘ cột của 1 ngày),
// 2 hàm dưới đây chỉ động tới đúng những ô đang TRỐNG — dùng khi ngày đó đã
// chạy đồng bộ xong nhưng một số tài khoản bị trống do cookie hết hạn tại
// thời điểm đó; sau khi cập nhật cookie, gọi lại CHỈ cho các tài khoản này.

// Tìm cột của 1 ngày (dayLabel dạng "dd.mm") đã tồn tại sẵn trong tab PHỤ TRÁCH.
// Trả về null nếu cột đó chưa từng được tạo (ngày đó chưa được đồng bộ lần nào).
async function findDayColumn(sheets, tabName, dayLabel, accountHeader, anchorHeader) {
    const row1Res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!1:1` });
    const row1Values = row1Res.data.values?.[0] || [];
    const accountColIdx0 = row1Values.findIndex((h) => (h || "").trim() === accountHeader);
    if (accountColIdx0 === -1) throw new Error(`Không tìm thấy cột "${accountHeader}" trong tab "${tabName}"`);
    const target = extractDayMonth(dayLabel);
    if (!target) throw new Error(`dayLabel không hợp lệ: "${dayLabel}"`);

    let colIdx0 = -1;
    for (let i = 0; i < row1Values.length; i++) {
        if (i === accountColIdx0) continue;
        if (anchorHeader && (row1Values[i] || "").trim() === anchorHeader) continue;
        const parsed = extractDayMonth(row1Values[i]);
        if (!parsed) continue;
        const sameDay = parsed.day === target.day;
        const sameMonth = parsed.month == null || target.month == null || parsed.month === target.month;
        if (sameDay && sameMonth) { colIdx0 = i; break; }
    }
    if (colIdx0 === -1) return null;
    return { accountColLetter: colLetter(accountColIdx0 + 1), dayColLetter: colLetter(colIdx0 + 1) };
}

/**
 * Tìm những tài khoản đang bị TRỐNG hoa hồng ở cột ngày `dayLabel` trong tab
 * PHỤ TRÁCH (ô trống do cookie lỗi lúc đồng bộ, hoặc do bị isErrorValue() xoá
 * trống ở syncCommissionToPhuTrachSheet) — để biết cần gọi lại API Shopee cho
 * đúng những tài khoản nào, thay vì toàn bộ danh sách.
 *
 * @param {string} dayLabel - "dd.mm", vd "09.10"
 * @returns {null | {dayColumn:string, accounts:string[]}} null nếu ngày đó
 *          chưa từng được đồng bộ (chưa có cột trong sheet)
 */
export async function getMissingCommissionAccounts(
    dayLabel, tabName = "PHỤ TRÁCH", accountHeader = "ACCOUNT", anchorHeader = "Tổng"
) {
    const sheets = await getSheets();
    const loc = await findDayColumn(sheets, tabName, dayLabel, accountHeader, anchorHeader);
    if (!loc) return null;

    const { accountColLetter, dayColLetter } = loc;
    const accountColRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${tabName}!${accountColLetter}2:${accountColLetter}`,
    });
    const accountRows = accountColRes.data.values || [];
    if (accountRows.length === 0) return { dayColumn: dayColLetter, accounts: [] };
    const lastRow = 1 + accountRows.length;

    const dayColRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${tabName}!${dayColLetter}2:${dayColLetter}${lastRow}`,
    });
    const dayValues = dayColRes.data.values || [];

    const accounts = [];
    for (let i = 0; i < accountRows.length; i++) {
        const account = (accountRows[i]?.[0] || "").trim();
        if (!account || isPlaceholderAccountValue(account)) continue; // dòng trống/placeholder, bỏ qua
        const cell = dayValues[i]?.[0];
        const isEmpty = cell === undefined || cell === null || String(cell).trim() === "";
        if (isEmpty) accounts.push(account);
    }
    return { dayColumn: dayColLetter, accounts };
}

/**
 * Điền hoa hồng CHỈ cho những tài khoản có mặt trong `valuesByAccount`, vào
 * cột ngày `dayLabel` ĐÃ CÓ SẴN trong tab PHỤ TRÁCH — các ô của tài khoản
 * KHÔNG nằm trong valuesByAccount được giữ nguyên, không đụng tới.
 *
 * @param {string} dayLabel
 * @param {Record<string, number>} valuesByAccount - key: account, value: số hoa hồng
 * @returns {{filled:number, notFoundInSheet:string[]}} notFoundInSheet: những
 *          account trong valuesByAccount nhưng không thấy ở cột ACCOUNT của sheet
 */
export async function fillMissingCommissionValues(
    dayLabel, valuesByAccount, tabName = "PHỤ TRÁCH", accountHeader = "ACCOUNT", anchorHeader = "Tổng"
) {
    const sheets = await getSheets();
    const loc = await findDayColumn(sheets, tabName, dayLabel, accountHeader, anchorHeader);
    if (!loc) throw new Error(`Chưa có cột ngày "${dayLabel}" trong tab "${tabName}" — cần chạy đồng bộ đầy đủ cho ngày đó trước`);

    const { accountColLetter, dayColLetter } = loc;
    const accountColRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${tabName}!${accountColLetter}2:${accountColLetter}`,
    });
    const accountRows = accountColRes.data.values || [];

    const remaining = new Set(Object.keys(valuesByAccount));
    const data = [];
    for (let i = 0; i < accountRows.length; i++) {
        const account = (accountRows[i]?.[0] || "").trim();
        if (!account || !(account in valuesByAccount)) continue;
        const rowNum = i + 2;
        const raw = valuesByAccount[account];
        const val = isErrorValue(raw) ? "" : raw; // phòng hờ, không nên xảy ra vì caller chỉ truyền số thành công
        data.push({ range: `${tabName}!${dayColLetter}${rowNum}`, values: [[val]] });
        remaining.delete(account);
    }
    if (data.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { valueInputOption: "USER_ENTERED", data },
        });
    }
    return { filled: data.length, notFoundInSheet: [...remaining] };
}