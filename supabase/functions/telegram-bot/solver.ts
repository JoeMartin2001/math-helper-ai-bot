// Sends the problem (image + Uzbek question) to Claude and returns an Uzbek solution, plus any
// figures Claude drew with the server-side code execution tool.

import Anthropic from "@anthropic-ai/sdk";
import type { ImageMediaType } from "./media.ts";

const MODEL = "claude-opus-5-5";
const MAX_FIGURES = 3;
// The API pauses long server-tool turns; resume at most this many times.
const MAX_CONTINUATIONS = 3;

// Kept constant so the prefix is cacheable across requests.
const SYSTEM_PROMPT =
  `Sen sabrli va tajribali matematika o'qituvchisisan. Foydalanuvchilar Telegram guruhida matematik masalaning rasmini va o'zbek tilidagi savolni yuborishadi.

Javob tili va tuzilishi:
- Har doim o'zbek tilida (lotin yozuvida) javob ber, savol qaysi tilda bo'lishidan qat'i nazar.
- Avval masala shartini qisqacha qayta yoz, so'ng uni bosqichma-bosqich, tushunarli qilib yech, oxirida alohida qatorda "Javob: ..." deb yakuniy javobni yoz.
- Agar savolda faqat javob so'ralgan bo'lsa ham, qisqa izoh bilan yechimni ko'rsat.
- Agar rasmda bir nechta masala bo'lsa va savolda qaysi biri ko'rsatilmagan bo'lsa, hammasini tartib bilan yech.
- Javobni ixcham saqla: keraksiz takrorlarsiz, lekin o'quvchi har bir qadamni tushunadigan darajada.

Format (javob Telegram'da oddiy matn sifatida ko'rsatiladi):
- LaTeX, # sarlavhalar, jadval belgilari yoki kod bloklaridan foydalanma.
- Matematik belgilar uchun Unicode ishlat: x², x³, √, ∛, π, ≤, ≥, ≠, ±, ×, ÷, °, ∞, ∫, ∑, kasrlar uchun a/b.
- Qadam sarlavhalarini **qalin** qilib belgilashing mumkin, lekin kam ishlat.

Hisoblash va rasmlar (code_execution vositasi):
- Hisob-kitob oddiy bo'lmasa (tenglama, kasrlar, ildizlar, katta sonlar), yakuniy javobni Python (sympy) bilan tekshir. Javobda kod, Python yoki tekshiruv jarayonini tilga olma — o'quvchi faqat tushuntirishni ko'radi.
- Rasm haqiqatan tushunishga yordam bersa, matplotlib bilan chiz: funksiya grafigi, geometrik shakl (berilgan va topilgan qiymatlar belgilangan holda), koordinata tekisligi, son o'qi, harakat masalasi sxemasi. Murakkab formulalar ko'p bo'lsa (ko'p qavatli kasrlar, integrallar, matritsalar), asosiy hisob-kitoblarni matplotlib mathtext bilan toza "formula varag'i" rasmi qilib chizishing mumkin.
- Oddiy arifmetika uchun rasm chizma. Ko'pi bilan ${MAX_FIGURES} ta rasm.
- Rasm talablari: oq fon, figsize=(7, 5) atrofida, dpi=150, yirik shrift (kamida 12), yozuvlar o'zbek tilida, plt.tight_layout().
- Har bir rasmni qisqa lotin nomli PNG fayl sifatida (masalan grafik.png) to'g'ridan-to'g'ri $OUTPUT_DIR papkasiga saqla va o'sha buyruqda ls "$OUTPUT_DIR" bilan tekshir — boshqa joyga saqlangan rasm o'quvchiga yetib bormaydi.
- Javob matnida rasm turishi kerak bo'lgan joyga alohida qatorda [[RASM:grafik.png]] belgisini qo'y (fayl nomi aynan bir xil bo'lsin).

Suhbat:
- Foydalanuvchi oldingi javobingga javob (reply) qilib qo'shimcha savol bersa, avvalgi suhbatdagi masala va javobga tayanib javob ber; masalani qayta yuborishni so'rama.
- "Soddaroq", "qisqaroq" deb so'ralsa, haqiqatan qisqa yoz (bir necha qator): butun yechimni qayta yozma, faqat asosiy g'oya va javobni sodda tilda tushuntir.
- Agar rasm o'qib bo'lmaydigan darajada xira bo'lsa yoki unda matematik masala bo'lmasa, buni xushmuomalalik bilan ayt va aniqroq rasm yuborishni so'ra.
- Matematika va aniq fanlarga aloqasi bo'lmagan so'rovlarga qisqa va xushmuomalalik bilan javob berib, faqat matematik masalalarda yordam bera olishingni ayt.`;

