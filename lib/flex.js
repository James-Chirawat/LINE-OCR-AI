import { formatDate } from "./transactions.js";

const number = new Intl.NumberFormat("th-TH");
const ink = "#172F2B";
const muted = "#4D625D";
const lineColor = "#DDE8E4";
const surface = "#F5F8F7";
const green = "#17624E";
const red = "#9B394E";
const themes = {
  income: { background: "#123D33", accent: "#B5E9CF" },
  expense: { background: "#49262F", accent: "#F6C6D0" },
  balance: { background: "#183546", accent: "#C5E7F2" },
  food: { background: "#412F26", accent: "#F8D9B5" },
};

function money(satang) {
  const absolute = Math.abs(satang);
  const fraction = absolute % 100;
  const baht = number.format((absolute - fraction) / 100);
  return (satang < 0 ? "−" : "") + baht +
    (fraction ? "." + String(fraction).padStart(2, "0") : "") + " บาท";
}

function text(value, properties = {}) {
  return { type: "text", text: value, wrap: true, color: ink, ...properties };
}

function box(layout, contents, properties = {}) {
  return { type: "box", layout, contents, ...properties };
}

function separator() {
  return { type: "separator", color: lineColor };
}

function panel(contents) {
  return box("vertical", contents, {
    spacing: "sm",
    paddingAll: "12px",
    borderWidth: "1px",
    borderColor: lineColor,
    cornerRadius: "12px",
    backgroundColor: surface,
  });
}

function detail(label, value) {
  return box("horizontal", [
    text(label, { size: "sm", color: muted, flex: 2 }),
    text(value, { size: "sm", align: "end", flex: 5 }),
  ], { spacing: "md" });
}

function card({ title, metric, context, theme, body, footer }) {
  const { background, accent } = themes[theme];
  return {
    type: "flex",
    altText: title + " · " + metric,
    contents: {
      type: "bubble",
      size: "mega",
      header: box("vertical", [
        text(title, { size: "sm", weight: "bold", color: accent }),
        text(metric, { size: metric.length > 18 ? "xl" : "xxl", weight: "bold", color: "#FFFFFF" }),
        ...(context ? [text(context, { size: "xs", color: accent })] : []),
      ], { spacing: "sm", paddingAll: "20px", backgroundColor: background }),
      body: box("vertical", body, {
        spacing: "md", paddingAll: "18px", backgroundColor: "#FFFFFF",
      }),
      ...(footer && {
        footer: box("vertical", footer, {
          spacing: "xs", paddingTop: "10px", paddingBottom: "10px",
          paddingStart: "18px", paddingEnd: "18px", backgroundColor: "#FFFFFF",
        }),
        styles: { footer: { separator: true, separatorColor: lineColor } },
      }),
    },
  };
}

function transactionDetails({ date, category, description, note }) {
  const details = [detail("วันที่", formatDate(date)), detail("หมวดหมู่", category)];
  if (note) {
    details.push(separator(), text("หมายเหตุ", { size: "xs", color: muted }),
      text(note, { size: "sm" }));
  }
  return [text(description, { size: "lg", weight: "bold" }), panel(details)];
}

export function confirmationFlex({ id, transaction }) {
  const income = transaction.type === "income";
  return card({
    title: "ตรวจสอบรายการ",
    metric: money(Math.round(transaction.amount * 100)),
    context: income ? "รายรับ · รอยืนยัน" : "รายจ่าย · รอยืนยัน",
    theme: transaction.type,
    body: transactionDetails(transaction),
    footer: [
      {
        type: "button", style: "primary", color: green, height: "md",
        action: {
          type: "postback", label: "ยืนยันบันทึก", data: "confirm:" + id,
          displayText: "✅ ขอยืนยันบันทึกรายการ",
        },
      },
      {
        type: "button", style: "link", color: muted, height: "sm",
        action: {
          type: "postback", label: "ยกเลิก", data: "cancel:" + id,
          displayText: "ขอยกเลิกรายการ",
        },
      },
    ],
  });
}

function periodLabel({ from, through }) {
  if (!from) return "ทุกรายการที่บันทึก";
  if (from === through) return formatDate(from);
  return formatDate(from) + " ถึง " + formatDate(through);
}

function balanceTile(label, value, color) {
  return panel([
    text(label, { size: "xs", color: muted }),
    text(money(value), { size: "md", weight: "bold", color }),
  ]);
}

export function summaryFlex(title, view, summary, range) {
  const { incomeSatang, expenseSatang, count } = summary;
  const balance = incomeSatang - expenseSatang;
  const total = view === "income" ? incomeSatang : view === "expense" ? expenseSatang : balance;
  const theme = view === "balance" ? (balance < 0 ? "expense" : "balance") : view;
  const body = view === "balance" ? [
    box("horizontal", [
      balanceTile("รายรับ", incomeSatang, green),
      balanceTile("รายจ่าย", expenseSatang, red),
    ], { spacing: "sm" }),
    detail("บันทึกแล้ว", number.format(count) + " รายการ"),
  ] : [
    detail("ช่วงวันที่", periodLabel(range)),
  ];
  return card({
    title,
    metric: money(total),
    context: view === "balance" ? "ยอดสุทธิ · " + periodLabel(range) : undefined,
    theme,
    body,
  });
}

const foodPrompt = "เดือนนี้ฉันกินอะไรบ่อย";
const healthPrompt = "เดือนนี้ฉันกินอาหารสุขภาพบ้างไหม";

function quickQuestion(message, label, question) {
  return {
    ...message,
    quickReply: {
      items: [{ type: "action", action: { type: "message", label, text: question } }],
    },
  };
}

