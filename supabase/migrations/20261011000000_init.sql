-- One row per Telegram update the bot acts on: usage log, rate limiting and retry de-duplication.
create table public.requests (
  id bigint generated always as identity primary key,
  update_id bigint unique not null,
  chat_id bigint not null,
  user_id bigint not null,
  username text,
  question text,
  has_image boolean not null default false,
  status text not null default 'processing'
    check (status in ('processing', 'done', 'error', 'rate_limited')),
  input_tokens int,
  output_tokens int,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index requests_user_created_idx on public.requests (user_id, created_at desc);

-- No policies: only the service role (used by the edge function) can read or write.
alter table public.requests enable row level security;
