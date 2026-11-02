-- Run once in Supabase SQL Editor for existing MineCast projects.
-- PostgreSQL treats the RETURNS TABLE field `amount_wei` as a PL/pgSQL
-- variable. Qualifying the CTE column removes the ambiguity without changing
-- the RPC response used by the claim API.
create or replace function public.reserve_claim(p_fid bigint, p_wallet text, p_nonce numeric)
returns table(amount_wei numeric) language plpgsql security definer set search_path = public as $$
declare
  total numeric(78, 0);
  last_claim timestamptz;
begin
  select last_claim_at into last_claim from miners where fid = p_fid for update;
  if not found then raise exception 'Miner record was not found.'; end if;
  if last_claim is not null and last_claim > now() - interval '24 hours' then
    raise exception 'Daily claim limit reached. Try again after 24 hours.';
  end if;

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
  select coalesce(sum(reserved_allocations.amount_wei), 0)
  into total
  from reserved_allocations;

  if total = 0 then return; end if;

  update miners set last_claim_at = now() where fid = p_fid;
  return query select total;
end;
$$;