function foodQuip({ type, category, description }) {
  if (type === "income") return "เงินเข้าแล้ว ขอให้มีเรื่องดี ๆ เข้ามาอีกนะ ✨";
  if (/หมูกรอบ|ไก่ทอด|ของทอด/i.test(description)) {
    return "แหม ๆ จานโปรดแสนกรอบมาแล้วน้า กรุบกรอบจนใจฟูเลย 😋";
  }
  if (/กะเพรา|กระเพรา|ส้มตำ|ยำ|ต้มยำ|หมาล่า/i.test(description)) {
    return "แหม ๆ ของแซ่บมาอีกแล้ว จานนี้รสชาติน่าจะจัดเต็ม 🌶️";
  }
  if (/กาแฟ|ชาเย็น|ชานม|coffee/i.test(description)) return "แก้วเล็ก ๆ เติมความสดใสให้วันนี้ ☕";
  if (/อาหาร|เครื่องดื่ม|food/i.test(category)) return "อิ่มอร่อยแล้ว ให้บอตช่วยจำมื้อนี้นะ 🍽️";
  return "เก็บไว้ให้แล้ว เรื่องเล็ก ๆ วันนี้รวมกันเป็นภาพใหญ่ของเดือน ✨";
}

export function savedFlex(transaction) {
  const isFood = transaction.type === "expense" &&
    /อาหาร|เครื่องดื่ม|หมูกรอบ|ไก่ทอด|กะเพรา|กระเพรา|ส้มตำ|กาแฟ|ชานม|food|coffee/i.test(
      transaction.category + " " + transaction.description,
    );
  const result = card({
    title: "✓ บันทึกรายการเรียบร้อย",
    metric: money(Math.round(transaction.amount * 100)),
    context: transaction.type === "income" ? "รายรับ" : "รายจ่าย",
    theme: "income",
    body: [
      ...transactionDetails(transaction),
      text(foodQuip(transaction), { size: "sm", color: green, margin: "md" }),
    ],
  });
  return isFood ? quickQuestion(result, "ดูเมนูที่กินบ่อย", foodPrompt) : result;
}

function menuRank({ name, count }, index, maxCount) {
  const width = Math.round(100 * count / maxCount) + "%";
  return box("vertical", [
    box("horizontal", [
      text(String(index + 1), {
        size: "xs", color: "#765238", weight: "bold", flex: 0,
      }),
      text(name, { size: "sm", weight: "bold", flex: 5 }),
      text(number.format(count) + " ครั้ง", { size: "xs", color: muted, align: "end", flex: 2 }),
    ], { spacing: "sm", alignItems: "center" }),
    box("vertical", [
      box("vertical", [], { width, height: "4px", cornerRadius: "4px", backgroundColor: "#A06543" }),
    ], { height: "4px", cornerRadius: "4px", backgroundColor: "#F0E5DA" }),
  ], { spacing: "sm" });
}

export function foodFlex(view, report, range, truncated, localOnly = false) {
  const { foodCount, namedCount, topMenus, clues } = report;
  const isClues = view === "clues";
  const heading = isClues ? "มีผัก ผลไม้ หรือธัญพืชไหม" : "เมนูที่บันทึกบ่อย";
  const body = [];
  if (!foodCount) {
    body.push(panel([
      text("ยังไม่มีรายการอาหารในช่วงนี้", { weight: "bold", size: "sm" }),
      text("ลองระบุชื่อเมนูเมื่อบันทึกมื้อถัดไป", { size: "sm", color: muted }),
    ]));
  } else if (isClues) {
    const labels = { vegetable: "ผัก", fruit: "ผลไม้", "whole-grain": "ธัญพืชเต็มเมล็ด" };
    if (clues.size) {
      for (const [kind, { name, count }] of clues) {
        body.push(panel([
          detail(labels[kind], number.format(count) + " รายการ"),
          text(name, { size: "sm", weight: "bold" }),
        ]));
      }
    } else {
      body.push(panel([text("ชื่อเมนูที่บันทึกยังไม่ระบุผัก ผลไม้ หรือธัญพืชชัดเจน", { size: "sm" })]));
    }
    body.push(text("อิงจากชื่อเมนูในรายการที่บันทึกเท่านั้น", { color: muted, size: "xs" }));
  } else if (namedCount && topMenus.length) {
    body.push(...topMenus.map((menu, index) => menuRank(menu, index, topMenus[0].count)));
  } else {
    body.push(panel([
      text("พบรายจ่ายอาหาร", { weight: "bold", size: "sm" }),
      text("ยังไม่มีชื่อเมนูให้จัดอันดับ ลองระบุชื่อเมนูเมื่อบันทึกครั้งถัดไป", { color: muted, size: "sm" }),
    ]));
  }
  if (localOnly) body.push(text("จัดอันดับตามชื่อที่จดไว้ การสะกดต่างกันอาจแยกเป็นคนละเมนู", { color: muted, size: "xs" }));
  if (truncated) body.push(text("อิงจาก 60 รายการรายจ่ายล่าสุดในช่วงนี้", { color: muted, size: "xs" }));
  const result = card({
    title: heading,
    metric: number.format(foodCount) + " รายการอาหาร",
    context: periodLabel(range),
    theme: isClues ? "income" : "food",
    body,
  });
  return isClues
    ? quickQuestion(result, "ดูเมนูที่กินบ่อย", foodPrompt)
    : quickQuestion(result, "ดูผักและผลไม้", healthPrompt);
}
