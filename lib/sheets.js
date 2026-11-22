import { createHmac } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";
import { draftSchema, summarySchema, transactionSchema } from "./transactions.js";

const outcomeSchema = z.enum(["confirmed", "already-confirmed", "cancelled", "already-cancelled", "not-found"]);
const detailedOutcomeSchema = z.union([
  outcomeSchema,
  z.object({ outcome: z.literal("confirmed"), transaction: transactionSchema }),
]);
const foodHistorySchema = z.object({
  entries: z.array(z.object({ category: z.string().max(60), description: z.string().max(180) })).max(60),
  truncated: z.boolean(),
});
const webAppPattern = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export function createSheetsClient({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  async function call(action, data, schema, signal) {
    const url = env.SHEETS_WEB_APP_URL;
    const secret = env.SHEETS_SHARED_SECRET;
    if (!webAppPattern.test(url || "") || !secret || secret.length < 32) {
      throw new AppError("ยังไม่ได้ตั้งค่า Google Sheets Web App", 503, "SHEETS_CONFIG");
    }

    const payload = JSON.stringify({ action, ...data, issuedAt: now() });
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    try {
      let response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, signature }),
        redirect: "manual",
        cache: "no-store",
        signal,
      });
      // Apps Script ContentService redirects clients to a one-time result URL.
      if ([302, 303].includes(response.status)) {
        const target = new URL(response.headers.get("location"), url);
        await response.body?.cancel();
        if (target.origin !== "https://script.googleusercontent.com" || target.username || target.password) {
          throw new Error("Unexpected Apps Script redirect");
        }
        response = await fetchImpl(target.href, { redirect: "error", cache: "no-store", signal });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Invalid Apps Script response");
      }
      const body = await response.json();
      if (action === "food-history" && body?.code === "bad-request") {
        throw new AppError("ฟีเจอร์สรุปอาหารต้องอัปเดต Apps Script เป็นเวอร์ชันล่าสุดครับ", 422, "SHEETS_FEATURE_UNAVAILABLE");
      }
      if (body?.ok !== true) throw new Error("Apps Script rejected the request");
      return schema.parse(body.data);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("ติดต่อ Google Sheets ไม่สำเร็จ", 502, "SHEETS_FAILED");
    }
  }

  return {
    find(userId, id, signal) {
      return call("find", { userId, id }, draftSchema.nullable(), signal);
    },
    create(userId, id, transaction, delivery, signal) {
      const validated = transactionSchema.parse(transaction);
      return call("create", { userId, id, transaction: validated, delivery }, draftSchema, signal);
    },
    resolve(userId, id, decision, signal, { includeTransaction = false } = {}) {
      return call(decision, { userId, id, includeTransaction },
        includeTransaction ? detailedOutcomeSchema : outcomeSchema, signal);
    },
    foodHistory(userId, range, signal) {
      return call("food-history", { userId, ...range }, foodHistorySchema, signal);
    },
    summarize(userId, range, signal) {
      return call("summary", { userId, ...range }, summarySchema, signal);
    },
  };
}
