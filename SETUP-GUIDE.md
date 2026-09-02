# Validation Tracker — Setup Guide

Everything you need to get this running, in order. Nothing here needs the command line, and nothing here can break the FDD Console.

Roughly 20 minutes. Do it in one sitting if you can, because the steps build on each other.

---

## Already set this up once?

If the tracker is already running, you only need three things:

1. Supabase → SQL Editor → run the **whole of `schema.sql`** again. It's written to be safe to re-run; the new sections at the bottom add the failure reasons, the history log and the planner. Nothing you've already recorded is touched.
2. Upload the four files to GitHub, replacing the old ones.
3. Hard refresh the app (Ctrl/Cmd + Shift + R) and open the new **Planner** tab.

Then read **Part 6** below for what the new features do. Skip everything in between.

---

## Before you start

**Have these open in browser tabs:**

- Supabase — the **existing console project**, `jkzyyxlrhnzwiwhwbgyw`
- GitHub — your account
- The four files downloaded to a folder you can find again: `index.html`, `app.js`, `styles.css`, `schema.sql`

**One thing to know up front.** This tracker does not hold a list of FDDs. It reads them live from the console's database. That is why everything below happens in the console's Supabase project and not a new one — the two have to share a database or the tracker has nothing to read.

**If you created a new Supabase project earlier** (the one starting `wzbzquanhza…`), leave it alone for now. Don't delete it until the tracker is working, then it can go.

---

## Part 1 — Database

### Step 1.1 — Open the right project

Go to **app.supabase.com**.

You'll see a list of your projects. Click the one for the **FDD Console**.

> **Check before continuing.** Look at the URL in your browser. It should contain `jkzyyxlrhnzwiwhwbgyw`. If it doesn't, you're in the wrong project — go back and pick the other one. This matters more than anything else in this guide.

### Step 1.2 — Confirm the console's table is there

In the left sidebar, click **Table Editor**.

You should see a table called **`fdd_status`** in the list.

> **If you don't see it:** you're in the wrong project. Go back to Step 1.1.

Click on `fdd_status` and glance at the contents. You should see your FDD refs (like `AHU-12`), your building names, and statuses like `Enabled`, `Configured`, `Built`. This is the data the tracker will read.

While you're here, it's worth knowing roughly how many rows say `Enabled` — that's the number of rules the tracker will show you. You don't need an exact figure, just a rough sense so you can sanity-check later.

### Step 1.3 — Run the schema

In the left sidebar, click **SQL Editor**.

Click **+ New query**.

Open `schema.sql` on your computer in any text editor (Notepad, TextEdit, VS Code — anything). Select all of it and copy.

Paste into the big empty box in Supabase.

Click **Run** (bottom right, or Ctrl/Cmd + Enter).

**What you should see:** a green message saying **"Success. No rows returned"**.

That is correct and expected. The script creates tables and views — it doesn't add any data, so there are no rows to return.

> **If you see a red error instead:** copy the whole error message and send it to me. Don't try to fix it by editing the SQL. The script is written to be safe to run again, so nothing is broken by a failed run.

### Step 1.4 — Check it worked

Still in the SQL Editor, click **+ New query** and run this:

```sql
select count(*) from public.v_validation_queue;
```

**What you should see:** a single number. That's how many Enabled FDD rules the tracker will show you.

> **If the number is 0:** the schema ran fine, but nothing in `fdd_status` has the status `Enabled`. Check the console — if your rules are still at Configured, that's why. The tracker deliberately only shows Enabled rules, because a rule that isn't live isn't worth validating yet.

> **If you get "relation does not exist":** Step 1.3 didn't complete. Go back and run the schema again, watching for a red error.

---

## Part 2 — Your sign-in account

The tracker uses the same rule as the console: **anyone with the link can read, only a signed-in user can record results.** That means results are attributed to a real person automatically, which matters once the team grows.

### Step 2.1 — Check whether you already have an account

In the left sidebar, click **Authentication**.

You'll see a list of users. Look for your email address.

**If your email is there** — good, skip to Step 2.3.

