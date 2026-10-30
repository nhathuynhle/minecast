create table if not exists public.miners (
  fid bigint primary key,
  username text,
  wallet_address text,
  referral_code text unique not null,
  inviter_fid bigint references public.miners(fid),
  last_claim_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.mining_sessions (
  id uuid primary key default gen_random_uuid(),
  fid bigint not null references public.miners(fid),
  cast_hash text unique not null,
  wallet_address text not null,
  reward_wei numeric(78, 0) not null check (reward_wei > 0),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  settled_at timestamptz,
  constraint session_duration check (ends_at = started_at + interval '24 hours')
);

-- Safe to run on the existing test database as a migration.
alter table public.miners add column if not exists last_claim_at timestamptz;
alter table public.mining_sessions drop constraint if exists session_duration;
alter table public.mining_sessions add constraint session_duration check (ends_at = started_at + interval '24 hours');

create unique index if not exists one_active_session_per_miner
  on public.mining_sessions (fid) where settled_at is null;

create table if not exists public.claim_allocations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.mining_sessions(id),
  fid bigint not null references public.miners(fid),
  wallet_address text not null,
  amount_wei numeric(78, 0) not null check (amount_wei > 0),
  status text not null default 'available' check (status in ('available', 'voucher_issued', 'claimed')),
  claim_nonce numeric(78, 0),
  voucher_expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.claim_allocations drop constraint if exists claim_allocations_session_id_key;
create unique index if not exists one_claim_allocation_per_session_recipient
  on public.claim_allocations (session_id, fid);

alter table public.miners enable row level security;
alter table public.mining_sessions enable row level security;
alter table public.claim_allocations enable row level security;

-- This is called with the Supabase service-role key only. It locks all available
-- allocations for one wallet so two claim requests cannot receive the same reward.
create or replace function public.reserve_claim(p_fid bigint, p_wallet text, p_nonce numeric)
returns table(amount_wei numeric) language plpgsql security definer set search_path = public as $$
declare
  total numeric(78, 0);
  last_claim timestamptz;
begin
  -- Lock the miner row so parallel browser calls cannot bypass the daily limit.
  select last_claim_at into last_claim from miners where fid = p_fid for update;
  if not found then raise exception 'Miner record was not found.'; end if;
  if last_claim is not null and last_claim > now() - interval '24 hours' then
    raise exception 'Daily claim limit reached. Try again after 24 hours.';
  end if;
  -- A voucher is short-lived. If its transaction was never submitted, make the
  -- allocation available again before issuing the next voucher.
  update claim_allocations
  set status = 'available', claim_nonce = null, voucher_expires_at = null
  where status = 'voucher_issued' and voucher_expires_at < now();

  with locked_allocations as (
    select id from claim_allocations
    where fid = p_fid and lower(wallet_address) = lower(p_wallet) and status = 'available'
    for update
  ), reserved_allocations as (
    update claim_allocations allocation
    set status = 'voucher_issued', claim_nonce = p_nonce, voucher_expires_at = now() + interval '30 minutes'
    from locked_allocations locked
    where allocation.id = locked.id
    returning allocation.amount_wei
  )
  select coalesce(sum(amount_wei), 0) into total from reserved_allocations;

  if total = 0 then return; end if;

  update miners set last_claim_at = now() where fid = p_fid;

  return query select total;
end;
$$;

-- Settling is deliberately a single database operation. This makes repeated
-- browser requests harmless and prevents two requests from allocating a
-- completed session twice.
create or replace function public.settle_ended_sessions(p_fid bigint)
returns table(session_id uuid) language plpgsql security definer set search_path = public as $$
begin
  return query
  with eligible as (
    select session.id, session.fid, session.wallet_address, session.reward_wei, miner.inviter_fid
    from mining_sessions session
    join miners miner on miner.fid = session.fid
    where session.fid = p_fid and session.settled_at is null and session.ends_at <= now()
    for update
  ), allocations as (
    insert into claim_allocations (session_id, fid, wallet_address, amount_wei)
    select id, fid, wallet_address, reward_wei from eligible
    union all
    select eligible.id, inviter.fid, inviter.wallet_address, floor(eligible.reward_wei * 8 / 100)
    from eligible
    join miners inviter on inviter.fid = eligible.inviter_fid
    where inviter.wallet_address is not null
      and (select count(*) from miners referred where referred.inviter_fid = inviter.fid) <= 20
    on conflict (session_id, fid) do nothing
    returning session_id
  )
  update mining_sessions session
  set settled_at = now()
  from eligible
  where session.id = eligible.id
  returning session.id;
end;
$$;
