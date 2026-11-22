import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandler } from "../lib/webhook.js";
import { createSheetsClient } from "../lib/sheets.js";
import { AppError } from "../lib/errors.js";
import { createScriptSandbox } from "./helpers/sheets.js";

const start = Date.parse("2026-11-21T17:02:00Z");
const env = {
  LINE_CHANNEL_ID: "12345",
  LINE_CHANNEL_SECRET: "line-test-secret",
  SHEETS_WEB_APP_URL: "https://script.google.com/macros/s/test/exec",
  SHEETS_SHARED_SECRET: "sheets-test-secret-32-characters-long",
};
const base = {
  date: "2026-11-22", type: "expense", category: "อาหาร", description: "ค่าอาหาร",
  amount: 80, currency: "THB", note: "",
};

function inbox(id, text, userId = "Ualice") {
  return {
    webhookEventId: id, replyToken: "token-" + id, timestamp: start,
    source: { type: "user", userId }, type: "message", message: { type: "text", text },
  };
}

function button(id, action, userId) {
  return { ...inbox(id, "", userId), type: "postback", postback: { data: action } };
}

function request(events, secret = env.LINE_CHANNEL_SECRET) {
  const body = JSON.stringify({ events });
  return new Request("http://localhost:3000/api/webhook", {
    method: "POST", body,
    headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") },
  });
}

function integration() {
  let clock = start;
  const now = () => clock;
  const script = createScriptSandbox(env.SHEETS_SHARED_SECRET, now);
  const replies = [];
  const pushes = [];
  const seenReplies = new Set();
  const seenPushes = new Set();
  const results = new Map();
  const calls = [];
  let redirect = 0;

  async function fetchImpl(url, options) {
    calls.push(url);
    if (url === env.SHEETS_WEB_APP_URL) {
      assert.equal(options.redirect, "manual");
      assert.equal(options.method, "POST");
      const target = "https://script.googleusercontent.com/test/" + ++redirect;
      results.set(target, script.receive(options.body));
      return new Response(null, { status: 302, headers: { location: target } });
    }
    if (results.has(url)) {
      assert.equal(options.body, undefined);
      assert.equal(options.method, undefined);
      const result = results.get(url);
      results.delete(url);
      return result;
    }
    if (url.endsWith("/oauth2/v3/token")) {
      return Response.json({ access_token: "fixture", expires_in: 900 });
    }
    assert.equal(options.headers.Authorization, "Bearer fixture");
    if (url.endsWith("/chat/loading/start")) return new Response(null, { status: 202 });
    if (url.startsWith("https://api-data.line.me/")) {
      return new Response("fixture PDF", { headers: { "Content-Type": "application/pdf" } });
    }
    const body = JSON.parse(options.body);
    if (url.endsWith("/reply")) {
      if (seenReplies.has(body.replyToken)) {
        return Response.json({ message: "Invalid reply token" }, { status: 400 });
      }
      seenReplies.add(body.replyToken);
      replies.push(body.messages[0]);
      return new Response();
    }
    assert.ok(url.endsWith("/push"));
    const key = options.headers["X-Line-Retry-Key"];
    assert.match(key, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    if (seenPushes.has(key)) {
      return new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "seen" } });
    }
    seenPushes.add(key);
    pushes.push(body);
    return new Response();
  }

  return {
    script, replies, pushes, calls,
    advance: (ms) => { clock += ms; },
    handler: (options) => createWebhookHandler({ env, now, fetchImpl, ...options }),
    sheets: createSheetsClient({ env, now, fetchImpl }),
  };
}

test("signed Verify succeeds without contacting providers and tampered requests fail", async () => {
  const run = integration();
  const post = run.handler();
  assert.equal((await post(request([]))).status, 200);
  assert.equal((await post(request([], "wrong-secret"))).status, 401);
  assert.equal(run.calls.length, 0);
});