**If the list is empty or your email isn't there** — do Step 2.2.

### Step 2.2 — Create your account

Click **Add user** (top right) → **Create new user**.

Fill in:
- **Email** — your work email
- **Password** — pick something you'll remember, at least 6 characters
- **Auto Confirm User** — tick this box. **This is important.** If you don't tick it, Supabase will wait for you to click a confirmation link in an email, and if that email doesn't arrive you'll be stuck.

Click **Create user**.

Your email should now appear in the list.

### Step 2.3 — Know your password

You'll need to type this password into the tracker in Part 4.

**If you already had an account but don't know the password:** in the Authentication user list, click the three dots (⋯) next to your email → **Reset password**. Or simpler, delete the user and recreate it via Step 2.2 with a password you choose. Deleting the user does not delete any data.

---

## Part 3 — GitHub

### Step 3.1 — Open your repo

Go to your `rcc-fdd-validation` repo on GitHub.

You should see the files you uploaded earlier.

### Step 3.2 — Replace the files

You're replacing all four files with the new versions. GitHub handles this automatically — uploading a file with the same name overwrites it.

Click **Add file** (top right) → **Upload files**.

Drag in all four:
- `index.html`
- `app.js`
- `styles.css`
- `schema.sql`

> **Note:** `schema.sql` isn't used by the running app — it's kept in the repo as a record of the database structure. Upload it anyway so the repo stays complete.

Scroll to the bottom. In the commit message box, type something like `Read live register, add sign-in`.

Click **Commit changes**.

### Step 3.3 — Delete the old README

If there's a `README.md` in the repo from the first upload, it now describes the old version and will confuse you later.

Click on it → click the bin/trash icon → **Commit changes**.

Optional, but worth doing.

### Step 3.4 — Wait for the site to rebuild

GitHub Pages takes 1–2 minutes to pick up changes.

You can watch it: click the **Actions** tab in your repo. You'll see a job running with an amber dot. When it turns into a green tick, the site is live.

---

## Part 4 — First run

### Step 4.1 — Open the app

Go to `https://YOUR-USERNAME.github.io/rcc-fdd-validation/`

> **If you see the old version:** your browser has cached it. Hard refresh — **Ctrl+Shift+R** on Windows, **Cmd+Shift+R** on Mac.

### Step 4.2 — Check it connected

Look at the **top right of the header**.

**What you should see:** a green dot and text like `327 enabled rules · 12 buildings`.

That number should roughly match what you saw in Step 1.4.

> **If you see an amber dot and "not connected":** the app will tell you what went wrong in the middle of the screen. Most likely the schema didn't run, or it ran in the wrong project. Go back to Part 1.

> **If you see real building names** — 1 Pancras, WTS, R7 and so on — it's working. If you ever see `KCE-01` through `KCE-16`, that's the old version still cached; hard refresh.

### Step 4.3 — Sign in

You'll see a grey bar saying **"Read-only. Sign in to record results."** That's correct — you're not signed in yet.

Click **Sign in** (top right).

Enter the email and password from Part 2.

Click **Sign in**.

**What you should see:** the modal closes, your email appears in the header, the grey read-only bar disappears, and the button now says **Sign out**.

> **If you get "That email and password did not match":** the account doesn't exist or the password is wrong. Go back to Step 2.2 and create the user, making sure **Auto Confirm User** is ticked.

You'll stay signed in — the session is remembered, so you shouldn't have to do this again on this device.

### Step 4.4 — Record one test

Do a real one so you know the whole chain works.

1. Click the **Register** tab
2. Click any row
3. The panel slides in from the right
4. Type something in **Point driven** — even just `TEST` for now
5. Change **Validation status** to `Passed`
6. Click **Save result**

**What you should see:** a message saying "Saved", the panel closes, and the row now shows a green `Passed` pill.

### Step 4.5 — Confirm it saved to the database

This is the step that proves it's genuinely working and not just updating the screen.

**Refresh the page.**

The row should still say `Passed`.

