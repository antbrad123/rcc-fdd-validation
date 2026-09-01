/* =========================================================
   RCC FDD Validation Tracker
   Vanilla JS. Supabase when configured, in-memory otherwise.
   ========================================================= */

/* ---------- 1. Configuration ---------- */

const CONFIG = {
  // Paste your Supabase project URL and anon key here to go live.
  // Leave blank to run on the built-in demo estate.
  SUPABASE_URL: 'https://wzbzquanhzwpbglrpsxa.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_m01bv9_Y_a8-TA8Gj6tXkw_8yyajkUX',
  TABLE: 'fdd_validations',
  OPERATOR: 'A. Bradley',
  STALE_HOURS: 4        // an override open longer than this is flagged red
};

/* ---------- 2. Domain constants ---------- */

const STATUSES = [
  { key: 'Not started', color: 'var(--s-notstarted)', hex: '#5c8087' },
  { key: 'Scheduled',   color: 'var(--s-scheduled)',  hex: '#4cc9f0' },
  { key: 'In test',     color: 'var(--s-intest)',     hex: '#f0a202' },
  { key: 'Passed',      color: 'var(--s-passed)',     hex: '#3ecf8e' },
  { key: 'Failed',      color: 'var(--s-failed)',     hex: '#e5484d' },
  { key: 'Blocked',     color: 'var(--s-blocked)',    hex: '#9d7cf0' }
];

const STATUS_HEX = Object.fromEntries(STATUSES.map(s => [s.key, s.hex]));

const BUILDINGS = Array.from({ length: 16 }, (_, i) => 'KCE-' + String(i + 1).padStart(2, '0'));

const EQUIP_TYPES = ['AHU', 'FCU', 'CHW Pump', 'LTHW Pump', 'Chiller', 'Boiler', 'VAV', 'Heat exchanger', 'Extract fan'];

// Asset tag prefixes so the register reads the way the estate is labelled.
const EQUIP_TAG = {
  'AHU': 'AHU', 'FCU': 'FCU', 'CHW Pump': 'CHWP', 'LTHW Pump': 'LTHWP',
  'Chiller': 'CH', 'Boiler': 'BLR', 'VAV': 'VAV', 'Heat exchanger': 'HEX', 'Extract fan': 'EF'
};

const ALL_PLANT = EQUIP_TYPES;
const AIR_SIDE = ['AHU', 'FCU', 'VAV'];
const ROTATING = ['AHU', 'Extract fan', 'CHW Pump', 'LTHW Pump'];
const WET_SIDE = ['CHW Pump', 'LTHW Pump', 'Chiller', 'Boiler', 'Heat exchanger'];

