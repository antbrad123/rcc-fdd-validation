# RCC FDD Validation Tracker

Tracks the validation of FDD trigger mechanisms across the King's Cross Estate. For each rule, it records the BMS point you drive, the value you drive it to, whether the FDD actually fired, and — critically — whether the point was put back.

Companion to the [RCC FDD Console](https://antbrad123.github.io/rcc-fdd-console/). Same lifecycle thinking, same petrol-and-paper design language, separate concern: the console tracks whether an FDD has been *built*, this tracks whether it has been *proved*.

---

## The idea

An FDD that has been built, configured and enabled has never actually been tested. We don't know whether it's watching the right point, whether its threshold is reachable, or whether the alarm lands on the right asset. Validation closes that gap: drive the point on purpose, watch what the platform does, put the point back.

## Views

**Monitor** — coverage and pass rate across the estate. Donut by status, stacked bars by building, and a pattern-against-outcome heatmap. Everything cross-filters: click a heatmap cell, a bar segment, a legend row, and the whole view narrows.

**Register** — every validation as a sortable, filterable row. Click any row to open the inspector, which shows the point to drive, the normal value, the drive value, the hold time and the expected trigger window. Record the result there.

**Method** — the operator handbook, on paper stock rather than petrol. The five rules, how a test moves through the register, and four worked test recipes laid out as set up → drive → confirm → restore.

## The override ledger

The one thing this app does that the console doesn't. Any point currently driven appears in an amber strip pinned below the header, with how long it's been that way. Past four hours it turns red.

This is deliberately impossible to ignore. A forgotten override is worse than the fault it was meant to prove — it masks the real condition and it can be left behind at the end of a shift. The strip disappears entirely when nothing is driven. An empty ledger is the state you hand over in.

## Lifecycle

```
Not started → Scheduled → In test → Passed
                             ↓         ↕
                          Blocked   Failed → (rule revised) → Not started
```

`Blocked` and `Failed` are not the same thing and the app keeps them apart. Failed means it was tested and the rule didn't work. Blocked means it couldn't be tested — read-only point, plant off, mapping unconfirmed. Mixing them makes the coverage figure meaningless.

Only `In test` puts a row on the override ledger.

---

## Setup

### 1. Create the repo

```bash
git init
git remote add origin https://github.com/antbrad123/rcc-fdd-validation.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: deploy from branch → main / (root)**.

### 2. Create the Supabase table

In your Supabase project, open the SQL editor and run `schema.sql`. It creates:

- `fdd_validations` — the table, with a check constraint on status and one preventing a row being both driven and restored
- `v_open_overrides` — everything currently driven, oldest first
- `v_validation_coverage` — coverage and pass rate per building, for reporting upward
- RLS policies (permissive with the anon key for now — tighten to `authenticated` when the team grows)

### 3. Point the app at it

In `app.js`, fill in the top block:

```js
const CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...',
  TABLE: 'fdd_validations',
  OPERATOR: 'A. Bradley',
  STALE_HOURS: 4
};
```

Leave those blank and the app runs on a built-in 192-record demo estate — useful for showing the thing to people without touching live data.

### 4. Seed it

Open the app, press **Export seed SQL**. It downloads `fdd_validations_seed.sql` containing all 192 rows. Run that in the Supabase SQL editor, then edit building by building to swap in real point names.

---

## Swapping in real estate data

Three places carry the estate model, all near the top of `app.js`:

- `BUILDINGS` — currently `KCE-01` … `KCE-16`. Replace with the real building names.
- `EQUIP_TYPES` and `EQUIP_TAG` — plant types and their asset-tag prefixes.
- `PATTERNS` — the 16 fault patterns. Each carries the point to drive, the expected normal value, the drive value, what to watch, and `equip`, the list of plant that pattern can occur on. That last field keeps the generator from producing nonsense like an economiser fault on an extract fan.

The point naming convention is `BUILDING/ASSET/POINT`. Change the template in `buildDemoEstate()` if KODE uses a different shape.

---

## A note carried over from the console

When removing any UI element, grep for every JS reference to its id and to any variable bound to it before finalising. The `#covToggle` bug in the console — a deleted element whose handler survived, throwing a TypeError at init and silently halting all subsequent script execution — cost real time. All DOM lookups in `app.js` that could be affected by markup changes are in `wire()` and `syncControls()`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell and all three views |
| `styles.css` | Petrol dark theme, paper theme, all components |
| `app.js` | Data layer, demo generator, rendering, inspector |
| `schema.sql` | Supabase table, views, RLS |

No build step and no framework. Open `index.html` locally and it runs.

## Still to do

- Add a validation from within the app rather than seeding (needs a form; the inspector covers editing already)
- Pull `fdd_ref` live from the console's Supabase project so the two stay in step
- Photo or screenshot evidence against a result
- CSV export for the monthly pack to regional engineering
