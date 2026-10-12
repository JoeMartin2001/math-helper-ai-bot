# Ustoz AI — brand assets

Brand assets for **@mathustozai_bot**, a math and physics helper bot that Abdulaziz Madg‘oziyev's students use in his Telegram groups (Milliy sertifikat tayyorlov).

## Files (`out/`)

| File | Size | Use |
|---|---|---|
| `avatar-640.jpg` | 640×640 | Bot profile photo (already set via the Bot API) |
| `avatar.png` | 1280×1280 | High-resolution profile photo |
| `description.png` | 640×360 | BotFather → *Edit Bot* → *Edit Description Picture*. Shown on the "What can this bot do?" screen |
| `guide.png` | 1080×1350 | "How to use the bot" post to **pin in each group** |
| `announcement.png` | 1280×720 | Launch post for @MatematikaMilliySertifikatUz and the groups |
| `logo.png` | 1024×1024 | Logo mark on a transparent background, for any other use |
| `src/mark.svg` | vector | Master logo |

The guide and announcement show real bot input and output from `src/img/`: one of Abdulaziz's exam questions, and the solution sheet the bot produced for it.

**Palette:** navy `#0B1736` / `#12244F`, teal `#2DD4BF` → `#0E9F92`, gold `#FFC23D`.
**Fonts:** Unbounded (headings) and Manrope (text), both under the SIL Open Font License (see `fonts/`).

## Editing and re-rendering
Each asset is an HTML page in `src/`. Edit the page, then render it with headless Chrome:
```bash
./brand/render.sh              # all assets
./brand/render.sh guide        # one asset
```

## Ready-to-post texts

**Announcement** (with `announcement.png`):
```
🎉 Yangi: Ustoz AI — guruhimizdagi matematika va fizika yordamchisi!

Masala ustida qolib ketmang: rasmini guruhga yuboring va izohda @mathustozai_bot ni belgilang. Bot masalani o‘qiydi, bosqichma-bosqich yechadi va yechimni formulalar va chizmalar bilan tayyor yechim varag‘i qilib yuboradi.

Tushunmasangiz, bot javobiga reply qilib «soddaroq tushuntiring» deb yozing.

Bot Abdulaziz Madg‘oziyev tomonidan Milliy sertifikat tayyorlov o‘quvchilari uchun yaratildi.
```

**Pinned guide** (with `guide.png`):
```
📌 Ustoz AI’dan foydalanish:
1. Matematika yoki fizika masalasi rasmini yuboring va izohda @mathustozai_bot ni belgilang
2. Nima kerakligini yozing: «3-masalani yeching»
3. Yechim varag‘ini oling — bosqichma-bosqich, formulalar va chizmalar bilan
4. Tushunmasangiz — bot javobiga reply qiling

💡 Rasm aniq bo‘lsin, bitta rasmda bitta masala.
⏱ Har bir o‘quvchi soatiga 10 tagacha savol berishi mumkin.
⚠️ Bot ham xato qilishi mumkin — shubhali joylarni ustozdan so‘rang.
```