> **If it reverted to "Not started":** the write didn't reach the database. Most likely the RLS policies in the schema didn't apply. Send me what happens and I'll sort it.

You can also check directly: Supabase → **Table Editor** → `fdd_validation`. You should see exactly one row, the one you just saved, with your email in the `updated_by` column.

### Step 4.6 — Undo your test

Go back to the row, set the status to `Not started`, clear the note and the point, and save. That returns it to the queue.

---

## Part 5 — Tidy up

Once everything above works:

- **Delete the spare Supabase project** (`wzbzquanhza…`) — Settings → General → Delete project. It's not being used and having two projects will confuse you in six months.
- **Test the read-only view.** Open the app in a private/incognito window. You should see all the data with the grey read-only bar and no ability to save. That's what the regional engineering heads will get from the link.

---

## How it works day to day

**Where the list comes from.** Every FDD marked `Enabled` in the console appears here automatically. Build a new rule, set it Enabled, and it shows up as `Not started` next time you open the tracker. There is no second list to maintain.

**The five statuses:**

| Status | Means |
|---|---|
| Not started | Arrived from the console, no test yet |
| In progress | Point is driven right now — appears on the override ledger |
| Passed | Tested, the rule fired correctly |
| Failed | Tested, the rule did not fire correctly |
| Parked | Needs a physical trigger, can't be done from the front end |

Failing a rule requires a reason from a fixed list — see Part 6.

**Parked and Failed are not the same thing.** Failed means you tested it and it didn't work — an engineer needs to look at the rule. Parked means you couldn't test it at all, usually because it needs something physical like a generator load test. Keeping them apart is what stops your coverage figure from being misleading.

**The amber strip.** Any point you've marked as driven appears in an amber bar under the header, with a running age. Past four hours it turns red. When nothing is driven the bar disappears entirely — an empty strip is the state you hand over in. Use the **Mark point driven** and **Mark point restored** buttons in the detail panel so it stays accurate.

**Reporting.** The **Export CSV** button gives you whatever is currently filtered on screen. There's also a `v_validation_coverage` view in the database that gives coverage and pass rate per building, if you want to pull numbers directly for the monthly pack.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Amber dot, "not connected" | App can't reach the database | Check schema ran in project `jkzyyxlrhnzwiwhwbgyw` |
| "relation v_validation_queue does not exist" | Schema didn't run, or ran in the wrong project | Re-run Part 1 |
| Connected but 0 rules | Nothing in `fdd_status` is `Enabled` | Check the console — this may be correct |
| Buildings show as `KCE-01`… | Old cached version | Hard refresh: Ctrl/Cmd+Shift+R |
| "Sign in to record a result" | Not signed in | Click Sign in, top right |
| "email and password did not match" | Account doesn't exist or wrong password | Part 2, tick **Auto Confirm User** |
| Saves, but reverts on refresh | Write isn't reaching the database | Check RLS policies — send me the error |
| Page looks unstyled | `styles.css` didn't upload | Re-upload it, check the filename is exact |
| Planner tab missing | Old `index.html` still cached | Hard refresh: Ctrl/Cmd+Shift+R |
| "Could not load the history" | History table not created | Re-run the whole of `schema.sql` |
| Planner shows no target | Plan not saved yet | Planner → cog icon → set it → Save plan |
| "Sign in to change the programme plan" | Plan settings are shared, so they need auth | Sign in, top right |
| Can't save a Failed result | A failure reason is required | Pick one from the dropdown |
| Email button does nothing | No mail client associated with the browser | Use Copy summary instead |

**A general rule:** if the page looks broken or blank, open the browser console (F12, then the Console tab) and look for a red error. Send me that error and I can usually identify it immediately. That's how the `#covToggle` problem on the console got found — one broken line silently stops everything after it from running.

---

## Part 6 — The planner, failure reasons and history

### Setting up your plan

Open the **Planner** tab and click the **cog icon** on the right.

You have two ways to describe the programme, and you can switch between them freely:

- **Run for X weeks** — "I'm giving this 10 weeks from when I started"
- **Finish by a date** — "This has to be done by 15 March"

