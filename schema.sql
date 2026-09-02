-- =========================================================
-- RCC FDD Validation Tracker — Supabase schema
--
-- RUN THIS IN THE CONSOLE'S PROJECT: jkzyyxlrhnzwiwhwbgyw
-- Not in a new project. This table reads from fdd_status,
-- so the two must live together.
-- Safe to re-run: everything is idempotent.
-- =========================================================

-- ---------------------------------------------------------
-- 1. Validation state, one row per (ref x building)
--    Mirrors the primary key of fdd_status so they join cleanly.
-- ---------------------------------------------------------

create table if not exists public.fdd_validation (
  ref             text not null,
  building        text not null,

  status          text not null default 'Not started',

  -- what you actually drove at the BMS
  point_driven    text,          -- point name as it reads on the front end
  point_normal    text,          -- value before you touched it
  point_target    text,          -- value you drove it to
  hold_mins       integer,

  -- override safety
  override_active boolean not null default false,
  driven_at       timestamptz,
  restored_at     timestamptz,

  -- outcome
  tested_at       timestamptz,
  validated_by    text,
  retests         integer not null default 0,
  notes           text default '',

  updated_at      timestamptz not null default now(),
  updated_by      text,

  primary key (ref, building),

  constraint validation_status_allowed check (
    status in ('Not started', 'In progress', 'Passed', 'Failed', 'Parked')
  ),

  -- a point cannot be both driven and restored
  constraint override_consistent check (
    not (override_active and restored_at is not null)
  )
);

comment on table public.fdd_validation is
  'Validation state for FDD trigger mechanisms. Joins to fdd_status on (ref, building).';

create index if not exists idx_val_status   on public.fdd_validation (status);
create index if not exists idx_val_building on public.fdd_validation (building);
create index if not exists idx_val_override on public.fdd_validation (override_active) where override_active;

-- ---------------------------------------------------------
-- 2. Stamp who and when on every write
-- ---------------------------------------------------------

create or replace function public.touch_fdd_validation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', 'unknown');
  return new;
end $$;

drop trigger if exists trg_touch_fdd_validation on public.fdd_validation;
create trigger trg_touch_fdd_validation
  before insert or update on public.fdd_validation
  for each row execute function public.touch_fdd_validation();

-- ---------------------------------------------------------
-- 3. The validation queue
--    Every Enabled FDD in the console with its validation state
--    attached. An FDD never touched shows as 'Not started'
--    without needing a row to exist.
-- ---------------------------------------------------------

create or replace view public.v_validation_queue as
select
  s.ref,
  s.building,
  split_part(s.ref, '-', 1)          as equip_class,
  s.status                           as build_status,
  coalesce(v.status, 'Not started')  as status,
  v.point_driven,
  v.point_normal,
  v.point_target,
  v.hold_mins,
  coalesce(v.override_active, false) as override_active,
  v.driven_at,
  v.restored_at,
  v.tested_at,
  v.validated_by,
  coalesce(v.retests, 0)             as retests,
  coalesce(v.notes, '')              as notes,
  v.updated_at
from public.fdd_status s
left join public.fdd_validation v
  on v.ref = s.ref and v.building = s.building
where s.status = 'Enabled';

comment on view public.v_validation_queue is
  'Enabled FDDs only. A rule is not worth validating until it is live.';

-- ---------------------------------------------------------
-- 4. Open overrides — what is still driven right now
-- ---------------------------------------------------------

create or replace view public.v_open_overrides as
select
  ref, building, point_driven, point_target, driven_at,
  round(extract(epoch from (now() - driven_at)) / 3600.0, 1) as hours_open
from public.fdd_validation
where override_active
order by driven_at;

-- ---------------------------------------------------------
-- 5. Coverage rollup for reporting upward
-- ---------------------------------------------------------

create or replace view public.v_validation_coverage as
select
  building,
  count(*)                                              as enabled_rules,
  count(*) filter (where status = 'Passed')             as passed,
  count(*) filter (where status = 'Failed')             as failed,
  count(*) filter (where status = 'Parked')             as parked,
  count(*) filter (where status in ('Passed','Failed')) as tested,
  round(100.0 * count(*) filter (where status in ('Passed','Failed'))
        / nullif(count(*), 0), 1)                       as coverage_pct,
  round(100.0 * count(*) filter (where status = 'Passed')
        / nullif(count(*) filter (where status in ('Passed','Failed')), 0), 1)
                                                        as pass_rate_pct
from public.v_validation_queue
group by building
order by building;

