import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
import { MAX_IMAGE_BYTES, MIME_TYPES, readLimitedBody } from "./image.js";
export function verifySignature(raw, signature, secret) {
  if (!signature || !secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature))
    return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const received = Buffer.from(signature, "base64");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
export function textMessages(text) {
  const messages = [];
  let rest = text;
  const suffix = "\n\n[ข้อความยาวเกินขีดจำกัด กรุณาแบ่งส่งภาพเป็นส่วนย่อย]";
  for (let i = 0; i < 5 && rest.length; i++) {
    const limit = i === 4 && rest.length > 5000 ? 5000 - suffix.length : 5000;
    let end = Math.min(limit, rest.length);
    // LINE counts UTF-16 units. Never split a surrogate pair between messages.
    if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    let chunk = rest.slice(0, end);
    rest = rest.slice(end);
    if (i === 4 && rest) chunk += suffix;
    messages.push({ type: "text", text: chunk });
  }
  return messages;
}
function messageList(message) {
  return typeof message === "string" ? textMessages(message) : [message];
}

export function createLineClient(token, fetchImpl = fetch) {
  async function authorizedFetch(url, options) {
    const value = typeof token === "function" ? await token() : token;
    const response = await fetchImpl(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${value}` },
    });
    if (response.status === 401 && typeof token === "function")
      token.invalidate?.(value);
    return response;
  }
  return {
    async showLoading(userId, signal) {
      const response = await authorizedFetch(
        "https://api.line.me/v2/bot/chat/loading/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: userId, loadingSeconds: 60 }),
          signal,
        },
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new AppError(
          "เปิด loading animation ไม่สำเร็จ",
          502,
          "LINE_LOADING",
        );
    },
    async download(messageId, signal, allowBinary = false) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId || ""))
        throw new AppError("Invalid message ID");
      const response = await authorizedFetch(
        `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
        { signal },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("ดาวน์โหลดภาพจาก LINE ไม่สำเร็จ", 502, "LINE_DOWNLOAD");
      }
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!MIME_TYPES.has(type) && !(allowBinary && type === "application/octet-stream")) {
        await response.body?.cancel();
        throw new AppError("รองรับภาพ JPEG, PNG และ WebP เท่านั้น");
      }
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new AppError("กรุณาส่งภาพขนาดไม่เกิน 4 MB", 413);
      }
      return readLimitedBody(response.body, MAX_IMAGE_BYTES);
    },
    async downloadPdf(messageId, signal) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId || "")) {
        throw new AppError("Invalid message ID");
      }
      const response = await authorizedFetch(
        "https://api-data.line.me/v2/bot/message/" + encodeURIComponent(messageId) + "/content",
        { signal },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("ดาวน์โหลด PDF จาก LINE ไม่สำเร็จ", 502, "LINE_DOWNLOAD");
      }
      const size = Number(response.headers.get("content-length") || 0);
      if (size > 4_000_000) {
        await response.body?.cancel();
        throw new AppError("กรุณาส่ง PDF ขนาดไม่เกิน 4 MB", 413, "PDF_SIZE");
      }
      const type = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
      if (!["application/pdf", "application/octet-stream", "application/x-pdf"].includes(type)) {
        await response.body?.cancel();
        throw new AppError("ไฟล์ที่แนบมาไม่ใช่ PDF", 422, "PDF_TYPE");
      }
      return readLimitedBody(response.body, 4_000_000);
    },
    async reply(replyToken, text, signal) {
      const messages = messageList(text);
      const response = await authorizedFetch(
        "https://api.line.me/v2/bot/message/reply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ replyToken, messages }),
          signal,
        },
      );
      if (response.status === 400) {
        const error = await response.json().catch(() => null);
        if (error?.message === "Invalid reply token") return false;
      } else {
        await response.body?.cancel();
      }
      if (!response.ok)
        throw new AppError("ส่งข้อความตอบกลับ LINE ไม่สำเร็จ", 502, "LINE_REPLY");
      return true;
    },
    async push(userId, message, retryKey, signal) {
      const response = await authorizedFetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Line-Retry-Key": retryKey },
        body: JSON.stringify({ to: userId, messages: messageList(message) }),
        signal,
      });
      const accepted = response.ok ||
        (response.status === 409 && response.headers.has("x-line-accepted-request-id"));
      await response.body?.cancel();
      if (!accepted) throw new AppError("ส่ง Push Message ไม่สำเร็จ", 502, "LINE_PUSH");
    },
  };
}
