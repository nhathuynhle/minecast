-- Do not consume the daily claim window until TokenCast confirms the claim.
-- Reissuing the same onchain nonce is idempotent and lets a user retry after a
-- wallet cancellation, RPC failure, page refresh, or expired client request.
create or replace function public.reserve_claim(p_fid bigint, p_wallet text, p_nonce numeric)
returns table(amount_wei numeric) language plpgsql security definer set search_path = public as $$
declare
  total numeric(78, 0);
begin
  perform 1 from miners where fid = p_fid for update;
  if not found then raise exception 'Miner record was not found.'; end if;

  update claim_allocations
  set status = 'available', claim_nonce = null, voucher_expires_at = null
  where status = 'voucher_issued' and voucher_expires_at < now();

  with locked_allocations as (
    select id from claim_allocations
    where fid = p_fid
      and lower(wallet_address) = lower(p_wallet)
      and (
        status = 'available'
        or (status = 'voucher_issued' and claim_nonce = p_nonce)
      )
    for update
  ), reserved_allocations as (
    update claim_allocations allocation
    set status = 'voucher_issued', claim_nonce = p_nonce, voucher_expires_at = now() + interval '30 minutes'
    from locked_allocations locked
    where allocation.id = locked.id
    returning allocation.amount_wei
  )
  select coalesce(sum(reserved_allocations.amount_wei), 0)
  into total
  from reserved_allocations;

  if total = 0 then return; end if;
  return query select total;
end;
$$;
