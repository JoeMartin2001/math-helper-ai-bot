-- Follow-up questions: replying to one of the bot's answers continues that conversation.
alter table public.requests
  add column image_file_id text,
  add column image_mime text,
  add column answer text,
  -- Telegram message ids that carry the answer (it may be split across several messages).
  add column answer_message_ids bigint[],
  add column parent_id bigint references public.requests (id) on delete set null;

create index requests_answer_message_ids_idx on public.requests using gin (answer_message_ids);