// Each pattern carries the point you drive to provoke it, and the plant it can occur on.
const PATTERNS = [
  { name: 'Valve leak-by',            point: 'HTG-VLV-POS',  normal: '0 %',      drive: '0 % (closed)', watch: 'coil temp rise',        equip: ['AHU', 'FCU', 'Heat exchanger'] },
  { name: 'Simultaneous heat & cool', point: 'CLG-VLV-POS',  normal: '0 %',      drive: '40 %',         watch: 'both valves open',      equip: AIR_SIDE },
  { name: 'Damper stuck',             point: 'OA-DMP-FBK',   normal: 'tracks',   drive: 'hold 20 %',    watch: 'cmd/fbk split',         equip: ['AHU', 'VAV'] },
  { name: 'Sensor drift',             point: 'SA-TEMP',      normal: '14.0 °C',  drive: '22.0 °C',      watch: 'vs setpoint',           equip: ['AHU', 'FCU', 'VAV', 'Chiller', 'Boiler'] },
  { name: 'Zero flow when enabled',   point: 'FLOW-SW',      normal: 'On',       drive: 'Off',          watch: 'pump run + no flow',    equip: WET_SIDE },
  { name: 'Setpoint deviation',       point: 'RM-TEMP',      normal: '21.5 °C',  drive: '27.0 °C',      watch: 'deviation timer',       equip: AIR_SIDE },
  { name: 'Short cycling',            point: 'RUN-CMD',      normal: 'steady',   drive: 'toggle x6',    watch: 'starts per hour',       equip: ['Chiller', 'Boiler', 'CHW Pump', 'LTHW Pump'] },
  { name: 'Runtime exceeded',         point: 'RUN-HRS',      normal: 'counting', drive: '+2000 h',      watch: 'threshold cross',       equip: ['AHU', 'Extract fan', 'CHW Pump', 'LTHW Pump', 'Chiller', 'Boiler'] },
  { name: 'Filter DP high',           point: 'FLT-DP',       normal: '110 Pa',   drive: '420 Pa',       watch: 'DP alarm limit',        equip: ['AHU'] },
  { name: 'Fan status mismatch',      point: 'FAN-STS',      normal: 'On',       drive: 'Off',          watch: 'cmd on / sts off',      equip: ['AHU', 'Extract fan', 'FCU'] },
  { name: 'VSD pinned at max',        point: 'VSD-SPD',      normal: '62 %',     drive: '100 %',        watch: 'sustained 100 %',       equip: ROTATING },
  { name: 'Economiser not utilised',  point: 'OA-TEMP',      normal: '18 °C',    drive: '9 °C',         watch: 'free cooling call',     equip: ['AHU'] },
  { name: 'Out-of-hours operation',   point: 'OCC-STS',      normal: 'Unocc',    drive: 'Occ',          watch: 'run outside schedule',  equip: ['AHU', 'Extract fan', 'FCU', 'Chiller', 'Boiler'] },
  { name: 'Frost protection active',  point: 'FROST-STAT',   normal: 'Healthy',  drive: 'Tripped',      watch: 'frost sequence',        equip: ['AHU'] },
  { name: 'Deadband breach',          point: 'HTG-SP',       normal: '20.0 °C',  drive: '24.5 °C',      watch: 'htg sp > clg sp',       equip: AIR_SIDE },
  { name: 'Comms loss / stale point', point: 'COV-HEARTBEAT',normal: 'live',     drive: 'freeze 30 min',watch: 'stale detection',       equip: ALL_PLANT }
];

/* ---------- 3. Seeded demo estate ---------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function buildDemoEstate() {
  const rnd = mulberry32(20260827);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const rows = [];
  const now = Date.now();

  // Weighted status draw — most of the estate is still waiting on a test.
  const weights = [
    ['Not started', 0.36], ['Scheduled', 0.13], ['In test', 0.05],
    ['Passed', 0.29], ['Failed', 0.10], ['Blocked', 0.07]
  ];
  function drawStatus() {
    let r = rnd(), acc = 0;
    for (const [k, w] of weights) { acc += w; if (r < acc) return k; }
    return 'Not started';
  }

  const failNotes = [
    'FDD did not raise inside the expected window.',
    'Alarm raised against the wrong asset reference.',
    'Threshold set too wide — condition cleared before trigger.',
    'Rule fired but severity mapped incorrectly.',
    'Point mapping in KODE resolves to a different asset.'
  ];
  const passNotes = [
    'Triggered inside the expected window. Cleared cleanly on restore.',
    'Triggered late but within tolerance. Left as is.',
    'Trigger and clear both confirmed at the console.',
    'Raised correctly, ticket generated as expected.'
  ];
  const blockNotes = [
    'Point is read-only at the BMS — no write access from RCC.',
    'Plant off for planned works. Retest after commissioning.',
    'Awaiting confirmation of point mapping from the site team.',
    'Head of engineering asked to hold until the tenant fit-out completes.'
  ];

  for (let i = 0; i < 192; i++) {
    const building = BUILDINGS[Math.floor(i / 12)];
    const pat = pick(PATTERNS);
    const type = pick(pat.equip);            // only plant the pattern can occur on
    const unit = String(1 + Math.floor(rnd() * 6)).padStart(2, '0');
    const asset = `${EQUIP_TAG[type]}-${unit}`;
    const status = drawStatus();

    const done = status === 'Passed' || status === 'Failed';
    const testedAt = done ? now - Math.floor(rnd() * 62 + 1) * 864e5 : null;

    // Overrides: every in-test row is live; a few completed rows were never restored.
    let overrideActive = false, drivenAt = null, restoredAt = null;
    if (status === 'In test') {
      overrideActive = true;
      drivenAt = now - Math.floor(rnd() * 9 * 36e5);
    } else if (done) {
      if (rnd() < 0.035) {                       // the ones that bite you
        overrideActive = true;
        drivenAt = testedAt + 36e5;
      } else {
        drivenAt = testedAt;
        restoredAt = testedAt + Math.floor(rnd() * 5 + 1) * 6e5;
      }
    }

    rows.push({
      id: 'VAL-' + String(i + 1).padStart(3, '0'),
      fdd_ref: 'FDD-' + String(i + 1).padStart(3, '0'),
      building,
      asset,
      equip_type: type,
      pattern: pat.name,
      status,
      point_name: `${building}/${asset}/${pat.point}`,
      point_normal: pat.normal,
      point_drive: pat.drive,
      hold_mins: [10, 15, 20, 30, 45][Math.floor(rnd() * 5)],
      expect_mins: [5, 10, 15, 20][Math.floor(rnd() * 4)],
      override_active: overrideActive,
      driven_at: drivenAt ? new Date(drivenAt).toISOString() : null,
      restored_at: restoredAt ? new Date(restoredAt).toISOString() : null,
      tested_at: testedAt ? new Date(testedAt).toISOString() : null,
      validated_by: done ? CONFIG.OPERATOR : null,
      retests: status === 'Failed' ? Math.floor(rnd() * 3) : 0,
      notes: status === 'Failed' ? pick(failNotes)
           : status === 'Passed' ? pick(passNotes)
           : status === 'Blocked' ? pick(blockNotes)
           : ''
    });
  }
  return rows;
}

/* ---------- 4. State ---------- */