-- ---------------------------------------------------------
-- 6. Row Level Security
--    Same model as the console: public read, signed-in write.
--    The updated_by trigger above reads the signed-in user's email,
--    so every result is attributed automatically.
-- ---------------------------------------------------------

alter table public.fdd_validation enable row level security;

drop policy if exists "read for all"     on public.fdd_validation;
drop policy if exists "insert open"      on public.fdd_validation;
drop policy if exists "write open"       on public.fdd_validation;
drop policy if exists "insert signed in" on public.fdd_validation;
drop policy if exists "write signed in"  on public.fdd_validation;

-- Anyone with the link can read. This is what lets the regional
-- engineering heads see live state without an account.
create policy "read for all" on public.fdd_validation
  for select using (true);

-- Only a signed-in user can record a result.
create policy "insert signed in" on public.fdd_validation
  for insert to authenticated with check (true);

create policy "write signed in" on public.fdd_validation
  for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------
-- 7. Optional: FDD titles
--    fdd_status holds refs only. Fault names live baked into the
--    console app. Populate this if you want titles in the tracker
--    and the app picks them up automatically.
-- ---------------------------------------------------------

create table if not exists public.fdd_catalog (
  ref     text primary key,
  title   text,
  pattern text
);

alter table public.fdd_catalog enable row level security;

drop policy if exists "catalog read" on public.fdd_catalog;
create policy "catalog read" on public.fdd_catalog for select using (true);

-- No seed data anywhere in this file. The tracker derives its whole
-- register from fdd_status, so it shows your real estate the moment
-- you point it at the project.


-- =========================================================
-- PART 2 — Failure taxonomy, test history, planner
-- Added after the initial build. Safe to run on top of Part 1.
-- =========================================================

-- ---------------------------------------------------------
-- 8. New columns on fdd_validation
-- ---------------------------------------------------------

alter table public.fdd_validation
  add column if not exists failure_reason text,
  add column if not exists attempt_number integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'failure_reason_allowed'
  ) then
    alter table public.fdd_validation
      add constraint failure_reason_allowed check (
        failure_reason is null or failure_reason in (
          'Threshold too wide',
          'Point read-only / inaccessible',
          'Timing issue',
          'Rule logic wrong',
          'Wrong asset mapping',
          'Measurement error',
          'Other'
        )
      );
  end if;
end $$;

comment on column public.fdd_validation.failure_reason is
  'Why the rule did not fire. Only meaningful when status = Failed.';
comment on column public.fdd_validation.attempt_number is
  'Increments each time the rule is settled to Passed or Failed.';

-- ---------------------------------------------------------
-- 9. Test history — every change, logged automatically
-- ---------------------------------------------------------

create table if not exists public.fdd_validation_history (
  id              bigserial primary key,
  ref             text not null,
  building        text not null,
  changed_at      timestamptz not null default now(),
  changed_by      text,
  attempt_number  integer,
  prev_status     text,
  status          text,
  failure_reason  text,
  point_driven    text,
  point_normal    text,
  point_target    text,
  hold_mins       integer,
  override_active boolean,
  driven_at       timestamptz,
  restored_at     timestamptz,
  tested_at       timestamptz,
  notes           text
);

create index if not exists idx_hist_rule
  on public.fdd_validation_history (ref, building, changed_at desc);

comment on table public.fdd_validation_history is
  'Append-only log of every change to a validation record. Never edited by hand.';

-- Bump the attempt counter when a rule is settled.
create or replace function public.bump_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('Passed', 'Failed')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.attempt_number := coalesce(
      case when tg_op = 'INSERT' then 0 else old.attempt_number end, 0) + 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_bump_attempt on public.fdd_validation;
create trigger trg_bump_attempt
  before insert or update on public.fdd_validation
  for each row execute function public.bump_attempt();

