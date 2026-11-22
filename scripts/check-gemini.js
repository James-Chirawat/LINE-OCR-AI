import { createGeminiAnalyzer } from "../lib/gemini.js";

try {
  const analyze = createGeminiAnalyzer();
  const result = await analyze("วันนี้กินข้าว 80 บาท", {
    source: "chat",
    today: "2026-11-22",
    signal: AbortSignal.timeout(16_000),
  });
  console.log(JSON.stringify(result.transaction || result, null, 2));
  if (!result.transaction) process.exitCode = 1;
} catch (error) {
  console.error(error.code || "GEMINI_CHECK_FAILED");
  process.exitCode = 1;
}
