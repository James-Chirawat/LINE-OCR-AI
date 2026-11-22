# LINE AI Expense Tracker

บันทึกรายรับ–รายจ่ายผ่านแชตส่วนตัวกับ LINE Official Account พิมพ์ข้อความภาษาไทยหรืออังกฤษ หรือส่งใบเสร็จเป็นรูปและ PDF จากนั้นตรวจรายละเอียดบน Flex Message แล้วกด **ยืนยันบันทึก** ข้อมูลจะเข้า Google Sheets และใช้สรุปยอดผ่านแชตได้ทันที

โปรเจกต์ใช้ Next.js App Router และ JavaScript ES Modules โดยนำ LINE stateless token, OCR บน CPU, การเตรียมภาพ และการเรนเดอร์ PDF มาจาก [Linebot-OCR](https://github.com/James-Chirawat/Linebot-OCR/tree/f087da1a43316ae817b6aee5928dc5a16c7dead1)

```text
ข้อความ LINE ───────────────────┐
ภาพ / PDF ── OpenThai OCR ──────┴─ Gemini JSON → Zod → PendingTransactions
                                                             ↓
                                                LINE Flex → กดยืนยัน
                                                             ↓
                                                        Transactions
```

## 1. เตรียมเครื่องและบัญชี

- ใช้ Node.js **22.13 ขึ้นไปในสาย 22.x** พร้อม npm และ VS Code
- เตรียม LINE Official Account ที่เปิดใช้ Messaging API และหา `Channel ID` กับ `Channel secret` ใน LINE Developers Console
- สร้าง API key ใน Google AI Studio และเลือกโมเดลที่รองรับ Structured Output และมี Free Tier ในโปรเจกต์ของคุณ เช่น `gemini-3.8-flash` เมื่อ AI Studio แสดงว่ามีสิทธิ์ใช้โมเดลนี้ บัญชีที่มีโควตาฟรีใช้ทดสอบได้โดยไม่เปิด Billing [โมเดลและราคา Gemini](https://ai.google.dev/gemini-api/docs/pricing)
- เตรียมบัญชี Google ที่สร้างชีตและเปิด Apps Script Web App ให้ **Anyone** เรียกได้ ใบเสร็จสำหรับ workshop ควรใช้ข้อมูลตัวอย่าง เพราะข้อความจากแชตและข้อความที่ OCR อ่านได้จะถูกส่งไป Gemini และ Google ระบุว่าอาจใช้ข้อมูลจาก Free Tier เพื่อปรับปรุงผลิตภัณฑ์ [เงื่อนไข Gemini API](https://ai.google.dev/gemini-api/terms)

## 2. ตั้งค่า Google Sheets และ Apps Script

1. สร้าง Google Sheets เปล่าหนึ่งไฟล์ เก็บ Spreadsheet ID จาก URL ส่วนระหว่าง `/d/` กับ `/edit` และจำกัดสิทธิ์แชร์ไฟล์ให้เฉพาะผู้ดูแล
2. ในเครื่อง สร้าง shared secret แบบสุ่ม เก็บค่านี้ไว้สำหรับทั้ง Apps Script และ `.env.local`

   ```bash
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
   ```

3. ในชีต เปิด **Extensions → Apps Script** และตรวจว่า **Project Settings → Enable Chrome V8 runtime** เปิดอยู่ จากนั้นวางเนื้อหาจาก [apps-script/Code.gs](apps-script/Code.gs) ในไฟล์ `รหัส.gs` แล้วกดบันทึก [คู่มือ V8 ของ Apps Script](https://developers.google.com/apps-script/guides/v8-runtime)
4. ไปที่ **Project Settings → Script properties** เพิ่ม `SPREADSHEET_ID` แล้วใส่ ID ของชีต เพิ่ม `SHARED_SECRET` แล้วใส่ค่าที่สร้างเมื่อครู่ รักษาชื่อทั้งสองไว้ตามนี้ใน `getProperty(...)` ของไฟล์ `รหัส.gs`
5. กลับที่ Editor เลือกฟังก์ชัน `setupSheets` แล้วกด **Run** อนุญาตให้สคริปต์เข้าถึงชีต และตรวจว่ามีสองแท็บด้านล่าง เรียกฟังก์ชันเดิมซ้ำได้หากหัวตารางตรง
6. เลือก **Deploy → New deployment → Web app** ตั้ง **Execute as** เป็น **Me** และ **Who has access** เป็น **Anyone** คัดลอก URL รูปแบบ `https://script.google.com/macros/s/.../exec` ไปใช้ในเครื่อง เมื่อแก้โค้ด Apps Script ให้เปิด **Manage deployments → Edit → New version** [การตั้งค่า Apps Script Web App](https://developers.google.com/apps-script/guides/web)

`Transactions` เก็บรายการที่ยืนยันแล้ว

```text
EventID | LINEUserID | Timestamp | Date | Type | Category | Description | Amount | Note
```

`PendingTransactions` เก็บรายการรอตรวจสอบและสถานะ `Pending`, `Confirmed` หรือ `Cancelled`

```text
PendingID | LINEUserID | CreatedAt | Status | Date | Type | Category | Description | Amount | Note
```

ให้ Web App เป็นผู้เขียนสองแท็บนี้ ระหว่างทดสอบควรเก็บหัวตาราง รหัสรายการ และสถานะไว้ตามเดิม คอลัมน์ `Date` เป็นข้อความวันที่ `YYYY-MM-DD` ส่วน `Timestamp` และ `CreatedAt` เป็น ISO timestamp ใน UTC

## 3. รัน Next.js ในเครื่อง

เปิดโฟลเดอร์นี้ใน VS Code แล้วรัน

```bash
npm install
npm run models
cp .env.example .env.local
```

กรอกค่าต่อไปนี้ใน `.env.local` โดยใช้ shared secret ค่าเดียวกับ Apps Script

```dotenv
LINE_CHANNEL_ID=
LINE_CHANNEL_SECRET=

GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash

SHEETS_WEB_APP_URL=
SHEETS_SHARED_SECRET=
```

`npm run models` จะดาวน์โหลดโมเดล OpenThai รุ่นที่กำหนดไว้และตรวจ SHA-256 ก่อนใช้งาน จากนั้นเริ่มเซิร์ฟเวอร์

```bash
npm run dev
```

ตรวจว่า terminal แสดง `http://localhost:3000` พาธ `/api/webhook` รับ POST จาก LINE จึงเปิด URL ตรง ๆ ด้วยเบราว์เซอร์แล้วได้ HTTP 405 ตามปกติ

## 4. เปิด VS Code Public Port และตั้งค่า LINE

1. เปิด **Ports** ใน VS Code หรือใช้ Command Palette ค้นหา **Ports: Focus on Ports View**
2. กด **Forward a Port** ใส่ `3000` และลงชื่อเข้าใช้ GitHub ใน VS Code หากระบบถาม
3. คลิกขวาบนแถวพอร์ต เลือก **Port Visibility → Public** แล้วคัดลอก **Forwarded Address** ตรวจในหน้าต่างไม่ระบุตัวตนว่า URL เข้าถึงได้โดยไม่ต้องล็อกอิน [คู่มือ VS Code Port Forwarding](https://code.visualstudio.com/docs/debugtest/port-forwarding)
4. ไปที่ LINE Developers Console ของ Channel นี้ → **Messaging API** ใส่ Webhook URL ในรูปแบบ `https://PUBLIC-URL/api/webhook` ในกรณี tunnel แจ้งว่าต้องล็อกอิน ให้กลับไปตรวจว่า Visibility เป็น Public
5. กด **Verify** ให้ขึ้น **Success** จากนั้นเปิด **Use webhook** และ **Webhook redelivery** เปิด **Error statistics** หากต้องการตรวจข้อผิดพลาดจาก LINE และปิดข้อความตอบอัตโนมัติที่ซ้ำกับบอตใน LINE Official Account Manager [การรับ Webhook และ Redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
6. เพิ่ม Official Account เป็นเพื่อนแล้วเปิดแชตส่วนตัว เปิด VS Code และ terminal ที่รัน Next.js ไว้ตลอดการทดสอบ หาก URL เปลี่ยนให้อัปเดต Webhook URL ก่อนทดสอบรอบถัดไป

## 5. ทดสอบผ่าน LINE

1. ส่ง `กินข้าว 80 บาท` ต้องได้การ์ดรายจ่าย 80 บาท ตรวจว่าพบร่างใน `PendingTransactions` แต่ยังไม่มีแถวจริงใน `Transactions`
2. ส่งภาพใบเสร็จตัวอย่าง JPEG, PNG หรือ WebP ซึ่งมีวันที่และยอดรวมชัดเจน ตรวจว่าขึ้น Loading และยอดบนการ์ดตรงกับยอดชำระเมื่อใบเสร็จมีหลายบรรทัด
3. ส่ง PDF ภาษาไทยที่เปิดได้โดยไม่ใช้รหัสผ่านและมีวันที่กับยอดรวมชัดเจน ตรวจการ์ดเช่นเดียวกับภาพ ขนาดไฟล์สูงสุดคือ 4,000,000 ไบต์ PDF สูงสุด 3 หน้า
4. เปิด terminal อีกหน้าต่างแล้วรัน `npm run gemini:check` คำสั่งใช้ API key และโมเดลจาก `.env` หรือ `.env.local` ส่งข้อความตัวอย่างคงที่ไป Gemini แล้วพิมพ์ JSON ที่ผ่าน Zod ตรวจ `date`, `type`, `category`, `description`, `amount`, `currency` และ `note`
5. กด **ยืนยันบันทึก** แล้วตรวจว่ามีแถวจริงเพียงหนึ่งแถวและสถานะร่างเป็น `Confirmed` กดปุ่มเดิมอีกครั้งเพื่อทดสอบการยืนยันซ้ำ จากนั้นสร้างอีกร่างและกด **ยกเลิก** เพื่อทดสอบสถานะ `Cancelled`
6. ส่ง `ได้เงินเดือน 35000` แล้วกดยืนยัน ลองทั้ง 6 คำสั่งด้านล่าง และเปรียบเทียบยอดกับชีต ใช้แชตส่วนตัวของอีกบัญชีเพื่อทดสอบว่าบัญชีนั้นเห็นเฉพาะยอดของตัวเอง
7. ส่ง `ซื้อกาแฟ` แล้วตรวจว่าบอตถามจำนวนเงิน จากนั้นส่งรายละเอียดครบในข้อความเดียว เช่น `ซื้อกาแฟเมื่อวาน 65 บาท` การตอบด้วยข้อมูลครบในข้อความเดียวช่วยให้รายการใหม่มีบริบทพอสำหรับตรวจสอบ
8. ทดสอบ Webhook Redelivery แบบทำซ้ำได้ด้วย `npm test` ชุดทดสอบส่ง event ID เดิมให้ webhook คนละ instance จำลองความล้มเหลวหลังเพิ่มแถว และตรวจว่ามีแถวจริงเพียงแถวเดียว การพิมพ์ข้อความเดิมส่งซ้ำใน LINE จะสร้าง event ใหม่

### คำสั่งที่รองรับ

- `ช่วยเหลือ` แสดงตัวอย่างและคำสั่ง
- `สรุปวันนี้` และ `สรุปเดือนนี้` แสดงรายรับ รายจ่าย และยอดสุทธิในช่วงนั้น
- `รายรับเดือนนี้` แสดงรายรับเดือนปัจจุบัน
- `รายจ่ายเดือนนี้` แสดงรายจ่ายเดือนปัจจุบัน
- `ยอดคงเหลือ` แสดงรายรับลบรายจ่ายจากรายการที่ยืนยันทั้งหมด

### ถามเกี่ยวกับอาหารใน LINE

- `ฉันกินอะไรเยอะ`, `เดือนนี้ฉันกินอะไรเยอะบ้าง` หรือ `สรุปการกิน` จัดอันดับเมนูตามจำนวนครั้งที่บันทึกและยืนยันตั้งแต่ต้นเดือนถึงวันนี้
- `ฉันกินอาหารสุขภาพบ้างไหม` แสดงรายการที่ชื่อเมนูระบุผัก ผลไม้ หรือธัญพืชเต็มเมล็ดอย่างชัดเจน ผลอิงจากรายการที่บันทึกในเดือนนี้
- ตั้งชื่อเมนูตอนจด เช่น `ข้าวกะเพราหมูกรอบ 80 บาท` รายการที่มีแค่คำว่า “ค่าอาหาร” ช่วยบอกว่ามีรายจ่ายอาหาร แต่ใช้จัดอันดับชื่อเมนูไม่ได้
- การวิเคราะห์อ่านเฉพาะรายจ่ายที่ยืนยันแล้วของบัญชีผู้ถาม สูงสุด 60 รายการล่าสุด คำถามสุขภาพตรวจจากคำในชื่อเมนูโดยตรง การจัดอันดับเรียก Gemini เมื่อมีหมวดหรือชื่อรายการที่ยังแยกไม่ชัด และใช้ชื่อที่จดไว้หาก Gemini ตอบไม่ทัน
- เมื่อกดยืนยัน การ์ดใหม่จะแสดงข้อความขอยืนยันในแชตทันที หลังยืนยันสำเร็จ บอตส่ง Flex สรุปยอดและข้อความสั้นตามรายการ พร้อมปุ่มดูเมนูที่กินบ่อยเมื่อเป็นรายการอาหารหรือเครื่องดื่ม
- สำหรับ Web App ที่ใช้อยู่ ให้คัดลอก `apps-script/Code.gs` ฉบับล่าสุดไปวางและเลือก **Manage deployments → Edit → New version** ใช้ URL `/exec` และชีตเดิมได้

วันที่และคำว่า “วันนี้” หรือ “เมื่อวาน” อิง `Asia/Bangkok` ข้อความแชตที่ละวันที่ใช้วันที่ของข้อความ ใบเสร็จหรือ PDF ที่อ่านวันที่ไม่ได้จะขอให้ผู้ใช้ระบุวันที่ ระบบรับเงินบาทและให้ใช้ตัวเลขสำหรับจำนวนเงินเพื่อเทียบกับข้อความต้นทาง หากพบหลายรายการอิสระในข้อความเดียวให้แยกส่งทีละรายการ

## 6. รันทดสอบและแก้ปัญหา

```bash
npm test
npm run test:ocr
npm run build
```

- `npm test` ทดสอบ Zod, วันที่และสตางค์, LINE signature และ stateless token, Google Apps Script ผ่านตัวจำลองชีต, การยืนยันซ้ำ, การกู้สถานะหลังบันทึกค้าง และการแยกผู้ใช้
- `npm run test:ocr` รัน OpenThai OCR จริงกับภาพและ PDF สแกน มีผลทดสอบและค่าสูงสุดของหน่วยความจำใน `test-results/ocr.json`
- `npm run build` ตรวจ checksum โมเดล สร้าง Next.js production build และตรวจไฟล์ใน trace ของ webhook
- ถ้า **Verify** ไม่ผ่าน ให้ตรวจ URL และพอร์ตใน VS Code แล้วตรวจว่า `LINE_CHANNEL_SECRET` ตรงกับ Channel ที่ใช้ หลังแก้ `.env.local` ควรตามด้วยการรีสตาร์ต Next.js
- ถ้าเจอ `GEMINI_CONFIG` หรือ `GEMINI_FAILED` ให้ตรวจ API key ชื่อโมเดล สิทธิ์ และโควตาผ่าน AI Studio แล้วใช้ `npm run gemini:check` คนละขั้นกับการทดสอบ LINE
- ถ้าเจอ `SHEETS_CONFIG` หรือ `SHEETS_FAILED` ให้ตรวจ URL ลงท้าย `/exec`, การตั้งค่า **Me / Anyone**, ชื่อ Script Properties, shared secret และหัวตาราง ดู **Executions** ใน Apps Script หากต้องตรวจต่อ
- ถ้า LINE โหลดนานหรือแจ้ง `request_timeout` ให้ดูสถานะใน LINE Error statistics และตรวจว่าร่างถูกสร้างหรือยัง Webhook รอผลช่วงสั้น ๆ เพื่อคืน 5xx ได้หากพบข้อผิดพลาดทันที จากนั้นตอบ HTTP 200 และให้ Next.js `after()` รอผลต่อ หากงานที่ตอบ HTTP 200 แล้วล้มเหลว ระบบลองทำเฉพาะ event ที่ล้มเหลวอีกครั้งเมื่อยังมีเวลา แล้วบันทึกรหัสความผิดพลาดให้ตรวจใน terminal [LINE webhook development guidelines](https://developers.line.biz/en/docs/partner-docs/development-guidelines/)

## 7. เตรียม Vercel หลังทดสอบ Local

1. ตั้ง Framework เป็น Next.js เลือก **Node.js 22.x** และเปิด Fluid Compute เพื่อรองรับ route ที่ตั้ง `maxDuration = 120` วินาที ตรวจเงื่อนไข Hobby และโควตาของบัญชีก่อนใช้ [Vercel Function Limits](https://vercel.com/docs/functions/limitations)
2. เพิ่มตัวแปรทั้งหกจาก `.env.example` ใน Environment Variables ฝั่งเซิร์ฟเวอร์ เลือก scope ให้ตรงกับ environment ที่จะรับ webhook
3. `vercel.json` ตั้งให้ติดตั้ง ONNX สำหรับ CPU และรัน `npm run build` ส่วน `next.config.mjs` เก็บ native dependencies และรวมโมเดลกับไฟล์ประกอบ PDF ตาม route trace ตรวจ log ว่า Linux x64 ONNX, PDF canvas และไฟล์โมเดลถูกรวม ตรวจขนาดแพ็กเกจ และทดลอง PDF ภาษาไทย 3 หน้าจาก cold start เพื่อวัดระยะเวลาและหน่วยความจำจริง
4. เมื่อ deploy ด้วยตัวเองแล้ว ใช้ URL ของ deployment ที่ LINE เข้าถึงได้ ใส่ `/api/webhook` แล้วทดสอบครบตามหัวข้อ 5 โดยเฉพาะไฟล์ 3 หน้า การกดซ้ำ และสลับบัญชีจากแชตจริง

### การบันทึกและข้อจำกัดเวลา

- ตรวจลายเซ็น LINE จาก raw body ก่อนอ่าน JSON และออก stateless token ฝั่งเซิร์ฟเวอร์ Apps Script ตรวจ HMAC ของ POST body และเวลาออกคำขอแทนการอ่าน custom headers ตัว secret ไม่ถูกส่งใน URL หรือใน payload
- ใช้ `webhookEventId` เป็นรหัสร่างและ EventID ของรายการจริง Apps Script ตรวจเจ้าของและใช้ Script Lock ตอนอ่านหรือแก้สถานะ หากมีแถวจริงอยู่แล้วแต่ร่างยังเป็น Pending ระบบจะปรับร่างให้ตรงกันก่อนจัดการคำขอถัดไป
- Webhook ใช้กรอบทำงาน 105 วินาทีต่อ batch พร้อม timeout ของบริการย่อย และจำกัดจำนวนหน้า ขนาด และพิกเซลของไฟล์ OCR เช็กเวลาระหว่างขั้นตอน การเรียก native ที่กำลังทำงานต้องรอคืนกลับมาก่อนตรวจเวลาอีกครั้ง
- งานที่ใกล้หมดเวลาของ Reply Token จะส่ง Flex ผ่าน **Push Message** พร้อม retry key คงที่ต่อ event ระบบบันทึกวิธีส่งไว้กับร่างเพื่อให้ Redelivery ใช้วิธีเดิม Push ใช้โควตาข้อความ LINE และเหมาะกับการทดสอบผ่านบัญชีที่เพิ่ม OA เป็นเพื่อนแล้ว [LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/nojs/) · [การใช้ Push retry key](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)
- Pending อยู่ใน Sheets โมเดลอ่านจากไฟล์ที่รวมมากับ build ส่วนไฟล์ผู้ใช้ประมวลผลในหน่วยความจำ เซิร์ฟเวอร์บันทึกเฉพาะรหัสความผิดพลาด งานหลังตอบ HTTP 200 ผูกกับอายุของ invocation หากเซิร์ฟเวอร์หยุดหรือ Vercel ตัดฟังก์ชันก่อนงานเสร็จ ผู้ใช้อาจต้องส่งรายการใหม่ ตรวจ deployment จริงก่อนเปลี่ยน webhook จาก local

## เครดิตและสิทธิ์ใช้งาน

โค้ดส่วน OCR มาจาก Linebot-OCR และใช้ OpenThai2.0-OCR-Text ของ iApp Technology ดู [LICENSE](LICENSE) และ [NOTICE](NOTICE) สำหรับรายละเอียด
