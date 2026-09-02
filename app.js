/* =========================================================
   RCC FDD Validation Tracker
   Reads the live register from the console's Supabase project.
   No baked-in estate data — if it is not in fdd_status, it is
   not in this app.
   ========================================================= */

/* ---------- 1. Configuration ---------- */

const CONFIG = {
  // The console's project. Both fdd_status and fdd_validation live here.
  SUPABASE_URL: 'https://jkzyyxlrhnzwiwhwbgyw.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_FzEZ-lYc_NAOw8qYjHpmtA_S51mqcZN',

  QUEUE_VIEW: 'v_validation_queue',   // Enabled FDDs + validation state
  WRITE_TABLE: 'fdd_validation',      // where results are written
  CATALOG: 'fdd_catalog',             // optional ref -> title lookup

  OPERATOR: 'Ant Bradford',
  STALE_HOURS: 4                      // an override open longer than this goes red
};

/* ---------- 2. Domain constants ---------- */

const STATUSES = [
  { key: 'Not started', hex: '#5c8087' },
  { key: 'In progress', hex: '#f0a202' },
  { key: 'Passed',      hex: '#3ecf8e' },
  { key: 'Failed',      hex: '#e5484d' },
  { key: 'Parked',      hex: '#9d7cf0' }
];

const STATUS_HEX = Object.fromEntries(STATUSES.map(s => [s.key, s.hex]));

// Why a rule did not fire. Recorded against every Failed result so the
// export shows whether a cause is clustering on one equipment class.
const FAILURE_REASONS = [
  'Threshold too wide',
  'Point read-only / inaccessible',
  'Timing issue',
  'Rule logic wrong',
  'Wrong asset mapping',
  'Measurement error',
  'Other'
];

// A rule counts as done when it has been settled either way.
const SETTLED = ['Passed', 'Failed', 'Parked'];

// Equipment classes as they appear in FDD refs (AHU-12 -> AHU).
const EQUIP_LABELS = {
  AHU: 'Air handling unit', CH: 'Chiller', PMP: 'Pump', CAL: 'Calorifier',
  DE: 'Dry expansion', BMS: 'BMS', PU: 'Pressurisation unit', FA: 'Fresh air',
  BCW: 'Boosted cold water', LD: 'Leak detection', SP: 'Sump pump',
  DG: 'Distribution gear', ACB: 'Air circuit breaker', GEN: 'Generator', RL: 'Relay'
};

// Starting suggestion for the point to drive, by equipment class.
// A hint only — the operator records what they actually drove.
const POINT_HINTS = {
  AHU: 'SA-TEMP / FAN-STS / FLT-DP', CH: 'CHW-FLOW / RUN-STS / EVAP-TEMP',
  PMP: 'RUN-STS / FLOW-SW / VSD-SPD', CAL: 'STORE-TEMP / HTG-VLV',
  DE: 'RUN-STS / SPACE-TEMP', BMS: 'COV-HEARTBEAT / PANEL-STS',
  PU: 'PRESS-LOW / PUMP-RUN', FA: 'FAN-STS / DMP-FBK',
  BCW: 'PRESS / PUMP-RUN / TANK-LVL', LD: 'LEAK-ALM',
  SP: 'HIGH-LVL / PUMP-RUN', DG: 'BREAKER-STS / SUPPLY-HLTH',
  ACB: 'BREAKER-STS / TRIP-ALM', GEN: 'RUN-STS / FUEL-LVL / BATT-V',
  RL: 'RELAY-STS'
};

/* ---------- 3. State ---------- */

const state = {
  view: 'monitor',
  rows: [],
  catalog: {},
  buildings: [],
  equipClasses: [],
  connected: false,
  loadError: null,
  session: null,
  settings: { target_mode: 'weeks', target_date: null, target_weeks: 10,
              days_per_week: 2.5, programme_start: null },
  history: {},          // rowKey -> array of history rows, fetched on demand
  sb: null,
  selectedId: null,
  sort: { key: 'building', dir: 1 },
  buildingView: 'bars',   // 'bars' or 'table'
  filters: {
    building: '', equip_class: '', status: '',
    search: '', overridesOnly: false, hideComplete: false
  }
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const rowKey = r => `${r.ref}::${r.building}`;

/* ---------- 4. Data layer ---------- */

async function initData() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) {
    state.loadError = 'No Supabase credentials set in app.js.';
    setConn(false, 'not configured');
    return;
  }

  try {
    state.sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

    const { data, error } = await state.sb
      .from(CONFIG.QUEUE_VIEW)
      .select('*')
      .order('building')
      .order('ref');

    if (error) throw error;

    state.rows = (data || []).map(r => ({
      ...r,
      equip_class: r.equip_class || String(r.ref).split('-')[0]
    }));

    // Optional titles. Absent table is not an error.
    try {
      const { data: cat } = await state.sb.from(CONFIG.CATALOG).select('ref,title,pattern');
      if (cat) state.catalog = Object.fromEntries(cat.map(c => [c.ref, c]));
    } catch (_) { /* catalog is optional */ }

    state.buildings = [...new Set(state.rows.map(r => r.building))].sort();
    state.equipClasses = [...new Set(state.rows.map(r => r.equip_class))].sort();
    state.connected = true;

    setConn(true, `${state.rows.length} enabled rules · ${state.buildings.length} buildings`);
  } catch (err) {
    console.error(err);
    state.loadError = err.message || String(err);
    setConn(false, 'not connected');
  }
}

// Upsert, because a validation row may not exist until first edit.
async function saveRow(row, patch) {
  if (!state.connected) return false;
  if (!signedIn()) {
    toast('Sign in to record a result. The register is read-only until you do.', true);
    openAuthModal();
    return false;
  }
  Object.assign(row, patch);

  const payload = {
    ref: row.ref,
    building: row.building,
    status: row.status,
    point_driven: row.point_driven || null,
    point_normal: row.point_normal || null,
    point_target: row.point_target || null,
    hold_mins: row.hold_mins || null,
    override_active: !!row.override_active,
    driven_at: row.driven_at || null,
    restored_at: row.restored_at || null,
    tested_at: row.tested_at || null,
    failure_reason: row.failure_reason || null,
    validated_by: row.validated_by || null,
    retests: row.retests || 0,
    notes: row.notes || ''
  };

  const { error } = await state.sb
    .from(CONFIG.WRITE_TABLE)
    .upsert(payload, { onConflict: 'ref,building' });

  // The write adds a history row, so the cached copy is now stale.
  delete state.history[rowKey(row)];

  if (error) {
    console.error(error);
    toast('Save failed: ' + error.message, true);
    return false;
  }
  return true;
}

function setConn(live, text) {
  $('#conn').classList.toggle('live', live);
  $('#conn-text').textContent = text;
}


/* ---------- 4a. Programme settings ---------- */

async function loadSettings() {
  if (!state.sb) return;
  try {
    const { data, error } = await state.sb
      .from('validation_settings').select('*').eq('id', 1).single();
    if (error) throw error;
    if (data) state.settings = data;
  } catch (err) {
    console.warn('Settings unavailable, using defaults.', err.message);
  }
  if (!state.settings.programme_start) {
    state.settings.programme_start = new Date().toISOString().slice(0, 10);
  }
}

