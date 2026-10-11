// Telegram webhook: acknowledges updates immediately and solves math problems in the background.

import Anthropic from "@anthropic-ai/sdk";
import {
  alreadyNotified,
  checkRateLimit,
  claimUpdate,
  dailyCount,
  finish,
  loadThread,
  sweepStale,
  type Turn,
} from "./db.ts";
import { answerForHistory, formatText, parseSegments, type Segment, splitFormatted } from "./format.ts";
import { encodeBase64, sniffImageType } from "./media.ts";
import { type Figure, type ImageData, solve } from "./solver.ts";
import { type Message, type Target, TelegramClient, type Update } from "./telegram.ts";
import { buildRequest, type ImageRef, isAddressed, senderOf } from "./trigger.ts";

// Provided by the Supabase Edge Runtime: keeps the worker alive for background work after responding.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const BOT_USERNAME = Deno.env.get("BOT_USERNAME")!.replace(/^@/, "");
const RATE_LIMIT_PER_HOUR = Number(Deno.env.get("RATE_LIMIT_PER_HOUR") ?? "10");
// Global cap on solved problems per 24h across all chats, to bound API spend.
const DAILY_REQUEST_LIMIT = Number(Deno.env.get("DAILY_REQUEST_LIMIT") ?? "300");
// Comma-separated chat ids allowed to use the bot; empty means every chat.
const ALLOWED_CHAT_IDS = new Set(
  (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
);
// Must stay below the Edge Function wall-clock limit (150s free plan, 400s paid) so we can still
// tell the user something went wrong before the worker is killed.
const SOLVE_TIMEOUT_MS = Number(Deno.env.get("SOLVE_TIMEOUT_SECONDS") ?? "120") * 1000;

// Claude's limit is 5 MB of base64, which encodes ~3.75 MB of image bytes.
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
const MINUTE = 60 * 1000;

const tg = new TelegramClient(BOT_TOKEN);

const MSG = {
  usage: `Salom! Men matematik masalalarni bosqichma-bosqich yechib beraman.\n\n` +
    `• Masala rasmini yuboring va izohda meni belgilang: @${BOT_USERNAME}\n` +
    `• Yoki masala rasmi bor xabarga javob (reply) qilib meni belgilang.\n` +
    `• Javobim bo'yicha savolingiz bo'lsa, shu javobga reply qilib yozing.`,
  working: "⏳ Yechilmoqda...",
  rateLimited: (minutes: number) =>
    `Siz bir soat ichida juda ko'p so'rov yubordingiz (${RATE_LIMIT_PER_HOUR} ta). Taxminan ${minutes} daqiqadan keyin qayta urinib ko'ring.`,
  notAllowed: (chatId: number) =>
    `Bu chatda bot hali yoqilmagan. Bot egasiga ushbu chat raqamini yuboring: ${chatId}`,
  overBudget: "Bugungi so'rovlar limiti tugadi. Iltimos, ertaga qayta urinib ko'ring.",
  badImage: "Bu rasm formatini o'qiy olmayman. Iltimos, rasmni oddiy surat (JPG/PNG) sifatida yuboring.",
  tooLarge: "Rasm juda katta. Iltimos, uni oddiy surat sifatida (fayl emas) yuboring.",
  refusal: "Kechirasiz, bu so'rovga javob bera olmayman.",
  truncated: "\n\n(Javob juda uzun bo'lgani uchun qisqartirildi.)",
  timeout:
    "Kechirasiz, bu masala juda uzoq vaqt oldi. Iltimos, savolni soddaroq qilib yoki masalani alohida yuboring.",
  busy: "Hozir so'rovlar juda ko'p. Iltimos, bir necha daqiqadan keyin qayta urinib ko'ring.",
  failed: "Kechirasiz, xatolik yuz berdi. Iltimos, birozdan keyin qayta urinib ko'ring.",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update.message;
  if (msg && senderOf(msg) && isAddressed(msg, BOT_USERNAME)) {
    // Ack now so Telegram doesn't retry while Claude is thinking; keep working after the response.
    EdgeRuntime.waitUntil(
      handle(update.update_id, msg).catch((err) => console.error("Unhandled error", update.update_id, err)),
    );
  }
  return new Response("ok");
});

