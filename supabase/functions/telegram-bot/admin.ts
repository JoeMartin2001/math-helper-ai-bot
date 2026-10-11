// Admin panel inside Telegram: approve or block the groups (and private chats) that may use the bot.
// Admins get a message with buttons when the bot meets a new chat, and manage all chats with /groups.

import { chatTitle, membershipChange, parseCallback, renderList, renderNotice } from "./admin_view.ts";
import {
  type ChatRow,
  claimPendingNotice,
  getChat,
  listChats,
  migrateChat,
  registerChat,
  setChatStatus,
  updateChat,
} from "./db.ts";
import type {
  CallbackQuery,
  ChatMemberUpdated,
  InlineKeyboard,
  Message,
  TelegramClient,
} from "./telegram.ts";

const TEXT = {
  pendingInChat:
    "⏳ Bot hozircha bu yerda faol emas: bot egasi tasdiqlashi kerak. Tasdiqlangach, shu yerda xabar beraman.",
  approvedInGroup: "✅ Bot bu guruhda faollashtirildi!",
  approvedInPrivate: "✅ Endi botdan foydalanishingiz mumkin!",
  blockedInGroup: "⛔ Bot bu guruhda o'chirildi.",
  notAdmin: "Bu amal faqat bot egasi uchun.",
  adminHelp: "\n\nAdmin buyruqlari:\n/groups — guruhlar va chatlarni boshqarish",
};

export class AdminPanel {
  constructor(
    private readonly tg: TelegramClient,
    private readonly adminIds: Set<number>,
    /** Usage instructions, posted in a group once it is approved. */
    private readonly usage: string,
  ) {}

  isAdmin(userId: number): boolean {
    return this.adminIds.has(userId);
  }

  /** Help text, with the admin commands appended for admins. */
  helpFor(userId: number): string {
    return this.usage + (this.isAdmin(userId) ? TEXT.adminHelp : "");
  }

  /**
   * Returns whether the bot may answer in this message's chat. Unknown chats are registered
   * (approved if an admin is the one using it, pending otherwise, with admins notified); pending
   * chats are told once a day that they are awaiting approval.
   */
  async checkAccess(msg: Message, sender: { id: number; username?: string }): Promise<boolean> {
    if (msg.chat.type === "private" && this.isAdmin(sender.id)) return true;

    let row = await getChat(msg.chat.id);
    if (!row) {
      const { row: created, created: isNew } = await registerChat({
        id: msg.chat.id,
        type: msg.chat.type,
        title: chatTitle(msg.chat),
        status: this.isAdmin(sender.id) ? "approved" : "pending",
        addedBy: sender,
      });
      row = created;
      if (isNew && row.status === "pending") {
        await this.notifyAdmins(row, "🔔 Yangi chat botdan foydalanmoqchi");
      }
    } else if (row.title !== chatTitle(msg.chat) || !row.is_member) {
      await updateChat(row.id, { title: chatTitle(msg.chat), is_member: true });
    }

    if (row.status === "pending" && await claimPendingNotice(row.id)) {
      await this.tg.sendMessage({ chatId: row.id }, TEXT.pendingInChat).catch(warn("pending notice"));
    }
    return row.status === "approved";
  }

  /** The bot was added to or removed from a chat (or a user started/blocked it in private). */
  async onMembership(u: ChatMemberUpdated): Promise<void> {
    if (u.chat.type === "channel") return;
    const change = membershipChange(u);
    if (change === "left") {
      await updateChat(u.chat.id, { is_member: false }).catch(warn("mark left"));
      return;
    }
    if (change !== "joined") return;

    const addedBy = { id: u.from.id, username: u.from.username };
    let row = await getChat(u.chat.id);
    if (row) {
      await updateChat(row.id, {
        title: chatTitle(u.chat),
        type: u.chat.type,
        is_member: true,
        added_by_id: addedBy.id,
        added_by_username: addedBy.username ?? null,
      });
      row = { ...row, added_by_id: addedBy.id, added_by_username: addedBy.username ?? null };
    } else {
      row = (await registerChat({
        id: u.chat.id,
        type: u.chat.type,
        title: chatTitle(u.chat),
        status: this.isAdmin(addedBy.id) ? "approved" : "pending",
        addedBy,
      })).row;
    }

    const target = { chatId: row.id };
    if (row.status === "approved") {
      if (u.chat.type !== "private") await this.tg.sendMessage(target, this.usage).catch(warn("welcome"));
    } else if (row.status === "pending") {
      if (await claimPendingNotice(row.id)) {
        await this.tg.sendMessage(target, TEXT.pendingInChat).catch(warn("pending notice"));
      }
      await this.notifyAdmins(row, "🔔 Bot yangi chatga qo'shildi");
    }
    // Blocked chats re-adding the bot get no reply.
  }