const state = {
  view: 'monitor',
  rows: [],
  live: false,
  sb: null,
  selectedId: null,
  sort: { key: 'id', dir: 1 },
  filters: {
    building: '', equip_type: '', pattern: '', status: '',
    search: '', overridesOnly: false, hideComplete: false
  }
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* ---------- 5. Data layer ---------- */

async function initData() {
  if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase) {
    try {
      state.sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
      const { data, error } = await state.sb.from(CONFIG.TABLE).select('*').order('id');
      if (error) throw error;
      if (data && data.length) {
        state.rows = data;
        state.live = true;
        setConn(true, 'supabase · ' + data.length + ' records');
        return;
      }
      toast('Connected to Supabase but the table is empty. Showing the demo estate.', true);
    } catch (err) {
      console.error(err);
      toast('Could not reach Supabase. Showing the demo estate.', true);
    }
  }
  state.rows = buildDemoEstate();
  state.live = false;
  setConn(false, 'demo estate · 192 records');
}

async function saveRow(row, patch) {
  Object.assign(row, patch);
  if (!state.live) return true;
  const { error } = await state.sb.from(CONFIG.TABLE).update(patch).eq('id', row.id);
  if (error) { console.error(error); toast('Save failed: ' + error.message, true); return false; }
  return true;
}

function setConn(live, text) {
  $('#conn').classList.toggle('live', live);
  $('#conn-text').textContent = text;
}

/* ---------- 6. Helpers ---------- */

const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

function hoursSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

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

function patternDef(name) { return PATTERNS.find(p => p.name === name) || {}; }

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

/* ---------- 7. Filtering ---------- */

