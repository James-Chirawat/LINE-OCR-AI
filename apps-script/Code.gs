const TRANSACTION_HEADERS = [
  "EventID", "LINEUserID", "Timestamp", "Date", "Type",
  "Category", "Description", "Amount", "Note",
];
const PENDING_HEADERS = [
  "PendingID", "LINEUserID", "CreatedAt", "Status", "Date",
  "Type", "Category", "Description", "Amount", "Note",
];

function doPost(event) {
  try {
    const body = event && event.postData && event.postData.contents;
    if (typeof body !== "string" || body.length > 12000) return result_(false, "bad-request");
    const properties = PropertiesService.getScriptProperties();
    const request = authenticatedRequest_(JSON.parse(body), properties.getProperty("SHARED_SECRET"));
    if (!request) return result_(false, "unauthorized");
    if (!validRequest_(request)) return result_(false, "bad-request");

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return result_(false, "busy");
    try {
      const book = SpreadsheetApp.openById(properties.getProperty("SPREADSHEET_ID"));
      const data = dispatch_(book, request);
      SpreadsheetApp.flush();
      return result_(true, data);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return result_(false, "storage-error");
  }
}

function result_(ok, value) {
  return ContentService.createTextOutput(JSON.stringify(
    ok ? { ok, data: value } : { ok, code: value },
  )).setMimeType(ContentService.MimeType.JSON);
}

function authenticatedRequest_(envelope, secret) {
  if (!secret || secret.length < 32 || !envelope || typeof envelope.payload !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.signature || "")) return null;
  const expected = Utilities.computeHmacSha256Signature(
    envelope.payload, secret, Utilities.Charset.UTF_8,
  );
  let mismatch = 0;
  expected.forEach((byte, index) => {
    mismatch |= (byte & 255) ^ parseInt(envelope.signature.slice(index * 2, index * 2 + 2), 16);
  });
  if (mismatch) return null;
  const request = JSON.parse(envelope.payload);
  if (!request || !Number.isSafeInteger(request.issuedAt) || Math.abs(Date.now() - request.issuedAt) > 120000) {
    return null;
  }
  return request;
}

// Run once from the Apps Script editor after setting Script Properties.
function setupSheets() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const id = properties.getProperty("SPREADSHEET_ID");
    const secret = properties.getProperty("SHARED_SECRET");
    if (!id) throw new Error("Set SPREADSHEET_ID in Script properties.");
    if (!secret || secret.length < 32) {
      throw new Error("Set SHARED_SECRET to at least 32 characters in Script properties.");
    }
    const book = SpreadsheetApp.openById(id);
    initializeSheet_(book, "Transactions", TRANSACTION_HEADERS, 8);
    initializeSheet_(book, "PendingTransactions", PENDING_HEADERS, 9);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function initializeSheet_(book, name, headers, amountColumn) {
  const sheet = book.getSheetByName(name) || book.insertSheet(name);
  if (!sheet.getLastRow()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  } else if (name === "Transactions") {
    const [actual] = sheet.getRange(1, 1, 1, headers.length).getValues();
    const priorHeaders = ["EventID", "Timestamp", "LINEUserID", ...headers.slice(3)];
    if (priorHeaders.every((header, index) => actual[index] === header)) {
      // Move the entire column so every LINE user ID follows its header.
      sheet.moveColumns(sheet.getRange(1, 3), 2);
    }
  }
  checkedSheet_(book, name, headers);
  sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat("@");
  sheet.getRange(2, amountColumn, sheet.getMaxRows() - 1, 1).setNumberFormat("0.00");
}

function checkedSheet_(book, name, headers) {
  const sheet = book.getSheetByName(name);
  if (!sheet || !sheet.getLastRow()) throw new Error("Run setupSheets first");
  const [actual] = sheet.getRange(1, 1, 1, headers.length).getValues();
  if (headers.some((header, index) => header !== actual[index])) {
    throw new Error("Unexpected headers in " + name + ". Expected: " + headers.join(" | "));
  }
  return sheet;
}

