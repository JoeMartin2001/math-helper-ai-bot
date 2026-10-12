import { assertEquals } from "@std/assert";
import type { Message } from "./telegram.ts";
import {
  buildRequest,
  DEFAULT_FOLLOW_UP,
  DEFAULT_QUESTION,
  isAddressed,
  isMentioned,
  isThanks,
  type Request,
  senderOf,
} from "./trigger.ts";

function question(r: Request): string | undefined {
  return r.kind === "solve" ? r.question : undefined;
}

const BOT = "MathHelperBot";

function msg(overrides: Partial<Message>): Message {
  return { message_id: 1, chat: { id: -100, type: "supergroup" }, ...overrides };
}

const photo = [
  { file_id: "small", width: 90, height: 60 },
  { file_id: "large", width: 1280, height: 853, file_size: 120_000 },
  { file_id: "medium", width: 320, height: 213 },
];

Deno.test("photo with mention in caption", () => {
  const m = msg({
    photo,
    caption: "@MathHelperBot 3-masalani yeching",
    caption_entities: [{ type: "mention", offset: 0, length: 14 }],
  });
  assertEquals(isMentioned(m, BOT), true);
  assertEquals(buildRequest(m, BOT), {
    kind: "solve",
    image: { fileId: "large", mimeType: "image/jpeg", size: 120_000 },
    question: "3-masalani yeching",
    followUpOf: null,
  });
});

Deno.test("mention is case-insensitive and can be mid-caption", () => {
  const m = msg({
    photo,
    caption: "Shu misolni @mathhelperbot tushuntiring",
    caption_entities: [{ type: "mention", offset: 12, length: 14 }],
  });
  assertEquals(isMentioned(m, BOT), true);
  assertEquals(question(buildRequest(m, BOT)), "Shu misolni tushuntiring");
});

Deno.test("no mention / other bot mentioned", () => {
  assertEquals(isMentioned(msg({ photo, caption: "yeching" }), BOT), false);
  const other = msg({
    photo,
    caption: "@OtherBot yeching",
    caption_entities: [{ type: "mention", offset: 0, length: 9 }],
  });
  assertEquals(isMentioned(other, BOT), false);
});

Deno.test("reply to a photo uses the replied image and its caption", () => {
  const m = msg({
    text: "@MathHelperBot",
    entities: [{ type: "mention", offset: 0, length: 14 }],
    reply_to_message: msg({ message_id: 0, photo, caption: "x² - 5x + 6 = 0 ni yeching" }),
  });
  assertEquals(buildRequest(m, BOT), {
    kind: "solve",
    image: { fileId: "large", mimeType: "image/jpeg", size: 120_000 },
    question: "x² - 5x + 6 = 0 ni yeching",
    followUpOf: null,
  });
});

Deno.test("reply with own question overrides replied caption", () => {
  const m = msg({
    text: "@MathHelperBot faqat javobini ayting",
    entities: [{ type: "mention", offset: 0, length: 14 }],
    reply_to_message: msg({ message_id: 0, photo, caption: "boshqa matn" }),
  });
  assertEquals(question(buildRequest(m, BOT)), "faqat javobini ayting");
});

Deno.test("image sent as document", () => {
  const m = msg({
    document: { file_id: "doc", mime_type: "image/png" },
    caption: "@MathHelperBot",
    caption_entities: [{ type: "mention", offset: 0, length: 14 }],
  });
  assertEquals(buildRequest(m, BOT), {
    kind: "solve",
    image: { fileId: "doc", mimeType: "image/png", size: undefined },
    question: DEFAULT_QUESTION,
    followUpOf: null,
  });
});

Deno.test("text-only problem without image", () => {
  const m = msg({
    text: "@MathHelperBot 2x + 3 = 11",
    entities: [{ type: "mention", offset: 0, length: 14 }],
  });
  assertEquals(buildRequest(m, BOT), {
    kind: "solve",
    image: null,
    question: "2x + 3 = 11",
    followUpOf: null,
  });
});

Deno.test("bare mention asks for help", () => {
  const m = msg({ text: "@MathHelperBot", entities: [{ type: "mention", offset: 0, length: 14 }] });
  assertEquals(buildRequest(m, BOT), { kind: "help" });
});

const botAnswer = msg({
  message_id: 50,
  from: { id: 9, username: "MathHelperBot", first_name: "Bot", is_bot: true },
  text: "Javob: x = 4",
});

