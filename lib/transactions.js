import { z } from "zod";

export const TIME_ZONE = "Asia/Bangkok";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const MAX_AMOUNT = 999_999_999.99;

export const eventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const userIdSchema = z.string().regex(/^U[A-Za-z0-9_-]{1,100}$/);
export const dateSchema = z.iso.date().refine((date) => date >= "1900-01-01");
const entryType = z.enum(["income", "expense"]);
const field = (max) => z.string().trim().min(1).max(max);

export const transactionSchema = z.strictObject({
  date: dateSchema,
  type: entryType,
  category: field(60),
  description: field(180),
  amount: z.number().positive().max(MAX_AMOUNT)
    .refine((amount) => amount === Number(amount.toFixed(2))),
  currency: z.literal("THB"),
  note: z.string().trim().max(200),
});

export const draftSchema = z.object({
  id: eventIdSchema,
  status: z.enum(["Pending", "Confirmed", "Cancelled"]),
  delivery: z.enum(["reply", "push"]),
  transaction: transactionSchema,
});

export const summarySchema = z.object({
  incomeSatang: z.number().int().nonnegative(),
  expenseSatang: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

export function bangkokDate(timestamp) {
  return dateFormatter.format(timestamp);
}

export function summaryRange(period, today) {
  if (period === "today") return { from: today, through: today };
  if (period === "month") {
    const [year, month] = today.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: today.slice(0, 7) + "-01", through: today.slice(0, 7) + "-" + lastDay };
  }
  return {};
}

export function formatDate(date) {
  return date.split("-").reverse().join("/");
}
