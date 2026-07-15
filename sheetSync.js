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

// ── Helper: định dạng ngày dạng "dd.mm" (VD: ngày 14/07 → "14.07") ───────────
// dateInput: Date object, hoặc chuỗi "YYYY-MM-DD"
export function formatDayLabel(dateInput) {
    const d = typeof dateInput === "string" ? new Date(dateInput + "T00:00:00") : dateInput;
    const day   = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}`;
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
 * Chèn 1 cột hoa hồng mới vào tab "PHỤ TRÁCH", ngay TRƯỚC cột "HH HÔM QUA".
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
    tabName = "PHỤ TRÁCH", accountHeader = "ACCOUNT", anchorHeader = "HH HÔM QUA"
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