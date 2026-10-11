-- Chats (groups and private chats) and whether the bot may answer in them; managed from Telegram by admins.
create table public.chats (
  id bigint primary key,                 -- Telegram chat id
  type text not null,                    -- private | group | supergroup
  title text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'blocked')),
  is_member boolean not null default true,  -- false after the bot is removed from the group
  added_by_id bigint,
  added_by_username text,
  decided_by bigint,                     -- admin who last approved/blocked
  decided_at timestamptz,
  pending_notice_at timestamptz,         -- last "awaiting approval" message, to send it at most daily
  migrated_to bigint,                    -- set when a group was upgraded to a supergroup (new id)
  created_at timestamptz not null default now()
);

alter table public.chats enable row level security;  -- service role only

-- Solved problems per chat over the last 7 days, for the admin list.
create view public.chat_usage with (security_invoker = true) as
  select chat_id, count(*)::int as solved_7d
  from public.requests
  where status = 'done' and created_at > now() - interval '7 days'
  group by chat_id;