-- Write a history row whenever something meaningful changes.
create or replace function public.log_validation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed boolean;
begin
  if tg_op = 'INSERT' then
    changed := true;
  else
    changed := old.status         is distinct from new.status
            or old.notes          is distinct from new.notes
            or old.failure_reason is distinct from new.failure_reason
            or old.point_driven   is distinct from new.point_driven
            or old.point_normal   is distinct from new.point_normal
            or old.point_target   is distinct from new.point_target
            or old.hold_mins      is distinct from new.hold_mins
            or old.override_active is distinct from new.override_active;
  end if;

  if changed then
    insert into public.fdd_validation_history (
      ref, building, changed_by, attempt_number, prev_status, status,
      failure_reason, point_driven, point_normal, point_target, hold_mins,
      override_active, driven_at, restored_at, tested_at, notes
    ) values (
      new.ref, new.building,
      coalesce(auth.jwt() ->> 'email', 'unknown'),
      new.attempt_number,
      case when tg_op = 'INSERT' then null else old.status end,
      new.status, new.failure_reason, new.point_driven, new.point_normal,
      new.point_target, new.hold_mins, new.override_active,
      new.driven_at, new.restored_at, new.tested_at, new.notes
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_log_validation on public.fdd_validation;
create trigger trg_log_validation
  after insert or update on public.fdd_validation
  for each row execute function public.log_validation_change();

alter table public.fdd_validation_history enable row level security;

drop policy if exists "history read" on public.fdd_validation_history;
create policy "history read" on public.fdd_validation_history
  for select using (true);
-- No insert or update policy: rows arrive only via the trigger,
-- which runs as security definer. History cannot be rewritten.

-- ---------------------------------------------------------
-- 10. Programme settings — one row, shared by the team
-- ---------------------------------------------------------

create table if not exists public.validation_settings (
  id              integer primary key default 1,
  target_mode     text    not null default 'date',   -- 'date' or 'weeks'
  target_date     date,
  target_weeks    integer,
  days_per_week   numeric not null default 2.5,
  programme_start date    not null default current_date,
  updated_at      timestamptz not null default now(),
  constraint single_row check (id = 1),
  constraint mode_allowed check (target_mode in ('date', 'weeks'))
);

insert into public.validation_settings (id, target_mode, target_weeks, days_per_week)
values (1, 'weeks', 10, 2.5)
on conflict (id) do nothing;

alter table public.validation_settings enable row level security;

drop policy if exists "settings read"  on public.validation_settings;
drop policy if exists "settings write" on public.validation_settings;

create policy "settings read" on public.validation_settings
  for select using (true);
create policy "settings write" on public.validation_settings
  for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------
-- 11. Rebuild the queue view to carry the new columns
-- ---------------------------------------------------------

create or replace view public.v_validation_queue as
select
  s.ref,
  s.building,
  split_part(s.ref, '-', 1)          as equip_class,
  s.status                           as build_status,
  coalesce(v.status, 'Not started')  as status,
  v.failure_reason,
  coalesce(v.attempt_number, 0)      as attempt_number,
  v.point_driven,
  v.point_normal,
  v.point_target,
  v.hold_mins,
  coalesce(v.override_active, false) as override_active,
  v.driven_at,
  v.restored_at,
  v.tested_at,
  v.validated_by,
  coalesce(v.retests, 0)             as retests,
  coalesce(v.notes, '')              as notes,
  v.updated_at
from public.fdd_status s
left join public.fdd_validation v
  on v.ref = s.ref and v.building = s.building
where s.status = 'Enabled';

-- ---------------------------------------------------------
-- 12. Reporting views for the planner
-- ---------------------------------------------------------

create or replace view public.v_building_progress as
select
  building,
  count(*)                                                       as enabled_rules,
  count(*) filter (where status = 'Passed')                      as passed,
  count(*) filter (where status = 'Failed')                      as failed,
  count(*) filter (where status = 'Parked')                      as parked,
  count(*) filter (where status = 'In progress')                 as in_progress,
  count(*) filter (where status = 'Not started')                 as not_started,
  count(*) filter (where status in ('Passed','Failed','Parked')) as settled,
  round(100.0 * count(*) filter (where status in ('Passed','Failed','Parked'))
        / nullif(count(*), 0), 1)                                as percent_complete,
  round(100.0 * count(*) filter (where status = 'Passed')
        / nullif(count(*) filter (where status in ('Passed','Failed')), 0), 1)
                                                                 as pass_rate_pct
from public.v_validation_queue
group by building
order by percent_complete desc, building;

create or replace view public.v_weekly_recap as
select
  date_trunc('week', tested_at)::date                as week_starting,
  count(*)                                           as tested,
  count(*) filter (where status = 'Passed')          as passed,
  count(*) filter (where status = 'Failed')          as failed
from public.v_validation_queue
where tested_at is not null
group by 1
order by 1 desc;

create or replace view public.v_failure_reasons as
select
  coalesce(failure_reason, 'Not recorded') as failure_reason,
  equip_class,
  count(*)                                 as failures
from public.v_validation_queue
where status = 'Failed'
group by 1, 2
order by failures desc;

comment on view public.v_failure_reasons is
  'Failures grouped by cause and equipment class. A cause clustering on one class usually means the rule template is wrong, not the individual builds.';
