-- Open V4 Quorum.7: a session counts for the UTC day it opens in and runs until that cohort closes at 00:00 UTC,
-- instead of 24 hours from its start. Apply after 20261110_v4_mining_sessions.sql and 20261110_v4_live_estimates.sql.
begin;
alter table public.v4_mining_sessions drop constraint if exists v4_mining_sessions_check;
alter table public.v4_mining_sessions drop constraint if exists v4_session_ends_at_cohort_close;
-- NOT VALID keeps the 24-hour rows of earlier deployments; every new row must end at its cohort close.
alter table public.v4_mining_sessions add constraint v4_session_ends_at_cohort_close
  check (ends_at = (date_trunc('day', started_at at time zone 'utc') + interval '1 day') at time zone 'utc') not valid;

create or replace function public.start_v4_mining_session(p_chain_id integer, p_distributor text, p_fid bigint,
  p_wallet text, p_cast_hash text, p_day bigint, p_started_at timestamptz)
returns setof public.v4_mining_sessions language plpgsql security definer set search_path = public as $$
declare existing public.v4_mining_sessions;
begin
  -- Serialize starts per deployment. This low-volume intake does not settle rewards.
  perform pg_advisory_xact_lock(hashtextextended('v4-start:' || p_chain_id || ':' || p_distributor, 0));
  select s.* into existing from public.v4_mining_sessions s
    where s.chain_id = p_chain_id and s.distributor = p_distributor and s.cast_hash = p_cast_hash;
  if found then
    if existing.fid <> p_fid or existing.wallet_address <> p_wallet then raise exception 'Cast already belongs to another mining session'; end if;
    return next existing; return;
  end if;
  if exists (select 1 from public.v4_mining_sessions s where s.chain_id = p_chain_id and s.distributor = p_distributor
    and (s.fid = p_fid or s.wallet_address = p_wallet) and s.ends_at > p_started_at) then raise exception 'An active session already exists'; end if;
  if exists (select 1 from public.v4_mining_sessions s where s.chain_id = p_chain_id and s.distributor = p_distributor
    and ((s.fid = p_fid and s.wallet_address <> p_wallet) or (s.wallet_address = p_wallet and s.fid <> p_fid))) then raise exception 'This wallet is linked to another miner identity'; end if;
  return query insert into public.v4_mining_sessions (chain_id, distributor, fid, wallet_address, cast_hash, day, started_at, ends_at)
    values (p_chain_id, p_distributor, p_fid, p_wallet, p_cast_hash, p_day, p_started_at,
      (date_trunc('day', p_started_at at time zone 'utc') + interval '1 day') at time zone 'utc') returning *;
end $$;
revoke all on function public.start_v4_mining_session(integer,text,bigint,text,text,bigint,timestamptz) from public, anon, authenticated;
grant execute on function public.start_v4_mining_session(integer,text,bigint,text,text,bigint,timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;
