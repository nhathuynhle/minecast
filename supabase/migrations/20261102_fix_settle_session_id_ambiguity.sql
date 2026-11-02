-- Fixes completed sessions being unable to settle because the function's
-- output field `session_id` collided with claim_allocations.session_id.

create or replace function public.settle_ended_sessions(
  p_fid bigint,
  p_launch_time numeric,
  p_halving_seconds numeric,
  p_base_daily_wei numeric
)
returns table(session_id uuid) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
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
    for update of session
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
        (p_base_daily_wei / power(2::numeric, greatest(0, floor(extract(epoch from (eligible.emission_day::timestamp - to_timestamp(p_launch_time))) / p_halving_seconds)::integer)))
        * eligible.reward_weight
        / nullif(daily_weights.total_weight + daily_weights.referral_weight * 8 / 100, 0)
      ),
      floor(
        (p_base_daily_wei / power(2::numeric, greatest(0, floor(extract(epoch from (eligible.emission_day::timestamp - to_timestamp(p_launch_time))) / p_halving_seconds)::integer)))
        / 100000 * eligible.reward_weight
      )
    ) as reward_wei
    from eligible
    cross join daily_weights
  ), updated_sessions as (
    update mining_sessions session
    set reward_wei = priced.reward_wei, settled_at = now()
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
    returning claim_allocations.session_id
  )
  select updated_sessions.id from updated_sessions;
end;
$$;