function filtered() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  return state.rows.filter(r => {
    if (f.building && r.building !== f.building) return false;
    if (f.equip_type && r.equip_type !== f.equip_type) return false;
    if (f.pattern && r.pattern !== f.pattern) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.overridesOnly && !r.override_active) return false;
    if (f.hideComplete && (r.status === 'Passed' || r.status === 'Blocked')) return false;
    if (q) {
      const hay = [r.id, r.fdd_ref, r.building, r.asset, r.pattern, r.point_name, r.notes].join(' ').toLowerCase();
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
  state.filters = { building: '', equip_type: '', pattern: '', status: '', search: '', overridesOnly: false, hideComplete: false };
  $('#search').value = '';
  render();
}

/* ---------- 8. Render: shell ---------- */

function render() {
  renderLedger();
  renderChips();
  syncControls();
  if (state.view === 'monitor') renderMonitor();
  if (state.view === 'register') renderRegister();
}

function switchView(v) {
  state.view = v;
  document.body.classList.toggle('view-method', v === 'method');
  $('#filterbar').hidden = (v === 'method');
  $$('nav.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $$('.view').forEach(el => { el.hidden = el.id !== 'view-' + v; });
  render();
}

/* ---------- 9. Render: override ledger (signature) ---------- */

function renderLedger() {
  const open = state.rows.filter(r => r.override_active);
  const bar = $('#ledger');
  if (!open.length) { bar.hidden = true; return; }
  bar.hidden = false;

  open.sort((a, b) => new Date(a.driven_at || 0) - new Date(b.driven_at || 0));
  const stale = open.filter(r => hoursSince(r.driven_at) > CONFIG.STALE_HOURS).length;

  $('#ledger-count').textContent = open.length + ' point' + (open.length === 1 ? '' : 's') + ' still driven'
    + (stale ? ` · ${stale} over ${CONFIG.STALE_HOURS}h` : '');

  $('#ledger-items').innerHTML = open.slice(0, 8).map(r => {
    const h = hoursSince(r.driven_at);
    return `<button class="ledger-chip" data-open="${r.id}">
      <span>${esc(r.asset)} · ${esc(patternDef(r.pattern).point || '')}</span>
      <span class="age${h > CONFIG.STALE_HOURS ? ' stale' : ''}">${ageLabel(r.driven_at)}</span>
      <span class="go">restore</span>
    </button>`;
  }).join('') + (open.length > 8 ? `<button class="ledger-chip" data-showall="1"><span>+${open.length - 8} more</span></button>` : '');
}

/* ---------- 10. Render: filter chips ---------- */

function renderChips() {
  const f = state.filters;
  const items = [];
  if (f.building) items.push(['Building', f.building, 'building']);
  if (f.equip_type) items.push(['Equipment', f.equip_type, 'equip_type']);
  if (f.pattern) items.push(['Pattern', f.pattern, 'pattern']);
  if (f.status) items.push(['Status', f.status, 'status']);
  if (f.overridesOnly) items.push(['View', 'Open overrides', 'overridesOnly']);
  if (f.hideComplete) items.push(['View', 'Outstanding only', 'hideComplete']);
  if (f.search) items.push(['Search', f.search, 'search']);

  const wrap = $('#chips');
  wrap.hidden = items.length === 0;
  wrap.innerHTML = items.map(([k, v, key]) =>
    `<span class="chip"><span class="k">${k}</span> ${esc(v)}
      <button data-clear="${key}" aria-label="Clear ${k} filter">×</button></span>`).join('')
    + (items.length > 1 ? `<button class="btn ghost" data-clear="__all">Clear all</button>` : '');
}

function syncControls() {
  const f = state.filters;
  ['building', 'equip_type', 'pattern', 'status'].forEach(k => {
    const el = document.getElementById('f-' + k);
    if (el) el.value = f[k];
  });
  $('#t-overrides').checked = f.overridesOnly;
  $('#t-outstanding').checked = f.hideComplete;
}

/* ---------- 11. Render: Monitor ---------- */

function renderMonitor() {
  const rows = filtered();
  renderKpis(rows);
  renderDonut(rows);
  renderBars(rows);
  renderHeat(rows);
  $('#monitor-count').textContent = `${rows.length} of ${state.rows.length} validations in view`;
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
    { cls: 'good', label: 'Trigger confirmed', value: passed, foot: settled ? Math.round(passed / settled * 100) + '% of tests passed' : 'no tests yet' },
    { cls: 'bad', label: 'Trigger failed', value: failed, foot: failed ? 'needs rule review' : 'nothing outstanding' },
    { cls: 'warn', label: 'Awaiting test', value: by('Not started') + by('Scheduled'), foot: by('Scheduled') + ' scheduled' },
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
    const dash = `${len} ${C - len}`;
    const seg = `<circle r="${R}" cx="95" cy="95" stroke="${c.hex}"
      stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
      class="${state.filters.status && state.filters.status !== c.key ? 'dim' : ''}"
      data-status="${c.key}"><title>${c.key}: ${c.n}</title></circle>`;
    offset += len;
    return seg;
  }).join('');

  $('#donut').innerHTML = `<svg viewBox="0 0 190 190">${segs || `<circle r="${R}" cx="95" cy="95" stroke="var(--surface-2)" stroke-dasharray="${C} 0"></circle>`}</svg>
    <div class="donut-centre"><div class="n">${total}</div><div class="t">in view</div></div>`;

  $('#legend').innerHTML = counts.map(c => `
    <button data-status="${c.key}" class="${state.filters.status === c.key ? 'active' : ''}">
      <span class="sw" style="background:${c.hex}"></span>
      <span class="nm">${c.key}</span>
      <span class="ct">${c.n}</span>
    </button>`).join('');
}

