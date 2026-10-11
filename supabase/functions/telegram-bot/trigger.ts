// Pure helpers that decide whether a message is addressed to the bot and what to solve.

import type { Message, MessageEntity } from "./telegram.ts";

export const DEFAULT_QUESTION = "Rasmdagi masalani yeching";
export const DEFAULT_FOLLOW_UP = "Batafsilroq tushuntiring";

// Telegram's stand-in sender for anonymous group admins.
const ANONYMOUS_ADMIN = "GroupAnonymousBot";

export interface ImageRef {
  fileId: string;
  /** Declared type: photos are always JPEG; documents report their own (verified after download). */
  mimeType: string;
  /** Size in bytes when Telegram reports it, to reject oversized files before downloading. */
  size?: number;
}

export type Request =
  | { kind: "help" }
  | {
    kind: "solve";
    image: ImageRef | null;
    question: string;
    /** Set when the message replies to one of the bot's own messages: that message's id. */
    followUpOf: number | null;
  };

function textAndEntities(msg: Message): { text: string; entities: MessageEntity[] } {
  if (msg.caption !== undefined) {
    return { text: msg.caption, entities: msg.caption_entities ?? [] };
  }
  return { text: msg.text ?? "", entities: msg.entities ?? [] };
}

// Telegram entity offsets are in UTF-16 code units, which matches JS string indexing.
function mentionEntities(msg: Message, botUsername: string): MessageEntity[] {
  const { text, entities } = textAndEntities(msg);
  const target = `@${botUsername}`.toLowerCase();
  return entities.filter(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === target,
  );
}

export function isMentioned(msg: Message, botUsername: string): boolean {
  return mentionEntities(msg, botUsername).length > 0;
}

export function isReplyToBot(msg: Message, botUsername: string): boolean {
  return msg.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase();
}

/** `/start`, `/help`, or either addressed to this bot (`/help@Bot`). Other bots' commands return null. */
function command(msg: Message, botUsername: string): string | null {
  const match = (msg.text ?? "").match(/^\/(\w+)(?:@(\w+))?/);
  if (!match) return null;
  if (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return match[1].toLowerCase();
}

export function isPrivate(msg: Message): boolean {
  return msg.chat.type === "private";
}

/**
 * Who to attribute the request to (for rate limits), or null for senders we ignore (other bots).
 * Anonymous admins all post as the same bot user, so they are keyed by the chat they post as.
 */
export function senderOf(msg: Message): { id: number; username?: string } | null {
  if (!msg.from) return null;
  if (msg.from.is_bot) {
    if (msg.from.username === ANONYMOUS_ADMIN && msg.sender_chat) {
      return { id: msg.sender_chat.id, username: ANONYMOUS_ADMIN };
    }
    return null;
  }
  return { id: msg.from.id, username: msg.from.username };
}

/**
 * The bot answers in private chats, when it is mentioned, when someone replies to one of
 * its messages, and to its own commands.
 */
export function isAddressed(msg: Message, botUsername: string): boolean {
  const cmd = command(msg, botUsername);
  if (cmd === "start" || cmd === "help") return true;
  if (cmd !== null && !isPrivate(msg)) return false; // some other command
  return isPrivate(msg) || isMentioned(msg, botUsername) || isReplyToBot(msg, botUsername);
}

function imageOf(msg: Message): ImageRef | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return { fileId: largest.file_id, mimeType: "image/jpeg", size: largest.file_size };
  }
  if (msg.document?.mime_type?.startsWith("image/")) {
    return { fileId: msg.document.file_id, mimeType: msg.document.mime_type, size: msg.document.file_size };
  }
  return null;
}

/** Returns the message text with every mention of the bot removed. */
function stripMentions(msg: Message, botUsername: string): string {
  let { text } = textAndEntities(msg);
  // Remove from the end so earlier offsets stay valid.
  const mentions = mentionEntities(msg, botUsername).sort((a, b) => b.offset - a.offset);
  for (const m of mentions) {
    text = text.slice(0, m.offset) + text.slice(m.offset + m.length);
  }
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Prefixes the question with the passage the user quoted, when they replied with a quote. */
function withQuote(msg: Message, question: string): string {
  const quote = msg.quote?.text.trim();
  return quote ? `Quyidagi qism haqida: «${quote}»\n\n${question}` : question;
}

/**
 * Builds the request for a message addressed to the bot.
 * Returns a help request when there is nothing to solve (no image and no text).
 */
export function buildRequest(msg: Message, botUsername: string): Request {
  const cmd = command(msg, botUsername);
  if (cmd === "start" || cmd === "help") return { kind: "help" };

  const question = stripMentions(msg, botUsername);

  // A reply to the bot continues that conversation; the replied message is the bot's own text.
  if (isReplyToBot(msg, botUsername)) {
    return {
      kind: "solve",
      image: imageOf(msg),
      question: withQuote(msg, question || DEFAULT_FOLLOW_UP),
      followUpOf: msg.reply_to_message!.message_id,
    };
  }

  const reply = msg.reply_to_message;
  const image = imageOf(msg) ?? (reply ? imageOf(reply) : null);
  const text = question || (reply ? (reply.caption ?? reply.text ?? "").trim() : "");

  if (!image && !text) return { kind: "help" };
  return { kind: "solve", image, question: withQuote(msg, text || DEFAULT_QUESTION), followUpOf: null };
}