function validDate_(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01") return false;
  const parsed = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validTransaction_(transaction) {
  if (!transaction || !validDate_(transaction.date) || !["income", "expense"].includes(transaction.type) ||
      transaction.currency !== "THB" || !Number.isFinite(transaction.amount) || transaction.amount <= 0 ||
      transaction.amount > 999999999.99 || transaction.amount !== Number(transaction.amount.toFixed(2))) return false;
  return [
    [transaction.category, 60, true],
    [transaction.description, 180, true],
    [transaction.note, 200, false],
  ].every(([value, max, required]) => typeof value === "string" &&
    value === value.trim() && value.length <= max && (!required || value.length > 0));
}

function validRequest_(request) {
  if (typeof request.userId !== "string" || !/^U[A-Za-z0-9_-]{1,100}$/.test(request.userId)) return false;
  if (["summary", "food-history"].includes(request.action)) {
    return (request.action === "summary" && request.from === undefined && request.through === undefined) ||
      (validDate_(request.from) && validDate_(request.through) && request.from <= request.through);
  }
  if (typeof request.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(request.id)) return false;
  if (request.action === "create") {
    return validTransaction_(request.transaction) && ["reply", "push"].includes(request.delivery);
  }
  return ["find", "confirm", "cancel"].includes(request.action);
}

function rowForId_(sheet, id) {
  const count = sheet.getLastRow() - 1;
  if (count < 1) return 0;
  const match = sheet.getRange(2, 1, count, 1)
    .createTextFinder(id).matchEntireCell(true).matchCase(true).findNext();
  return match ? match.getRow() : 0;
}

function safeCell_(text) {
  // Escape formula prefixes even if the cell format changes later.
  return /^[\s\u0000-\u001f]*[=+@'\-]/u.test(text) ? "'" + text : text;
}

function writeRow_(sheet, row, values, amountColumn) {
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  const range = sheet.getRange(row, 1, 1, values.length);
  range.setNumberFormats([values.map((_, index) => index + 1 === amountColumn ? "0.00" : "@")]);
  range.setValues([values.map((value) => typeof value === "string" ? safeCell_(value) : value)]);
}

function transactionCells_(transaction) {
  return [transaction.date, transaction.type, transaction.category, transaction.description,
    transaction.amount, transaction.note];
}

function draftAt_(pending, row) {
  const [id, , , status, date, type, category, description, amount, note] =
    pending.getRange(row, 1, 1, PENDING_HEADERS.length).getValues()[0];
  // Keep delivery metadata on the ID cell so the two tab schemas stay stable.
  const delivery = pending.getRange(row, 1).getNote() || "reply";
  const transaction = { date, type, category, description, amount, currency: "THB", note };
  if (!validTransaction_(transaction)) throw new Error("Invalid pending row");
  return { id, status, delivery, transaction };
}

function dispatch_(book, request) {
  const transactions = checkedSheet_(book, "Transactions", TRANSACTION_HEADERS);
  if (request.action === "summary") return summarize_(transactions, request);
  if (request.action === "food-history") return expenseHistory_(transactions, request);

  const pending = checkedSheet_(book, "PendingTransactions", PENDING_HEADERS);
  const { id, userId, action } = request;
  const existing = rowForId_(pending, id);
  if (existing && pending.getRange(existing, 2).getValue() !== userId) {
    if (action === "create") throw new Error("Pending ID collision");
    return action === "find" ? null : "not-found";
  }
  if (action === "create" && !existing) {
    const row = pending.getLastRow() + 1;
    // Write mode first. If row insertion stops midway, redelivery can still create the row.
    if (row > pending.getMaxRows()) pending.insertRowsAfter(pending.getMaxRows(), 1);
    pending.getRange(row, 1).setNote(request.delivery);
    writeRow_(pending, row, [id, userId, new Date().toISOString(), "Pending",
      ...transactionCells_(request.transaction)], 9);
    return draftAt_(pending, row);
  }
  if (!existing) return action === "find" ? null : "not-found";

  const draft = draftAt_(pending, existing);
  const statusCell = pending.getRange(existing, 4);
  // A Transactions row is authoritative if an earlier run stopped before updating Pending.
  if (draft.status === "Pending" && rowForId_(transactions, id)) {
    statusCell.setValue("Confirmed");
    draft.status = "Confirmed";
  }
  if (action === "create" || action === "find") return draft;
  if (draft.status === "Confirmed") return "already-confirmed";
  if (draft.status === "Cancelled") return "already-cancelled";
  if (draft.status !== "Pending") throw new Error("Unexpected pending status");

  if (action === "cancel") {
    statusCell.setValue("Cancelled");
    return "cancelled";
  }
  writeRow_(transactions, transactions.getLastRow() + 1, [
    id, userId, new Date().toISOString(), ...transactionCells_(draft.transaction),
  ], 8);
  SpreadsheetApp.flush();
  statusCell.setValue("Confirmed");
  return request.includeTransaction === true
    ? { outcome: "confirmed", transaction: draft.transaction }
    : "confirmed";
}

function summarize_(sheet, { userId, from, through }) {
  let incomeSatang = 0;
  let expenseSatang = 0;
  let count = 0;
  const rows = sheet.getLastRow() - 1;
  if (rows < 1) return { incomeSatang, expenseSatang, count };

  const clients = sheet.getRange(2, 2, rows, 1)
    .createTextFinder(userId).matchEntireCell(true).matchCase(true).findAll();
  if (!clients.length) return { incomeSatang, expenseSatang, count };

  const values = sheet.getRange(2, 4, rows, 5).getValues();
  for (const match of clients) {
    const [date, type, , , amount] = values[match.getRow() - 2];
    if (!validDate_(date) || (from && (date < from || date > through))) continue;
    if (!["income", "expense"].includes(type) || typeof amount !== "number" ||
        !Number.isFinite(amount) || amount <= 0) throw new Error("Invalid transaction row");
    const satang = Math.round(amount * 100);
    if (type === "income") incomeSatang += satang;
    else expenseSatang += satang;
    count++;
  }
  if (!Number.isSafeInteger(incomeSatang) || !Number.isSafeInteger(expenseSatang)) {
    throw new Error("Summary amount exceeds safe integer range");
  }
  return { incomeSatang, expenseSatang, count };
}

function expenseHistory_(sheet, { userId, from, through }) {
  const count = sheet.getLastRow() - 1;
  if (count < 1) return { entries: [], truncated: false };
  const matches = sheet.getRange(2, 2, count, 1)
    .createTextFinder(userId).matchEntireCell(true).matchCase(true).findAll();
  if (!matches.length) return { entries: [], truncated: false };

  const rows = sheet.getRange(2, 4, count, 4).getValues();
  const entries = [];
  for (const match of matches) {
    const row = match.getRow();
    const [date, type, category, description] = rows[row - 2];
    if (type !== "expense" || !validDate_(date) || date < from || date > through) continue;
    if (typeof category !== "string" || typeof description !== "string" || !description.trim()) continue;
    entries.push({ date, row, category: category.slice(0, 60), description: description.slice(0, 180) });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.row - a.row);
  return {
    entries: entries.slice(0, 60).map(({ category, description }) => ({ category, description })),
    truncated: entries.length > 60,
  };
}
