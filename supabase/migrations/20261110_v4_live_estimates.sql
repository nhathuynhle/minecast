-- Informational estimates only. Neither this table nor these functions authorize minting.
-- Apply after 20261110_v4_mining_sessions.sql.
begin;
alter table public.v4_mining_sessions
  add column if not exists follower_count bigint check (follower_count between 0 and 9007199254740991),
  add column if not exists follower_observed_at timestamptz,
  add column if not exists estimated_weight smallint generated always as (
    case when follower_count is null then null
      when follower_count >= 100000 then 100 when follower_count >= 50000 then 75
      when follower_count >= 25000 then 50 when follower_count >= 10000 then 30
      when follower_count >= 5000 then 18 when follower_count >= 2000 then 10
      when follower_count >= 1000 then 6 when follower_count >= 500 then 4
      when follower_count >= 10 then 2 else 1 end
  ) stored;
create index if not exists v4_sessions_active on public.v4_mining_sessions (chain_id, distributor, ends_at);

create or replace function public.start_v4_mining_session_with_estimate(p_chain_id integer, p_distributor text, p_fid bigint,
  p_wallet text, p_cast_hash text, p_day bigint, p_started_at timestamptz, p_follower_count bigint)
returns setof public.v4_mining_sessions language plpgsql security definer set search_path = public as $$
declare created public.v4_mining_sessions;
begin
  select s.* into created from public.start_v4_mining_session(p_chain_id,p_distributor,p_fid,p_wallet,p_cast_hash,p_day,p_started_at) s;
  -- Preserve the original observation on retries; never trust a client boost/node flag.
  if created.follower_count is null and p_follower_count is not null then
    return query update public.v4_mining_sessions s
      set follower_count = p_follower_count, follower_observed_at = now()
      where s.id = created.id returning s.*;
  else return next created;
  end if;
end $$;
revoke all on function public.start_v4_mining_session_with_estimate(integer,text,bigint,text,text,bigint,timestamptz,bigint) from public, anon, authenticated;
grant execute on function public.start_v4_mining_session_with_estimate(integer,text,bigint,text,text,bigint,timestamptz,bigint) to service_role;

create or replace function public.get_v4_mining_stats(p_chain_id integer, p_distributor text, p_day bigint)
returns table (observed_at timestamptz, active_miners text, cohort_miners text, estimated_miners text, total_weight text)
language sql stable security definer set search_path = public as $$
  select now(),
    (select count(distinct a.fid)::text from public.v4_mining_sessions a
      where a.chain_id = p_chain_id and a.distributor = p_distributor and a.started_at <= now() and a.ends_at > now()),
    count(*)::text, count(c.estimated_weight)::text, coalesce(sum(c.estimated_weight),0)::text
  from public.v4_mining_sessions c
  where c.chain_id = p_chain_id and c.distributor = p_distributor and c.day = p_day;
$$;
revoke all on function public.get_v4_mining_stats(integer,text,bigint) from public, anon, authenticated;
grant execute on function public.get_v4_mining_stats(integer,text,bigint) to service_role;
notify pgrst, 'reload schema';
commit;