test("signed text becomes one pending card across fresh instances and only its owner can confirm", async () => {
  const run = integration();
  let analyses = 0;
  const analyze = async (text, context) => {
    analyses++;
    assert.equal(text, "กินข้าว 80 บาท");
    assert.equal(context.today, base.date);
    assert.equal(context.source, "chat");
    return { transaction: base };
  };
  const event = inbox("evt-1", "กินข้าว 80 บาท");
  assert.equal((await run.handler({ analyze })(request([event]))).status, 200);
  assert.equal((await run.handler({ analyze })(request([{ ...event, deliveryContext: { isRedelivery: true } }]))).status, 200);
  assert.equal(analyses, 1);
  assert.equal(run.script.tabs.PendingTransactions.rows.length, 2);
  assert.equal(run.script.tabs.Transactions.rows.length, 1);
  assert.equal(run.replies.length, 1);
  const actions = run.replies[0].contents.footer.contents.map(({ action }) => action);
  assert.equal(actions[0].displayText, "✅ ขอยืนยันบันทึกรายการ");
  assert.equal(actions[0].type, "postback");
  const [confirm, cancel] = actions.map(({ data }) => data);
  assert.equal(cancel, "cancel:evt-1");

  const post = run.handler();
  await post(request([button("evt-2", confirm, "Ueve")]));
  assert.match(run.replies.at(-1).text, /ไม่พบรายการ/);
  assert.equal(run.script.tabs.Transactions.rows.length, 1);
  await post(request([button("evt-3", confirm)]));
  assert.match(run.replies.at(-1).altText, /บันทึกรายการเรียบร้อย/);
  await run.handler()(request([button("evt-4", confirm)]));
  assert.match(run.replies.at(-1).text, /บันทึกเรียบร้อยแล้ว/);
  await post(request([button("evt-5", cancel)]));
  assert.equal(run.script.tabs.Transactions.rows.length, 2);
  assert.equal(run.script.tabs.Transactions.rows[1][0], "evt-1");
  assert.equal(run.script.tabs.PendingTransactions.rows[1][3], "Confirmed");

  await post(request([inbox("evt-6", "สรุปวันนี้"), inbox("evt-7", "สรุปวันนี้", "Ueve")]));
  assert.match(run.replies.at(-2).altText, /−80 บาท/);
  assert.match(run.replies.at(-1).altText, /0 บาท/);
});

test("recover a write interrupted after appending the confirmed transaction", async () => {
  const { sheets, script } = integration();
  await sheets.create("Ualice", "recovery", base, "reply");
  script.tabs.PendingTransactions.failStatus = true;
  await assert.rejects(sheets.resolve("Ualice", "recovery", "confirm"), { code: "SHEETS_FAILED" });
  assert.equal(script.tabs.Transactions.rows.length, 2);
  assert.equal(await sheets.resolve("Ualice", "recovery", "cancel"), "already-confirmed");
  assert.equal(script.tabs.PendingTransactions.rows[1][3], "Confirmed");
  assert.equal(script.tabs.Transactions.rows.length, 2);
});

test("cancelled rows stay cancelled and summaries use dates, owners and satang", async () => {
  const { sheets } = integration();
  const records = [
    ["Ualice", "a", { ...base, amount: 0.1, date: "2026-11-01" }],
    ["Ualice", "b", { ...base, amount: 0.2, date: "2026-11-30" }],
    ["Ualice", "c", { ...base, amount: 20, type: "income" }],
    ["Ualice", "d", { ...base, amount: 100, date: "2026-12-01" }],
    ["Ubob", "e", base],
  ];
  for (const [owner, id, transaction] of records) {
    await sheets.create(owner, id, transaction, "reply");
    assert.equal(await sheets.resolve(owner, id, "confirm"), "confirmed");
  }
  await sheets.create("Ualice", "cancelled", base, "reply");
  assert.equal(await sheets.resolve("Ualice", "cancelled", "cancel"), "cancelled");
  assert.equal(await sheets.resolve("Ualice", "cancelled", "confirm"), "already-cancelled");
  assert.deepEqual(await sheets.summarize("Ualice", { from: "2026-11-01", through: "2026-11-30" }),
    { incomeSatang: 2000, expenseSatang: 30, count: 3 });
  assert.deepEqual(await sheets.summarize("Ualice", {}), { incomeSatang: 2000, expenseSatang: 10030, count: 4 });
});

