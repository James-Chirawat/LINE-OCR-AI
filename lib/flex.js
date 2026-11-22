import { formatDate } from "./transactions.js";

const number = new Intl.NumberFormat("th-TH");
const incomeColor = "#087358";
const expenseColor = "#B23D46";

function money(satang) {
  const absolute = Math.abs(satang);
  const fraction = absolute % 100;
  const baht = number.format((absolute - fraction) / 100);
  return (satang < 0 ? "−" : "") + baht +
    (fraction ? "." + String(fraction).padStart(2, "0") : "") + " บาท";
}

function text(value, properties = {}) {
  return { type: "text", text: value, wrap: true, ...properties };
}

function row(label, value, labelFlex = 2) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    contents: [
      text(label, { size: "sm", color: "#5C6873", flex: labelFlex }),
      text(value, { size: "sm", color: "#20333A", flex: 7 - labelFlex, align: "end" }),
    ],
  };
}

function card(title, amount, color, rows, footer) {
  return {
    type: "flex",
    altText: title + " · " + amount,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", spacing: "sm", backgroundColor: "#EEF5F4",
        contents: [
          text(title, { weight: "bold", color: "#20333A" }),
          text(amount, { size: "xl", weight: "bold", color }),
        ],
      },
      body: { type: "box", layout: "vertical", spacing: "md", contents: rows },
      ...(footer && { footer }),
    },
  };
}

export function confirmationFlex({ id, transaction }) {
  const { date, type, category, description, amount, note } = transaction;
  const income = type === "income";
  const rows = [
    row("วันที่", formatDate(date)),
    row("ประเภท", income ? "รายรับ" : "รายจ่าย"),
    row("รายการ", description),
    row("หมวดหมู่", category),
  ];
  if (note) rows.push(row("หมายเหตุ", note));
  return card("ตรวจสอบรายการ", money(Math.round(amount * 100)),
    income ? incomeColor : expenseColor, rows, {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button", style: "primary", color: "#087358", height: "sm",
          action: {
            type: "postback", label: "ยืนยันบันทึก", data: "confirm:" + id,
            displayText: "✅ ขอยืนยันบันทึกรายการ",
          },
        },
        {
          type: "button", style: "secondary", height: "sm",
          action: {
            type: "postback", label: "ยกเลิก", data: "cancel:" + id,
            displayText: "ขอยกเลิกรายการ",
          },
        },
      ],
    });
}

export function summaryFlex(title, view, summary, range) {
  const { incomeSatang, expenseSatang, count } = summary;
  const balance = incomeSatang - expenseSatang;
  const total = view === "income" ? incomeSatang : view === "expense" ? expenseSatang : balance;
  const color = view === "expense" || total < 0 ? expenseColor : incomeColor;
  const period = range.from === range.through && range.from
    ? formatDate(range.from)
    : range.from ? formatDate(range.from) + " ถึง " + formatDate(range.through) : "ทั้งหมด";
  const rows = [row("ช่วงวันที่", period)];
  if (view === "balance") {
    rows.push(row("รายรับ", money(incomeSatang)), row("รายจ่าย", money(expenseSatang)),
      row("รายการที่บันทึก", number.format(count) + " รายการ"));
  }
  return card(title, money(total), color, rows);
}

const foodPrompt = "เดือนนี้ฉันกินอะไรบ่อย";
const healthPrompt = "เดือนนี้ฉันกินอาหารสุขภาพบ้างไหม";

function quickQuestions(card, prompts) {
  return {
    ...card,
    quickReply: {
      items: prompts.map((prompt) => ({
        type: "action",
        action: { type: "message", label: prompt.label, text: prompt.text },
      })),
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
  const result = card("บันทึกรายการเรียบร้อย ✓", money(Math.round(transaction.amount * 100)),
    "#087358", [
      row("รายการ", transaction.description),
      row("วันที่", formatDate(transaction.date)),
      { type: "separator", color: "#E5EFEC" },
      text(foodQuip(transaction), { color: "#34665C", size: "sm" }),
    ]);
  return isFood ? quickQuestions(result, [{ label: "ดูเมนูที่กินบ่อย", text: foodPrompt }]) : result;
}

export function foodFlex(view, report, range, truncated, localOnly = false) {
  const { foodCount, namedCount, topMenus, clues } = report;
  const isClues = view === "clues";
  const heading = isClues ? "มีผัก ผลไม้ หรือธัญพืชไหม" : "เมนูที่บันทึกบ่อย";
  const rows = [row("ช่วงวันที่", formatDate(range.from) + " ถึง " + formatDate(range.through))];
  if (!foodCount) {
    rows.push(text("ยังไม่มีรายการอาหารที่ระบุได้ในช่วงนี้ ลองบันทึกชื่อเมนูหลังมื้อถัดไปนะ 🍽️",
      { color: "#34665C", size: "sm" }));
  } else if (isClues) {
    const labels = { vegetable: "ผัก", fruit: "ผลไม้", "whole-grain": "ธัญพืชเต็มเมล็ด" };
    if (clues.size) {
      for (const [kind, { name, count }] of clues) {
        rows.push(row(labels[kind], number.format(count) + " รายการ · " + name, 3));
      }
    } else {
      rows.push(text("ชื่อเมนูที่บันทึกยังไม่ระบุผัก ผลไม้ หรือธัญพืชชัดเจน", { color: "#34665C", size: "sm" }));
    }
    rows.push(text("อิงจากชื่อเมนูในรายการที่บันทึกเท่านั้น", { color: "#5C6873", size: "xs" }));
  } else if (namedCount) {
    topMenus.forEach(({ name, count }, index) => {
      rows.push(row(String(index + 1) + ". " + name, number.format(count) + " ครั้ง", 5));
    });
  } else {
    rows.push(text("เจอรายการค่าอาหารแล้ว แต่ยังไม่มีชื่อเมนูให้จัดอันดับ ลองระบุชื่อเมนูครั้งถัดไปนะ",
      { color: "#34665C", size: "sm" }));
  }
  if (localOnly) rows.push(text("จัดอันดับตามชื่อที่จดไว้ การสะกดต่างกันอาจแยกเป็นคนละเมนู", { color: "#5C6873", size: "xs" }));
  if (truncated) rows.push(text("วิเคราะห์จาก 60 รายการรายจ่ายล่าสุดในช่วงนี้", { color: "#5C6873", size: "xs" }));
  return quickQuestions(card(heading, number.format(foodCount) + " รายการอาหาร", "#087358", rows), [
    isClues ? { label: "ดูเมนูที่กินบ่อย", text: foodPrompt } : { label: "ดูผักและผลไม้", text: healthPrompt },
  ]);
}