function renderBars(rows) {
  const html = BUILDINGS.map(b => {
    const set = rows.filter(r => r.building === b);
    const total = set.length;
    const segs = STATUSES.map(s => {
      const n = set.filter(r => r.status === s.key).length;
      if (!n) return '';
      const pct = (n / total * 100).toFixed(2);
      return `<div class="bar-seg" style="width:${pct}%;background:${s.hex}"
        data-building="${b}" data-status="${s.key}" title="${b} · ${s.key}: ${n}"></div>`;
    }).join('');
    return `<div class="bar-row">
      <div class="name ${state.filters.building === b ? 'active' : ''}" data-building="${b}">${b}</div>
      <div class="bar-track">${segs}</div>
      <div class="tot">${total || ''}</div>
    </div>`;
  }).join('');
  $('#bars').innerHTML = html;
}

function renderHeat(rows) {
  const cols = STATUSES.map(s => s.key);
  const max = Math.max(1, ...PATTERNS.map(p => Math.max(...cols.map(c =>
    rows.filter(r => r.pattern === p.name && r.status === c).length))));

  const head = `<tr><th></th>${cols.map(c => `<th class="col">${c}</th>`).join('')}</tr>`;
  const body = PATTERNS.map(p => {
    const cells = cols.map(c => {
      const n = rows.filter(r => r.pattern === p.name && r.status === c).length;
      const hex = STATUS_HEX[c];
      const a = (0.16 + 0.72 * (n / max)).toFixed(2);
      const style = n ? `background-color:${hexA(hex, a)};color:${n / max > 0.55 ? '#08161a' : hex}` : '';
      return `<td><div class="cell ${n ? '' : 'zero'}" style="${style}"
        data-pattern="${esc(p.name)}" data-status="${c}" title="${p.name} · ${c}: ${n}">${n || ''}</div></td>`;
    }).join('');
    return `<tr><th>${p.name}</th>${cells}</tr>`;
  }).join('');

  $('#heat').innerHTML = `<table>${head}${body}</table>`;
}

function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---------- 12. Render: Register ---------- */

