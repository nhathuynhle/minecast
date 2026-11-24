-- Open V4 Quorum.10: a cast that repeats an earlier cast of the same UTC day does not count.
-- text_key is the cast's first 10 letters or digits, case-folded (the server computes it from Neynar; nodes compute the
-- same from Snapchain and have the final say). A later cast repeats an earlier one when its key is a prefix of the
-- earlier key: "123456789" after "1234567890" repeats it, "1234567891011" does not.
-- Apply after 20261122_v4_utc_day_sessions.sql.
begin;
alter table public.v4_mining_sessions add column if not exists text_key text check (char_length(text_key) <= 10);

create or replace function public.start_v4_mining_session_with_text(p_chain_id integer, p_distributor text, p_fid bigint,
  p_wallet text, p_cast_hash text, p_day bigint, p_started_at timestamptz, p_follower_count bigint, p_text_key text)
returns setof public.v4_mining_sessions language plpgsql security definer set search_path = public as $$
declare created public.v4_mining_sessions;
begin
  if p_text_key is null or char_length(p_text_key) > 10 then raise exception 'Invalid cast text key'; end if;
  -- The same per-deployment lock start_v4_mining_session takes (re-entrant), so two copies cannot both pass this check.
  perform pg_advisory_xact_lock(hashtextextended('v4-start:' || p_chain_id || ':' || p_distributor, 0));
  if exists (select 1 from public.v4_mining_sessions s where s.chain_id = p_chain_id and s.distributor = p_distributor
    and s.day = p_day and s.cast_hash <> p_cast_hash and starts_with(s.text_key, p_text_key)) then
    raise exception 'Cast text repeats an earlier cast today';
  end if;
  select s.* into created from public.start_v4_mining_session_with_estimate(p_chain_id,p_distributor,p_fid,p_wallet,p_cast_hash,p_day,p_started_at,p_follower_count) s;
  if created.text_key is null then
    return query update public.v4_mining_sessions s set text_key = p_text_key where s.id = created.id returning s.*;
  else return next created;
  end if;
end $$;
revoke all on function public.start_v4_mining_session_with_text(integer,text,bigint,text,text,bigint,timestamptz,bigint,text) from public, anon, authenticated;
grant execute on function public.start_v4_mining_session_with_text(integer,text,bigint,text,text,bigint,timestamptz,bigint,text) to service_role;
notify pgrst, 'reload schema';
commit;
