import { assert, assertEquals } from "@std/assert";
import {
  answerForHistory,
  formatText,
  parseSegments,
  sheetTranscript,
  splitFormatted,
  withoutInternals,
} from "./format.ts";

const plain = (text: string) => ({ text, entities: [] });

Deno.test("short text is one chunk", () => {
  assertEquals(splitFormatted(plain("  Javob: 4  ")), [plain("Javob: 4")]);
});

Deno.test("splits on paragraph boundaries and keeps all content", () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `${i}. ${"qadam ".repeat(30)}`.trim());
  const text = paragraphs.join("\n\n");
  const chunks = splitFormatted(plain(text), 1000);
  assert(chunks.length > 1);
  for (const c of chunks) assert(c.text.length <= 1000);
  assertEquals(chunks.map((c) => c.text).join("\n\n"), text);
});

Deno.test("hard-cuts text with no break points", () => {
  const chunks = splitFormatted(plain("a".repeat(2500)), 1000);
  assertEquals(chunks.map((c) => c.text.length), [1000, 1000, 500]);
});

Deno.test("bold markers become entities and the Javob line is bold", () => {
  const f = formatText("**1-qadam** x = 2\nJavob: x = 2");
  assertEquals(f.text, "1-qadam x = 2\nJavob: x = 2");
  assertEquals(f.entities, [
    { type: "bold", offset: 0, length: 7 },
    { type: "bold", offset: 14, length: 12 },
  ]);
});

Deno.test("entity offsets count UTF-16 units (x², √ and emoji)", () => {
  const f = formatText("✅ x² √9 **natija**");
  assertEquals(f.text.slice(f.entities[0].offset, f.entities[0].offset + f.entities[0].length), "natija");
});

Deno.test("entities are clipped and re-based across chunks", () => {
  const f = formatText(`${"a ".repeat(20)}**${"b".repeat(10)} ${"c".repeat(10)}**`);
  const chunks = splitFormatted(f, 50);
  assertEquals(chunks.length, 2);
  for (const c of chunks) {
    for (const e of c.entities) {
      assert(e.offset >= 0 && e.offset + e.length <= c.text.length);
    }
  }
  assertEquals(chunks[1].entities, [{ type: "bold", offset: 0, length: chunks[1].text.length }]);
});

Deno.test("figure markers split the answer in order", () => {
  const answer = "Grafikni chizamiz:\n[[RASM:grafik.png]]\nJavob: 2\n[[RASM: sxema.png ]]";
  assertEquals(parseSegments(answer), [
    { kind: "text", text: "Grafikni chizamiz:" },
    { kind: "figure", name: "grafik.png" },
    { kind: "text", text: "Javob: 2" },
    { kind: "figure", name: "sxema.png" },
  ]);
  assertEquals(answerForHistory(answer).includes("(rasm: grafik.png)"), true);
});

Deno.test("answer without markers is a single text segment", () => {
  assertEquals(parseSegments("Javob: 5"), [{ kind: "text", text: "Javob: 5" }]);
});

Deno.test("sheet transcript keeps the solution readable for follow-ups", () => {
  const t = sheetTranscript({
    topic: "Harakat masalasi",
    question: ["70 km masofa ..."],
    options: { A: "23", B: "21" },
    steps: [{ title: "Shart", body: ["$t_1-t_2=2$", { math: "v=20" }] }],
    answer: { option: "B" },
  });
  assertEquals(
    t,
    "Mavzu: Harakat masalasi\nSavol: 70 km masofa ...\nVariantlar: A) 23  B) 21\n1. Shart\n$t_1-t_2=2$\n$$v=20$$\nJavob: B",
  );
  assertEquals(sheetTranscript(null), "");
  assertEquals(sheetTranscript({ answer: { parts: [{ label: "a)", value: "9/8" }] } }), "Javob: a) 9/8");
});

Deno.test("replies about internal tooling never reach students", () => {
  const leak = "Fayllar qabul qilindi: render_solution.py va cmunrm, cmunbx shriftlari. Lekin savol yo'q.";
  assertEquals(
    withoutInternals(leak, false),
    "Savolingizni tushunmadim. Iltimos, masala rasmini yoki shartini aniqroq yuboring.",
  );
  assertEquals(withoutInternals("Rasm $OUTPUT_DIR ga saqlandi.\nJavob: B) 21", true), "Javob: B) 21");
  assertEquals(withoutInternals("yechim.json tayyor", true), "");
  assertEquals(withoutInternals("Javob: C) 70°", true), "Javob: C) 70°");
  assertEquals(
    withoutInternals("Javob: x = 2 (fayl emas, oddiy javob)", false),
    "Javob: x = 2 (fayl emas, oddiy javob)",
  );
});