const COLUMNS = [
  { key: 'id', label: 'Ref' },
  { key: 'building', label: 'Building' },
  { key: 'asset', label: 'Asset' },
  { key: 'pattern', label: 'Pattern' },
  { key: 'point_name', label: 'Point driven' },
  { key: 'status', label: 'Status' },
  { key: 'override_active', label: 'Override' },
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
    `<th data-sort="${c.key}">${c.label}${state.sort.key === c.key ? ` <span class="arrow">${state.sort.dir > 0 ? '↑' : '↓'}</span>` : ''}</th>`
  ).join('') + '</tr>';

  if (!rows.length) {
    $('#reg-body').innerHTML = '';
    $('#reg-empty').hidden = false;
    $('#reg-count').textContent = '';
    return;
  }
  $('#reg-empty').hidden = true;

  $('#reg-body').innerHTML = rows.map(r => `
    <tr data-open="${r.id}" class="${state.selectedId === r.id ? 'selected' : ''}">
      <td class="ref">${r.id}</td>
      <td>${r.building}</td>
      <td>${r.asset} <span class="muted">${r.equip_type}</span></td>
      <td>${esc(r.pattern)}</td>
      <td class="point muted">${esc(r.point_name.split('/').pop())}</td>
      <td>${statusPill(r.status)}</td>
      <td>${r.override_active ? `<span class="ov-flag">DRIVEN ${ageLabel(r.driven_at)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${fmtDate(r.tested_at)}</td>
      <td class="muted">${r.retests || '—'}</td>
    </tr>`).join('');

  $('#reg-count').textContent = `${rows.length} of ${state.rows.length} validations`;
}

/* ---------- 13. Inspector ---------- */

function openInspector(id) {
  const r = state.rows.find(x => x.id === id);
  if (!r) return;
  state.selectedId = id;
  const p = patternDef(r.pattern);

  $('#insp-title').textContent = `${r.asset} · ${r.pattern}`;
  $('#insp-sub').innerHTML = `${r.id} · ${r.fdd_ref} · ${r.building} · ${r.equip_type}`;

  const overridden = r.override_active;
  const h = hoursSince(r.driven_at);

  $('#insp-body').innerHTML = `
    <div class="drive-box">
      <div class="field" style="margin:0 0 10px">
        <label>Point to drive</label>
        <div class="point">${esc(r.point_name)}</div>
      </div>
      <div class="drive-row">
        <span class="from">${esc(r.point_normal)}</span>
        <span class="arw">→</span>
        <span class="to">${esc(r.point_drive)}</span>
      </div>
      <div class="foot muted" style="margin-top:9px;font-size:12px">
        Hold ${r.hold_mins} min · expect the FDD inside ${r.expect_mins} min · watch ${esc(p.watch || '')}
      </div>
    </div>

    <div class="override-panel ${overridden ? '' : 'clear'}">
      <div class="op-title">${overridden ? 'Override open' : 'Point at normal'}</div>
      <p>${overridden
        ? `Driven ${ageLabel(r.driven_at)} ago${h > CONFIG.STALE_HOURS ? ' — past the ' + CONFIG.STALE_HOURS + ' hour window.' : '.'} Release it at the BMS, then record it here.`
        : r.restored_at ? `Restored ${fmtDate(r.restored_at)}. Nothing left driven on this asset.`
        : 'No override has been applied for this test.'}</p>
      ${overridden
        ? `<button class="btn primary" id="btn-restore">Mark point restored</button>`
        : `<button class="btn" id="btn-drive">Mark point driven</button>`}
    </div>

    <div class="field">
      <label for="i-status">Validation status</label>
      <select id="i-status">${STATUSES.map(s =>
        `<option value="${s.key}" ${r.status === s.key ? 'selected' : ''}>${s.key}</option>`).join('')}</select>
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
      <dt>Retests</dt><dd>${r.retests || 0}</dd>
    </dl>`;

  $('#insp-restore-warn').hidden = !overridden;

  $('#inspector').classList.add('open');
  $('#scrim').classList.add('open');

  const restoreBtn = $('#btn-restore');
  if (restoreBtn) restoreBtn.onclick = async () => {
    await saveRow(r, { override_active: false, restored_at: new Date().toISOString() });
    toast('Point restored — ledger updated.');
    openInspector(id); render();
  };
  const driveBtn = $('#btn-drive');
  if (driveBtn) driveBtn.onclick = async () => {
    await saveRow(r, { override_active: true, driven_at: new Date().toISOString(), restored_at: null });
    toast('Override logged. It stays on the ledger until you restore it.');
    openInspector(id); render();
  };

  renderRegister();
}

function closeInspector() {
  $('#inspector').classList.remove('open');
  $('#scrim').classList.remove('open');
  state.selectedId = null;
  renderRegister();
}

async function saveInspector() {
  const r = state.rows.find(x => x.id === state.selectedId);
  if (!r) return;
  const status = $('#i-status').value;
  const notes = $('#i-notes').value;
  const patch = { status, notes };

  if ((status === 'Passed' || status === 'Failed') && r.status !== status) {
    patch.tested_at = new Date().toISOString();
    patch.validated_by = CONFIG.OPERATOR;
  }
  // A rule re-tested after a fix counts as a retest.
  if (status === 'Failed' && r.status === 'Not started' && r.tested_at) {
    patch.retests = (r.retests || 0) + 1;
  }

  const ok = await saveRow(r, patch);
  if (!ok) return;

  if (r.override_active) {
    toast('Saved. The point on ' + r.asset + ' is still driven.');
  } else {
    toast('Saved.');
  }
  closeInspector();
  render();
}

/* ---------- 14. SQL export ---------- */

function exportSql() {
  const cols = ['id', 'fdd_ref', 'building', 'asset', 'equip_type', 'pattern', 'status', 'point_name',
    'point_normal', 'point_drive', 'hold_mins', 'expect_mins', 'override_active', 'driven_at',
    'restored_at', 'tested_at', 'validated_by', 'retests', 'notes'];
  const val = v => v === null || v === undefined || v === '' ? 'null'
    : typeof v === 'boolean' ? (v ? 'true' : 'false')
    : typeof v === 'number' ? v
    : `'${String(v).replace(/'/g, "''")}'`;

  const lines = state.rows.map(r => `  (${cols.map(c => val(r[c])).join(', ')})`);
  const sql = `-- RCC FDD Validation Tracker — seed export\n-- Generated ${new Date().toISOString()}\n\n`
    + `insert into public.fdd_validations (${cols.join(', ')}) values\n${lines.join(',\n')}\non conflict (id) do nothing;\n`;

  const blob = new Blob([sql], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fdd_validations_seed.sql';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Seed file downloaded. Run it in the Supabase SQL editor.');
}