async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  if (!signedIn()) {
    toast('Sign in to change the programme plan.', true);
    openAuthModal();
    return false;
  }
  const { error } = await state.sb.from('validation_settings').update({
    target_mode: state.settings.target_mode,
    target_date: state.settings.target_date || null,
    target_weeks: state.settings.target_weeks || null,
    days_per_week: state.settings.days_per_week,
    programme_start: state.settings.programme_start
  }).eq('id', 1);
  if (error) { toast('Could not save the plan: ' + error.message, true); return false; }
  return true;
}

/* ---------- 4b. Authentication ---------- */
/* Same model as the console: anyone can read, only a signed-in
   user can record a result. Session persists, so you sign in once. */

async function initAuth() {
  if (!state.sb) return;
  try {
    const { data } = await state.sb.auth.getSession();
    state.session = data ? data.session : null;
  } catch (err) {
    console.error(err);
  }
  state.sb.auth.onAuthStateChange((_evt, session) => {
    state.session = session;
    renderAuth();
    if (state.connected) render();
  });
  renderAuth();
}

const signedIn = () => !!state.session;
const userEmail = () => (state.session && state.session.user && state.session.user.email) || '';

function renderAuth() {
  const btn = $('#auth-btn');
  const who = $('#auth-who');
  if (!btn) return;
  if (signedIn()) {
    btn.textContent = 'Sign out';
    btn.classList.remove('primary');
    who.textContent = userEmail();
    who.hidden = false;
  } else {
    btn.textContent = 'Sign in';
    btn.classList.add('primary');
    who.hidden = true;
  }
  const banner = $('#readonly-banner');
  if (banner) banner.hidden = signedIn() || !state.connected;
}

function openAuthModal() {
  $('#auth-modal').classList.add('open');
  $('#auth-error').hidden = true;
  setTimeout(() => $('#auth-email').focus(), 60);
}

function closeAuthModal() {
  $('#auth-modal').classList.remove('open');
}

