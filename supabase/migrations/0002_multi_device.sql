-- Travel Audit: accurate sync across many devices.
--  * members.periods keeps every join/leave, so splits can be checked against who was on the trip
--  * expenses.split_confirmed records that the bookkeeper reviewed an unusual split
--  * deleted expenses, transfers and members stay deleted, even if an offline device edits them later
--  * trip_digest() lets each device verify that it holds exactly what the server holds

-- ---------------------------------------------------------------------------
-- Membership history (backfilled before the keep-deleted triggers exist)
-- ---------------------------------------------------------------------------
alter table public.members add column if not exists periods jsonb;

-- One period per existing member, starting no later than the first expense they share
update public.members m
set periods = jsonb_build_array(jsonb_build_object(
  'joinedAt', least(m.created_at, coalesce(
    (select min(e.occurred_at) from public.expenses e where e.trip_id = m.trip_id and m.id = any (e.participants)),
    m.created_at)),
  'leftAt', m.left_at))
where m.periods is null;

alter table public.members alter column periods set default '[]'::jsonb;
alter table public.members alter column periods set not null;
alter table public.members add constraint members_periods_is_array check (jsonb_typeof(periods) = 'array');

alter table public.expenses add column if not exists split_confirmed boolean not null default false;

-- ---------------------------------------------------------------------------
-- Deletions win over concurrent edits
-- ---------------------------------------------------------------------------
-- An update to a deleted row keeps the deleted version. The *_touch trigger (which runs after
-- this one, triggers fire in name order) still bumps updated_at, so every device pulls the
-- deletion again and converges. Trips and viewers are excluded: those can be restored.
create or replace function public.keep_deleted() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.deleted_at is not null then
    new := old;
  end if;
  return new;
end $$;

create trigger expenses_keep_deleted before update on public.expenses for each row execute function public.keep_deleted();
create trigger transfers_keep_deleted before update on public.transfers for each row execute function public.keep_deleted();
create trigger members_keep_deleted before update on public.members for each row execute function public.keep_deleted();

-- ---------------------------------------------------------------------------
-- Verification digest
-- ---------------------------------------------------------------------------
-- For each trip and table: how many rows (including deleted ones) and a SHA-256 over
-- "id:updated_at_in_microseconds" sorted by id. Runs with the caller's rights, so it only
-- covers rows the caller can read. Tables with no rows are left out.
create or replace function public.trip_digest(trip_ids uuid[])
returns table (trip_id uuid, table_name text, row_count bigint, digest text)
language sql stable security invoker set search_path = public as $$
  with r as (
    select t.id as trip, 'trips'::text as tbl, t.id, t.updated_at from public.trips t where t.id = any (trip_ids)
    union all
    select v.trip_id, 'trip_viewers', v.id, v.updated_at from public.trip_viewers v where v.trip_id = any (trip_ids)
    union all
    select m.trip_id, 'members', m.id, m.updated_at from public.members m where m.trip_id = any (trip_ids)
    union all
    select e.trip_id, 'expenses', e.id, e.updated_at from public.expenses e where e.trip_id = any (trip_ids)
    union all
    select x.trip_id, 'transfers', x.id, x.updated_at from public.transfers x where x.trip_id = any (trip_ids)
  )
  select trip, tbl, count(*),
         encode(sha256(convert_to(
           string_agg(id::text || ':' || floor(extract(epoch from updated_at) * 1000000)::bigint::text, ',' order by id),
           'UTF8')), 'hex')
  from r
  group by trip, tbl
$$;

revoke all on function public.trip_digest(uuid[]) from public, anon;
grant execute on function public.trip_digest(uuid[]) to authenticated;