/* ---------- 15. Method view content ---------- */

const RECIPES = [
  {
    pattern: 'Valve leak-by',
    equip: 'AHU / FCU heating coil',
    why: 'A valve that is commanded shut but still passing water wastes energy all year and hides itself behind a comfortable space temperature. It is one of the few faults that costs money without generating a single complaint.',
    steps: [
      ['setup', 'Set up', 'Pick a unit that has been off for at least two hours so the coil has settled. Note the coil-off temperature — that is your reference. Confirm the heating valve is commanded to <span class="pt">0 %</span> and the pump serving that circuit is running.'],
      ['drive', 'Drive', 'You are not driving the valve open. You are proving the rule notices a coil that warms while the valve is shut. Drive <span class="pt">HTG-COIL-TEMP</span> up by 6 °C above the reference while leaving the valve command at 0 %.'],
      ['confirm', 'Confirm', 'The FDD should raise inside 15 minutes. Check it lands on the right asset and reads as leak-by, not as a sensor fault. If it raises against the wrong asset, the point mapping in KODE is wrong — that is a build fault, not a rule fault.'],
      ['restore', 'Restore', 'Release the temperature point and watch the alarm clear on its own. If it does not clear, the rule has no reset condition and needs sending back.']
    ],
    notes: 'Leak-by rules usually take the difference between coil-on and coil-off temperature over a rolling window. If your test is too short the window never fills and nothing fires — that looks like a failed rule but it is a failed test. Always hold longer than the rule\'s own averaging period.'
  },
  {
    pattern: 'Simultaneous heat & cool',
    equip: 'AHU with heating and cooling coils',
    why: 'Two coils fighting each other is the clearest waste in any plant room. The rule is simple, which means when it fails to trigger the cause is almost always a mapping problem rather than logic.',
    steps: [
      ['setup', 'Set up', 'Choose an AHU in occupied mode with a stable supply air temperature. Record both valve positions before you touch anything.'],
      ['drive', 'Drive', 'Leave the heating valve where the control loop has it and drive <span class="pt">CLG-VLV-POS</span> to 40 %. Hold for 20 minutes — most rules want both open together for a sustained period, not a momentary crossover.'],
      ['confirm', 'Confirm', 'Expect the fault inside 10 minutes of the hold starting. Check the alarm text names both valves. A rule that only names one is half-built.'],
      ['restore', 'Restore', 'Release the cooling valve and let the loop take back control. Confirm the position returns to what you recorded at the start.']
    ],
    notes: 'Some rules include a deadband so that a small overlap during changeover does not trigger. If nothing fires at 40 %, try 60 % before you record a fail — and note the threshold you needed, because that tells the engineer where the deadband actually sits.'
  },
  {
    pattern: 'Fan status mismatch',
    equip: 'Any fan with a command and a status',
    why: 'Command on, status off means the plant thinks it is running when it is not. It is the fault most likely to be masked by a stuck status contact, so proving the rule matters more here than almost anywhere.',
    steps: [
      ['setup', 'Set up', 'Find a fan that is genuinely running with a healthy status. Confirm command and status agree before you start, or your test proves nothing.'],
      ['drive', 'Drive', 'Drive <span class="pt">FAN-STS</span> to Off while the command stays On. Hold for 10 minutes to clear any start-up delay built into the rule.'],
      ['confirm', 'Confirm', 'The FDD should raise quickly — this is usually a fast rule with a short delay. If it takes more than 15 minutes, the delay is set too long to be useful operationally and is worth flagging.'],
      ['restore', 'Restore', 'Release the status point. The fault should clear within one scan. Leaving a status point driven is dangerous because it hides a genuine failure — restore this one first, before you write anything up.']
    ],
    notes: 'On some sites the status point is hardware-only and cannot be written from the front end. If so, record the validation as Blocked with the reason, rather than Failed. Blocked means the platform could not be tested; Failed means it was tested and did not work. Keeping those apart is what makes the register trustworthy.'
  },
  {
    pattern: 'Sensor drift',
    equip: 'Any monitored temperature sensor',
    why: 'A drifting sensor quietly poisons every rule that depends on it. Validating drift detection is really validating the foundation the rest of the estate sits on.',
    steps: [
      ['setup', 'Set up', 'Pick a sensor with a neighbouring reference — a supply air sensor with a duct sensor nearby, or two space sensors in the same zone. Record both readings.'],
      ['drive', 'Drive', 'Drive <span class="pt">SA-TEMP</span> 8 °C away from its neighbour and hold. Drift rules average over a long window, so give it at least 30 minutes.'],
      ['confirm', 'Confirm', 'Check that the fault names the drifting sensor rather than the reference. Getting this the wrong way round sends an engineer to the wrong sensor and burns trust in the whole programme.'],
      ['restore', 'Restore', 'Release the point and confirm both readings converge again before you leave the asset.']
    ],
    notes: 'Drift rules often use a slow filter to avoid tripping on genuine transients. If you drive the point and nothing happens within the expected window, extend the hold before you record a fail. Note the actual time to trigger in the register — over a few tests that number tells you what the real detection lag is across the estate.'
  }
];

