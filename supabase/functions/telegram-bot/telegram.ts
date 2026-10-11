// Minimal Telegram Bot API client — only the methods and fields this bot uses.

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface Document {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface User {
  id: number;
  username?: string;
  first_name: string;
  is_bot: boolean;
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat: { id: number; type: string };
  from?: User;
  /** Set when an anonymous group admin (or a channel) posts on behalf of the chat. */
  sender_chat?: { id: number; type: string };
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  photo?: PhotoSize[];
  document?: Document;
  media_group_id?: string;
  reply_to_message?: Message;
  /** The part of the replied-to message the user selected when replying. */
  quote?: { text: string };
}

export interface Update {
  update_id: number;
  message?: Message;
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly parameters?: { retry_after?: number; migrate_to_chat_id?: number },
  ) {
    super(`Telegram ${method} failed: ${code} ${description}`);
  }
}

/** Where to post: the chat, plus the forum topic when the group uses topics. */
export interface Target {
  chatId: number;
  threadId?: number;
}

// Telegram's getFile only serves files up to 20 MB.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramClient {
  private readonly base: string;
  private readonly fileBase: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData, attempt = 0): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      ...(body instanceof FormData
        ? { body }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json = await res.json();
    if (json.ok) return json.result as T;

    const err = new TelegramError(method, json.error_code, json.description, json.parameters);
    // Flood control: wait as instructed once, if the wait is short enough to fit our time budget.
    const retryAfter = err.parameters?.retry_after;
    if (err.code === 429 && retryAfter !== undefined && retryAfter <= 10 && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.call<T>(method, body, attempt + 1);
    }
    throw err;
  }

  sendMessage(
    to: Target,
    text: string,
    opts: { replyTo?: number; entities?: MessageEntity[] } = {},
  ): Promise<Message> {
    return this.call<Message>("sendMessage", {
      chat_id: to.chatId,
      ...(to.threadId ? { message_thread_id: to.threadId } : {}),
      text,
      ...(opts.entities?.length ? { entities: opts.entities } : {}),
      ...(opts.replyTo
        ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
        : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    entities?: MessageEntity[],
  ): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(entities?.length ? { entities } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  sendPhoto(
    to: Target,
    photo: { bytes: Uint8Array; filename: string },
    opts: { replyTo?: number; caption?: string; captionEntities?: MessageEntity[] } = {},
  ): Promise<Message> {
    const form = new FormData();
    form.set("chat_id", String(to.chatId));
    if (to.threadId) form.set("message_thread_id", String(to.threadId));
    form.set("photo", new Blob([photo.bytes as BlobPart]), photo.filename);
    if (opts.caption) form.set("caption", opts.caption);
    if (opts.captionEntities?.length) form.set("caption_entities", JSON.stringify(opts.captionEntities));
    if (opts.replyTo) {
      form.set(
        "reply_parameters",
        JSON.stringify({ message_id: opts.replyTo, allow_sending_without_reply: true }),
      );
    }
    return this.call<Message>("sendPhoto", form);
  }

  sendChatAction(to: Target, action = "typing"): Promise<unknown> {
    return this.call("sendChatAction", {
      chat_id: to.chatId,
      ...(to.threadId ? { message_thread_id: to.threadId } : {}),
      action,
    });
  }

  /** Downloads a file by file_id. */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
    const res = await fetch(`${this.fileBase}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