test("Apps Script rejects bad authentication and escapes formula-like text across both tabs", async () => {
  const { sheets, script } = integration();
  const payload = JSON.stringify({ action: "summary", userId: "Ualice", issuedAt: start });
  assert.deepEqual(await script.receive(JSON.stringify({ payload, signature: "0".repeat(64) })).json(),
    { ok: false, code: "unauthorized" });
  const tampered = JSON.stringify({ action: "summary", userId: "Ualice", issuedAt: start - 121_000 });
  const signature = createHmac("sha256", env.SHEETS_SHARED_SECRET).update(tampered).digest("hex");
  assert.deepEqual(await script.receive(JSON.stringify({ payload: tampered, signature })).json(),
    { ok: false, code: "unauthorized" });
  const transaction = { ...base, description: "=1+1", note: "@SUM(1)" };
  assert.deepEqual((await sheets.create("Ualice", "formula", transaction, "reply")).transaction, transaction);
  await sheets.resolve("Ualice", "formula", "confirm");
  assert.equal(script.tabs.Transactions.rows[1][6], "=1+1");
});

test("slow PDF uses a stable LINE Push key and redelivery never attempts the old reply", async () => {
  const run = integration();
  const event = {
    ...inbox("pdf-event", ""), message: { type: "file", id: "pdf-1", fileName: "receipt.PDF", fileSize: 900 },
  };
  const post = run.handler({
    pdfOcr: async (file) => {
      assert.equal(file.toString(), "fixture PDF");
      run.advance(53_000);
      return { text: "ใบเสร็จวันที่ 22/11/2026 ยอดรวม 80 บาท", confidence: 0.98 };
    },
    analyze: async (text, context) => {
      assert.match(text, /ยอดรวม 80 บาท/);
      assert.equal(context.source, "ocr");
      return { transaction: base };
    },
  });
  assert.equal((await post(request([event]))).status, 200);
  assert.equal((await run.handler()(request([{ ...event, deliveryContext: { isRedelivery: true } }]))).status, 200);
  assert.equal(run.replies.length, 0);
  assert.equal(run.pushes.length, 1);
  assert.equal(run.pushes[0].to, "Ualice");
  assert.equal(run.calls.filter((url) => url.includes("/push")).length, 2);
  assert.equal(run.script.tabs.PendingTransactions.rows.length, 2);
});

test("missing fields ask for clarification without adding a draft, and groups are ignored", async () => {
  const run = integration();
  const post = run.handler({ analyze: async () => ({ question: "กรุณาระบุจำนวนเงิน" }) });
  await post(request([inbox("ambiguous", "ซื้อกาแฟ")]));
  assert.match(run.replies[0].text, /จำนวนเงิน/);
  await post(request([{ ...inbox("group", "สรุปวันนี้"), source: { type: "group", userId: "Ualice" } }]));
  assert.equal(run.replies.length, 1);
  assert.equal(run.script.tabs.PendingTransactions.rows.length, 1);
});

test("unsupported and oversized file attachments are rejected before download", async () => {
  const run = integration();
  const post = run.handler();
  const fileEvent = (id, fileName, fileSize) => ({
    ...inbox(id, ""), message: { type: "file", id, fileName, fileSize },
  });
  await post(request([fileEvent("unsupported", "archive.zip", 10), fileEvent("oversized", "receipt.pdf", 4_000_001)]));
  assert.match(run.replies[0].text, /รองรับไฟล์ PDF/);
  assert.match(run.replies[1].text, /4 MB/);
  assert.ok(!run.calls.some((url) => url.startsWith("https://api-data.line.me/")));
});

test("a failed confirmation returns a retryable HTTP status and redelivery repairs the draft", async () => {
  const run = integration();
  await run.sheets.create("Ualice", "interrupted", base, "reply");
  run.script.tabs.PendingTransactions.failStatus = true;
  const confirmation = button("confirm-retry", "confirm:interrupted");
  const failed = await run.handler()(request([confirmation]));
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).code, "SHEETS_FAILED");
  assert.equal(run.replies.length, 0);
  const retry = await run.handler()(request([{ ...confirmation, deliveryContext: { isRedelivery: true } }]));
  assert.equal(retry.status, 200);
  assert.match(run.replies[0].text, /บันทึกเรียบร้อยแล้ว/);
  assert.equal(run.script.tabs.Transactions.rows.length, 2);
});

