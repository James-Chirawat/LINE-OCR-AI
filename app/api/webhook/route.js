import { after } from "next/server";
import { extractText } from "../../../lib/ocr/engine.js";
import { createWebhookHandler } from "../../../lib/webhook.js";
export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = createWebhookHandler({ ocr: extractText, defer: after });
