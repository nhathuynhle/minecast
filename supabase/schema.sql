create table if not exists public.miners (
  fid bigint primary key,
  username text,
  wallet_address text,
  follower_count bigint not null default 0,
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
  reward_weight numeric(20, 0) not null default 1 check (reward_weight > 0),
  emission_day date not null default current_date,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  settled_at timestamptz,
  constraint session_duration check (ends_at = started_at + interval '24 hours')
);

-- Safe to run on the existing test database as a migration.
alter table public.miners add column if not exists last_claim_at timestamptz;
alter table public.miners add column if not exists follower_count bigint not null default 0;
create unique index if not exists one_miner_per_wallet
  on public.miners (lower(wallet_address)) where wallet_address is not null;
alter table public.mining_sessions drop constraint if exists session_duration;
alter table public.mining_sessions add constraint session_duration check (ends_at = started_at + interval '24 hours');
alter table public.mining_sessions add column if not exists emission_day date;
update public.mining_sessions set emission_day = started_at::date where emission_day is null;
alter table public.mining_sessions alter column emission_day set not null;
alter table public.mining_sessions add column if not exists reward_weight numeric(20, 0) not null default 1;

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
  -- `amount_wei` is also the name of this function's output column, so it
  -- must be qualified to avoid PostgreSQL's PL/pgSQL ambiguity error.
  select coalesce(sum(reserved_allocations.amount_wei), 0)
  into total
  from reserved_allocations;

  if total = 0 then return; end if;

  update miners set last_claim_at = now() where fid = p_fid;

  return query select total;
end;
$$;

-- Settling is deliberately a single database operation. This makes repeated
-- browser requests harmless and prevents two requests from allocating a
-- completed session twice.
drop function if exists public.settle_ended_sessions(bigint);

create or replace function public.settle_ended_sessions(
  p_fid bigint,
  p_launch_time numeric,
  p_halving_seconds numeric,
  p_base_daily_wei numeric
)
returns table(session_id uuid) language plpgsql security definer set search_path = public as $$
begin
  return query
  with eligible as (
    select
      session.id,
      session.fid,
      session.wallet_address,
      session.emission_day,
      session.reward_weight,
      miner.inviter_fid,
      (miner.inviter_fid is not null
        and inviter.wallet_address is not null
        and (select count(*) from mining_sessions completed where completed.fid = session.fid and completed.settled_at is not null) >= 6
        and (select count(*) from miners referred where referred.inviter_fid = miner.inviter_fid) <= 20
      ) as referral_qualified
    from mining_sessions session
    join miners miner on miner.fid = session.fid
    left join miners inviter on inviter.fid = miner.inviter_fid
    where session.fid = p_fid and session.settled_at is null and session.ends_at <= now()
    for update
  ), daily_weights as (
    select
      sum(session.reward_weight) as total_weight,
      sum(case when miner.inviter_fid is not null
        and inviter.wallet_address is not null
        and (select count(*) from mining_sessions completed where completed.fid = session.fid and completed.settled_at is not null) >= 6
        and (select count(*) from miners referred where referred.inviter_fid = miner.inviter_fid) <= 20
        then session.reward_weight else 0 end
      ) as referral_weight
    from mining_sessions session
    join miners miner on miner.fid = session.fid
    left join miners inviter on inviter.fid = miner.inviter_fid
    where session.emission_day = (select emission_day from eligible limit 1)
  ), priced as (
    select eligible.*, least(
      floor(
        (p_base_daily_wei / power(2, greatest(0, floor(extract(epoch from (eligible.emission_day::timestamp - to_timestamp(p_launch_time))) / p_halving_seconds)::integer)))
        * eligible.reward_weight
        / nullif(daily_weights.total_weight + daily_weights.referral_weight * 8 / 100, 0)
      ),
      -- A verified creator may receive at most the public 100x benchmark.
      -- The residual stays unallocated for the later Airdrop Treasury finalisation.
      floor(
        (p_base_daily_wei / power(2, greatest(0, floor(extract(epoch from (eligible.emission_day::timestamp - to_timestamp(p_launch_time))) / p_halving_seconds)::integer)))
        / 100000 * 100
      )
    ) as reward_wei
    from eligible
    cross join daily_weights
  ), updated_sessions as (
    update mining_sessions session
    set reward_wei = priced.reward_wei
    from priced
    where session.id = priced.id
    returning session.id
  ), allocations as (
    insert into claim_allocations (session_id, fid, wallet_address, amount_wei)
    select id, fid, wallet_address, reward_wei from priced
    union all
    select priced.id, inviter.fid, inviter.wallet_address, floor(priced.reward_wei * 8 / 100)
    from priced
    join miners inviter on inviter.fid = priced.inviter_fid
    where priced.referral_qualified
    on conflict (session_id, fid) do nothing
    returning session_id
  )
  update mining_sessions session
  set settled_at = now()
  from updated_sessions
  where session.id = updated_sessions.id
  returning session.id;
end;
$$;