export interface ImageData {
  base64: string;
  mediaType: ImageMediaType;
}

export interface Figure {
  name: string;
  bytes: Uint8Array;
}

export type SolveResult =
  | {
    kind: "ok";
    text: string;
    figures: Figure[];
    truncated: boolean;
    inputTokens: number;
    outputTokens: number;
  }
  | { kind: "refusal" };

export interface SolveInput {
  /** Earlier exchanges of this conversation, oldest first. */
  history: { question: string; image?: ImageData; answer: string }[];
  question: string;
  image?: ImageData;
  /** Abort the request (and any retries) when this fires. */
  signal: AbortSignal;
}

// One retry for transient errors; the deadline signal bounds total time.
const client = new Anthropic({ maxRetries: 1 }); // reads ANTHROPIC_API_KEY

function userContent(question: string, image?: ImageData): Anthropic.Beta.BetaContentBlockParam[] {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 },
    });
  }
  content.push({ type: "text", text: question });
  return content;
}

export async function solve(input: SolveInput): Promise<SolveResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = input.history.flatMap((turn) => [
    { role: "user" as const, content: userContent(turn.question, turn.image) },
    { role: "assistant" as const, content: turn.answer },
  ]);
  messages.push({ role: "user", content: userContent(input.question, input.image) });

  let inputTokens = 0;
  let outputTokens = 0;
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let container: string | undefined;
  let message: Anthropic.Beta.BetaMessage;

  for (let attempt = 0;; attempt++) {
    message = await client.beta.messages
      .stream(
        {
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          // On a safety-classifier decline, retry server-side on Anthropic's recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ type: "code_execution_20260521", name: "code_execution" }],
          ...(container ? { container } : {}),
          messages,
        },
        { signal: input.signal },
      )
      .finalMessage();

    inputTokens += message.usage.input_tokens +
      (message.usage.cache_read_input_tokens ?? 0) +
      (message.usage.cache_creation_input_tokens ?? 0);
    outputTokens += message.usage.output_tokens;
    content.push(...message.content);
    container = message.container?.id ?? container;

    if (message.stop_reason !== "pause_turn" || attempt >= MAX_CONTINUATIONS) break;
    // Resume: send the paused assistant turn back as-is and the API continues where it stopped.
    messages.push({ role: "assistant", content: message.content });
  }

  if (message.stop_reason === "refusal") return { kind: "refusal" };

  // Only text after the last tool activity is the answer; earlier text is working commentary.
  const lastTool = content.findLastIndex((b) => b.type !== "text" && b.type !== "thinking");
  const text = content
    .slice(lastTool + 1)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    kind: "ok",
    text,
    figures: await collectFigures(content, input.signal),
    truncated: message.stop_reason === "max_tokens",
    inputTokens,
    outputTokens,
  };
}

/** Downloads the PNG/JPEG files Claude left in $OUTPUT_DIR, then deletes them from the Files API. */
async function collectFigures(
  content: Anthropic.Beta.BetaContentBlock[],
  signal: AbortSignal,
): Promise<Figure[]> {
  const fileIds = content.flatMap((b) =>
    b.type === "bash_code_execution_tool_result" && b.content.type === "bash_code_execution_result"
      ? b.content.content.map((o) => o.file_id)
      : []
  );

  // Claude may re-save a figure after fixing it; each save is a new file, and the last one wins.
  const latest = new Map<string, string>();
  for (const fileId of fileIds) {
    try {
      const meta = await client.files.retrieveMetadata(fileId, {}, { signal });
      const name = meta.filename.split("/").pop() ?? meta.filename;
      if (/\.(png|jpe?g)$/i.test(name)) latest.set(name, fileId);
    } catch (err) {
      console.warn("Could not read generated file metadata", fileId, err);
    }
  }

  const figures: Figure[] = [];
  for (const [name, fileId] of [...latest].slice(0, MAX_FIGURES)) {
    try {
      const res = await client.files.download(fileId, {}, { signal });
      figures.push({ name, bytes: new Uint8Array(await res.arrayBuffer()) });
    } catch (err) {
      console.warn("Could not download generated file", fileId, err);
    }
  }

  // Generated files persist until deleted; Telegram keeps the copy users see.
  await Promise.all(
    fileIds.map((id) =>
      client.files.delete(id).catch((err) => console.warn("Could not delete file", id, err))
    ),
  );
  return figures;
}
