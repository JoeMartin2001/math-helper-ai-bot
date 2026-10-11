import { assert, assertEquals } from "@std/assert";
import { chatTitle, membershipChange, parseCallback, renderList, renderNotice } from "./admin_view.ts";
import type { ChatListItem, ChatRow } from "./db.ts";

function row(overrides: Partial<ChatListItem> = {}): ChatListItem {
  return {
    id: -1001,
    type: "supergroup",
    title: "9-B sinf",
    status: "pending",
    is_member: true,
    added_by_id: 5,
    added_by_username: "ali",
    created_at: "2026-10-11T00:00:00Z",
    solved7d: 0,
    ...overrides,
  };
}

Deno.test("callback data round-trips through parseCallback", () => {
  assertEquals(parseCallback("a:-1001"), {
    kind: "status",
    chatId: -1001,
    status: "approved",
    page: undefined,
  });
  assertEquals(parseCallback("b:-1001:2"), { kind: "status", chatId: -1001, status: "blocked", page: 2 });
  assertEquals(parseCallback("g:3"), { kind: "page", page: 3 });
  assertEquals(parseCallback("x:1"), null);
  assertEquals(parseCallback(undefined), null);
  assertEquals(parseCallback("a:-1001; drop table"), null);
});

Deno.test("every generated callback_data is parseable and within Telegram's 64-byte limit", () => {
  const items = Array.from(
    { length: 20 },
    (_, i) => row({ id: -1009876543210 - i, status: (["pending", "approved", "blocked"] as const)[i % 3] }),
  );
  for (let page = 0; page < 3; page++) {
    for (const button of renderList(items, page).keyboard.flat()) {
      assert(new TextEncoder().encode(button.callback_data).length <= 64);
      assert(parseCallback(button.callback_data) !== null, button.callback_data);
    }
  }
  for (const item of items) {
    for (const button of renderNotice(item).keyboard.flat()) assert(parseCallback(button.callback_data));
  }
});

Deno.test("notice offers the actions that change the status", () => {
  const texts = (r: ChatRow) => renderNotice(r).keyboard.flat().map((b) => b.callback_data);
  assertEquals(texts(row({ status: "pending" })), ["a:-1001", "b:-1001"]);
  assertEquals(texts(row({ status: "approved" })), ["b:-1001"]);
  assertEquals(texts(row({ status: "blocked" })), ["a:-1001"]);
  const { text } = renderNotice(row(), { memberCount: 34, heading: "🔔 Yangi" });
  assert(text.includes("A'zolar: 34") && text.includes("@ali (5)") && text.startsWith("🔔 Yangi"));
});

Deno.test("list: counts, usage, pagination and page clamping", () => {
  const items = Array.from(
    { length: 10 },
    (_, i) => row({ id: -i - 1, title: `G${i + 1}`, status: "approved", solved7d: i }),
  );
  const first = renderList(items, 0);
  assert(first.text.startsWith("Guruhlar va chatlar: 10 (⏳ 0 · ✅ 10 · ⛔ 0)"));
  assert(first.text.includes("1. ✅ G1 — 0 ta yechim (7 kun)"));
  assertEquals(first.keyboard.at(-1)!.map((b) => b.text), ["◀️", "1/2", "▶️"]);
  const last = renderList(items, 99);
  assert(last.text.includes("9. ✅ G9") && last.text.includes("10. ✅ G10"));
  assertEquals(last.keyboard.at(-1)![2].callback_data, "g:0"); // wraps around
});

Deno.test("list marks private chats and chats the bot was removed from", () => {
  const { text } = renderList([row({ type: "private", title: "Ali (@ali)", is_member: false })], 0);
  assert(text.includes("👤 Ali (@ali)") && text.includes("🚪 bot chiqarilgan"));
  assertEquals(renderList([], 0), { text: "Hali hech qanday guruh yoki chat yo'q.", keyboard: [] });
});

Deno.test("membership transitions", () => {
  const u = (from: string, to: string) => ({
    chat: { id: -1, type: "group" },
    from: { id: 5, first_name: "Ali", is_bot: false },
    old_chat_member: { status: from, user: { id: 9, first_name: "Bot", is_bot: true } },
    new_chat_member: { status: to, user: { id: 9, first_name: "Bot", is_bot: true } },
  });
  assertEquals(membershipChange(u("left", "member")), "joined");
  assertEquals(membershipChange(u("kicked", "administrator")), "joined");
  assertEquals(membershipChange(u("member", "administrator")), null); // promoted
  assertEquals(membershipChange(u("member", "left")), "left");
  assertEquals(membershipChange(u("administrator", "kicked")), "left");
});

Deno.test("chat titles for groups and private chats", () => {
  assertEquals(chatTitle({ id: 1, type: "group", title: "Test group" }), "Test group");
  assertEquals(chatTitle({ id: 2, type: "private", first_name: "Ali", username: "ali" }), "Ali (@ali)");
  assertEquals(chatTitle({ id: 3, type: "private", first_name: "Ali" }), "Ali");
  assertEquals(chatTitle({ id: 4, type: "private" }), null);
});