async function doSignIn() {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const err = $('#auth-error');

  if (!email || !password) {
    err.textContent = 'Enter both your email and password.';
    err.hidden = false;
    return;
  }

  const btn = $('#auth-submit');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const { error } = await state.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    closeAuthModal();
    $('#auth-password').value = '';
    toast('Signed in as ' + email);
  } catch (e) {
    err.textContent = e.message === 'Invalid login credentials'
      ? 'That email and password did not match. Check the user exists in Supabase under Authentication and that the password is right.'
      : e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function doSignOut() {
  await state.sb.auth.signOut();
  toast('Signed out. The register is still readable.');
}

/* ---------- 4c. Test history ---------- */

async function loadHistory(key) {
  if (state.history[key]) return state.history[key];
  const [ref, building] = key.split('::');
  try {
    const { data, error } = await state.sb
      .from('fdd_validation_history')
      .select('*')
      .eq('ref', ref).eq('building', building)
      .order('changed_at', { ascending: true });
    if (error) throw error;
    state.history[key] = data || [];
  } catch (err) {
    console.error(err);
    state.history[key] = null;   // null means the lookup failed
  }
  return state.history[key];
}

/* ---------- 5. Helpers ---------- */

const fmtDate = iso => iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  : '—';

const hoursSince = iso => iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : 0;

function ageLabel(iso) {
  const h = hoursSince(iso);
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
  if (h < 48) return h.toFixed(1).replace('.0', '') + 'h';
  return Math.round(h / 24) + 'd';
}

function statusPill(status) {
  const hex = STATUS_HEX[status] || '#888';
  return `<span class="pill" style="color:${hex};background:${hex}1f"><span class="d"></span>${status}</span>`;
}

const title = ref => (state.catalog[ref] && state.catalog[ref].title) || '';
const equipLabel = c => EQUIP_LABELS[c] || c;

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 6. Filtering ---------- */

function filtered() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  return state.rows.filter(r => {
    if (f.building && r.building !== f.building) return false;
    if (f.equip_class && r.equip_class !== f.equip_class) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.overridesOnly && !r.override_active) return false;
    if (f.hideComplete && (r.status === 'Passed' || r.status === 'Parked')) return false;
    if (q) {
      const hay = [r.ref, r.building, r.equip_class, title(r.ref), r.point_driven, r.notes]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function setFilter(key, value) {
  state.filters[key] = state.filters[key] === value ? '' : value;
  render();
}

function clearFilters() {
  state.filters = { building: '', equip_class: '', status: '', search: '', overridesOnly: false, hideComplete: false };
  $('#search').value = '';
  render();
}

/* ---------- 7. Render: shell ---------- */

function render() {
  // When disconnected the Monitor and Register markup has been replaced by
  // the empty state, so their elements no longer exist. Rendering into them
  // would throw and halt everything after it.
  if (!state.connected) return;
  renderLedger();
  renderChips();
  syncControls();
  if (state.view === 'monitor') renderMonitor();
  if (state.view === 'register') renderRegister();
  if (state.view === 'planner') renderPlanner();
}

function switchView(v) {
  state.view = v;
  document.body.classList.toggle('view-method', v === 'method');
  $('#filterbar').hidden = (v === 'method' || v === 'planner') || !state.connected;
  $$('nav.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $$('.view').forEach(el => { el.hidden = el.id !== 'view-' + v; });
  render();
}

/* ---------- 8. Not-connected state ---------- */

function renderDisconnected() {
  const msg = state.loadError || 'Could not reach the console database.';
  const html = `<div class="empty">
    <strong>Not connected to the register</strong>
    This tracker reads your live FDD register from the console's Supabase project.
    It carries no data of its own, so there is nothing to show until it connects.
    <div class="err-detail">${esc(msg)}</div>
    <div class="err-steps">
      Check that <code>schema.sql</code> has been run in project
      <code>jkzyyxlrhnzwiwhwbgyw</code>, and that the URL and key at the top of
      <code>app.js</code> match that project.
    </div>
  </div>`;
  $('#view-monitor').innerHTML = html;
  $('#view-register').innerHTML = html;
  $('#filterbar').hidden = true;
}

/* ---------- 9. Render: override ledger ---------- */

function renderLedger() {
  const open = state.rows.filter(r => r.override_active);
  const bar = $('#ledger');
  if (!open.length) { bar.hidden = true; return; }
  bar.hidden = false;

  open.sort((a, b) => new Date(a.driven_at || 0) - new Date(b.driven_at || 0));
  const stale = open.filter(r => hoursSince(r.driven_at) > CONFIG.STALE_HOURS).length;

  $('#ledger-count').textContent =
    `${open.length} point${open.length === 1 ? '' : 's'} still driven`
    + (stale ? ` · ${stale} over ${CONFIG.STALE_HOURS}h` : '');

  $('#ledger-items').innerHTML = open.slice(0, 8).map(r => {
    const h = hoursSince(r.driven_at);
    return `<button class="ledger-chip" data-open="${esc(rowKey(r))}">
      <span>${esc(r.building)} · ${esc(r.ref)}${r.point_driven ? ' · ' + esc(r.point_driven) : ''}</span>
      <span class="age${h > CONFIG.STALE_HOURS ? ' stale' : ''}">${ageLabel(r.driven_at)}</span>
      <span class="go">restore</span>
    </button>`;
  }).join('')
  + (open.length > 8 ? `<button class="ledger-chip" data-showall="1"><span>+${open.length - 8} more</span></button>` : '');
}

/* ---------- 10. Render: filter chips ---------- */

function renderChips() {
  const f = state.filters;
  const items = [];
  if (f.building) items.push(['Building', f.building, 'building']);
  if (f.equip_class) items.push(['Class', f.equip_class, 'equip_class']);
  if (f.status) items.push(['Status', f.status, 'status']);
  if (f.overridesOnly) items.push(['View', 'Open overrides', 'overridesOnly']);
  if (f.hideComplete) items.push(['View', 'Outstanding only', 'hideComplete']);
  if (f.search) items.push(['Search', f.search, 'search']);

  const wrap = $('#chips');
  if (!wrap) return;
  wrap.hidden = items.length === 0;
  wrap.innerHTML = items.map(([k, v, key]) =>
    `<span class="chip"><span class="k">${k}</span> ${esc(v)}
      <button data-clear="${key}" aria-label="Clear ${k} filter">×</button></span>`).join('')
    + (items.length > 1 ? `<button class="btn ghost" data-clear="__all">Clear all</button>` : '');
}

function syncControls() {
  const f = state.filters;
  ['building', 'equip_class', 'status'].forEach(k => {
    const el = document.getElementById('f-' + k);
    if (el) el.value = f[k];
  });
  if ($('#t-overrides')) $('#t-overrides').checked = f.overridesOnly;
  if ($('#t-outstanding')) $('#t-outstanding').checked = f.hideComplete;
}

/* ---------- 11. Render: Monitor ---------- */

function renderMonitor() {
  const rows = filtered();
  renderKpis(rows);
  renderDonut(rows);
  renderBars(rows);
  renderHeat(rows);
  $('#monitor-count').textContent = `${rows.length} of ${state.rows.length} enabled rules in view`;
}

function renderKpis(rows) {
  const n = rows.length || 1;
  const by = s => rows.filter(r => r.status === s).length;
  const passed = by('Passed'), failed = by('Failed');
  const settled = passed + failed;
  const open = state.rows.filter(r => r.override_active).length;
  const stale = state.rows.filter(r => r.override_active && hoursSince(r.driven_at) > CONFIG.STALE_HOURS).length;

  const cards = [
    { cls: 'info', label: 'Coverage', value: Math.round(settled / n * 100) + '%', foot: `${settled} of ${rows.length} tested` },
    { cls: 'good', label: 'Trigger confirmed', value: passed, foot: settled ? Math.round(passed / settled * 100) + '% pass rate' : 'no tests yet' },
    { cls: 'bad', label: 'Trigger failed', value: failed, foot: failed ? 'needs rule review' : 'nothing outstanding' },
    { cls: 'warn', label: 'Still to test', value: by('Not started') + by('In progress'), foot: by('In progress') + ' in progress' },
    { cls: open ? (stale ? 'bad' : 'warn') : 'good', label: 'Points driven', value: open, foot: open ? (stale ? stale + ' over ' + CONFIG.STALE_HOURS + 'h' : 'all within window') : 'BMS clean' }
  ];

  $('#kpis').innerHTML = cards.map(c => `
    <div class="kpi ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="foot">${c.foot}</div>
    </div>`).join('');
}

function renderDonut(rows) {
  const counts = STATUSES.map(s => ({ ...s, n: rows.filter(r => r.status === s.key).length }));
  const total = rows.length;
  const R = 76, C = 2 * Math.PI * R;
  let offset = 0;

  const segs = counts.filter(c => c.n > 0).map(c => {
    const len = total ? (c.n / total) * C : 0;
    const seg = `<circle r="${R}" cx="95" cy="95" stroke="${c.hex}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      class="${state.filters.status && state.filters.status !== c.key ? 'dim' : ''}"
      data-status="${c.key}"><title>${c.key}: ${c.n}</title></circle>`;
    offset += len;
    return seg;
  }).join('');

  $('#donut').innerHTML = `<svg viewBox="0 0 190 190">${segs ||
    `<circle r="${R}" cx="95" cy="95" stroke="var(--surface-2)" stroke-dasharray="${C} 0"></circle>`}</svg>
    <div class="donut-centre"><div class="n">${total}</div><div class="t">in view</div></div>`;

  $('#legend').innerHTML = counts.map(c => `
    <button data-status="${c.key}" class="${state.filters.status === c.key ? 'active' : ''}">
      <span class="sw" style="background:${c.hex}"></span>
      <span class="nm">${c.key}</span>
      <span class="ct">${c.n}</span>
    </button>`).join('');
}

function renderBars(rows) {
  $('#bars').innerHTML = state.buildings.map(b => {
    const set = rows.filter(r => r.building === b);
    const total = set.length;
    const segs = STATUSES.map(s => {
      const n = set.filter(r => r.status === s.key).length;
      if (!n) return '';
      return `<div class="bar-seg" style="width:${(n / total * 100).toFixed(2)}%;background:${s.hex}"
        data-building="${esc(b)}" data-status="${s.key}" title="${esc(b)} · ${s.key}: ${n}"></div>`;
    }).join('');
    return `<div class="bar-row">
      <div class="name ${state.filters.building === b ? 'active' : ''}" data-building="${esc(b)}" title="${esc(b)}">${esc(b)}</div>
      <div class="bar-track">${segs}</div>
      <div class="tot">${total || ''}</div>
    </div>`;
  }).join('');
}

function renderHeat(rows) {
  const cols = STATUSES.map(s => s.key);
  const classes = state.equipClasses;
  const max = Math.max(1, ...classes.map(c => Math.max(...cols.map(st =>
    rows.filter(r => r.equip_class === c && r.status === st).length))));

  const head = `<tr><th></th>${cols.map(c => `<th class="col">${c}</th>`).join('')}</tr>`;
  const body = classes.map(cl => {
    const cells = cols.map(st => {
      const n = rows.filter(r => r.equip_class === cl && r.status === st).length;
      const hex = STATUS_HEX[st];
      const a = (0.16 + 0.72 * (n / max)).toFixed(2);
      const style = n ? `background-color:${hexA(hex, a)};color:${n / max > 0.55 ? '#08161a' : hex}` : '';
      return `<td><div class="cell ${n ? '' : 'zero'}" style="${style}"
        data-equip="${esc(cl)}" data-status="${st}" title="${esc(cl)} · ${st}: ${n}">${n || ''}</div></td>`;
    }).join('');
    return `<tr><th title="${esc(equipLabel(cl))}">${esc(cl)}</th>${cells}</tr>`;
  }).join('');

  $('#heat').innerHTML = `<table>${head}${body}</table>`;
}

function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}


/* ---------- 11b. Planner: the maths ---------- */

const DAY = 864e5;
const dayStart = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const addDays = (d, n) => new Date(dayStart(d).getTime() + n * DAY);
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY);
const isoDay = d => dayStart(d).toISOString().slice(0, 10);

function programme() {
  const s = state.settings;
  const rows = state.rows;
  const today = dayStart(new Date());

  const start = dayStart(s.programme_start || today);
  const target = s.target_mode === 'date' && s.target_date
    ? dayStart(s.target_date)
    : addDays(start, (s.target_weeks || 10) * 7);

  const total = rows.length;
  const settled = rows.filter(r => SETTLED.includes(r.status)).length;
  const passed = rows.filter(r => r.status === 'Passed').length;
  const failed = rows.filter(r => r.status === 'Failed').length;
  const parked = rows.filter(r => r.status === 'Parked').length;
  const remaining = total - settled;

  const dpw = Number(s.days_per_week) || 2.5;
  const daysLeft = daysBetween(today, target);
  const sessionsLeft = Math.max(0, (daysLeft / 7) * dpw);
  const requiredPerSession = sessionsLeft > 0 ? remaining / sessionsLeft : Infinity;

  // Observed rate over the last 28 days, or since the programme started
  // if that is shorter. Measured per working session, not per calendar day.
  const elapsed = Math.max(1, daysBetween(start, today));
  const windowDays = Math.min(28, elapsed);
  const since = addDays(today, -windowDays);
  const recent = rows.filter(r => r.tested_at && new Date(r.tested_at) >= since).length;
  const sessionsInWindow = Math.max(0.5, (windowDays / 7) * dpw);
  const actualPerSession = recent / sessionsInWindow;

  const ratio = requiredPerSession > 0 && isFinite(requiredPerSession)
    ? actualPerSession / requiredPerSession : (remaining === 0 ? 2 : 0);

  let health = 'red', healthLabel = 'Behind — needs more time booked';
  if (remaining === 0) { health = 'green'; healthLabel = 'Complete'; }
  else if (ratio >= 0.9) { health = 'green'; healthLabel = 'On track'; }
  else if (ratio >= 0.7) { health = 'amber'; healthLabel = 'Slightly behind'; }

  // Where the current rate lands you.
  const projSessions = actualPerSession > 0 ? remaining / actualPerSession : Infinity;
  const projDate = isFinite(projSessions) ? addDays(today, (projSessions / dpw) * 7) : null;

  return {
    start, target, today, total, settled, passed, failed, parked, remaining,
    dpw, daysLeft, sessionsLeft, requiredPerSession, actualPerSession,
    ratio, health, healthLabel, projDate, windowDays,
    percent: total ? Math.round(settled / total * 100) : 0
  };
}

function weekOf(d) {
  const x = dayStart(d);
  const day = (x.getDay() + 6) % 7;        // Monday = 0
  return addDays(x, -day);
}

function weeklyRecap() {
  const thisWeek = weekOf(new Date());
  const bucket = start => {
    const end = addDays(start, 7);
    const set = state.rows.filter(r => r.tested_at
      && new Date(r.tested_at) >= start && new Date(r.tested_at) < end);
    return {
      start,
      tested: set.length,
      passed: set.filter(r => r.status === 'Passed').length,
      failed: set.filter(r => r.status === 'Failed').length,
      parked: set.filter(r => r.status === 'Parked').length
    };
  };
  return [0, 1, 2, 3].map(i => bucket(addDays(thisWeek, -7 * i)));
}

/* ---------- 11c. Planner: render ---------- */

function renderPlanner() {
  const p = programme();
  renderPlanHero(p);
  renderPlanChart(p);
  renderRecap(p);
  renderBuildingProgress();
  renderSettingsCard();
}

function renderPlanHero(p) {
  const dot = { green: 'var(--good)', amber: 'var(--warn)', red: 'var(--bad)' }[p.health];
  const perWeekNeeded = (p.requiredPerSession * p.dpw);

  $('#plan-hero').innerHTML = `
    <div class="plan-top">
      <div class="plan-progress">
        <div class="plan-nums">
          <span class="big">${p.settled}</span>
          <span class="of">of ${p.total} settled</span>
          <span class="pct">${p.percent}%</span>
        </div>
        <div class="pbar">
          <div class="pbar-seg" style="width:${p.total ? p.passed / p.total * 100 : 0}%;background:var(--s-passed)" title="Passed: ${p.passed}"></div>
          <div class="pbar-seg" style="width:${p.total ? p.failed / p.total * 100 : 0}%;background:var(--s-failed)" title="Failed: ${p.failed}"></div>
          <div class="pbar-seg" style="width:${p.total ? p.parked / p.total * 100 : 0}%;background:var(--s-parked)" title="Parked: ${p.parked}"></div>
        </div>
        <div class="pbar-key">
          <span><i style="background:var(--s-passed)"></i>${p.passed} passed</span>
          <span><i style="background:var(--s-failed)"></i>${p.failed} failed</span>
          <span><i style="background:var(--s-parked)"></i>${p.parked} parked</span>
          <span><i style="background:var(--surface-3)"></i>${p.remaining} to go</span>
        </div>
      </div>

      <div class="plan-health ${p.health}">
        <div class="ph-dot" style="background:${dot}"></div>
        <div>
          <div class="ph-label">${p.healthLabel}</div>
          <div class="ph-sub">${p.daysLeft > 0
            ? `${p.daysLeft} days left · target ${fmtDate(p.target)}`
            : `Target date passed (${fmtDate(p.target)})`}</div>
        </div>
      </div>
    </div>

    <div class="plan-metrics">
      <div class="pm">
        <div class="pm-label">Needed</div>
        <div class="pm-value">${isFinite(p.requiredPerSession) ? p.requiredPerSession.toFixed(1) : '—'}</div>
        <div class="pm-foot">rules per working day${isFinite(perWeekNeeded) ? ` · ${perWeekNeeded.toFixed(0)}/week` : ''}</div>
      </div>
      <div class="pm">
        <div class="pm-label">Actual</div>
        <div class="pm-value">${p.actualPerSession.toFixed(1)}</div>
        <div class="pm-foot">last ${p.windowDays} days${p.actualPerSession ? ` · ${(p.actualPerSession * p.dpw).toFixed(0)}/week` : ''}</div>
      </div>
      <div class="pm">
        <div class="pm-label">Working days left</div>
        <div class="pm-value">${Math.round(p.sessionsLeft)}</div>
        <div class="pm-foot">at ${p.dpw} days per week</div>
      </div>
      <div class="pm">
        <div class="pm-label">Finishes</div>
        <div class="pm-value sm">${p.remaining === 0 ? 'Done'
          : p.projDate ? fmtDate(p.projDate) : 'No rate yet'}</div>
        <div class="pm-foot">${p.remaining === 0 ? 'nothing outstanding'
          : p.projDate ? (daysBetween(p.target, p.projDate) <= 0
              ? `${Math.abs(daysBetween(p.target, p.projDate))} days early`
              : `${daysBetween(p.target, p.projDate)} days late`)
          : 'record a result to project'}</div>
      </div>
    </div>`;
}

function renderPlanChart(p) {
  const W = 720, H = 260, PAD = { t: 16, r: 16, b: 30, l: 40 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;

  const spanDays = Math.max(7, daysBetween(p.start, p.target));
  const x = d => PAD.l + Math.min(1, Math.max(0, daysBetween(p.start, d) / spanDays)) * plotW;
  const y = v => PAD.t + plotH - (p.total ? v / p.total : 0) * plotH;

  // Actual cumulative, one point per week up to today.
  const done = state.rows.filter(r => r.tested_at)
    .map(r => dayStart(r.tested_at)).sort((a, b) => a - b);

  const pts = [{ d: p.start, v: 0 }];
  let cum = 0, cursor = weekOf(p.start);
  while (cursor <= p.today) {
    const end = addDays(cursor, 7);
    cum += done.filter(d => d >= cursor && d < end).length;
    pts.push({ d: end > p.today ? p.today : end, v: cum });
    cursor = end;
  }
  // Anything settled without a date still counts at today.
  const undated = p.settled - done.length;
  if (undated > 0) pts.push({ d: p.today, v: cum + undated });

  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${x(q.d).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[pts.length - 1].d).toFixed(1)},${y(0)} L${x(p.start)},${y(0)} Z`;

  const ideal = `M${x(p.start)},${y(0)} L${x(p.target)},${y(p.total)}`;

  // Weekly gridlines, monthly labels
  const ticks = [];
  for (let d = weekOf(p.start); d <= p.target; d = addDays(d, 7)) ticks.push(new Date(d));
  const labelEvery = Math.ceil(ticks.length / 8);

  const grid = ticks.map((d, i) => `
    <line x1="${x(d).toFixed(1)}" y1="${PAD.t}" x2="${x(d).toFixed(1)}" y2="${PAD.t + plotH}"
      stroke="var(--line-soft)" stroke-width="1"/>
    ${i % labelEvery === 0 ? `<text x="${x(d).toFixed(1)}" y="${H - 10}" class="ax"
      text-anchor="middle">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</text>` : ''}`).join('');

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = Math.round(p.total * f);
    return `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${PAD.l + plotW}" y2="${y(v).toFixed(1)}"
      stroke="var(--line-soft)"/>
      <text x="${PAD.l - 8}" y="${(y(v) + 4).toFixed(1)}" class="ax" text-anchor="end">${v}</text>`;
  }).join('');

  const todayX = x(p.today);

  $('#plan-chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="plan-svg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}${yTicks}
      <path d="${ideal}" stroke="var(--ink-faint)" stroke-width="1.5"
        stroke-dasharray="5 5" fill="none"/>
      <path d="${area}" fill="url(#fill)"/>
      <path d="${line}" stroke="var(--accent)" stroke-width="2.5" fill="none"
        stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="${todayX.toFixed(1)}" y1="${PAD.t}" x2="${todayX.toFixed(1)}" y2="${PAD.t + plotH}"
        stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <text x="${todayX.toFixed(1)}" y="${PAD.t - 4}" class="ax" fill="var(--warn)"
        text-anchor="middle">today</text>
    </svg>
    <div class="chart-key">
      <span><i class="ln" style="background:var(--accent)"></i>Actual</span>
      <span><i class="ln dash"></i>Even pace to target</span>
    </div>`;
}

function recapText(p, weeks) {
  const w = weeks[0];
  const need = Math.round(p.requiredPerSession * p.dpw);
  return [
    `FDD validation — week of ${w.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    ``,
    `This week: ${w.tested} settled (${w.passed} passed, ${w.failed} failed, ${w.parked} parked)`,
    `Target for the week: ${isFinite(need) ? need : '—'}`,
    ``,
    `Programme: ${p.settled} of ${p.total} settled (${p.percent}%)`,
    `Outstanding: ${p.remaining}`,
    `Pace: ${p.actualPerSession.toFixed(1)} per working day against ${isFinite(p.requiredPerSession) ? p.requiredPerSession.toFixed(1) : '—'} needed`,
    `Status: ${p.healthLabel}`,
    `Target date: ${fmtDate(p.target)}${p.projDate ? ` · projected ${fmtDate(p.projDate)}` : ''}`,
    ``,
    `Previous weeks: ${weeks.slice(1).map(x => x.tested).join(', ')}`,
    ``,
    `Open overrides: ${state.rows.filter(r => r.override_active).length}`
  ].join('\n');
}

function renderRecap(p) {
  const weeks = weeklyRecap();
  const w = weeks[0];
  const need = p.requiredPerSession * p.dpw;
  const short = isFinite(need) ? Math.max(0, Math.round(need) - w.tested) : 0;

  $('#recap').innerHTML = `
    <div class="recap-main">
      <div class="recap-fig">
        <span class="rf-n">${w.tested}</span>
        <span class="rf-l">settled this week</span>
      </div>
      <div class="recap-split">
        <span class="pill" style="color:var(--s-passed);background:#3ecf8e1f"><span class="d"></span>${w.passed} passed</span>
        <span class="pill" style="color:var(--s-failed);background:#e5484d1f"><span class="d"></span>${w.failed} failed</span>
        <span class="pill" style="color:var(--s-parked);background:#9d7cf01f"><span class="d"></span>${w.parked} parked</span>
      </div>
      <p class="recap-line">${isFinite(need)
        ? (short > 0
            ? `${short} short of the ${Math.round(need)} needed to hold pace this week.`
            : `Ahead of the ${Math.round(need)} needed this week.`)
        : 'Set a target in the planner settings to see a weekly figure.'}</p>
    </div>

    <div class="recap-weeks">
      ${weeks.slice().reverse().map(x => {
        const h = need && isFinite(need) ? Math.min(100, x.tested / Math.max(need, 1) * 100) : 0;
        return `<div class="rw">
          <div class="rw-bar"><div class="rw-fill" style="height:${h}%"></div></div>
          <div class="rw-n">${x.tested}</div>
          <div class="rw-d">${x.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
        </div>`;
      }).join('')}
    </div>

    <div class="recap-actions">
      <button class="btn" id="btn-copy-recap">Copy summary</button>
      <button class="btn" id="btn-email-recap">Email to me</button>
    </div>`;

  const text = recapText(p, weeks);

  $('#btn-copy-recap').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Summary copied.');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('Summary copied.');
    }
  };

  $('#btn-email-recap').onclick = () => {
    const subject = `FDD validation — week of ${w.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
    window.location.href = `mailto:${encodeURIComponent(userEmail() || '')}`
      + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  };
}

function renderBuildingProgress() {
  const rows = state.buildings.map(b => {
    const set = state.rows.filter(r => r.building === b);
    const settled = set.filter(r => SETTLED.includes(r.status)).length;
    const passed = set.filter(r => r.status === 'Passed').length;
    const failed = set.filter(r => r.status === 'Failed').length;
    const parked = set.filter(r => r.status === 'Parked').length;
    const tested = passed + failed;
    return {
      b, total: set.length, settled, passed, failed, parked,
      pct: set.length ? Math.round(settled / set.length * 100) : 0,
      pass: tested ? Math.round(passed / tested * 100) : null
    };
  }).sort((a, b) => b.pct - a.pct);

  const band = p => p >= 80 ? 'good' : p >= 50 ? 'warn' : 'bad';

  $('#bldg-body').innerHTML = state.buildingView === 'bars'
    ? `<div class="bp-bars">${rows.map(r => `
        <div class="bp-row" data-building="${esc(r.b)}">
          <div class="bp-name">${esc(r.b)}</div>
          <div class="bp-track">
            <div class="bp-fill ${band(r.pct)}" style="width:${r.pct}%"></div>
          </div>
          <div class="bp-pct ${band(r.pct)}">${r.pct}%</div>
          <div class="bp-count">${r.settled}/${r.total}</div>
        </div>`).join('')}</div>`
    : `<div class="table-wrap plain"><table class="reg bp-table">
        <thead><tr>
          <th>Building</th><th>Enabled</th><th>Settled</th><th>Passed</th>
          <th>Failed</th><th>Parked</th><th>Complete</th><th>Pass rate</th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr data-building="${esc(r.b)}">
            <td>${esc(r.b)}</td>
            <td class="num">${r.total}</td>
            <td class="num">${r.settled}</td>
            <td class="num" style="color:var(--s-passed)">${r.passed || '—'}</td>
            <td class="num" style="color:var(--s-failed)">${r.failed || '—'}</td>
            <td class="num" style="color:var(--s-parked)">${r.parked || '—'}</td>
            <td class="num ${band(r.pct)}">${r.pct}%</td>
            <td class="num muted">${r.pass == null ? '—' : r.pass + '%'}</td>
          </tr>`).join('')}
        </tbody></table></div>`;

  $$('#bldg-toggle button').forEach(btn =>
    btn.setAttribute('aria-selected', String(btn.dataset.bview === state.buildingView)));
}

function renderSettingsCard() {
  const s = state.settings;
  const p = programme();
  $('#settings-body').innerHTML = `
    <div class="set-modes" id="set-modes">
      <button class="${s.target_mode === 'weeks' ? 'on' : ''}" data-mode="weeks">Run for X weeks</button>
      <button class="${s.target_mode === 'date' ? 'on' : ''}" data-mode="date">Finish by a date</button>
    </div>

    <div class="set-grid">
      ${s.target_mode === 'weeks' ? `
        <div class="field">
          <label for="set-weeks">Weeks to run</label>
          <input type="number" id="set-weeks" min="1" max="104" value="${s.target_weeks || 10}">
        </div>` : `
        <div class="field">
          <label for="set-date">Finish by</label>
          <input type="date" id="set-date" value="${s.target_date || isoDay(p.target)}">
        </div>`}

      <div class="field">
        <label for="set-dpw">Days per week on this</label>
        <input type="number" id="set-dpw" min="0.5" max="7" step="0.5" value="${s.days_per_week}">
      </div>

      <div class="field">
        <label for="set-start">Programme started</label>
        <input type="date" id="set-start" value="${s.programme_start || isoDay(p.start)}">
      </div>
    </div>

    <p class="set-note">Working days are what the pace is measured in, not calendar days.
      At ${s.days_per_week} days a week the target lands ${fmtDate(p.target)}.</p>

    <button class="btn primary" id="set-save">Save plan</button>`;

  $('#set-modes').onclick = async e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.settings.target_mode = b.dataset.mode;
    renderSettingsCard();
  };

  $('#set-save').onclick = async () => {
    const patch = {
      target_mode: state.settings.target_mode,
      days_per_week: parseFloat($('#set-dpw').value) || 2.5,
      programme_start: $('#set-start').value || null
    };
    if (state.settings.target_mode === 'weeks') {
      patch.target_weeks = parseInt($('#set-weeks').value, 10) || 10;
      patch.target_date = null;
    } else {
      patch.target_date = $('#set-date').value || null;
      patch.target_weeks = null;
    }
    if (await saveSettings(patch)) {
      toast('Plan saved.');
      $('#settings-card').hidden = true;
      renderPlanner();
    }
  };
}

/* ---------- 12. Render: Register ---------- */

const COLUMNS = [
  { key: 'ref', label: 'FDD' },
  { key: 'building', label: 'Building' },
  { key: 'equip_class', label: 'Class' },
  { key: 'status', label: 'Validation' },
  { key: 'override_active', label: 'Override' },
  { key: 'point_driven', label: 'Point driven' },
  { key: 'tested_at', label: 'Tested' },
  { key: 'retests', label: 'Retests' }
];

function renderRegister() {
  const rows = filtered().slice().sort((a, b) => {
    const { key, dir } = state.sort;
    const av = a[key] == null ? '' : a[key], bv = b[key] == null ? '' : b[key];
    return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
  });

  $('#reg-head').innerHTML = '<tr>' + COLUMNS.map(c =>
    `<th data-sort="${c.key}">${c.label}${state.sort.key === c.key
      ? ` <span class="arrow">${state.sort.dir > 0 ? '↑' : '↓'}</span>` : ''}</th>`).join('') + '</tr>';

  if (!rows.length) {
    $('#reg-body').innerHTML = '';
    $('#reg-empty').hidden = false;
    $('#reg-count').textContent = '';
    return;
  }
  $('#reg-empty').hidden = true;

  $('#reg-body').innerHTML = rows.map(r => `
    <tr data-open="${esc(rowKey(r))}" class="${state.selectedId === rowKey(r) ? 'selected' : ''}">
      <td class="ref">${esc(r.ref)}${title(r.ref) ? ` <span class="muted">${esc(title(r.ref))}</span>` : ''}</td>
      <td>${esc(r.building)}</td>
      <td><span class="cls" title="${esc(equipLabel(r.equip_class))}">${esc(r.equip_class)}</span></td>
      <td>${statusPill(r.status)}</td>
      <td>${r.override_active ? `<span class="ov-flag">DRIVEN ${ageLabel(r.driven_at)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="point muted">${esc(r.point_driven) || '—'}</td>
      <td class="muted">${fmtDate(r.tested_at)}</td>
      <td class="muted">${r.retests || '—'}</td>
    </tr>`).join('');

  $('#reg-count').textContent = `${rows.length} of ${state.rows.length} enabled rules`;
}

/* ---------- 13. Inspector ---------- */

function openInspector(key) {
  const r = state.rows.find(x => rowKey(x) === key);
  if (!r) return;
  state.selectedId = key;

  $('#insp-title').textContent = `${r.ref} · ${r.building}`;
  $('#insp-sub').textContent =
    `${equipLabel(r.equip_class)}${title(r.ref) ? ' · ' + title(r.ref) : ''} · enabled in console`;

  const overridden = r.override_active;
  const h = hoursSince(r.driven_at);
  const hint = POINT_HINTS[r.equip_class] || '';

  $('#insp-body').innerHTML = `
    <div class="override-panel ${overridden ? '' : 'clear'}">
      <div class="op-title">${overridden ? 'Override open' : 'Point at normal'}</div>
      <p>${overridden
        ? `Driven ${ageLabel(r.driven_at)} ago${h > CONFIG.STALE_HOURS ? ' — past the ' + CONFIG.STALE_HOURS + ' hour window.' : '.'} Release it at the BMS, then record it here.`
        : r.restored_at ? `Restored ${fmtDate(r.restored_at)}. Nothing left driven on this rule.`
        : 'No override recorded against this rule.'}</p>
      ${overridden
        ? `<button class="btn primary" id="btn-restore">Mark point restored</button>`
        : `<button class="btn" id="btn-drive">Mark point driven</button>`}
    </div>

    <div class="field">
      <label for="i-point">Point driven</label>
      <input type="text" id="i-point" value="${esc(r.point_driven)}"
        placeholder="${esc(hint) || 'Point name as it reads at the BMS'}">
      ${hint ? `<div class="hint-line">Typical for ${esc(r.equip_class)}: ${esc(hint)}</div>` : ''}
    </div>

    <div class="field-row">
      <div class="field">
        <label for="i-normal">Normal value</label>
        <input type="text" id="i-normal" value="${esc(r.point_normal)}" placeholder="before">
      </div>
      <div class="field">
        <label for="i-target">Driven to</label>
        <input type="text" id="i-target" value="${esc(r.point_target)}" placeholder="after">
      </div>
      <div class="field">
        <label for="i-hold">Hold (min)</label>
        <input type="text" id="i-hold" value="${r.hold_mins || ''}" placeholder="15">
      </div>
    </div>

    <div class="field">
      <label for="i-status">Validation status</label>
      <select id="i-status">${STATUSES.map(s =>
        `<option value="${s.key}" ${r.status === s.key ? 'selected' : ''}>${s.key}</option>`).join('')}</select>
    </div>

    <div class="field" id="fail-wrap" ${r.status === 'Failed' ? '' : 'hidden'}>
      <label for="i-reason">Why did it fail?</label>
      <select id="i-reason">
        <option value="">Choose a reason…</option>
        ${FAILURE_REASONS.map(x =>
          `<option value="${esc(x)}" ${r.failure_reason === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label for="i-notes">Result and observations</label>
      <textarea id="i-notes" placeholder="What did the FDD do when the point moved?">${esc(r.notes)}</textarea>
    </div>

    <dl class="kv">
      <dt>Validated by</dt><dd>${esc(r.validated_by) || '<span class="muted">—</span>'}</dd>
      <dt>Tested</dt><dd>${fmtDate(r.tested_at)}</dd>
      <dt>Driven</dt><dd>${fmtDate(r.driven_at)}</dd>
      <dt>Restored</dt><dd>${fmtDate(r.restored_at)}</dd>
      <dt>Attempt</dt><dd>${r.attempt_number || 0}</dd>
    </dl>

    <div class="hist">
      <button class="btn ghost hist-toggle" id="btn-history">
        Show full test history${r.attempt_number > 1 ? ` (${r.attempt_number} attempts)` : ''}
      </button>
      <div id="hist-body" hidden></div>
    </div>`;

  $('#insp-restore-warn').hidden = !overridden;
  $('#inspector').classList.add('open');
  $('#scrim').classList.add('open');

  // Show the failure reason only when it is relevant.
  $('#i-status').onchange = e => {
    $('#fail-wrap').hidden = e.target.value !== 'Failed';
  };

  $('#btn-history').onclick = async () => {
    const body = $('#hist-body');
    if (!body.hidden) {
      body.hidden = true;
      $('#btn-history').textContent = 'Show full test history';
      return;
    }
    body.hidden = false;
    body.innerHTML = '<div class="hist-loading">Loading history…</div>';
    $('#btn-history').textContent = 'Hide test history';
    const hist = await loadHistory(key);
    body.innerHTML = renderHistory(hist);
  };

  const restoreBtn = $('#btn-restore');
  if (restoreBtn) restoreBtn.onclick = async () => {
    await saveRow(r, { override_active: false, restored_at: new Date().toISOString() });
    toast('Point restored — ledger updated.');
    openInspector(key); render();
  };
  const driveBtn = $('#btn-drive');
  if (driveBtn) driveBtn.onclick = async () => {
    await saveRow(r, {
      override_active: true,
      driven_at: new Date().toISOString(),
      restored_at: null,
      status: r.status === 'Not started' ? 'In progress' : r.status,
      point_driven: $('#i-point').value.trim() || r.point_driven
    });
    toast('Override logged. It stays on the ledger until you restore it.');
    openInspector(key); render();
  };

  renderRegister();
}

function renderHistory(hist) {
  if (hist === null) {
    return `<div class="hist-empty">Could not load the history. The
      <code>fdd_validation_history</code> table may not exist yet — re-run
      <code>schema.sql</code>.</div>`;
  }
  if (!hist.length) {
    return `<div class="hist-empty">No changes recorded yet. History starts
      from the first result you save against this rule.</div>`;
  }

  return `<ol class="hist-list">${hist.slice().reverse().map(h => {
    const hex = STATUS_HEX[h.status] || '#888';
    const when = new Date(h.changed_at).toLocaleString('en-GB',
      { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    const moved = h.prev_status && h.prev_status !== h.status;
    return `<li style="--hc:${hex}">
      <div class="hist-head">
        <span class="hist-status" style="color:${hex}">${esc(h.status)}</span>
        ${h.attempt_number ? `<span class="hist-attempt">attempt ${h.attempt_number}</span>` : ''}
        <span class="hist-when">${when}</span>
      </div>
      ${moved ? `<div class="hist-moved">${esc(h.prev_status)} → ${esc(h.status)}</div>` : ''}
      ${h.failure_reason ? `<div class="hist-reason">${esc(h.failure_reason)}</div>` : ''}
      ${h.point_driven ? `<div class="hist-point">${esc(h.point_driven)}${
        h.point_normal || h.point_target
          ? ` · ${esc(h.point_normal || '?')} → ${esc(h.point_target || '?')}` : ''}${
        h.hold_mins ? ` · held ${h.hold_mins} min` : ''}</div>` : ''}
      ${h.notes ? `<p class="hist-notes">${esc(h.notes)}</p>` : ''}
      <div class="hist-by">${esc(h.changed_by || 'unknown')}</div>
    </li>`;
  }).join('')}</ol>`;
}

function closeInspector() {
  $('#inspector').classList.remove('open');
  $('#scrim').classList.remove('open');
  state.selectedId = null;
  renderRegister();
}

async function saveInspector() {
  const r = state.rows.find(x => rowKey(x) === state.selectedId);
  if (!r) return;

  const status = $('#i-status').value;
  const reasonEl = $('#i-reason');
  const patch = {
    status,
    failure_reason: status === 'Failed' ? (reasonEl ? reasonEl.value || null : null) : null,
    notes: $('#i-notes').value,
    point_driven: $('#i-point').value.trim(),
    point_normal: $('#i-normal').value.trim(),
    point_target: $('#i-target').value.trim(),
    hold_mins: parseInt($('#i-hold').value, 10) || null
  };

  const settling = (status === 'Passed' || status === 'Failed');
  if (settling && r.status !== status) {
    patch.tested_at = new Date().toISOString();
    patch.validated_by = userEmail() || CONFIG.OPERATOR;
  }
  // Re-testing something that already failed counts as a retest.
  if (settling && r.status === 'Failed') patch.retests = (r.retests || 0) + 1;

  if (status === 'Failed' && !patch.failure_reason) {
    toast('Pick a reason for the failure so the pattern shows up in the export.', true);
    if (reasonEl) reasonEl.focus();
    return;
  }

  if (!await saveRow(r, patch)) return;

  toast(r.override_active
    ? `Saved. The point on ${r.ref} at ${r.building} is still driven.`
    : 'Saved.');
  closeInspector();
  render();
}

/* ---------- 14. CSV export ---------- */

function exportCsv() {
  const cols = ['ref', 'building', 'equip_class', 'status', 'failure_reason', 'attempt_number',
    'point_driven', 'point_normal', 'point_target', 'hold_mins', 'override_active',
    'driven_at', 'restored_at', 'tested_at', 'validated_by', 'retests', 'notes'];
  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(',')]
    .concat(filtered().map(r => cols.map(c => q(r[c])).join(',')))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fdd_validation_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported the current view.');
}

/* ---------- 15. Method view content ---------- */

const RECIPES = [
  {
    cls: 'AHU',
    equip: 'Air handling unit — valve leak-by',
    why: 'A valve commanded shut but still passing water wastes energy all year and hides behind a comfortable space temperature. It costs money without generating a single complaint.',
    steps: [
      ['setup', 'Set up', 'Pick a unit off for at least two hours so the coil has settled. Note the coil-off temperature — that is your reference. Confirm the heating valve is commanded to <span class="pt">0 %</span> and the circuit pump is running.'],
      ['drive', 'Drive', 'You are not driving the valve open. You are proving the rule notices a coil warming while the valve is shut. Drive the coil temperature up by 6 °C above reference, leaving the valve command at 0 %.'],
      ['confirm', 'Confirm', 'The FDD should raise inside 15 minutes. Check it lands on the right asset and reads as leak-by, not a sensor fault. Wrong asset means the point mapping in KODE is wrong — a build fault, not a rule fault.'],
      ['restore', 'Restore', 'Release the point and watch the alarm clear on its own. If it does not clear, the rule has no reset condition and needs sending back.']
    ],
    notes: 'Leak-by rules take the difference between coil-on and coil-off temperature over a rolling window. Too short a test never fills the window and nothing fires — that looks like a failed rule but it is a failed test. Always hold longer than the rule\'s own averaging period.'
  },
  {
    cls: 'PMP',
    equip: 'Pump — zero flow when enabled',
    why: 'A pump running against a closed system, or a failed flow switch, means the plant believes it is circulating when it is not. Everything downstream reasons from that false premise.',
    steps: [
      ['setup', 'Set up', 'Find a pump genuinely running with a healthy flow signal. Confirm run status and flow agree before you start, or the test proves nothing.'],
      ['drive', 'Drive', 'Drive <span class="pt">FLOW-SW</span> to Off while the run command stays On. Hold ten minutes to clear any start-up delay built into the rule.'],
      ['confirm', 'Confirm', 'This should be a fast rule with a short delay. More than 15 minutes to raise is too slow to be operationally useful and is worth flagging to the engineer.'],
      ['restore', 'Restore', 'Release the flow point first, before you write anything up. A driven flow signal masks a genuine pump failure for as long as it sits there.']
    ],
    notes: 'On some plant the flow switch is hardware-only and cannot be written from the front end. Record that as Parked with the reason, not Failed. Parked means it could not be tested; Failed means it was tested and did not work. Keeping those apart is what makes the coverage figure trustworthy.'
  },
  {
    cls: 'GEN',
    equip: 'Generator — the parked case',
    why: 'Standby power rules mostly need a physical trigger. You cannot drive a battery to flat from a keyboard, and you should not try.',
    steps: [
      ['setup', 'Set up', 'Read the rule and decide honestly whether it can be provoked from the front end at all. Battery voltage, fuel level and charger health usually cannot.'],
      ['drive', 'Drive', 'Where a soft point exists — run status, a comms heartbeat, an alarm relay — drive that one and validate what you can. Do not force the rest.'],
      ['confirm', 'Confirm', 'Validate the part that is reachable and note precisely which conditions remain unproven. Half-validated with a clear boundary beats a tick that means nothing.'],
      ['restore', 'Restore', 'Release anything you drove, then set the rule to Parked with the physical trigger it needs written into the note.']
    ],
    notes: 'Parked rules are not failures and should not sit in the outstanding queue nagging at you. They are a separate list to be picked up alongside the next generator load test or planned maintenance visit, when the physical trigger exists anyway.'
  },
  {
    cls: 'BMS',
    equip: 'BMS — comms loss and stale points',
    why: 'A stale point is the quietest fault on the estate. Values still display, trends still draw, and everything looks fine — the numbers simply stopped changing.',
    steps: [
      ['setup', 'Set up', 'Choose a point you can see updating. Note the timestamp of its last change so you can tell a frozen value from a genuinely steady one.'],
      ['drive', 'Drive', 'Drive the point to a fixed value and leave it. A held override is functionally identical to a stale point from the platform\'s side, which is exactly what makes it a valid test.'],
      ['confirm', 'Confirm', 'Stale detection windows are long — 30 to 60 minutes is normal. Set the hold accordingly and come back to it rather than watching.'],
      ['restore', 'Restore', 'Release the point and confirm it starts moving again before you close the record.']
    ],
    notes: 'This is the one test where the override ledger genuinely earns itself. A stale-point test looks identical to a forgotten override, so the age counter on the strip is the only thing telling you which one you are looking at. Long holds are exactly when a point gets left behind.'
  }
];

function renderMethod() {
  $('#recipes').innerHTML = RECIPES.map(r => `
    <article class="recipe">
      <div class="recipe-head">
        <h3>${esc(r.equip)}</h3>
        <div class="meta">${esc(r.cls)} class</div>
      </div>
      <p class="why">${r.why}</p>
      <ol class="timeline">
        ${r.steps.map(([cls, label, text]) => `
          <li class="phase-${cls}">
            <span class="phase">${label}</span>
            <p>${text}</p>
          </li>`).join('')}
      </ol>
      <details class="notes">
        <summary>Full builder's notes</summary>
        <p>${r.notes}</p>
      </details>
    </article>`).join('');
}

/* ---------- 16. Wiring ---------- */

function populateSelects() {
  const fill = (id, values) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${el.dataset.all}</option>`
      + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  };
  fill('f-building', state.buildings);
  fill('f-equip_class', state.equipClasses);
  fill('f-status', STATUSES.map(s => s.key));
}

function wire() {
  $$('nav.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));

  ['building', 'equip_class', 'status'].forEach(k => {
    const el = document.getElementById('f-' + k);
    if (el) el.onchange = e => { state.filters[k] = e.target.value; render(); };
  });

  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  on('#search', 'input', e => { state.filters.search = e.target.value; render(); });
  on('#t-overrides', 'change', e => { state.filters.overridesOnly = e.target.checked; render(); });
  on('#t-outstanding', 'change', e => { state.filters.hideComplete = e.target.checked; render(); });
  on('#btn-export', 'click', exportCsv);
  on('#btn-clear', 'click', clearFilters);

  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-clear]');
    if (chip) {
      const k = chip.dataset.clear;
      if (k === '__all') return clearFilters();
      state.filters[k] = (k === 'overridesOnly' || k === 'hideComplete') ? false : '';
      if (k === 'search') $('#search').value = '';
      return render();
    }

    const opener = e.target.closest('[data-open]');
    if (opener) return openInspector(opener.dataset.open);

    if (e.target.closest('[data-showall]')) {
      state.filters.overridesOnly = true;
      return switchView('register');
    }

    const cell = e.target.closest('[data-equip][data-status]');
    if (cell) {
      state.filters.equip_class = state.filters.equip_class === cell.dataset.equip ? '' : cell.dataset.equip;
      state.filters.status = cell.dataset.status;
      return render();
    }

    const seg = e.target.closest('[data-building][data-status]');
    if (seg) {
      state.filters.building = seg.dataset.building;
      state.filters.status = seg.dataset.status;
      return render();
    }

    const bname = e.target.closest('[data-building]');
    if (bname) return setFilter('building', bname.dataset.building);

    const st = e.target.closest('[data-status]');
    if (st) return setFilter('status', st.dataset.status);

    const th = e.target.closest('[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
      return renderRegister();
    }
  });

  on('#btn-settings', 'click', () => {
    const c = $('#settings-card');
    c.hidden = !c.hidden;
    if (!c.hidden) renderSettingsCard();
  });

  on('#bldg-toggle', 'click', e => {
    const b = e.target.closest('[data-bview]');
    if (!b) return;
    state.buildingView = b.dataset.bview;
    renderBuildingProgress();
  });

  on('#auth-btn', 'click', () => signedIn() ? doSignOut() : openAuthModal());
  on('#auth-submit', 'click', doSignIn);
  on('#auth-cancel', 'click', closeAuthModal);
  on('#auth-scrim', 'click', closeAuthModal);
  on('#auth-password', 'keydown', e => { if (e.key === 'Enter') doSignIn(); });
  on('#auth-email', 'keydown', e => { if (e.key === 'Enter') $('#auth-password').focus(); });

  on('#insp-close', 'click', closeInspector);
  on('#scrim', 'click', closeInspector);
  on('#insp-save', 'click', saveInspector);

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('#auth-modal').classList.contains('open')) return closeAuthModal();
    closeInspector();
  });
}

/* ---------- 17. Boot ---------- */

(async function start() {
  wire();
  renderMethod();
  await initData();
  await initAuth();
  if (state.connected) await loadSettings();

  if (!state.connected) {
    renderDisconnected();
    switchView('monitor');
    return;
  }

  populateSelects();
  switchView('monitor');
})();
