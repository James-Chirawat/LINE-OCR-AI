import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { AppError, errorResponse } from "./errors.js";
import { MAX_IMAGE_BYTES, readLimitedBody } from "./image.js";
import { createStatelessTokenProvider } from "./line-token.js";
import { extractPdfText, validatePdfAttachment } from "./pdf.js";
import { verifySignature, createLineClient } from "./line.js";
import { createFoodClassifier, createGeminiAnalyzer } from "./gemini.js";
import { createSheetsClient } from "./sheets.js";
import { confirmationFlex, foodFlex, savedFlex, summaryFlex } from "./flex.js";
import { classifyRecordedFood, foodQuestion, summarizeFood } from "./food.js";
import { bangkokDate, eventIdSchema, summaryRange, userIdSchema } from "./transactions.js";

const HELP = [
  "LINE AI Expense Tracker",
  "พิมพ์ เช่น กินข้าว 80 บาท, ซื้อกาแฟเมื่อวาน 65 บาท หรือได้เงินเดือน 35000",
  "หรือส่งใบเสร็จเป็นภาพ JPEG, PNG, WebP หรือ PDF ได้สูงสุด 4 MB และ PDF ไม่เกิน 3 หน้า",
  "ตรวจสอบรายละเอียดแล้วกดยืนยันบันทึกหรือยกเลิก",
  "คำสั่ง: ช่วยเหลือ, สรุปวันนี้, สรุปเดือนนี้, รายรับเดือนนี้, รายจ่ายเดือนนี้, ยอดคงเหลือ",
  "ลองถามว่า เดือนนี้ฉันกินอะไรเยอะ หรือ ฉันกินอาหารสุขภาพบ้างไหม",
].join("\n\n");

const summaries = new Map([
  ["สรุปวันนี้", { period: "today", view: "balance" }],
  ["สรุปเดือนนี้", { period: "month", view: "balance" }],
  ["รายรับเดือนนี้", { period: "month", view: "income" }],
  ["รายจ่ายเดือนนี้", { period: "month", view: "expense" }],
  ["ยอดคงเหลือ", { period: "all", view: "balance" }],
]);

const decisionMessage = {
  confirmed: "บันทึกรายการเรียบร้อยครับ ✅",
  "already-confirmed": "รายการนี้บันทึกเรียบร้อยแล้วครับ",
  cancelled: "ยกเลิกรายการเรียบร้อยครับ",
  "already-cancelled": "รายการนี้ถูกยกเลิกแล้วครับ",
  "not-found": "ไม่พบรายการที่คุณสามารถจัดการได้ครับ",
};

function pushKey(eventId) {
  const bytes = createHash("sha256").update("line-expense:" + eventId).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return hex.replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
}

async function readAttachment(message, { line, userId, signal, ocr, pdfOcr, remaining }) {
  const isFile = message.type === "file";
  const name = typeof message.fileName === "string" ? message.fileName.trim() : "";
  const isPdf = isFile && /\.pdf$/i.test(name);
  if (isPdf) {
    validatePdfAttachment(name, message.fileSize);
  } else if (isFile) {
    if (!/\.(jpe?g|png|webp)$/i.test(name)) {
      throw new AppError("รองรับไฟล์ PDF, JPEG, PNG และ WebP เท่านั้น", 422);
    }
    if (!Number.isFinite(message.fileSize) || message.fileSize <= 0 || message.fileSize > MAX_IMAGE_BYTES) {
      throw new AppError("กรุณาส่งไฟล์ขนาดไม่เกิน 4 MB", 413);
    }
  }
  const downloadSignal = signal(8_000);
  const loading = line.showLoading(userId, signal(1_500)).catch(() => {});
  const download = isPdf
    ? line.downloadPdf(message.id, downloadSignal)
    : line.download(message.id, downloadSignal, isFile);
  const [file] = await Promise.all([download, loading]);

  const timeoutMs = Math.min(isPdf ? 55_000 : 42_000, remaining() - 7_000);
  if (timeoutMs < 2_500) throw new AppError("งาน OCR รอประมวลผลนานเกินไป", 503, "WEBHOOK_TIMEOUT");
  const result = isPdf ? await pdfOcr(file, ocr, { timeoutMs }) : await ocr(file, { timeoutMs });
  const text = result.text?.trim() || "";
  return isPdf && result.confidence === 0 ? "" : text;
}

