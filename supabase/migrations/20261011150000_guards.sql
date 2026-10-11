-- Cost guards: chats outside the allowlist are recorded once so the owner can find their id.
alter table public.requests drop constraint requests_status_check;
alter table public.requests add constraint requests_status_check
  check (status in ('processing', 'done', 'error', 'rate_limited', 'not_allowed', 'over_budget'));

-- Number of figures sent with the answer (code execution).
alter table public.requests add column figures int not null default 0;

create index requests_created_idx on public.requests (created_at desc);
create index requests_chat_created_idx on public.requests (chat_id, created_at desc);