async function handle(updateId: number, msg: Message): Promise<void> {
  const chatId = msg.chat.id;
  const sender = senderOf(msg)!;
  // In forum groups, keep chat actions in the same topic as the question.
  const target: Target = { chatId, threadId: msg.is_topic_message ? msg.message_thread_id : undefined };
  const send = (text: string) => tg.sendMessage(target, text, { replyTo: msg.message_id });

  const request = buildRequest(msg, BOT_USERNAME);
  if (request.kind === "help") {
    await send(MSG.usage);
    return;
  }

  await sweepStale();

  // A reply to one of our answers continues that conversation.
  const thread: Turn[] = request.followUpOf ? await loadThread(chatId, request.followUpOf) : [];
  let question = request.question;
  if (request.followUpOf && thread.length === 0) {
    // Not a stored answer (e.g. sent before conversations were saved): pass the replied text as context.
    const previous = msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "";
    if (previous) question = `Oldingi javobing:\n${previous}\n\nMening savolim: ${question}`;
  }

  const rowId = await claimUpdate({
    updateId,
    chatId,
    userId: sender.id,
    username: sender.username,
    question,
    image: request.image,
    parentId: thread.at(-1)?.id ?? null,
  });
  if (rowId === null) return; // duplicate delivery

  // From here on, every path must finish the row.
  let placeholderId: number | undefined;
  let typing: number | undefined;
  const notify = async (text: string) => {
    if (placeholderId !== undefined) {
      try {
        await tg.editMessageText(chatId, placeholderId, text);
        return;
      } catch { /* placeholder deleted or uneditable: send a new message instead */ }
    }
    await send(text);
  };

  try {
    if (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(chatId)) {
      console.warn("Chat not in ALLOWED_CHAT_IDS", chatId, msg.chat.type);
      if (!await alreadyNotified({ chatId }, "not_allowed", 24 * 60 * MINUTE, rowId)) {
        await notify(MSG.notAllowed(chatId));
      }
      await finish(rowId, "not_allowed");
      return;
    }

    if (await dailyCount() > DAILY_REQUEST_LIMIT) {
      console.warn("Daily request limit reached", DAILY_REQUEST_LIMIT);
      if (!await alreadyNotified({ chatId }, "over_budget", 60 * MINUTE, rowId)) {
        await notify(MSG.overBudget);
      }
      await finish(rowId, "over_budget");
      return;
    }

    const waitMinutes = await checkRateLimit(sender.id, RATE_LIMIT_PER_HOUR, rowId);
    if (waitMinutes !== null) {
      // Tell the user once; staying silent afterwards keeps a spammer from making the bot spam.
      if (!await alreadyNotified({ userId: sender.id }, "rate_limited", 10 * MINUTE, rowId)) {
        await notify(MSG.rateLimited(waitMinutes));
      }
      await finish(rowId, "rate_limited");
      return;
    }

    placeholderId = (await send(MSG.working)).message_id;
    // Chat actions expire after ~5s, so keep refreshing until we're done.
    typing = setInterval(() => tg.sendChatAction(target).catch(() => {}), 4500);
    tg.sendChatAction(target).catch(() => {});

    const signal = AbortSignal.timeout(SOLVE_TIMEOUT_MS);

    const image = await loadImage(request.image);
    if (typeof image === "string") {
      await notify(image);
      await finish(rowId, "error", { error: "unusable image" });
      return;
    }

    const history = await Promise.all(thread.map(async (turn) => ({
      question: turn.question,
      image: await loadHistoryImage(turn.image),
      answer: answerForHistory(turn.answer),
    })));

    const result = await solve({ history, question, image: image ?? undefined, signal });
    clearInterval(typing);
    if (result.kind === "refusal") {
      await notify(MSG.refusal);
      await finish(rowId, "done", { error: "refusal" });
      return;
    }

    const answer = (result.text || MSG.failed) + (result.truncated ? MSG.truncated : "");
    const placeholder = placeholderId;
    placeholderId = undefined; // deliver owns it now; if delivery fails midway, report in a new message
    const answerMessageIds = await deliver(target, msg.message_id, placeholder, answer, result.figures);
    await finish(rowId, "done", {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      answer,
      answerMessageIds,
      figures: result.figures.length,
    });
  } catch (err) {
    console.error("Request failed", updateId, err);
    const timedOut = err instanceof Anthropic.APIUserAbortError ||
      (err instanceof DOMException && err.name === "TimeoutError");
    const busy = err instanceof Anthropic.RateLimitError ||
      (err instanceof Anthropic.APIError && err.status === 529);
    await notify(timedOut ? MSG.timeout : busy ? MSG.busy : MSG.failed)
      .catch((e) => console.error("Failed to report error", e));
    await finish(rowId, "error", { error: timedOut ? "timeout" : describeError(err) });
  } finally {
    clearInterval(typing);
  }
}