export function createWebhookHandler({
  ocr,
  pdfOcr = extractPdfText,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  analyze = createGeminiAnalyzer({ env }),
  classifyFood = createFoodClassifier({ env }),
  sheets = createSheetsClient({ env, fetchImpl, now }),
  defer,
} = {}) {
  const line = createLineClient(createStatelessTokenProvider({ env, fetchImpl, now }), fetchImpl);

  async function processEvent(event, received, remaining, signal, retry) {
    const userId = event.source?.userId;
    const id = event.webhookEventId;
    if (event.mode === "standby" || event.source?.type !== "user" ||
        !userIdSchema.safeParse(userId).success || !eventIdSchema.safeParse(id).success) return;
    if (!["message", "postback", "follow"].includes(event.type)) return;

    const eventTime = Number.isSafeInteger(event.timestamp) ? event.timestamp : received;
    if (received - eventTime >= 20 * 60_000) return;
    const mode = (reserve = 0) => {
      const at = now() + reserve;
      return event.replyToken && at < received + 48_000 && at < eventTime + 20 * 60_000
        ? "reply" : "push";
    };
    const send = async (message, delivery = mode()) => {
      if (delivery === "push") {
        await line.push(userId, message, pushKey(id), signal(5_000));
      } else if (mode() === "reply") {
        // A rejected/consumed reply token is never replayed here or converted to a duplicate push.
        try {
          await line.reply(event.replyToken, message, signal(5_000));
        } catch {
          throw new AppError("ส่งข้อความตอบกลับ LINE ไม่สำเร็จ", 502, "LINE_REPLY");
        }
      }
    };
    if (event.type === "follow") return send(HELP);
    if (event.type === "postback") {
      const action = /^(confirm|cancel):([A-Za-z0-9_-]{1,100})$/.exec(event.postback?.data || "");
      if (!action) return send("ปุ่มนี้ใช้งานไม่ได้ครับ พิมพ์ ช่วยเหลือ เพื่อดูวิธีใช้งาน");
      let result;
      try {
        result = await sheets.resolve(userId, action[2], action[1], signal(8_000), {
          includeTransaction: action[1] === "confirm",
        });
      } catch (error) {
        if (!retry && !event.deliveryContext?.isRedelivery) throw error;
        console.warn("Could not verify postback outcome:", error instanceof AppError ? error.code : "INTERNAL_ERROR");
        return send("ยังตรวจสอบผลของรายการนี้ไม่สำเร็จครับ ลองกดปุ่มบนการ์ดอีกครั้งได้เลย");
      }
      return send(typeof result === "string" ? decisionMessage[result] : savedFlex(result.transaction));
    }

    const message = event.message;
    const input = message?.type === "text" ? message.text?.trim() : "";
    const today = bangkokDate(eventTime);
    if (input === "ช่วยเหลือ") return send(HELP);
    const summary = summaries.get(input);
    if (summary) {
      const range = summaryRange(summary.period, today);
      const totals = await sheets.summarize(userId, range, signal(12_000));
      return send(summaryFlex(input, summary.view, totals, range));
    }
    const foodView = input && foodQuestion(input);
    if (foodView) {
      const range = { from: summaryRange("month", today).from, through: today };
      let history;
      try {
        history = await sheets.foodHistory(userId, range, signal(8_000));
      } catch (error) {
        const message = error?.code === "SHEETS_FEATURE_UNAVAILABLE"
          ? error.message
          : "ตอนนี้เปิดประวัติอาหารไม่สำเร็จครับ ลองถามอีกครั้งได้เลย";
        if (error?.code !== "SHEETS_FEATURE_UNAVAILABLE") {
          console.warn("Food history unavailable:", error instanceof AppError ? error.code : "INTERNAL_ERROR");
        }
        return send(message);
      }
      const { entries, truncated } = history;
      const localMatches = classifyRecordedFood(entries);
      let matches = localMatches;
      let localOnly = false;
      if (foodView === "frequency" && localMatches.length < entries.length) {
        try {
          matches = await classifyFood(entries, signal(5_000));
        } catch {
          localOnly = true;
        }
      }
      return send(foodFlex(foodView, summarizeFood(entries, matches), range, truncated, localOnly));
    }
    const attachment = ["image", "file"].includes(message?.type);
    if (!input && !attachment) return send(HELP);

    // A first delivery can go straight to OCR/Gemini. The atomic create still
    // returns the original draft if two deliveries overlap.
    if (retry || event.deliveryContext?.isRedelivery) {
      const existing = await sheets.find(userId, id, signal(8_000));
      if (existing && existing.status !== "Pending") return;
      if (existing) return send(confirmationFlex(existing), existing.delivery);
    }

    let extraction;
    try {
      const text = attachment
        ? await readAttachment(message, { line, userId, signal, ocr, pdfOcr, remaining })
        : input;
      if (!text) return send("ไม่พบข้อความบนใบเสร็จ กรุณาส่งภาพที่ชัดขึ้นหรือพิมพ์ข้อมูลรายการครับ");
      extraction = await analyze(text, {
        source: attachment ? "ocr" : "chat",
        today,
        signal: signal(16_000),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "OCR_BUSY") {
        throw new AppError(error.message, 503, error.code);
      }
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      return send(error.message);
    }
    if (extraction.question) return send(extraction.question);

    // Leave room for Apps Script and LINE before committing to a reply token.
    // Persist the delivery method so a redelivery cannot turn a prior reply into a push.
    const draft = await sheets.create(userId, id, extraction.transaction, mode(17_000), signal(12_000));
    if (draft.status === "Pending") await send(confirmationFlex(draft), draft.delivery);
  }

  return async function POST(request) {
    const received = now();
    const remaining = () => received + 105_000 - now();
    const signal = (limit) => {
      const timeout = Math.min(limit, remaining());
      if (timeout <= 0) throw new AppError("ประมวลผล Webhook เกินเวลาที่กำหนด", 503, "WEBHOOK_TIMEOUT");
      return AbortSignal.timeout(timeout);
    };

    try {
      if (!env.LINE_CHANNEL_SECRET) throw new AppError("ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET", 503);
      const raw = await readLimitedBody(request.body, 1_000_000);
      if (!verifySignature(raw, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET)) {
        throw new AppError("Invalid signature", 401);
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new AppError("Invalid JSON");
      }
      if (!Array.isArray(payload?.events) || payload.events.length > 100) {
        throw new AppError("Invalid events");
      }

      async function processBatch(events, retry = false) {
        const failures = [];
        for (const event of events) {
          if (!event || typeof event !== "object") continue;
          try {
            if (remaining() < 1_000) {
              throw new AppError("ประมวลผล Webhook เกินเวลาที่กำหนด", 503, "WEBHOOK_TIMEOUT");
            }
            await processEvent(event, received, remaining, signal, retry);
          } catch (error) {
            failures.push({ event, error });
          }
        }
        return failures;
      }

      const batch = processBatch(payload.events);
      const waiting = Symbol("acknowledge webhook");
      const acknowledgementTimer = new AbortController();
      const failures = defer
        ? await Promise.race([batch, setTimeout(1_200, waiting, { signal: acknowledgementTimer.signal })])
          .finally(() => acknowledgementTimer.abort())
        : await batch;
      if (failures === waiting) {
        // Next.js keeps the invocation alive once the HTTP response has been sent.
        defer(async () => {
          const failed = await batch;
          if (!failed.length) return;
          const canRetry = remaining() > 7_000;
          const retryable = ({ error }) => canRetry && error?.code !== "LINE_REPLY";
          const retryFailures = await processBatch(failed.filter(retryable).map(({ event }) => event), true);
          for (const { error } of [...failed.filter((entry) => !retryable(entry)), ...retryFailures]) {
            console.error("Deferred webhook processing failed:",
              error instanceof AppError ? error.code : "INTERNAL_ERROR");
          }
        });
      } else if (failures.length) {
        throw failures[0].error;
      }
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof AppError && error.status >= 500) {
        console.error("Webhook processing failed:", error.code);
      }
      return errorResponse(error);
    }
  };
}