Deno.test("reply to the bot's answer without a mention is a follow-up", () => {
  const m = msg({ text: "Soddaroq tushuntir", reply_to_message: botAnswer });
  assertEquals(isMentioned(m, BOT), false);
  assertEquals(isAddressed(m, BOT), true);
  assertEquals(buildRequest(m, BOT), {
    kind: "solve",
    image: null,
    question: "Soddaroq tushuntir",
    followUpOf: 50,
  });
});

Deno.test("follow-up with only a mention uses the default follow-up question", () => {
  const m = msg({
    text: "@MathHelperBot",
    entities: [{ type: "mention", offset: 0, length: 14 }],
    reply_to_message: botAnswer,
  });
  assertEquals(buildRequest(m, BOT), {
    kind: "solve",
    image: null,
    question: DEFAULT_FOLLOW_UP,
    followUpOf: 50,
  });
});

Deno.test("reply to another user's text message is not addressed to the bot", () => {
  const other = msg({ message_id: 7, from: { id: 3, first_name: "Ali", is_bot: false }, text: "salom" });
  assertEquals(isAddressed(msg({ text: "rahmat", reply_to_message: other }), BOT), false);
});

const user = { id: 5, username: "ali", first_name: "Ali", is_bot: false };

Deno.test("private chat: every message is addressed, no mention needed", () => {
  const m = msg({ chat: { id: 5, type: "private" }, from: user, text: "2x = 8" });
  assertEquals(isAddressed(m, BOT), true);
  assertEquals(buildRequest(m, BOT), { kind: "solve", image: null, question: "2x = 8", followUpOf: null });
});

Deno.test("commands: /help and /start for this bot only", () => {
  assertEquals(isAddressed(msg({ text: "/help" }), BOT), true);
  assertEquals(buildRequest(msg({ text: "/start" }), BOT), { kind: "help" });
  assertEquals(isAddressed(msg({ text: "/help@MathHelperBot" }), BOT), true);
  assertEquals(isAddressed(msg({ text: "/help@OtherBot" }), BOT), false);
  assertEquals(isAddressed(msg({ text: "/stats" }), BOT), false);
});

Deno.test("quoted reply includes the quoted passage", () => {
  const m = msg({
    text: "bu qayerdan chiqdi?",
    reply_to_message: botAnswer,
    quote: { text: "v² − 29v + 180 = 0" },
  });
  assertEquals(
    question(buildRequest(m, BOT)),
    "Quyidagi qism haqida: «v² − 29v + 180 = 0»\n\nbu qayerdan chiqdi?",
  );
});

Deno.test("sender: users, anonymous admins, and other bots", () => {
  assertEquals(senderOf(msg({ from: user })), { id: 5, username: "ali" });
  const anon = msg({
    from: { id: 1087968824, username: "GroupAnonymousBot", first_name: "Group", is_bot: true },
    sender_chat: { id: -100, type: "supergroup" },
  });
  assertEquals(senderOf(anon), { id: -100, username: "GroupAnonymousBot" });
  assertEquals(senderOf(msg({ from: { id: 7, username: "SomeBot", first_name: "B", is_bot: true } })), null);
  assertEquals(senderOf(msg({})), null);
});

Deno.test("multi-line questions keep their line breaks", () => {
  const m = msg({
    text: "@MathHelperBot\n1) 2x = 4\n2) 3x = 9",
    entities: [{ type: "mention", offset: 0, length: 14 }],
  });
  assertEquals(question(buildRequest(m, BOT)), "1) 2x = 4\n2) 3x = 9");
});

Deno.test("thanks messages are recognized, questions are not", () => {
  for (
    const t of [
      "Raxmat",
      "rahmat!",
      "Katta rahmat ustoz",
      "Rahmat sizga 🙏",
      "Спасибо",
      "ok",
      "Zo'r",
      "zo‘r!",
      "tushundim",
      "👍",
    ]
  ) {
    assertEquals(isThanks(t), true, t);
  }
  for (
    const t of [
      "Rahmat, lekin 2-qadam tushunarsiz",
      "Soddaroq tushuntir",
      "2x = 8",
      "Batafsilroq tushuntiring",
    ]
  ) {
    assertEquals(isThanks(t), false, t);
  }
});
