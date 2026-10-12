-- Accurate per-request cost: cache reads/writes are billed differently from fresh input.
-- input_tokens now counts only uncached input (rows before this migration include cache reads).
alter table public.requests
  add column cache_read_tokens int,
  add column cache_write_tokens int,
  add column cost_usd numeric(10, 5);

-- Daily usage and spend (Tashkent time), for monitoring.
create view public.daily_costs with (security_invoker = true) as
  select (created_at at time zone 'Asia/Tashkent')::date as day,
         count(*) filter (where status = 'done') as answered,
         count(*) filter (where status = 'error') as failed,
         count(distinct user_id) as users,
         round(sum(cost_usd), 2) as cost_usd,
         round(avg(cost_usd) filter (where status = 'done'), 4) as avg_cost_usd
  from public.requests
  group by 1
  order by 1 desc;
