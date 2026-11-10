-- Separate Open V4 observations from the legacy reward/voucher ledger.
-- Only authenticated Edge handlers using service_role may create a session.
begin;
create table if not exists public.v4_mining_sessions (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (8453, 84532)),
  distributor text not null check (distributor ~ '^0x[0-9a-f]{40}$'),
  fid bigint not null check (fid > 0),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  cast_hash text not null check (cast_hash ~ '^0x[0-9a-f]{40}$'),
  day bigint not null check (day >= 0),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at = started_at + interval '24 hours'),
  unique (chain_id, distributor, cast_hash),
  unique (chain_id, distributor, day, fid),
  unique (chain_id, distributor, day, wallet_address)
);
create index if not exists v4_sessions_miner on public.v4_mining_sessions (chain_id, distributor, fid, day desc);
alter table public.v4_mining_sessions enable row level security;
revoke all on public.v4_mining_sessions from anon, authenticated;
grant select, insert on public.v4_mining_sessions to service_role;

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
    values (p_chain_id, p_distributor, p_fid, p_wallet, p_cast_hash, p_day, p_started_at, p_started_at + interval '24 hours') returning *;
end $$;
revoke all on function public.start_v4_mining_session(integer,text,bigint,text,text,bigint,timestamptz) from public, anon, authenticated;
grant execute on function public.start_v4_mining_session(integer,text,bigint,text,text,bigint,timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;
