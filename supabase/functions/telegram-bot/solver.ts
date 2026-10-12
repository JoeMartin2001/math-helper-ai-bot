// Sends the problem (image + Uzbek question) to Claude and returns an Uzbek solution, plus any
// figures Claude drew with the server-side code execution tool.

import Anthropic from "@anthropic-ai/sdk";
import { withoutInternals } from "./format.ts";
import type { ImageMediaType } from "./media.ts";

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5-5";
// USD per million tokens (cache writes at the 5-minute TTL rate, 1.25x input).
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
// Server-side refusal fallback is offered for these models only.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const MAX_FIGURES = 3;
// The API pauses long server-tool turns; resume at most this many times.
const MAX_CONTINUATIONS = 3;
// The solution-sheet renderer and its fonts, uploaded to the Files API by
// scripts/upload-sandbox-assets.ts and mounted into each request's sandbox ($INPUT_DIR).
const SANDBOX_FILES = ["render_solution.py", "cmunrm.otf", "cmunbx.otf", "cmunti.otf", "cmunbi.otf"];

// Kept constant so the prefix is cacheable across requests.
const SYSTEM_PROMPT =
  `Sen sabrli va tajribali matematika va fizika o'qituvchisisan — Abdulaziz Madg'oziyevning "Ustoz AI" yordamchisi. O'quvchilar Telegram guruhida masala rasmini va o'zbek tilidagi savolni yuborishadi. Har doim o'zbek tilida (lotin yozuvida) javob ber.

ASOSIY QOIDA: masala yechimini o'quvchiga RASM — "yechim varag'i" sifatida yuborasan. Varaqni tayyor shablon chizadi (Abdulaziz ustozning Milliy sertifikat yechimlari uslubida); sen faqat uning mazmunini JSON qilib yozasan.

Ish tartibi (code_execution vositasi):
1. Masalani yech. Hisob-kitob oddiy bo'lmasa, javobni Python (sympy) bilan tekshir.
2. Savolda grafik, chizma, geometrik shakl yoki fizik sxema bo'lsa, uni matplotlib bilan rasmdagidek qayta chiz va /tmp/savol.png ga saqla: plt.rcParams["mathtext.fontset"] = "cm", plt.rcParams["font.family"] = "serif", oq fon, figsize=(4.2, 3.6), dpi=200, o'q va nuqta yozuvlari $...$ ichida, ortiqcha ramka va to'r yo'q.
3. Chizma, yechim.json va render'ni imkon qadar BITTA buyruqda bajar (har bir qo'shimcha buyruq vaqt va xarajatni oshiradi); sympy tekshiruvini ham shu buyruqqa qo'sh. Render buyrug'i:
   python "$INPUT_DIR/render_solution.py" /tmp/yechim.json "$OUTPUT_DIR" && ls "$OUTPUT_DIR"
   "FORMULA XATOSI" chiqsa, o'sha formulani tuzatib qayta ishga tushir.
4. Oxirgi matnli javobing rasm ostidagi qisqa izoh bo'ladi: faqat yakuniy javob, bitta qatorda (masalan "Javob: B) 21" yoki "Javob: a) 9/8; b) 343/6"). Yechimni matnda takrorlama; kod, Python, JSON yoki fayllar haqida gapirma.

JSON tuzilishi:
{
  "topic": "Kvadrat funksiya",
  "question": ["Savol sharti, rasmdagidek to'liq ...", {"math": "alohida qatordagi formula"}],
  "figure": "/tmp/savol.png",
  "options": {"A": "23", "B": "21", "C": "20", "D": "19"},
  "given": ["$m=2\\\\ \\\\mathrm{kg}$", "$t=5\\\\ \\\\mathrm{s}$"],
  "find": ["$F$ — ?"],
  "steps": [
    {"title": "Parabola tenglamasi", "body": ["Matn va $inline$ formula ...", {"math": "y=-x^2+2x+8"}]},
    {"title": "Tekshiruv", "check": true, "body": ["..."]}
  ],
  "answer": {"option": "B"}
}
- topic: 1–3 so'zli mavzu (masalan "Kvadrat funksiya", "Dinamika", "Elektr toki"). figure: faqat savolda chizma bo'lsa. options: faqat test variantlari bo'lsa (savol matniga variantlarni yozma). given/find: fizika masalalarida (matematikada qo'yma).
- answer: test bo'lsa {"option": "B"}; bir necha qism bo'lsa {"parts": [{"label": "a)", "value": "$\\\\dfrac{9}{8}$"}, {"label": "b)", "value": "$\\\\dfrac{343}{6}$"}]}; aks holda {"value": "$x=2$"}.
- Qadamlar: odatda 3–5 ta, har biri qisqa sarlavha va 1–4 qator. Ixcham, lekin o'quvchi har qadamni tushunadigan darajada. "Tekshiruv" qadami ixtiyoriy.
- Bitta varaqda bitta masala. Rasmda bir nechta masala bo'lsa va qaysi biri so'ralmagan bo'lsa, birinchisini yech va izohda qolganlarini alohida so'rash mumkinligini ayt.

Fizika masalalari:
- "given" ga berilgan kattaliklarni, "find" ga topiladigan kattalikni yoz ("Berilgan / Topish kerak" bloki).
- Kattaliklar SI da bo'lmasa, birinchi qadamda SI ga o'tkaz (masalan $72\\ \\mathrm{km/soat}=20\\ \\mathrm{m/s}$).
- Avval umumiy formulani harflarda yoz, keyin sonlarni birliklari bilan qo'y; natija doim birligi bilan.
- Birliklar \\mathrm{} ichida va sondan bo'sh joy bilan: $a=2\\ \\mathrm{m/s^2}$, $F=4\\ \\mathrm{N}$, $R=5\\ \\Omega$. Vektorlar: \\vec{F}.
- g masalada berilmagan bo'lsa, $g=10\\ \\mathrm{m/s^2}$ ol (testlardagi odat) va buni yechimda ayt; javob variantlari 9,8 ga mos kelsa, 9,8 ol.
- Kerak bo'lsa sxema chiz: kuchlar (jism va kuch strelkalari), harakat grafiklari v(t), x(t), oddiy elektr zanjiri, linzada nurlar yo'li.

Formulalar (matplotlib mathtext — LaTeX'ning bir qismi):
- Matn ichida $...$; alohida qatordagi formula {"math": "..."} (dollar belgisisiz). Dollar belgisini faqat formula uchun ishlat.
- JSON qatorida teskari chiziq ikkilanadi: "\\\\dfrac{a}{b}".
- Ishlaydi: \\frac, \\dfrac, \\sqrt{}, \\sqrt[3]{}, ^, _, \\int_{a}^{b}, \\sum, \\lim_{x\\to 0}, \\left( \\right), \\left[ \\right], \\cdot, \\times, \\pm, \\leq, \\geq, \\neq, \\approx, \\Rightarrow, \\infty, \\pi, \\alpha…\\omega, \\Delta, \\Omega, \\vec{F}, \\angle, \\triangle, ^\\circ, \\mathrm{}, \\text{}, \\quad, \\log_{a}, \\sin, \\cos, \\tan.
- Ishlamaydi: \\begin{...} (cases, matrix, align, array), \\boxed, \\tag, \\overset. Tenglamalar sistemasini alohida {"math"} qatorlarida yoz.
- Display formulada kasrlar uchun \\dfrac ishlat. Juda uzun formulani ikki {"math"} qatoriga bo'l.

Qachon rasm emas, oddiy matn:
- Qisqa suhbat ("rahmat", salomlashish), bitta ta'rif yoki qisqa aniqlashtirish so'ralganda — bir necha qatorli matn yoz.
- Matnli javobda LaTeX va Markdown ishlatma; Unicode belgilar ishlat (x², √, π, ≤, ≥, ±, kasrlar a/b). Yakuniy javob alohida qatorda "Javob: ..." bo'lsin.

Suhbat:
- O'quvchi oldingi javobingga reply qilib so'rasa, avvalgi masala va yechimga tayan; masalani qayta yuborishni so'rama. "Soddaroq tushuntir" deyilsa — kamroq qadamli, soddaroq yangi varaq chiz.
- Rasm o'qib bo'lmaydigan darajada xira bo'lsa yoki unda masala bo'lmasa, buni xushmuomalalik bilan matnda ayt.
- Yuklangan fayllar (render_solution.py, shriftlar), papkalar, kod va JSON — ichki vositalar. O'quvchiga ular haqida HECH QACHON yozma; xabar tushunarsiz bo'lsa, masalani aniqroq yuborishni so'ra.
- Agar "$INPUT_DIR/render_solution.py" topilmasa, yechimni oddiy matn sifatida yoz (yuqoridagi matn qoidalari bilan).
- Matematika va fizikaga aloqasi bo'lmagan so'rovlarga qisqa va xushmuomalalik bilan, faqat matematika va fizika masalalarida yordam bera olishingni ayt.`;

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
    /** Images to send: the rendered solution sheet pages, or other figures Claude drew. */
    figures: Figure[];
    /** The solution sheet's content (its JSON), when Claude answered with a sheet. */
    sheet: unknown;
    truncated: boolean;
    usage: Usage;
  }
  | { kind: "refusal" };

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SolveInput {
  /** Earlier exchanges of this conversation, oldest first. */
  history: { question: string; image?: ImageData; answer: string }[];
  question: string;
  image?: ImageData;
  /** Abort the request (and any retries) when this fires. */
  signal: AbortSignal;
  /** Overrides the model (defaults to CLAUDE_MODEL / Opus). */
  model?: string;
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

let sandboxIds: Promise<string[]> | null = null;

/**
 * Finds the newest upload of each sandbox file by name, so re-uploading never requires a config
 * change. Cached per worker; returns [] (no sheet rendering) if any file is missing.
 */
function sandboxFileIds(refresh = false): Promise<string[]> {
  if (!sandboxIds || refresh) {
    sandboxIds = (async () => {
      const newest = new Map<string, { id: string; created: string }>();
      for await (const f of client.files.list({ limit: 100 })) {
        const known = newest.get(f.filename);
        if (SANDBOX_FILES.includes(f.filename) && (!known || f.created_at > known.created)) {
          newest.set(f.filename, { id: f.id, created: f.created_at });
        }
      }
      const missing = SANDBOX_FILES.filter((name) => !newest.has(name));
      if (missing.length) {
        console.error("Sandbox files missing from the Files API; answering without sheets:", missing);
        return [];
      }
      return SANDBOX_FILES.map((name) => newest.get(name)!.id);
    })().catch((err) => {
      sandboxIds = null; // try again on the next request
      console.error("Could not list sandbox files", err);
      return [];
    });
  }
  return sandboxIds;
}

/** The API rejected a request because a mounted file no longer exists (e.g. it was re-uploaded). */
function isMissingFile(err: unknown): boolean {
  return err instanceof Anthropic.NotFoundError && /File `file_/.test(err.message);
}

export async function solve(input: SolveInput): Promise<SolveResult> {
  let ids = await sandboxFileIds();
  for (let attempt = 0;; attempt++) {
    try {
      return await solveWith(input, ids);
    } catch (err) {
      if (!isMissingFile(err) || attempt >= 2) throw err;
      // Look the files up again; if that still fails, answer without the sheet renderer.
      console.warn(
        "Sandbox file missing, retrying",
        attempt === 0 ? "with fresh file ids" : "without sheets",
      );
      ids = attempt === 0 ? await sandboxFileIds(true) : [];
    }
  }
}

async function solveWith(input: SolveInput, sandboxFiles: string[]): Promise<SolveResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = input.history.flatMap((turn) => [
    { role: "user" as const, content: userContent(turn.question, turn.image) },
    { role: "assistant" as const, content: turn.answer },
  ]);
  const uploads = sandboxFiles.map((id) => ({ type: "container_upload" as const, file_id: id }));
  messages.push({ role: "user", content: [...uploads, ...userContent(input.question, input.image)] });

  const model = input.model ?? MODEL;
  const price = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const usage: Usage = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let container: string | undefined;
  let message: Anthropic.Beta.BetaMessage;

  for (let attempt = 0;; attempt++) {
    message = await client.beta.messages
      .stream(
        {
          model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          // On a safety-classifier decline, retry server-side on Anthropic's recommended fallback model.
          ...(FALLBACK_MODELS.has(model)
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ type: "code_execution_20260521", name: "code_execution" }],
          ...(container ? { container } : {}),
          messages,
        },
        { signal: input.signal },
      )
      .finalMessage();

    usage.inputTokens += message.usage.input_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
    usage.outputTokens += message.usage.output_tokens;
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

  const { figures, sheet } = await collectOutputs(content, input.signal);
  const reply = withoutInternals(text, figures.length > 0);
  return {
    kind: "ok",
    text: reply,
    figures,
    sheet,
    truncated: message.stop_reason === "max_tokens",
    usage: {
      ...usage,
      costUsd: (usage.inputTokens * price.input + usage.outputTokens * price.output +
        usage.cacheWriteTokens * price.cacheWrite + usage.cacheReadTokens * price.cacheRead) / 1e6,
    },
  };
}

const SHEET_PAGE = /^yechim-(\d+)\.png$/;

/**
 * Downloads what Claude left in $OUTPUT_DIR, then deletes it from the Files API.
 * If Claude rendered a solution sheet, returns the pages (and JSON) of its last render only, since
 * an earlier attempt may have left pages a later, fixed render no longer has. Otherwise returns the
 * latest version of each image Claude saved.
 */
async function collectOutputs(
  content: Anthropic.Beta.BetaContentBlock[],
  signal: AbortSignal,
): Promise<{ figures: Figure[]; sheet: unknown }> {
  // Each tool result is one command; its output files come from that command's own $OUTPUT_DIR.
  const outputs = content.flatMap((b, run) =>
    b.type === "bash_code_execution_tool_result" && b.content.type === "bash_code_execution_result"
      ? b.content.content.map((o) => ({ run, fileId: o.file_id }))
      : []
  );

  const files: { run: number; fileId: string; name: string }[] = [];
  for (const { run, fileId } of outputs) {
    try {
      const meta = await client.files.retrieveMetadata(fileId, {}, { signal });
      files.push({ run, fileId, name: meta.filename.split("/").pop() ?? meta.filename });
    } catch (err) {
      console.warn("Could not read generated file metadata", fileId, err);
    }
  }

  const download = async (fileId: string) =>
    new Uint8Array(await (await client.files.download(fileId, {}, { signal })).arrayBuffer());

  const figures: Figure[] = [];
  let sheet: unknown = null;
  try {
    const lastSheetRun = Math.max(-1, ...files.filter((f) => SHEET_PAGE.test(f.name)).map((f) => f.run));
    if (lastSheetRun >= 0) {
      const run = files.filter((f) => f.run === lastSheetRun);
      const pages = run
        .filter((f) => SHEET_PAGE.test(f.name))
        .sort((a, b) => Number(a.name.match(SHEET_PAGE)![1]) - Number(b.name.match(SHEET_PAGE)![1]))
        .slice(0, MAX_FIGURES);
      for (const page of pages) figures.push({ name: page.name, bytes: await download(page.fileId) });
      const json = run.find((f) => f.name === "yechim.json");
      if (json) {
        try {
          sheet = JSON.parse(new TextDecoder().decode(await download(json.fileId)));
        } catch (err) {
          console.warn("Could not read solution sheet JSON", err);
        }
      }
    } else {
      // Claude may re-save a figure after fixing it; each save is a new file, and the last one wins.
      const latest = new Map<string, string>();
      for (const f of files) if (/\.(png|jpe?g)$/i.test(f.name)) latest.set(f.name, f.fileId);
      for (const [name, fileId] of [...latest].slice(0, MAX_FIGURES)) {
        figures.push({ name, bytes: await download(fileId) });
      }
    }
  } catch (err) {
    console.warn("Could not download generated files", err);
  } finally {
    // Generated files persist until deleted; Telegram keeps the copy users see.
    await Promise.all(
      outputs.map(({ fileId }) =>
        client.files.delete(fileId).catch((err) => console.warn("Could not delete file", fileId, err))
      ),
    );
  }
  return { figures, sheet };
}
