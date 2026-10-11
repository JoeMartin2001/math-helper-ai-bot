// Pure rendering and parsing for the Telegram admin panel (no I/O, unit-tested).

import type { ChatListItem, ChatRow, ChatStatus } from "./db.ts";
import type { Chat, ChatMemberUpdated, InlineKeyboard } from "./telegram.ts";

const PAGE_SIZE = 8;
const MEMBER_STATUSES = ["member", "administrator", "creator", "restricted"];

export const ICON: Record<ChatStatus, string> = { approved: "✅", pending: "⏳", blocked: "⛔" };
export const STATUS_TEXT: Record<ChatStatus, string> = {
  approved: "ruxsat berilgan",
  pending: "kutilmoqda",
  blocked: "bloklangan",
};

/** Display name for a chat: the group title, or the person's name for private chats. */
export function chatTitle(chat: Chat): string | null {
  if (chat.title) return chat.title;
  const name = chat.first_name ?? "";
  return chat.username ? `${name} (@${chat.username})`.trim() : name || null;
}

function label(row: Pick<ChatRow, "title" | "id">): string {
  return row.title || String(row.id);
}

function typeText(type: string): string {
  return type === "private" ? "shaxsiy chat" : "guruh";
}

/** The admin notification for a single chat, with buttons for the actions that change its status. */
export function renderNotice(
  row: ChatRow,
  opts: { memberCount?: number; heading?: string } = {},
): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    opts.heading ?? `${ICON[row.status]} ${typeText(row.type)}`,
    `Nomi: ${label(row)}`,
    `ID: ${row.id}`,
    ...(opts.memberCount !== undefined ? [`A'zolar: ${opts.memberCount}`] : []),
    ...(row.added_by_id
      ? [
        `Qo'shgan: ${
          row.added_by_username ? "@" + row.added_by_username : "foydalanuvchi"
        } (${row.added_by_id})`,
      ]
      : []),
    `Holat: ${ICON[row.status]} ${STATUS_TEXT[row.status]}`,
  ];
  const approve = { text: "✅ Ruxsat berish", callback_data: `a:${row.id}` };
  const block = { text: "⛔ Bloklash", callback_data: `b:${row.id}` };
  const buttons = row.status === "pending"
    ? [approve, block]
    : row.status === "approved"
    ? [block]
    : [approve];
  return { text: lines.join("\n"), keyboard: [buttons] };
}

/** One page of the /groups list: a numbered line per chat and a row of buttons per chat. */
export function renderList(items: ChatListItem[], page: number): { text: string; keyboard: InlineKeyboard } {
  if (items.length === 0) return { text: "Hali hech qanday guruh yoki chat yo'q.", keyboard: [] };

  const pages = Math.ceil(items.length / PAGE_SIZE);
  page = Math.min(Math.max(page, 0), pages - 1);
  const start = page * PAGE_SIZE;
  const shown = items.slice(start, start + PAGE_SIZE);

  const counts = { pending: 0, approved: 0, blocked: 0 };
  for (const item of items) counts[item.status]++;

  const lines = shown.map((c, i) => {
    const n = start + i + 1;
    const detail = c.status === "approved" ? `${c.solved7d} ta yechim (7 kun)` : STATUS_TEXT[c.status];
    const left = c.is_member ? "" : " · 🚪 bot chiqarilgan";
    const kind = c.type === "private" ? "👤 " : "";
    return `${n}. ${ICON[c.status]} ${kind}${label(c)} — ${detail}${left}`;
  });

  const keyboard: InlineKeyboard = shown.map((c, i) => {
    const n = start + i + 1;
    const approve = { text: `${n}. ✅ Ruxsat`, callback_data: `a:${c.id}:${page}` };
    const block = { text: `${n}. ⛔ Bloklash`, callback_data: `b:${c.id}:${page}` };
    return c.status === "pending" ? [approve, block] : c.status === "approved" ? [block] : [approve];
  });
  if (pages > 1) {
    keyboard.push([
      { text: "◀️", callback_data: `g:${(page - 1 + pages) % pages}` },
      { text: `${page + 1}/${pages}`, callback_data: `g:${page}` },
      { text: "▶️", callback_data: `g:${(page + 1) % pages}` },
    ]);
  }

  const header =
    `Guruhlar va chatlar: ${items.length} (⏳ ${counts.pending} · ✅ ${counts.approved} · ⛔ ${counts.blocked})`;
  return { text: [header, "", ...lines].join("\n"), keyboard };
}

export type CallbackAction =
  | { kind: "status"; chatId: number; status: "approved" | "blocked"; page?: number }
  | { kind: "page"; page: number };

export function parseCallback(data: string | undefined): CallbackAction | null {
  const m = data?.match(/^([abg]):(-?\d+)(?::(\d+))?$/);
  if (!m) return null;
  if (m[1] === "g") return { kind: "page", page: Number(m[2]) };
  return {
    kind: "status",
    chatId: Number(m[2]),
    status: m[1] === "a" ? "approved" : "blocked",
    page: m[3] !== undefined ? Number(m[3]) : undefined,
  };
}

/** Whether a my_chat_member update means the bot just joined, just left, or neither. */
export function membershipChange(u: ChatMemberUpdated): "joined" | "left" | null {
  const was = MEMBER_STATUSES.includes(u.old_chat_member.status);
  const is = MEMBER_STATUSES.includes(u.new_chat_member.status);
  if (!was && is) return "joined";
  if (was && !is) return "left";
  return null;
}