test("a slow webhook acknowledges early and lets the Next.js callback finish a retry", async () => {
  const run = integration();
  let task;
  let failFirst;
  const upstream = new Promise((_, reject) => { failFirst = reject; });
  let calls = 0;
  const post = run.handler({
    defer: (callback) => { task = callback; },
    analyze: () => ++calls === 1 ? upstream : { transaction: base },
  });
  const response = await post(request([inbox("delayed", "กินข้าว 80 บาท")]));
  assert.equal(response.status, 200);
  assert.equal(typeof task, "function");
  assert.equal(run.replies.length, 0);
  failFirst(new Error("temporary Gemini error"));
  await task();
  assert.equal(calls, 2);
  assert.equal(run.replies[0].type, "flex");
  assert.equal(run.script.tabs.PendingTransactions.rows.length, 2);
});

test("setup migrates the swapped Transactions columns with their data and creates the pending tab", () => {
  const { script } = integration();
  const sheet = script.tabs.Transactions;
  const timestamp = "2026-11-21T17:02:00.000Z";
  sheet.rows[0] = ["EventID", "Timestamp", "LINEUserID", "Date", "Type",
    "Category", "Description", "Amount", "Note"];
  sheet.rows[1] = ["existing", timestamp, "Ualice", base.date, base.type,
    base.category, base.description, base.amount, base.note];
  delete script.tabs.PendingTransactions;

  script.setup();
  script.setup();

  assert.deepEqual(sheet.rows[0].slice(0, 3), ["EventID", "LINEUserID", "Timestamp"]);
  assert.deepEqual(sheet.rows[1].slice(0, 3), ["existing", "Ualice", timestamp]);
  assert.equal(script.tabs.PendingTransactions.rows[0][0], "PendingID");
});

test("setup rejects other header changes without moving data", () => {
  const { script } = integration();
  const sheet = script.tabs.Transactions;
  sheet.rows[0][2] = "Wrong Timestamp";
  assert.throws(() => script.setup(), /Unexpected headers in Transactions/);
  assert.equal(sheet.rows[0][2], "Wrong Timestamp");
});

test("food questions analyze only the caller's confirmed month-to-date expenses and return Flex", async () => {
  const { sheets, handler, replies } = integration();
  const add = async (owner, id, updates, decision = "confirm") => {
    await sheets.create(owner, id, { ...base, ...updates }, "reply");
    if (decision) await sheets.resolve(owner, id, decision);
  };
  await add("Ualice", "first", { description: "กะเพราหมูกรอบ" });
  await add("Ualice", "second", { description: "ข้าวกระเพราหมูกรอบ" });
  await add("Ualice", "salad", { description: "สลัดผัก", date: "2026-11-19" });
  await add("Ualice", "other", { description: "ค่าเดินทาง", category: "เดินทาง" });
  await add("Ualice", "income", { description: "ขายอาหาร", type: "income" });
  await add("Ualice", "prior-month", { description: "กาแฟ", date: "2026-10-31" });
  await add("Ualice", "future", { description: "ข้าวโอ๊ต", date: "2026-11-30" });
  await add("Ualice", "pending", { description: "ข้าวผัด" }, null);
  await add("Ualice", "cancel", { description: "ข้าวมันไก่" }, "cancel");
  await add("Ubob", "private", { description: "รายการของบัญชีอื่น" });

  const post = handler({
    analyze: async () => assert.fail("insight must not become a draft"),
    classifyFood: async (entries) => {
      assert.deepEqual(entries.map(({ description }) => description),
        ["ค่าเดินทาง", "ข้าวกระเพราหมูกรอบ", "กะเพราหมูกรอบ", "สลัดผัก"]);
      return [
        { index: 1, menu: "ข้าวกระเพราหมูกรอบ", clue: "none" },
        { index: 2, menu: "กะเพราหมูกรอบ", clue: "none" },
        { index: 3, menu: "สลัดผัก", clue: "vegetable" },
        { index: 3, menu: "สลัดผัก", clue: "fruit" },
        { index: 99, menu: "ข้าวมันไก่", clue: "none" },
      ];
    },
  });
  assert.equal((await post(request([
    inbox("food-question", "เดือนนี้ฉันกินอะไรเยอะบ้าง"),
    inbox("health-question", "ฉันกินอาหารรักสุชภาพบ้างไหม"),
  ]))).status, 200);
  assert.match(replies[0].altText, /3 รายการอาหาร/);
  assert.match(JSON.stringify(replies[0]), /กระเพราหมูกรอบ.*2 ครั้ง/);
  assert.match(JSON.stringify(replies[1]), /ผัก.*1 รายการ/);
  assert.match(JSON.stringify(replies[1]), /อิงจากชื่อเมนู/);
});

