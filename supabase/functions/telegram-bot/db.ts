// Usage log, rate limiting and de-duplication backed by the `requests` table.

import { createClient } from "@supabase/supabase-js";

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into every edge function.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export type Status = "processing" | "done" | "error" | "rate_limited" | "not_allowed" | "over_budget";

const HOUR = 60 * 60 * 1000;
// A row still "processing" after this long belongs to a worker that was killed (e.g. wall-clock limit).
const STALE_AFTER_MS = 15 * 60 * 1000;

export interface NewRequest {
  updateId: number;
  chatId: number;
  userId: number;
  username?: string;
  question: string;
  image: { fileId: string; mimeType: string } | null;
  parentId: number | null;
  status?: Status;
}

/** One answered exchange of a conversation, as stored. */
export interface Turn {
  id: number;
  question: string;
  image: { fileId: string; mimeType: string } | null;
  answer: string;
}

// How many earlier exchanges a follow-up sees (oldest dropped first).
const MAX_THREAD_TURNS = 5;

/**
 * Inserts the request row. Returns its id, or null if this update was already
 * claimed (Telegram re-delivered it).
 */
export async function claimUpdate(req: NewRequest): Promise<number | null> {
  const { data, error } = await supabase
    .from("requests")
    .insert({
      update_id: req.updateId,
      chat_id: req.chatId,
      user_id: req.userId,
      username: req.username ?? null,
      question: req.question,
      has_image: req.image !== null,
      image_file_id: req.image?.fileId ?? null,
      image_mime: req.image?.mimeType ?? null,
      parent_id: req.parentId,
      status: req.status ?? "processing",
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return null; // unique_violation on update_id
    throw error;
  }
  return data.id;
}

/** Marks requests whose worker died mid-flight as errors, so they stop looking in-progress. */
export async function sweepStale(): Promise<void> {
  const { error } = await supabase
    .from("requests")
    .update({ status: "error", error: "abandoned: worker stopped before finishing" })
    .eq("status", "processing")
    .lt("created_at", new Date(Date.now() - STALE_AFTER_MS).toISOString());
  if (error) console.error("Failed to sweep stale requests", error);
}

/**
 * Counts the user's answered/in-flight requests in the past hour (excluding `excludeId`).
 * Failed requests don't count against the user. Returns null when under the limit,
 * otherwise the minutes until a slot frees up.
 */
export async function checkRateLimit(
  userId: number,
  limit: number,
  excludeId: number,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("requests")
    .select("created_at")
    .eq("user_id", userId)
    .neq("id", excludeId)
    .in("status", ["processing", "done"])
    .gte("created_at", new Date(Date.now() - HOUR).toISOString())
    .order("created_at", { ascending: true });

  if (error) throw error;
  if (data.length < limit) return null;

  // The oldest request in the window that must expire before the user is under the limit again.
  const oldest = new Date(data[data.length - limit].created_at).getTime();
  return Math.max(1, Math.ceil((oldest + HOUR - Date.now()) / 60_000));
}

/** Number of requests answered or in flight across all chats in the past 24 hours. */
export async function dailyCount(): Promise<number> {
  const { count, error } = await supabase
    .from("requests")
    .select("id", { count: "exact", head: true })
    .in("status", ["processing", "done"])
    .gte("created_at", new Date(Date.now() - 24 * HOUR).toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * Whether a row with `status` already exists for this user or chat within `windowMs`,
 * other than `excludeId`. Used to send each refusal notice once instead of on every message.
 */
export async function alreadyNotified(
  by: { userId: number } | { chatId: number },
  status: Status,
  windowMs: number,
  excludeId: number,
): Promise<boolean> {
  let query = supabase
    .from("requests")
    .select("id", { count: "exact", head: true })
    .eq("status", status)
    .neq("id", excludeId)
    .gte("created_at", new Date(Date.now() - windowMs).toISOString());
  query = "userId" in by ? query.eq("user_id", by.userId) : query.eq("chat_id", by.chatId);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Finds the answered request whose answer is in Telegram message `messageId` and returns
 * its conversation, oldest turn first. Returns an empty list if the message isn't a stored answer.
 */
export async function loadThread(chatId: number, messageId: number): Promise<Turn[]> {
  const columns = "id, question, image_file_id, image_mime, answer, parent_id";
  const { data: found, error } = await supabase
    .from("requests")
    .select(columns)
    .eq("chat_id", chatId)
    .contains("answer_message_ids", [messageId])
    .not("answer", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const turns: Turn[] = [];
  let row = found;
  while (row && turns.length < MAX_THREAD_TURNS) {
    turns.unshift({
      id: row.id,
      question: row.question ?? "",
      image: row.image_file_id
        ? { fileId: row.image_file_id, mimeType: row.image_mime ?? "image/jpeg" }
        : null,
      answer: row.answer,
    });
    if (!row.parent_id) break;
    const { data: parent, error: parentError } = await supabase
      .from("requests")
      .select(columns)
      .eq("id", row.parent_id)
      .not("answer", "is", null)
      .maybeSingle();
    if (parentError) throw parentError;
    row = parent;
  }
  return turns;
}

export async function finish(
  id: number,
  status: Exclude<Status, "processing">,
  extra: {
    usage?: {
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      costUsd: number;
    };
    error?: string;
    answer?: string;
    answerMessageIds?: number[];
    figures?: number;
  } = {},
): Promise<void> {
  const { error } = await supabase
    .from("requests")
    .update({
      status,
      input_tokens: extra.usage?.inputTokens ?? null,
      output_tokens: extra.usage?.outputTokens ?? null,
      cache_read_tokens: extra.usage?.cacheReadTokens ?? null,
      cache_write_tokens: extra.usage?.cacheWriteTokens ?? null,
      cost_usd: extra.usage ? Math.round(extra.usage.costUsd * 1e5) / 1e5 : null,
      error: extra.error ?? null,
      answer: extra.answer ?? null,
      answer_message_ids: extra.answerMessageIds ?? null,
      figures: extra.figures ?? 0,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) console.error("Failed to update request row", id, error);
}

// ---- Chats: which groups/private chats may use the bot ----

export type ChatStatus = "pending" | "approved" | "blocked";

export interface ChatRow {
  id: number;
  type: string;
  title: string | null;
  status: ChatStatus;
  is_member: boolean;
  added_by_id: number | null;
  added_by_username: string | null;
  created_at: string;
}

const CHAT_COLUMNS = "id, type, title, status, is_member, added_by_id, added_by_username, created_at";

export async function getChat(id: number): Promise<ChatRow | null> {
  const { data, error } = await supabase.from("chats").select(CHAT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Records a chat the bot hasn't seen before. Returns the stored row and whether this call created
 * it, so only one of several concurrent updates notifies the admins.
 */
export async function registerChat(chat: {
  id: number;
  type: string;
  title: string | null;
  status: ChatStatus;
  addedBy?: { id: number; username?: string };
}): Promise<{ row: ChatRow; created: boolean }> {
  const { data, error } = await supabase
    .from("chats")
    .insert({
      id: chat.id,
      type: chat.type,
      title: chat.title,
      status: chat.status,
      added_by_id: chat.addedBy?.id ?? null,
      added_by_username: chat.addedBy?.username ?? null,
      ...(chat.status !== "pending" && chat.addedBy
        ? { decided_by: chat.addedBy.id, decided_at: new Date().toISOString() }
        : {}),
    })
    .select(CHAT_COLUMNS)
    .single();
  if (!error) return { row: data, created: true };
  if (error.code !== "23505") throw error;
  return { row: (await getChat(chat.id))!, created: false };
}

export async function updateChat(
  id: number,
  patch: Partial<Pick<ChatRow, "title" | "type" | "is_member">> & {
    added_by_id?: number | null;
    added_by_username?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("chats").update(patch).eq("id", id);
  if (error) throw error;
}

export async function setChatStatus(
  id: number,
  status: ChatStatus,
  adminId: number,
): Promise<ChatRow | null> {
  const { data, error } = await supabase
    .from("chats")
    .update({ status, decided_by: adminId, decided_at: new Date().toISOString() })
    .eq("id", id)
    .select(CHAT_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Returns true (and records it) if the chat hasn't been told "awaiting approval" in the last day. */
export async function claimPendingNotice(id: number): Promise<boolean> {
  const dayAgo = new Date(Date.now() - 24 * HOUR).toISOString();
  const { data, error } = await supabase
    .from("chats")
    .update({ pending_notice_at: new Date().toISOString() })
    .eq("id", id)
    .or(`pending_notice_at.is.null,pending_notice_at.lt.${dayAgo}`)
    .select("id");
  if (error) throw error;
  return data.length > 0;
}

/** Carries a group's settings over when Telegram upgrades it to a supergroup (which gets a new id). */
export async function migrateChat(
  oldId: number,
  newChat: { id: number; type: string; title: string | null },
) {
  const old = await getChat(oldId);
  if (!old) return;
  const { error } = await supabase.from("chats").upsert({
    id: newChat.id,
    type: newChat.type,
    title: newChat.title ?? old.title,
    status: old.status,
    added_by_id: old.added_by_id,
    added_by_username: old.added_by_username,
  });
  if (error) throw error;
  await supabase.from("chats").update({ migrated_to: newChat.id, is_member: false }).eq("id", oldId);
}

export interface ChatListItem extends ChatRow {
  solved7d: number;
}

/** All chats (except ones migrated away), pending first, then approved, then blocked. */
export async function listChats(): Promise<ChatListItem[]> {
  const { data: chats, error } = await supabase
    .from("chats")
    .select(CHAT_COLUMNS)
    .is("migrated_to", null)
    // Students who opened the bot in private before it pointed them to the groups.
    .or("type.neq.private,status.neq.pending")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const { data: usage, error: usageError } = await supabase.from("chat_usage").select("chat_id, solved_7d");
  if (usageError) throw usageError;
  const solved = new Map(usage.map((u) => [u.chat_id, u.solved_7d]));

  const rank: Record<ChatStatus, number> = { pending: 0, approved: 1, blocked: 2 };
  return (chats as ChatRow[])
    .map((c) => ({ ...c, solved7d: (solved.get(c.id) as number | undefined) ?? 0 }))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.solved7d - a.solved7d);
}
