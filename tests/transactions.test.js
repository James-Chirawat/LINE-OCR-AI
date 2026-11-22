import test from "node:test";
import assert from "node:assert/strict";
import { bangkokDate, summaryRange, transactionSchema } from "../lib/transactions.js";
import { createGeminiAnalyzer } from "../lib/gemini.js";

const entry = {
  date: "2026-11-22", type: "expense", category: "อาหาร", description: "ค่าอาหาร",
  amount: 80, currency: "THB", note: "",
};

test("date uses Bangkok midnight and month ranges include leap days and December", () => {
  assert.equal(bangkokDate(Date.parse("2026-11-21T17:00:00Z")), "2026-11-22");
  assert.equal(bangkokDate(Date.parse("2026-11-21T16:59:59Z")), "2026-11-21");
  assert.deepEqual(summaryRange("today", "2026-11-22"), { from: "2026-11-22", through: "2026-11-22" });
  assert.deepEqual(summaryRange("month", "2024-02-28"), { from: "2024-02-01", through: "2024-02-29" });
  assert.deepEqual(summaryRange("month", "2026-12-31"), { from: "2026-12-01", through: "2026-12-31" });
});

test("Zod rejects impossible dates, invalid amounts and unsupported currency", () => {
  assert.ok(transactionSchema.safeParse({ ...entry, amount: 65.01 }).success);
  for (const invalid of [{ date: "2026-02-29" }, { amount: -1 }, { amount: 1.005 }, { currency: "USD" }]) {
    assert.equal(transactionSchema.safeParse({ ...entry, ...invalid }).success, false);
  }
});

test("Gemini receives text with structured schema and Bangkok context", async () => {
  const analyze = createGeminiAnalyzer({
    env: { GEMINI_API_KEY: "fixture", GEMINI_MODEL: "fixture-model" },
    client: { models: { generateContent: async ({ model, contents, config }) => {
      assert.equal(model, "fixture-model");
      assert.deepEqual(JSON.parse(contents), {
        source: "ocr", referenceDate: "2026-11-22", timeZone: "Asia/Bangkok",
        text: "ค่าอาหารวันที่ 22/11/2026 80.00 บาท",
      });
      assert.equal(config.responseMimeType, "application/json");
      assert.ok(config.responseJsonSchema.required.includes("amount"));
      assert.match(config.systemInstruction, /explicitly printed final paid or net total/);
      return { text: JSON.stringify({ ...entry, dateSource: "22/11/2026", intent: "transaction" }) };
    } } },
  });
  assert.deepEqual(await analyze("ค่าอาหารวันที่ 22/11/2026 80.00 บาท", { source: "ocr", today: entry.date }), { transaction: entry });
});

test("missing fields, multiple receipts, other currencies and broken JSON are handled", async () => {
  let text;
  const analyze = createGeminiAnalyzer({
    env: { GEMINI_API_KEY: "fixture", GEMINI_MODEL: "fixture-model" },
    client: { models: { generateContent: async () => ({ text }) } },
  });
  const context = { source: "ocr", today: entry.date };
  for (const [override, expected] of [
    [{ amount: null, date: null }, /วันที่, จำนวนเงิน/],
    [{ intent: "multiple" }, /หลายรายการ/],
    [{ currency: "USD" }, /เงินบาท/],
  ]) {
    text = JSON.stringify({ ...entry, dateSource: "22/11/2026", intent: "transaction", ...override });
    assert.match((await analyze("ข้อมูลใบเสร็จ", context)).question, expected);
  }
  text = "broken";
  await assert.rejects(analyze("ข้อมูลใบเสร็จ", context), { code: "GEMINI_FAILED" });
});

test("rejects generated amounts or document dates without evidence and allows omitted chat dates", async () => {
  let output = { ...entry, intent: "transaction", dateSource: null };
  const analyze = createGeminiAnalyzer({
    env: { GEMINI_API_KEY: "fixture", GEMINI_MODEL: "fixture-model" },
    client: { models: { generateContent: async () => ({ text: JSON.stringify(output) }) } },
  });
  const context = { today: entry.date, source: "chat" };
  assert.deepEqual(await analyze("ค่าอาหาร ๘๐ บาท", context), { transaction: entry });
  assert.match((await analyze("ค่าอาหาร 180 บาท", context)).question, /จำนวนเงิน/);
  assert.match((await analyze("ค่าอาหาร 80 บาท", { ...context, source: "ocr" })).question, /วันที่/);
  output = { ...output, dateSource: "22/11/2026" };
  assert.match((await analyze("ค่าอาหาร 80 บาท", context)).question, /วันที่/);
});