function renderMethod() {
  $('#recipes').innerHTML = RECIPES.map(r => `
    <article class="recipe">
      <div class="recipe-head">
        <h3>${esc(r.pattern)}</h3>
        <div class="meta">${esc(r.equip)}</div>
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
    el.innerHTML = `<option value="">${el.dataset.all}</option>`
      + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  };
  fill('f-building', BUILDINGS);
  fill('f-equip_type', EQUIP_TYPES);
  fill('f-pattern', PATTERNS.map(p => p.name));
  fill('f-status', STATUSES.map(s => s.key));
}

function wire() {
  $$('nav.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));

  ['building', 'equip_type', 'pattern', 'status'].forEach(k => {
    document.getElementById('f-' + k).onchange = e => { state.filters[k] = e.target.value; render(); };
  });

  $('#search').oninput = e => { state.filters.search = e.target.value; render(); };
  $('#t-overrides').onchange = e => { state.filters.overridesOnly = e.target.checked; render(); };
  $('#t-outstanding').onchange = e => { state.filters.hideComplete = e.target.checked; render(); };
  $('#btn-export').onclick = exportSql;
  $('#btn-clear').onclick = clearFilters;

  // Delegated clicks across the whole app.
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-clear]');
    if (chip) {
      const k = chip.dataset.clear;
      if (k === '__all') return clearFilters();
      state.filters[k] = (k === 'overridesOnly' || k === 'hideComplete') ? false : '';
      if (k === 'search') $('#search').value = '';
      return render();
    }

    const led = e.target.closest('[data-open]');
    if (led) return openInspector(led.dataset.open);

    if (e.target.closest('[data-showall]')) {
      state.filters.overridesOnly = true;
      switchView('register');
      return;
    }

    const cell = e.target.closest('[data-pattern][data-status]');
    if (cell) {
      state.filters.pattern = state.filters.pattern === cell.dataset.pattern ? '' : cell.dataset.pattern;
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

  $('#insp-close').onclick = closeInspector;
  $('#scrim').onclick = closeInspector;
  $('#insp-save').onclick = saveInspector;

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeInspector();
  });
}

/* ---------- 17. Boot ---------- */

(async function start() {
  populateSelects();
  wire();
  renderMethod();
  await initData();
  switchView('monitor');
})();
