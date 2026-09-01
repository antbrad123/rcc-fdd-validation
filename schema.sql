-- =========================================================
-- RCC FDD Validation Tracker — Supabase schema
-- Run this once in the SQL editor of your Supabase project.
-- =========================================================

create table if not exists public.fdd_validations (
  id             text primary key,                 -- VAL-001
  fdd_ref        text not null,                    -- FDD-001, links back to the console
  building       text not null,
  asset          text not null,                    -- AHU-02
  equip_type     text not null,
  pattern        text not null,

  status         text not null default 'Not started',

  -- the BMS point you drive to provoke the fault
  point_name     text not null,
  point_normal   text,                             -- expected value at rest
  point_drive    text,                             -- value you drive it to
  hold_mins      integer default 15,
  expect_mins    integer default 10,               -- window the FDD should fire inside

  -- override safety
  override_active boolean not null default false,
  driven_at       timestamptz,
  restored_at     timestamptz,

  -- outcome
  tested_at      timestamptz,
  validated_by   text,
  retests        integer not null default 0,
  notes          text default '',

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint status_allowed check (
    status in ('Not started', 'Scheduled', 'In test', 'Passed', 'Failed', 'Blocked')
  ),
  -- an override cannot be both open and restored
  constraint override_consistent check (
    not (override_active and restored_at is not null)
  )
);

comment on table public.fdd_validations is
  'One row per FDD trigger-mechanism validation. Tracks the BMS point driven to prove the rule fires.';

create index if not exists idx_val_building on public.fdd_validations (building);
create index if not exists idx_val_status   on public.fdd_validations (status);
create index if not exists idx_val_pattern  on public.fdd_validations (pattern);
create index if not exists idx_val_override on public.fdd_validations (override_active) where override_active;

-- ---------------------------------------------------------
-- keep updated_at honest
-- ---------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_val_touch on public.fdd_validations;
create trigger trg_val_touch
  before update on public.fdd_validations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------
-- Open overrides — the ledger the console reads
-- ---------------------------------------------------------

create or replace view public.v_open_overrides as
select
  id, fdd_ref, building, asset, pattern, point_name, point_drive, driven_at,
  round(extract(epoch from (now() - driven_at)) / 3600.0, 1) as hours_open
from public.fdd_validations
where override_active
order by driven_at;

comment on view public.v_open_overrides is
  'Every BMS point currently driven for a validation, oldest first.';

-- ---------------------------------------------------------
-- Coverage rollup for reporting to regional engineering
-- ---------------------------------------------------------

create or replace view public.v_validation_coverage as
select
  building,
  count(*)                                            as total,
  count(*) filter (where status = 'Passed')           as passed,
  count(*) filter (where status = 'Failed')           as failed,
  count(*) filter (where status = 'Blocked')          as blocked,
  count(*) filter (where status in ('Passed','Failed')) as tested,
  round(
    100.0 * count(*) filter (where status in ('Passed','Failed')) / nullif(count(*), 0)
  , 1)                                                as coverage_pct,
  round(
    100.0 * count(*) filter (where status = 'Passed')
    / nullif(count(*) filter (where status in ('Passed','Failed')), 0)
  , 1)                                                as pass_rate_pct
from public.fdd_validations
group by building
order by building;

-- ---------------------------------------------------------
-- Row level security
-- Start permissive with the anon key so GitHub Pages can read
-- and write. Tighten to authenticated users once you add a team.
-- ---------------------------------------------------------

alter table public.fdd_validations enable row level security;

drop policy if exists "anon read"   on public.fdd_validations;
drop policy if exists "anon write"  on public.fdd_validations;
drop policy if exists "anon insert" on public.fdd_validations;

create policy "anon read"   on public.fdd_validations for select using (true);
create policy "anon write"  on public.fdd_validations for update using (true) with check (true);
create policy "anon insert" on public.fdd_validations for insert with check (true);

-- When you move to a team, swap the three policies above for:
--   create policy "team read"  on public.fdd_validations for select to authenticated using (true);
--   create policy "team write" on public.fdd_validations for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------
-- Seeding
-- ---------------------------------------------------------
-- Open the console, press "Export seed SQL", and run the file it
-- downloads. It writes 192 rows shaped exactly like the demo estate,
-- so you can swap in real point names building by building.