/** Returns the base64 image, null if there is none, or a user-facing error message. */
async function loadImage(ref: ImageRef | null): Promise<ImageData | null | string> {
  if (!ref) return null;
  if (ref.size !== undefined && ref.size > MAX_IMAGE_BYTES) return MSG.tooLarge;

  const bytes = await tg.downloadFile(ref.fileId);
  if (bytes.byteLength > MAX_IMAGE_BYTES) return MSG.tooLarge;
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return MSG.badImage;
  return { base64: encodeBase64(bytes), mediaType };
}

/** Earlier images are best-effort context: skip any that can no longer be fetched. */
async function loadHistoryImage(ref: ImageRef | null): Promise<ImageData | undefined> {
  try {
    const image = await loadImage(ref);
    return typeof image === "string" ? undefined : image ?? undefined;
  } catch (err) {
    console.warn("Could not reload earlier image", err);
    return undefined;
  }
}

/**
 * Sends the answer as text and figures in the order Claude placed them. The first text chunk
 * replaces the placeholder; everything else is threaded under the question. Figures Claude
 * drew but didn't place go at the end. Returns the ids of all messages that carry the answer.
 */
async function deliver(
  target: Target,
  replyTo: number,
  placeholderId: number,
  answer: string,
  figures: Figure[],
): Promise<number[]> {
  const segments: Segment[] = parseSegments(answer);
  const byName = new Map(figures.map((f) => [f.name, f]));
  const placed = new Set(segments.flatMap((s) => (s.kind === "figure" ? [s.name] : [])));
  for (const f of figures) {
    if (!placed.has(f.name)) segments.push({ kind: "figure", name: f.name });
  }

  const ids: number[] = [];
  let placeholder: number | undefined = placeholderId;

  for (const segment of segments) {
    if (segment.kind === "figure") {
      const figure = byName.get(segment.name);
      if (!figure) continue; // Claude referenced a file that wasn't captured
      if (placeholder !== undefined) {
        // Content must stay in order, so the placeholder can't be reused for text after this figure.
        await tg.deleteMessage(target.chatId, placeholder).catch(() => {});
        placeholder = undefined;
      }
      const sent = await tg.sendPhoto(target, { bytes: figure.bytes, filename: figure.name }, { replyTo });
      ids.push(sent.message_id);
      continue;
    }
    for (const chunk of splitFormatted(formatText(segment.text))) {
      if (placeholder !== undefined) {
        try {
          await tg.editMessageText(target.chatId, placeholder, chunk.text, chunk.entities);
          ids.push(placeholder);
          placeholder = undefined;
          continue;
        } catch (err) {
          console.warn("Could not edit placeholder, sending a new message", err);
          placeholder = undefined;
        }
      }
      ids.push((await tg.sendMessage(target, chunk.text, { replyTo, entities: chunk.entities })).message_id);
    }
  }

  // Nothing replaced the placeholder (no text and no figures): remove it.
  if (placeholder !== undefined) {
    await tg.deleteMessage(target.chatId, placeholder).catch(() => {});
  }
  return ids;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `anthropic ${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