Then set **days per week on this**. This is the number that matters most. If you can realistically give this 2 or 3 partial days a week, put `2.5`. Everything the planner tells you is measured in *working days*, not calendar days, because calendar days would flatter the numbers and tell you you're fine right up until you aren't.

**Programme started** defaults to today the first time. If you began validating before setting this up, backdate it so the pace figures reflect reality.

Click **Save plan**. You need to be signed in — the plan is shared, not personal, so the team sees the same targets.

### Reading the planner

**The health box** (top right) is the summary. Green means the rate you're actually working at will land the remaining rules before the target. Amber means slightly behind. Red means the target isn't reachable at the current rate — either book more time or move the date.

**Four metrics underneath:**

| Metric | What it means |
|---|---|
| Needed | Rules you must settle per working day to hit the target |
| Actual | What you've actually managed, measured over the last 28 days |
| Working days left | Calendar days remaining converted at your days-per-week |
| Finishes | Where the current rate projects you landing, and by how much you'd miss |

**The trajectory chart** shows cumulative settled rules over time. The dashed grey line is even pace to the target. The solid teal line is you. Above the dashed line is ahead, below is behind. The amber vertical line is today.

> **Worth knowing:** the chart only draws from data you've recorded. In the first couple of weeks it will look sparse and the pace figures will swing about. Give it three or four weeks of real results before you trust the projection.

### This week card

Shows what you've settled this week against what you needed, with the previous three weeks as bars for context.

**Copy summary** puts a plain-text block on your clipboard — paste it into Slack, Teams or a status email.

**Email to me** opens your normal mail client with the same text already in the body and a subject line filled in. It doesn't send anything; you get a draft to check and send. If nothing happens when you click it, your browser doesn't have a mail client associated — use Copy summary instead.

### By building

Two views, toggled top right:

- **Bars** — quick scan, sorted with the most complete building first
- **Table** — the numbers: enabled, settled, passed, failed, parked, % complete, pass rate

Colour banding is 80%+ green, 50–80% amber, below 50% red.

Sorting by completion is deliberate. It tends to show that one or two buildings are naturally faster, usually because the plant is more accessible or the points are better mapped. Worth leaning into that rather than working alphabetically.

### Failure reasons

When you set a result to **Failed**, a "Why did it fail?" dropdown appears. **You can't save a failure without picking one.** That's intentional and slightly annoying by design.

The seven reasons:

| Reason | Use when |
|---|---|
| Threshold too wide | The condition cleared before the rule's limit was reached |
| Point read-only / inaccessible | You couldn't drive the point from the front end |
| Timing issue | The rule fired, but far too slowly to be useful |
| Rule logic wrong | The logic doesn't match what the fault actually looks like |
| Wrong asset mapping | The alarm raised against a different asset |
| Measurement error | The rule reads a point that isn't measuring what it claims |
| Other | Anything else — put the detail in the notes |

The point of forcing this is what shows up when you export. If six PMP rules all failed with "Point read-only", that isn't six build mistakes — it's one problem with how pumps are mapped estate-wide. You'd never spot that from free-text notes.

There's a view in the database for exactly this:

```sql
select * from public.v_failure_reasons;
```

It groups failures by cause and equipment class.

### Test history

Every change to a validation record is logged automatically — status, points, notes, who and when. You don't have to do anything.

Open any rule and click **Show full test history** at the bottom of the panel. It's collapsed by default because most of the time you only care about the current state.

The history is **append-only**. There's no policy allowing anything to update or delete those rows, so it can't be rewritten, by you or anyone else. That's what makes it usable as a commissioning record.

A rule that took three attempts reads as a story: failed on timing, failed on mapping, passed. That's far more useful at handover than a single green tick.

---

## What this does not touch

Worth stating plainly, since the console is in use across the estate:

- It **only reads** from `fdd_status`. It never writes to it.
- It writes only to `fdd_validation`, a new table nothing else uses.
- The console's own code isn't modified in any way.

The worst case if something here goes wrong is that the tracker doesn't work. The console carries on exactly as it is.
