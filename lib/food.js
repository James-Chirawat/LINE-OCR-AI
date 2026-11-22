// Require question phrasing so a normal entry such as "กินข้าว 80 บาท" still saves a draft.
export function foodQuestion(text) {
  if (/(?:กิน|อาหาร).*(?:สุ[ขช]ภาพ|คลีน|ผัก|ผลไม้).*(?:ไหม|มั้ย|หรือเปล่า|บ้างไหม)/.test(text)) return "clues";
  if (/สรุป(?:การกิน|อาหาร)|(?:กิน|ซื้ออาหาร|สั่งอาหาร)(?:อะไร|เมนูไหน).*(?:เยอะ|บ่อย|มาก|บ้าง)|(?:ฉัน|ผม|เรา)กินอะไร[?？]?$/.test(text)) return "frequency";
  return null;
}

function normalizedMenu(menu) {
  return menu.normalize("NFKC").toLowerCase()
    .replace(/กระเพรา|กะเพา|กระเพา/g, "กะเพรา")
    .replace(/\s+/g, "");
}

const foodCategory = /อาหาร|เครื่องดื่ม|ของกิน|มื้อ(?:เช้า|กลางวัน|เย็น)|food|drink/i;
const knownMenu = /ก[ะร]ะ?เพ[ร]?า|ข้าว|ก๋วยเตี๋ยว|บะหมี่|ส้มตำ|ต้มยำ|สลัด|กาแฟ|ชานม|น้ำเต้าหู้|ไก่ทอด|หมูกรอบ|ซูชิ|สเต๊ก|พิซซ่า|แซนด์วิช|coffee|salad|noodle|pizza/i;
const genericMeal = /^(?:ค่า)?(?:อาหาร(?:และเครื่องดื่ม)?|เครื่องดื่ม|ของกิน|มื้อ(?:เช้า|กลางวัน|เย็น)|food|meal|restaurant bill)$/i;
const foodClues = [
  ["vegetable", /ผัก|คะน้า|บรอกโคลี|บรอกโคลี่|แครอท|กะหล่ำ|ฟักทอง|แตงกวา|มะเขือเทศ|เห็ด|spinach|broccoli|cabbage|carrot|vegetable/i],
  ["fruit", /ผลไม้|กล้วย|ฝรั่ง|แตงโม|สตรอว์เบอร์รี|แอปเปิล|แอปเปิ้ล|มะละกอ|ส้มสด|น้ำส้ม|fruit|banana|apple|watermelon/i],
  ["whole-grain", /ข้าวกล้อง|ข้าวโอ๊ต|โฮลวี[ตท]|โฮลเกรน|ธัญพืชเต็มเมล็ด|whole.?grain|whole.?wheat|brown rice|oatmeal/i],
];

function mentionedClues(description) {
  return foodClues.filter(([, pattern]) => pattern.test(description)).map(([kind]) => kind);
}

// Read only explicit words in the saved description. Generic meal labels count as
// food expenses but never appear in rankings or as evidence of ingredients.
export function classifyRecordedFood(entries) {
  return entries.flatMap(({ category, description }, index) => {
    const label = description.trim();
    if (!foodCategory.test(category) && !knownMenu.test(label) &&
        !(!category && mentionedClues(label).length)) return [];
    return [{ index, menu: genericMeal.test(label) ? null : label }];
  });
}

export function summarizeFood(entries, matches) {
  const menus = new Map();
  const clues = new Map();
  const seen = new Set();
  let namedCount = 0;
  for (const { index, menu } of matches) {
    if (!entries[index] || seen.has(index)) continue;
    seen.add(index);
    const description = entries[index].description;
    const label = menu?.trim();
    const key = label ? normalizedMenu(label) : "";
    if (!key || !normalizedMenu(description).includes(key)) continue;

    namedCount++;
    const menuKey = key.replace(/^(?:ข้าว(?:ราด)?(?:ผัด)?|ผัด)(?=กะเพรา)/, "");
    const existing = menus.get(menuKey);
    if (existing) existing.count++;
    else menus.set(menuKey, { name: label, count: 1 });
    for (const clue of mentionedClues(description)) {
      const existingClue = clues.get(clue);
      if (existingClue) existingClue.count++;
      else clues.set(clue, { name: label, count: 1 });
    }
  }
  return {
    foodCount: seen.size,
    namedCount,
    topMenus: [...menus.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    clues,
  };
}