test("confirmation Flex displays a food quip once with a shortcut to insights", async () => {
  const { sheets, handler, replies } = integration();
  await sheets.create("Ualice", "dinner", { ...base, description: "กะเพราหมูกรอบ" }, "reply");
  const post = handler();
  await post(request([button("first-confirm", "confirm:dinner"), button("second-confirm", "confirm:dinner")]));
  assert.match(JSON.stringify(replies[0]), /กรุบกรอบจนใจฟู/);
  assert.match(replies[0].quickReply.items[0].action.text, /กินอะไรบ่อย/);
  assert.equal(replies[1].type, "text");
  assert.match(replies[1].text, /บันทึกเรียบร้อยแล้ว/);
});

test("food questions with no entries skip Gemini and display an empty Flex", async () => {
  const { handler, replies } = integration();
  const post = handler({ classifyFood: async () => assert.fail("no entries") });
  await post(request([inbox("empty-food", "ฉันกินอะไรเยอะ")]));
  assert.match(replies[0].altText, /0 รายการอาหาร/);
});

test("health insights respond from recorded ingredients without waiting on Gemini", async () => {
  const run = integration();
  await run.sheets.create("Ualice", "healthy-menu", { ...base, description: "สลัดผักกับกล้วยหอม" }, "reply");
  await run.sheets.resolve("Ualice", "healthy-menu", "confirm");
  const post = run.handler({ classifyFood: () => assert.fail("health question must not call Gemini") });
  await post(request([inbox("health-fast", "เดือนนี้ฉันกินอาหารสุขภาพบ้างไหม")]));
  const contents = JSON.stringify(run.replies[0]);
  assert.match(contents, /ผัก.*1 รายการ/);
  assert.match(contents, /ผลไม้.*1 รายการ/);
});

test("food ranking still responds with known dishes when Gemini fails", async () => {
  const run = integration();
  await run.sheets.create("Ualice", "local-menu", { ...base, description: "ข้าวกะเพราหมูกรอบ" }, "reply");
  await run.sheets.resolve("Ualice", "local-menu", "confirm");
  await run.sheets.create("Ualice", "local-other", { ...base, description: "ค่ารถ", category: "เดินทาง" }, "reply");
  await run.sheets.resolve("Ualice", "local-other", "confirm");
  let calls = 0;
  const post = run.handler({ classifyFood: async () => {
    calls++;
    throw new AppError("timeout", 502, "GEMINI_FAILED");
  } });
  await post(request([inbox("fallback-food", "ฉันกินอะไรเยอะ")]));
  assert.equal(calls, 1);
  assert.match(JSON.stringify(run.replies[0]), /ข้าวกะเพราหมูกรอบ.*1 ครั้ง/);
});

test("food history failure replies in chat instead of dropping the question", async () => {
  const run = integration();
  const post = run.handler({ sheets: {
    foodHistory: async () => { throw new AppError("timeout", 502, "SHEETS_FAILED"); },
  } });
  assert.equal((await post(request([inbox("error-food", "ฉันกินอาหารสุขภาพบ้างไหม")]))).status, 200);
  assert.match(run.replies[0].text, /เปิดประวัติอาหารไม่สำเร็จ/);
});

test("first transaction skips reading a draft and still writes it before replying", async () => {
  const run = integration();
  const post = run.handler({
    analyze: async () => ({ transaction: base }),
    sheets: { ...run.sheets, find: () => assert.fail("first delivery does not need a draft lookup") },
  });
  await post(request([inbox("first-write", "กินข้าว 80 บาท")]));
  assert.equal(run.script.tabs.PendingTransactions.rows.length, 2);
  assert.equal(run.replies[0].type, "flex");
});