  async onCallback(cq: CallbackQuery): Promise<void> {
    if (!this.isAdmin(cq.from.id)) {
      await this.tg.answerCallbackQuery(cq.id, TEXT.notAdmin);
      return;
    }
    const action = parseCallback(cq.data);
    const where = cq.message ? { chatId: cq.message.chat.id, messageId: cq.message.message_id } : null;
    if (!action || !where) {
      await this.tg.answerCallbackQuery(cq.id);
      return;
    }

    if (action.kind === "page") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.showList(where, action.page);
      return;
    }

    const before = await getChat(action.chatId);
    const row = await setChatStatus(action.chatId, action.status, cq.from.id);
    if (!row) {
      await this.tg.answerCallbackQuery(cq.id, "Chat topilmadi");
      return;
    }
    await this.tg.answerCallbackQuery(
      cq.id,
      action.status === "approved" ? "✅ Ruxsat berildi" : "⛔ Bloklandi",
    );
    if (before?.status !== row.status) await this.announce(row);

    if (action.page !== undefined) {
      await this.showList(where, action.page);
    } else {
      const { text, keyboard } = renderNotice(row);
      await this.edit(where, text, keyboard);
    }
  }

  /** Handles admin-only commands in a private chat. Returns true if the message was one. */
  async onCommand(msg: Message, userId: number): Promise<boolean> {
    if (msg.chat.type !== "private" || !this.isAdmin(userId)) return false;
    const cmd = (msg.text ?? "").match(/^\/(\w+)/)?.[1]?.toLowerCase();
    if (cmd !== "groups") return false;
    const { text, keyboard } = renderList(await listChats(), 0);
    await this.tg.sendMessage({ chatId: msg.chat.id }, text, { keyboard });
    return true;
  }

  /** A group was upgraded to a supergroup: its id changed, so carry its status over. */
  async onMigration(msg: Message): Promise<void> {
    if (msg.migrate_from_chat_id) {
      await migrateChat(msg.migrate_from_chat_id, {
        id: msg.chat.id,
        type: msg.chat.type,
        title: chatTitle(msg.chat),
      });
    }
  }

  private async notifyAdmins(row: ChatRow, heading: string): Promise<void> {
    const memberCount = row.type === "private"
      ? undefined
      : await this.tg.getChatMemberCount(row.id).catch(() => undefined);
    const { text, keyboard } = renderNotice(row, { memberCount, heading });
    await Promise.all([...this.adminIds].map((id) =>
      // Fails if the admin never opened a private chat with the bot (bots can't message first).
      this.tg.sendMessage({ chatId: id }, text, { keyboard }).catch(warn(`notify admin ${id}`))
    ));
  }

  /** Tells the chat itself about an admin decision. */
  private async announce(row: ChatRow): Promise<void> {
    if (!row.is_member) return;
    const text = row.status === "approved"
      ? (row.type === "private" ? TEXT.approvedInPrivate : `${TEXT.approvedInGroup}\n\n${this.usage}`)
      : row.type === "private"
      ? null
      : TEXT.blockedInGroup;
    if (text) await this.tg.sendMessage({ chatId: row.id }, text).catch(warn("announce decision"));
  }

  private async showList(where: { chatId: number; messageId: number }, page: number): Promise<void> {
    const { text, keyboard } = renderList(await listChats(), page);
    await this.edit(where, text, keyboard);
  }

  private async edit(where: { chatId: number; messageId: number }, text: string, keyboard: InlineKeyboard) {
    await this.tg.editMessageText(where.chatId, where.messageId, text, undefined, keyboard).catch((err) => {
      // Pressing a button that doesn't change anything (e.g. the page counter) is not an error.
      if (!String(err).includes("message is not modified")) throw err;
    });
  }
}

function warn(what: string) {
  return (err: unknown) => console.warn(`Could not ${what}:`, err);
}
