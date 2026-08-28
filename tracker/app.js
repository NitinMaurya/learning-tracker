import { boot, all, run, save, load, exportJson, upload, deleteDoc, q, uid, today, now, TABLES } from './api.js';
import { graphHtml, mountGraph, topoOrder, autoPos } from './graph.js';

/* ---------- utils ---------- */

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUSES = ['not started', 'building', 'walled', 'closed'];
const NEXT_ACTION = {
  'not started': ['Build', 'Not read. One concrete thing that runs.'],
  building: ['Break it on purpose', 'If nothing broke, the build was too easy.'],
  walled: ['Read the earned concepts', 'The wall is what entitles you to them.'],
  closed: ['Open the next concept', 'Both exit lists have entries.'],
};

const SECTION_DEFAULTS = { progress: true, concepts: true, log: true, queue: true, parked: false };

let state = {
  tab: 'dashboard',
  open: null,          // expanded concept id
  edit: null,          // { kind: 'trace'|'resolution'|'note', id, phase }
  noteTags: [],        // concept ids while editing a note
  showResolved: false,
  sessionsAll: false,
  newPhase: false,
  seKind: 'build',
  dragId: null,
  drawer: localStorage.getItem('ai-lab-drawer') === '1',
  view: localStorage.getItem('ai-lab-view') || 'list',
  sections: { ...SECTION_DEFAULTS, ...JSON.parse(localStorage.getItem('ai-lab-sections') || '{}') },
};

const saveSections = () => localStorage.setItem('ai-lab-sections', JSON.stringify(state.sections));

function toast(msg) {
  if (!msg) return;
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2400);
}

const touch = (id) => run(`UPDATE phases SET last_touched = ${q(today())} WHERE id = ${q(id)}`);

const relDay = (d) => {
  if (!d) return '—';
  const days = Math.round((new Date(today()) - new Date(d)) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days > 0 ? `${days}d ago` : d;
};

/* ---------- session timer ---------- */

const TIMER_MS = 60 * 60 * 1000; // one hour
let timer = JSON.parse(localStorage.getItem('ai-lab-timer') || 'null'); // {id, num, name, startedAt, kind}

const persistTimer = () =>
  timer ? localStorage.setItem('ai-lab-timer', JSON.stringify(timer)) : localStorage.removeItem('ai-lab-timer');

const remainingMs = () => (timer ? Math.max(0, TIMER_MS - (Date.now() - timer.startedAt)) : 0);
const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

async function startTimer(p) {
  if (timer && timer.id !== p.id && !confirm(`A session on concept ${timer.num} is still running. Stop it and start this one?`))
    return;
  if (timer) await stopTimer(false, true);
  timer = { id: p.id, num: p.num, name: p.name, startedAt: Date.now(), kind: state.seKind };
  persistTimer();
  if (p.status === 'not started') await run(`UPDATE phases SET status = 'building' WHERE id = ${q(p.id)}`);
  await after(`session started — 60:00 on concept ${p.num}`);
}

async function stopTimer(auto = false, quiet = false) {
  if (!timer) return;
  const elapsed = Math.min(Date.now() - timer.startedAt, TIMER_MS);
  const mins = Math.max(1, Math.round(elapsed / 60000));
  const note = ($('#timer-note')?.value || '').trim() || (auto ? 'ran the full hour' : '');
  const t = timer;
  timer = null;
  persistTimer();
  await run(
    `INSERT INTO sessions VALUES (${q(uid())}, ${q(today())}, ${q(t.num)}, ${q(t.kind)}, ${mins}, ${q(note)})`
  );
  await run(`UPDATE phases SET last_touched = ${q(today())} WHERE id = ${q(t.id)}`);
  if (quiet) return;
  await after(auto ? `the hour is up — ${mins}m logged on concept ${t.num}` : `stopped — ${mins}m logged`);
}

function tick() {
  const chip = $('#timerchip');
  if (!timer) {
    chip.hidden = true;
    return;
  }
  const left = remainingMs();
  chip.hidden = false;
  chip.innerHTML = `⏱ <b>${clock(left)}</b> · concept ${esc(timer.num)}`;
  const inline = $('#timer-count');
  if (inline) inline.textContent = clock(left);
  document.querySelectorAll('.timer-bar > i').forEach((i) => (i.style.width = `${(1 - left / TIMER_MS) * 100}%`));
  if (left <= 0) stopTimer(true);
}
setInterval(tick, 1000);

/* ---------- shared ui bits ---------- */

function section(key, title, count, body, { head = '', pad = true } = {}) {
  const open = state.sections[key];
  return `<div class="card ${open ? 'open' : ''}">
    <div class="sec-head" data-action="toggle-sec" data-key="${key}">
      <span class="chev">▶</span>
      <span class="sec-title">${esc(title)}</span>
      ${count !== null && count !== undefined ? `<span class="count">${count}</span>` : ''}
      <span class="right">${head}</span>
    </div>
    ${open ? `<div class="sec-body" ${pad ? '' : 'style="padding:0"'}>${body}</div>` : ''}
  </div>`;
}

const statusPill = (s) => `<span class="pill ${s.replace(' ', '-')}">${esc(s)}</span>`;

const barHtml = (done, total) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="row"><div class="bar"><i style="width:${pct}%"></i></div>
    <span class="dim mini">${done}/${total}</span></div>`;
};

/* ---------- data ---------- */

async function model() {
  const [phases, breaks, claims, sources, notes, docs, confusions, edges] = await Promise.all([
    all('SELECT * FROM phases ORDER BY pos'),
    all('SELECT * FROM breaks ORDER BY pos'),
    all('SELECT * FROM claims ORDER BY created_at'),
    all('SELECT * FROM sources ORDER BY created_at DESC'),
    all('SELECT * FROM notes ORDER BY updated_at DESC'),
    all('SELECT * FROM docs ORDER BY created_at DESC'),
    all('SELECT * FROM confusions ORDER BY created_at DESC'),
    all('SELECT * FROM edges'),
  ]);
  for (const p of phases) {
    p.breaks = breaks.filter((b) => b.phase_id === p.id);
    p.can = claims.filter((c) => c.phase_id === p.id && c.kind === 'can');
    p.cannot = claims.filter((c) => c.phase_id === p.id && c.kind === 'cannot');
    p.sources = sources.filter((s) => s.phase_id === p.id);
    p.notes = notes.filter((n) => (n.phase_ids || '').split(',').includes(p.id));
    p.docs = docs.filter((d) => d.phase_id === p.id);
    p.confusions = confusions.filter((c) => c.phase_num === p.num);
    p.prereqs = edges.filter((e) => e.to_id === p.id).map((e) => e.from_id);
  }
  phases.confusions = confusions;
  phases.edges = edges;
  return phases;
}

// A concept is gated by its prerequisites (graph edges). With no edges drawn it
// falls back to "the one before it in the list", which is spec §4's default.
function blockedBy(phases, i) {
  const p = phases[i];
  if (p.prereqs?.length) {
    const open = p.prereqs
      .map((id) => phases.find((x) => x.id === id))
      .filter((x) => x && x.status !== 'closed');
    return open.length ? open.map((x) => `concept ${x.num}`).join(', ') : null;
  }
  return i === 0 || phases[i - 1].status === 'closed' ? null : `concept ${phases[i - 1].num}`;
}

const canClose = (p) => p.can.length > 0 && p.cannot.length > 0;

/* ---------- dashboard ---------- */

async function renderDashboard() {
  const [phases, sessions, parked] = await Promise.all([
    model(),
    all('SELECT * FROM sessions ORDER BY on_date DESC, rowid DESC'),
    all('SELECT * FROM parked ORDER BY fired DESC, topic'),
  ]);

  const openConf = phases.confusions.filter((c) => !c.resolved).length;
  const firedParked = parked.filter((p) => p.fired).length;
  const current = phases.find((p) => p.status === 'walled') || phases.find((p) => p.status === 'building');

  const chip = $('#nowchip');
  if (current) {
    chip.hidden = false;
    chip.innerHTML = `now: <b>concept ${esc(current.num)}</b> · ${esc(current.status)}`;
  } else chip.hidden = true;

  const nextUp = current || phases.find((p) => p.status !== 'closed');
  const act = NEXT_ACTION[nextUp ? nextUp.status : 'closed'];

  $('#tab-dashboard').innerHTML = `
    ${nextUp
      ? `<div class="now">
          <div>
            <div class="lbl">current</div>
            <div class="who">concept ${esc(nextUp.num)} — ${esc(nextUp.name)}</div>
          </div>
          ${statusPill(nextUp.status)}
          <div class="do grow"><b>${act[0]}.</b> <span class="dim">${act[1]}</span></div>
          ${timer
            ? `<button class="mini-btn stop" data-action="stop-timer">■ stop ${clock(remainingMs())}</button>`
            : `<button class="mini-btn" data-action="start-timer" data-id="${nextUp.id}">▶ start session</button>`}
          <button class="mini-btn" data-action="open-phase" data-id="${nextUp.id}">open ↓</button>
        </div>`
      : ''}

    <div class="cols2">
      <div class="rail">
        ${section('progress', 'progress', null, progressRail(phases), { pad: false })}
      </div>
      <div>
    ${section('concepts', 'concepts', `${phases.length}`,
      state.view === 'graph' ? graphHtml(phases, phases.edges) : phasesHtml(phases), {
      head: `<span class="seg">
          <button data-action="set-view" data-view="list" class="${state.view === 'list' ? 'on' : ''}">list</button>
          <button data-action="set-view" data-view="graph" class="${state.view === 'graph' ? 'on' : ''}">graph</button>
        </span>
        <button class="mini-btn" data-action="new-phase-form" style="margin-left:6px">+ concept</button>`,
    })}
      </div>
    </div>`;

  if (state.view === 'graph') mountGraph($('#graph'), phases, phases.edges, GRAPH_CTX);

  $('#drawer-body').innerHTML = `
    ${section('log', 'sessions', null, sessionForm(sessions))}
    ${section('queue', 'interest queue', `${openConf} open`, queueHtml(phases))}
    ${section('parked', 'parked registry', `${firedParked}/${parked.length}`, parkedHtml(parked))}`;

  const badge = $('#panelbadge');
  badge.hidden = !openConf;
  badge.textContent = openConf;
  $('#drawer').classList.toggle('open', state.drawer);
  $('#backdrop').hidden = !state.drawer;
}

/* ---------- progress rail ---------- */

function progressRail(phases) {
  const current = phases.find((p) => p.status === 'walled') || phases.find((p) => p.status === 'building');
  return `<ul class="list rail-list">
    ${phases
      .map((p) => {
        const now = current && current.id === p.id;
        const cls = [
          'row-link',
          now ? 'now' : '',
          state.open === p.id ? 'here' : '',
          p.status === 'closed' ? 'done' : '',
        ].filter(Boolean).join(' ');
        return `<li class="${cls}" data-action="open-phase" data-id="${p.id}" title="${esc(p.status)}">
          <span class="txt"><span class="dim">${esc(p.num)}</span> ${esc(p.name)}</span>
          ${timer && timer.id === p.id ? '<span class="railtimer">⏱</span>' : ''}
        </li>`;
      })
      .join('')}
  </ul>`;
}

/* ---------- concepts ---------- */

function phasesHtml(phases) {
  const cards = phases
    .map((p, i) => {
      const blocked = blockedBy(phases, i);
      const open = state.open === p.id;
      const done = p.breaks.filter((b) => b.done).length;
      const openConf = p.confusions.filter((c) => !c.resolved).length;
      const running = timer && timer.id === p.id;

      const head = `<div class="phase-head" data-action="toggle-phase" data-id="${p.id}"
          draggable="true" data-drag="${p.id}" title="drag to reorder">
        <span class="grip" title="drag to reorder">⠿</span>
        <span class="chev" style="${open ? 'transform:rotate(90deg)' : ''}">▶</span>
        <span class="phase-name"><span class="n">${esc(p.num)}</span> ${esc(p.name)}</span>
        ${statusPill(p.status)}
        ${blocked && p.status !== 'closed' ? `<span class="pill locked">gated · ${esc(blocked)}</span>` : ''}
        ${running ? `<span class="pill running">⏱ <span id="timer-count">${clock(remainingMs())}</span></span>` : ''}
        <span class="right">
          <span class="dim mini counts">
            ${done}/${p.breaks.length} broken · ${p.can.length}✓ ${p.cannot.length}✗${openConf ? ` · <span class="warnc">${openConf}?</span>` : ''}${p.notes.length ? ` · ${p.notes.length} notes` : ''}${p.docs.length ? ` · ${p.docs.length} files` : ''}
          </span>
          ${running
            ? `<button class="mini-btn stop" data-action="stop-timer">■ stop</button>`
            : `<button class="mini-btn" data-action="start-timer" data-id="${p.id}">▶ start</button>`}
          <select data-action="status" data-id="${p.id}">
            ${STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </span>
      </div>`;

      if (!open) return `<div class="phase-card ${running ? 'running' : ''}" data-card="${p.id}">${head}</div>`;

      const gateWarn =
        blocked && p.status !== 'not started' && p.status !== 'closed'
          ? `<div class="warnbox">Gate not paid — ${esc(blocked)} is not closed.</div>`
          : '';

      return `<div class="phase-card is-open ${running ? 'running' : ''}" data-card="${p.id}">${head}
        <div class="phase-body">
          ${running ? timerPanel() : ''}
          ${gateWarn}
          <div class="field"><label>gate</label><div class="ro">${esc(p.gate || 'none')}</div></div>
          ${['build', 'verify_txt', 'wall', 'earned']
            .map(
              (f) => `<div class="field">
                <label>${f === 'verify_txt' ? 'verify' : f === 'earned' ? 'earned concepts' : f}</label>
                <textarea data-action="field" data-id="${p.id}" data-field="${f}"
                  placeholder="${f === 'wall' ? 'the failure you expect to hit and not be able to explain' : ''}">${esc(p[f])}</textarea>
              </div>`
            )
            .join('')}

          <div class="field">
            <label>break on purpose</label>
            <ul class="list">
              ${p.breaks.map((b) => breakItem(b, p.id)).join('') || '<li class="empty">nothing listed — add the failures you intend to cause</li>'}
            </ul>
            <input type="text" placeholder="+ failure to induce  ⏎" data-action="add-break" data-id="${p.id}" style="margin-top:8px" />
          </div>

          <div class="grid2">
            <div class="field">
              <label>exit ✓ can explain without notes</label>
              <ul class="list">${p.can.map(claimItem).join('') || '<li class="empty">empty</li>'}</ul>
              <input type="text" placeholder="+ claim  ⏎" data-action="add-claim" data-kind="can" data-id="${p.id}" style="margin-top:8px" />
            </div>
            <div class="field">
              <label>exit ✗ still can't explain</label>
              <ul class="list">${p.cannot.map(claimItem).join('') || '<li class="empty">empty</li>'}</ul>
              <input type="text" placeholder="+ gap — also logged as a confusion  ⏎" data-action="add-claim" data-kind="cannot" data-id="${p.id}" style="margin-top:8px" />
            </div>
          </div>

          ${!canClose(p) && p.status !== 'closed'
            ? `<div class="note">Closes only when <em>both</em> exit lists have entries. An empty "still can't explain" means you weren't honest, not that you're done.</div>`
            : ''}

          <hr />
          ${confusionsBlock(p)}
          ${notesBlock(p, phases)}
          ${sourcesBlock(p)}
          ${docsBlock(p)}
        </div>
      </div>`;
    })
    .join('');

  const form = state.newPhase
    ? `<div class="phase-card is-open"><div class="phase-body" style="padding-top:14px">
        <div class="row wrap">
          <input type="text" id="np-num" placeholder="06" style="width:80px" />
          <input type="text" id="np-name" placeholder="name" class="grow" />
          <button class="act" data-action="add-phase">add</button>
          <button class="mini-btn" data-action="cancel-new-phase">cancel</button>
        </div>
        <div class="note" style="margin-top:8px">Concept 05's output is a new unit spec written to §3 — add it here once you've written it.</div>
      </div></div>`
    : '';

  return cards + form;
}

function timerPanel() {
  const left = remainingMs();
  return `<div class="timer-panel">
    <div class="row wrap">
      <span class="tbig" id="timer-count">${clock(left)}</span>
      <span class="dim mini">left of the hour · logging as <b>${esc(timer.kind)}</b></span>
      <span class="right"><button class="mini-btn stop" data-action="stop-timer">■ stop &amp; log</button></span>
    </div>
    <div class="bar timer-bar" style="margin:8px 0"><i style="width:${(1 - left / TIMER_MS) * 100}%"></i></div>
    <input type="text" id="timer-note" placeholder="what happened — written into the session when you stop" />
  </div>`;
}

function breakItem(b, phaseId) {
  if (state.edit?.kind === 'trace' && state.edit.id === b.id) {
    return `<li><div class="grow">
      <div class="dim mini" style="margin-bottom:5px">${esc(b.label)}</div>
      <textarea id="edit-box" placeholder="what actually broke — paste the trace">${esc(b.trace)}</textarea>
      <div class="row" style="margin-top:6px">
        <button class="act" data-action="save-trace" data-id="${b.id}" data-phase="${phaseId}">save</button>
        <button class="mini-btn" data-action="cancel-edit">cancel</button>
      </div>
    </div></li>`;
  }
  return `<li class="${b.done ? 'checked' : ''}">
    <input type="checkbox" data-action="break" data-id="${b.id}" data-phase="${phaseId}" ${b.done ? 'checked' : ''} />
    <span class="txt">
      <span class="main">${esc(b.label)}</span>
      ${b.trace ? `<span class="sub">↳ ${esc(b.trace)}</span>` : ''}
    </span>
    <button class="x" data-action="edit-trace" data-id="${b.id}" title="${b.trace ? 'edit' : 'attach'} trace">✎</button>
    <button class="x danger" data-action="del-break" data-id="${b.id}" title="delete">✕</button>
  </li>`;
}

const claimItem = (c) => `<li>
  <span class="txt"><span class="main">${esc(c.text)}</span></span>
  <button class="x danger" data-action="del-claim" data-id="${c.id}">✕</button>
</li>`;

/* ---------- confusions (per concept) ---------- */

function confusionsBlock(p) {
  const rows = state.showResolved ? p.confusions : p.confusions.filter((c) => !c.resolved);
  const resolved = p.confusions.filter((c) => c.resolved).length;

  return `<div class="field">
    <label>confusions
      ${resolved ? `<button class="mini-btn" data-action="toggle-resolved" style="float:right;margin-top:-3px">${state.showResolved ? 'hide' : 'show'} ${resolved} resolved</button>` : ''}
    </label>
    <ul class="list">
      ${rows.map(confItem).join('') || `<li class="empty">anything you couldn't explain goes here, dated</li>`}
    </ul>
    <input type="text" placeholder="+ what you couldn't explain  ⏎" data-action="add-conf"
      data-id="${p.id}" data-num="${esc(p.num)}" id="conf-${p.id}" style="margin-top:8px" />
    <div class="note" style="margin-top:6px">Append-only — resolving strikes through, nothing is deleted.</div>
  </div>`;
}

function confItem(c) {
  if (state.edit?.kind === 'resolution' && state.edit.id === c.id) {
    return `<li><div class="grow">
      <div class="dim mini" style="margin-bottom:5px">${esc(c.text)}</div>
      <input type="text" id="edit-box" placeholder="resolved → note filename or one line" value="${esc(c.resolution || '')}" />
      <div class="row" style="margin-top:6px">
        <button class="act" data-action="save-resolution" data-id="${c.id}">save</button>
        <button class="mini-btn" data-action="cancel-edit">cancel</button>
      </div>
    </div></li>`;
  }
  return `<li class="${c.resolved ? 'checked' : ''}">
    <input type="checkbox" data-action="resolve-conf" data-id="${c.id}" ${c.resolved ? 'checked' : ''} />
    <span class="txt">
      <span class="main">${esc(c.text)}</span>
      ${c.resolved && c.resolution ? `<span class="sub">→ ${esc(c.resolution)}</span>` : ''}
      <span class="sub">${esc((c.created_at || '').slice(0, 10))}</span>
    </span>
    ${c.resolved ? `<button class="x" data-action="edit-resolution" data-id="${c.id}" title="resolution">✎</button>` : ''}
  </li>`;
}

/* ---------- notes ---------- */

function notesBlock(p, phases) {
  const editingNew = state.edit?.kind === 'note' && state.edit.id === 'new' && state.edit.phase === p.id;

  const list = p.notes
    .map((n) => {
      if (state.edit?.kind === 'note' && state.edit.id === n.id) return `<li>${noteEditor(n, p, phases)}</li>`;
      const others = (n.phase_ids || '')
        .split(',')
        .filter((x) => x && x !== p.id)
        .map((id) => phases.find((x) => x.id === id))
        .filter(Boolean);
      return `<li>
        <span class="txt">
          <span class="main">${esc(n.title)}</span>
          ${others.map((o) => `<span class="pill tag">c${esc(o.num)}</span>`).join('')}
          ${n.body ? `<span class="sub body">${esc(n.body)}</span>` : ''}
          <span class="sub">${esc(relDay((n.updated_at || '').slice(0, 10)))}</span>
        </span>
        <button class="x" data-action="edit-note" data-id="${n.id}" data-phase="${p.id}" title="edit">✎</button>
        <button class="x danger" data-action="del-note" data-id="${n.id}" title="delete">✕</button>
      </li>`;
    })
    .join('');

  return `<div class="field">
    <label>notes
      <button class="mini-btn" data-action="new-note" data-phase="${p.id}" style="float:right;margin-top:-3px">+ note</button>
    </label>
    <ul class="list">
      ${editingNew ? `<li>${noteEditor(null, p, phases)}</li>` : ''}
      ${list || (editingNew ? '' : '<li class="empty">a note is a claim, not a summary — the title states it, the body defends it</li>')}
    </ul>
  </div>`;
}

function noteEditor(n, p, phases) {
  const tags = state.noteTags || [];
  return `<div class="grow">
    <input type="text" id="note-title" placeholder="the claim — e.g. kv-cache memory is linear in batch × context"
      value="${esc(n ? n.title : '')}" />
    <textarea id="note-body" style="margin-top:6px;min-height:120px"
      placeholder="defend it to a smarter colleague">${esc(n ? n.body : '')}</textarea>
    <div class="row wrap" style="margin-top:8px;gap:5px">
      <span class="dim mini">belongs to</span>
      ${phases
        .map((x) => `<button class="chip ${tags.includes(x.id) ? 'on' : ''}" data-action="tag-note" data-id="${x.id}">c${esc(x.num)}</button>`)
        .join('')}
    </div>
    <div class="row" style="margin-top:8px">
      <button class="act" data-action="save-note" data-id="${n ? n.id : 'new'}" data-phase="${p.id}">save</button>
      <button class="mini-btn" data-action="cancel-edit">cancel</button>
      <span class="note">tag every concept it explains — a note on KV-cache belongs to three at once</span>
    </div>
  </div>`;
}

/* ---------- sources ---------- */

function sourcesBlock(p) {
  return `<div class="field">
    <label>sources</label>
    <ul class="list">
      ${p.sources
        .map(
          (r) => `<li>
            <span class="txt">
              <span class="main">${esc(r.changed)}</span>
              <span class="sub"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a></span>
            </span>
            <button class="x danger" data-action="del-source" data-id="${r.id}">✕</button>
          </li>`
        )
        .join('') || '<li class="empty">read only what the wall entitles you to — then log the one line</li>'}
    </ul>
    <div class="row wrap" style="margin-top:8px">
      <input type="text" id="sr-url-${p.id}" placeholder="https://…" style="flex:1 1 200px" />
      <input type="text" id="sr-note-${p.id}" placeholder="one line: what it changed in your head  ⏎"
        data-action="add-source-input" data-id="${p.id}" style="flex:2 1 260px" />
      <button class="act" data-action="add-source" data-id="${p.id}">add</button>
    </div>
  </div>`;
}

/* ---------- documents ---------- */

const fmtSize = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

const fileIcon = (mime, name) => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (/^image\//.test(mime)) return '🖼';
  if (ext === 'pdf') return '📕';
  if (['json', 'csv', 'tsv', 'parquet'].includes(ext)) return '🗂';
  if (['log', 'txt', 'md'].includes(ext)) return '📄';
  if (['py', 'js', 'ts', 'sh', 'ipynb'].includes(ext)) return '🧾';
  return '📎';
};

function docsBlock(p) {
  return `<div class="field">
    <label>documents</label>
    <ul class="list">
      ${p.docs
        .map(
          (d) => `<li>
            <span class="ficon">${fileIcon(d.mime || '', d.filename)}</span>
            <span class="txt">
              <span class="main"><a href="/files/${encodeURIComponent(d.stored)}" target="_blank" rel="noreferrer">${esc(d.filename)}</a></span>
              <span class="sub">${fmtSize(d.size || 0)} · ${esc((d.created_at || '').slice(0, 10))}</span>
            </span>
            <button class="x danger" data-action="del-doc" data-id="${d.id}">✕</button>
          </li>`
        )
        .join('')}
    </ul>
    <label class="dropzone" data-phase="${p.id}">
      <input type="file" multiple hidden data-action="upload" data-id="${p.id}" />
      <span>drop files here or <u>choose</u></span>
      <span class="dim mini">traces, logs, eval outputs, screenshots</span>
    </label>
    <div class="note" style="margin-top:6px">Files live in <span class="mono">tracker/files/</span>. §1.7 keeps PDFs out of the repo — gitignore that folder if you want the rule to hold.</div>
  </div>`;
}

/* ---------- interest queue ---------- */

function queueHtml(phases) {
  const open = phases.confusions.filter((c) => !c.resolved);
  const byNum = new Map(phases.map((p) => [p.num, p]));
  return `<ul class="list">
      ${open
        .map((c) => {
          const p = byNum.get(c.phase_num);
          return `<li ${p ? `class="row-link" data-action="open-phase" data-id="${p.id}"` : ''}>
            <span class="txt">
              <span class="main">${esc(c.text)}</span>
              <span class="sub">${p ? `concept ${esc(p.num)} · ` : 'unfiled · '}${esc(relDay((c.created_at || '').slice(0, 10)))}</span>
            </span>
          </li>`;
        })
        .join('') || '<li class="empty">nothing open</li>'}
    </ul>
    <div class="note" style="margin-top:8px">Every open confusion, across concepts — pick by curiosity, not order. Entries that keep resurfacing are where depth is owed. Click one to jump to its concept.</div>`;
}

/* ---------- parked ---------- */

function parkedHtml(rows) {
  return `<ul class="list">
      ${rows
        .map(
          (r) => `<li class="${r.fired ? 'checked' : ''}">
            <input type="checkbox" data-action="fire-parked" data-id="${r.id}" ${r.fired ? 'checked' : ''} />
            <span class="txt">
              <span class="main">${esc(r.topic)}</span>
              <span class="sub">${r.fired ? `fired ${esc(r.fired_at || '')} — write it up as a concept` : '⟶ ' + esc(r.trigger_text)}</span>
            </span>
            <button class="x danger" data-action="del-parked" data-id="${r.id}">✕</button>
          </li>`
        )
        .join('')}
    </ul>
    <div class="row wrap" style="margin-top:10px">
      <input type="text" id="pk-topic" placeholder="topic" class="grow" />
      <input type="text" id="pk-trigger" placeholder="trigger" class="grow" />
      <button class="act" data-action="add-parked">park</button>
    </div>
    <div class="note" style="margin-top:8px">Parked ≠ skipped. Tick only when the trigger has actually fired — reading this list for interest is the failure mode it exists to prevent.</div>`;
}

/* ---------- sessions ---------- */

function sessionForm(sessions) {
  const shown = state.sessionsAll ? sessions : sessions.slice(0, 6);
  const dryOver = sessions.filter((s) => s.kind === 'dry' && (s.minutes || 0) > 90).length;

  return `<div class="row wrap" style="gap:8px">
      <span class="dim mini">next session logs as</span>
      <div class="seg">
        ${['build', 'break', 'read', 'dry']
          .map((k) => `<button data-action="se-kind" data-kind="${k}" class="${state.seKind === k ? 'on' : ''}">${k}</button>`)
          .join('')}
      </div>
    </div>
    <div class="note" style="margin-top:8px">
      ${timer
        ? `Running on concept ${esc(timer.num)} — stop it there, or <a href="#" data-action="stop-timer">stop &amp; log now</a>.`
        : 'Sessions are only ever recorded by the timer — hit <b>▶ start</b> on a concept and it runs an hour, then logs itself.'}
    </div>
    ${dryOver ? `<div class="warnbox" style="margin-top:10px">${dryOver} dry session(s) over the 90-minute box (§1.5).</div>` : ''}
    <hr />
    <ul class="list">
      ${shown
        .map(
          (s) => `<li>
            <span class="txt">
              <span class="main">${esc(s.note || '(no note)')}</span>
              <span class="sub">${esc(s.on_date)} · ${esc(s.kind)}${s.phase_num ? ' · c' + esc(s.phase_num) : ''} · <span class="${s.kind === 'dry' && s.minutes > 90 ? 'err' : ''}">${s.minutes || 0}m</span></span>
            </span>
            <button class="x danger" data-action="del-session" data-id="${s.id}">✕</button>
          </li>`
        )
        .join('') || '<li class="empty">no sessions yet</li>'}
    </ul>
    ${sessions.length > 6 ? `<button class="mini-btn" data-action="toggle-sessions" style="margin-top:8px">${state.sessionsAll ? 'show less' : `show all ${sessions.length}`}</button>` : ''}`;
}

/* ---------- sql tab ---------- */

const SAMPLES = {
  'concept progress': `SELECT p.num, p.name, p.status,
       count(*) FILTER (WHERE b.done) AS broken,
       count(b.id) AS breaks
FROM concepts p LEFT JOIN breaks b ON b.phase_id = p.id
GROUP BY 1,2,3 ORDER BY 1;`,
  'open confusions': `SELECT date(created_at) AS day, phase_num AS concept, text
FROM confusions WHERE resolved = 0
ORDER BY created_at DESC;`,
  'time per week': `SELECT strftime('%Y-W%W', on_date) AS week, kind,
       sum(minutes) AS minutes, count(*) AS sessions
FROM sessions GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC;`,
  'honest exits': `SELECT p.num, p.status,
       sum(c.kind = 'can') AS can_explain,
       sum(c.kind = 'cannot') AS cannot_explain
FROM concepts p LEFT JOIN claims c ON c.phase_id = p.id
GROUP BY 1,2 ORDER BY 1;`,
  'notes by concept': `SELECT p.num, n.title, n.updated_at
FROM notes n JOIN concepts p ON instr(n.phase_ids, p.id) > 0
ORDER BY p.num, n.updated_at DESC;`,
  documents: `SELECT p.num, d.filename, d.size, d.created_at
FROM docs d LEFT JOIN concepts p ON p.id = d.phase_id
ORDER BY d.created_at DESC;`,
};

function renderSql() {
  const el = $('#tab-sql');
  if (el.dataset.built) return;
  el.dataset.built = '1';
  el.innerHTML = `
    <div class="card open">
      <div class="sec-head" style="cursor:default">
        <span class="sec-title">sqlite console</span>
        <span class="count">ai-lab.db</span>
        <span class="right">
          <button class="ghost" data-action="backup" title="download the whole database as JSON">backup</button>
          <button class="ghost" data-action="restore" title="replace the database from a JSON backup">restore</button>
          <button class="act" data-action="run-sql">run ⌘⏎</button>
        </span>
      </div>
      <div class="sec-body">
        <div class="row wrap" style="margin-bottom:10px">
          ${Object.keys(SAMPLES)
            .map((k) => `<button class="mini-btn" data-action="sample" data-key="${esc(k)}">${esc(k)}</button>`)
            .join('')}
        </div>
        <textarea id="sql-in" class="mono" style="min-height:150px">${esc(SAMPLES['concept progress'])}</textarea>
        <div class="note" style="margin-top:8px">
          tables: <span class="mono">${TABLES.join(' · ')}</span> — <span class="mono">concepts</span> is a view over
          <span class="mono">phases</span>, which is what the storage still calls them. Writes are allowed and land straight in the file.
        </div>
        <div class="note" style="margin-top:6px">
          <b>backup</b> downloads every table as JSON; <b>restore</b> replaces the database from one.
          Uploaded documents in <span class="mono">tracker/files/</span> are not in the JSON — copy that folder yourself.
        </div>
        <div id="sql-out" style="margin-top:14px"></div>
      </div>
    </div>`;
}

async function runSql() {
  const sql = $('#sql-in').value.trim();
  const out = $('#sql-out');
  if (!sql) return;
  out.innerHTML = '<div class="dim mini">running…</div>';
  try {
    const rows = await all(sql);
    if (!rows.length) return void (out.innerHTML = '<div class="dim mini">ok — 0 rows</div>');
    const cols = Object.keys(rows[0]);
    out.innerHTML = `<div class="scroll"><table>
        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] === null ? '—' : r[c])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="note" style="margin-top:8px">${rows.length} row(s)</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">${esc(e.message || e)}</div>`;
  }
}

/* ---------- graph ---------- */

// Concept order follows the graph: a topological sort of the prerequisite edges.
async function applyGraphOrder(phases) {
  const { order, cycle } = topoOrder(phases, phases.edges);
  if (cycle) return 'cycle — order left alone';
  const current = phases.map((p) => p.id).join(',');
  if (order.join(',') === current) return '';
  for (let i = 0; i < order.length; i++) await run(`UPDATE phases SET pos = ${i} WHERE id = ${q(order[i])}`);
  return 'reordered to match the graph';
}

const GRAPH_CTX = {
  async onMove(id, x, y) {
    await run(`UPDATE phases SET x = ${Math.round(x)}, y = ${Math.round(y)} WHERE id = ${q(id)}`);
  },
  async onLink(from, to) {
    const dup = await all(`SELECT id FROM edges WHERE from_id = ${q(from)} AND to_id = ${q(to)}`);
    if (dup.length) return toast('already linked');
    const back = await all(`SELECT id FROM edges WHERE from_id = ${q(to)} AND to_id = ${q(from)}`);
    if (back.length) return toast('that would point both ways — delete the other edge first');
    await run(`INSERT INTO edges VALUES (${q(uid())}, ${q(from)}, ${q(to)})`);
    const phases = await model();
    const { cycle } = topoOrder(phases, phases.edges);
    if (cycle) {
      await run(`DELETE FROM edges WHERE from_id = ${q(from)} AND to_id = ${q(to)}`);
      return after('that edge would make a cycle — not added');
    }
    return after(await applyGraphOrder(phases));
  },
  async onDeleteEdge(id) {
    await run(`DELETE FROM edges WHERE id = ${q(id)}`);
    return after(await applyGraphOrder(await model()));
  },
  onOpen(id) {
    state.view = 'list';
    state.open = id;
    localStorage.setItem('ai-lab-view', 'list');
    render().then(() => document.querySelector('.phase-card.is-open')?.scrollIntoView({ block: 'center' }));
  },
};

/* ---------- render / tabs ---------- */

async function render() {
  if (state.tab === 'sql') return renderSql();
  const y = window.scrollY;
  await renderDashboard();
  window.scrollTo(0, y);
  const box = $('#edit-box') || (state.edit?.kind === 'note' ? $('#note-title') : null);
  if (box) {
    box.focus();
    if (box.setSelectionRange) box.setSelectionRange(box.value.length, box.value.length);
  }
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
  render();
}

async function after(msg) {
  await save();
  await render();
  toast(msg);
}

/* ---------- actions ---------- */

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) return showTab(tabBtn.dataset.tab);

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;

  switch (a) {
    case 'toggle-drawer':
    case 'close-drawer':
      state.drawer = a === 'toggle-drawer' ? !state.drawer : false;
      localStorage.setItem('ai-lab-drawer', state.drawer ? '1' : '0');
      return render();

    case 'set-view':
      state.view = el.dataset.view;
      localStorage.setItem('ai-lab-view', state.view);
      return render();
    case 'auto-layout': {
      const phases = await model();
      for (let i = 0; i < phases.length; i++) {
        const { x, y } = autoPos(i);
        await run(`UPDATE phases SET x = ${x}, y = ${y} WHERE id = ${q(phases[i].id)}`);
      }
      return after('tidied');
    }
    case 'apply-order':
      return after(await applyGraphOrder(await model()));

    case 'toggle-sec':
      state.sections[el.dataset.key] = !state.sections[el.dataset.key];
      saveSections();
      return render();

    case 'open-phase':
      state.open = id;
      state.view = 'list';
      localStorage.setItem('ai-lab-view', 'list');
      state.sections.concepts = true;
      saveSections();
      await render();
      document.querySelector('.phase-card.is-open')?.scrollIntoView({ block: 'center' });
      return;
    case 'toggle-phase':
      state.open = state.open === id ? null : id;
      state.edit = null;
      return render();

    /* timer */
    case 'start-timer': {
      const p = (await model()).find((x) => x.id === id);
      return startTimer(p);
    }
    case 'stop-timer':
      e.preventDefault();
      return stopTimer(false);

    /* breaks */
    case 'break':
      await run(`UPDATE breaks SET done = ${el.checked ? 1 : 0} WHERE id = ${q(id)}`);
      await touch(el.dataset.phase);
      return after(el.checked ? 'broken — write the trace down' : '');
    case 'edit-trace':
      state.edit = { kind: 'trace', id };
      return render();
    case 'save-trace':
      await run(`UPDATE breaks SET trace = ${q($('#edit-box').value.trim())} WHERE id = ${q(id)}`);
      await touch(el.dataset.phase);
      state.edit = null;
      return after('trace saved');
    case 'del-break':
      await run(`DELETE FROM breaks WHERE id = ${q(id)}`);
      return after();
    case 'cancel-edit':
      state.edit = null;
      return render();
    case 'del-claim':
      await run(`DELETE FROM claims WHERE id = ${q(id)}`);
      return after();

    /* concepts */
    case 'new-phase-form':
      state.newPhase = true;
      state.sections.concepts = true;
      return render();
    case 'cancel-new-phase':
      state.newPhase = false;
      return render();
    case 'add-phase': {
      const num = $('#np-num').value.trim();
      const name = $('#np-name').value.trim();
      if (!num || !name) return toast('num and name required');
      const pos = (((await all('SELECT max(pos) AS m FROM phases'))[0].m) ?? -1) + 1;
      await run(`INSERT INTO phases VALUES (${q(uid())}, ${q(num)}, ${q(name)}, 'not started', '', '', '', '', '', ${pos}, NULL)`);
      state.newPhase = false;
      return after('concept added');
    }

    /* confusions */
    case 'resolve-conf':
      if (el.checked) {
        await run(`UPDATE confusions SET resolved = 1 WHERE id = ${q(id)}`);
        state.edit = { kind: 'resolution', id };
      } else {
        await run(`UPDATE confusions SET resolved = 0, resolution = NULL WHERE id = ${q(id)}`);
      }
      return after();
    case 'edit-resolution':
      state.edit = { kind: 'resolution', id };
      return render();
    case 'save-resolution':
      await run(`UPDATE confusions SET resolution = ${q($('#edit-box').value.trim() || null)} WHERE id = ${q(id)}`);
      state.edit = null;
      return after('struck through');
    case 'toggle-resolved':
      state.showResolved = !state.showResolved;
      return render();

    /* notes */
    case 'new-note':
      state.edit = { kind: 'note', id: 'new', phase: el.dataset.phase };
      state.noteTags = [el.dataset.phase];
      return render();
    case 'edit-note': {
      const n = (await all(`SELECT phase_ids FROM notes WHERE id = ${q(id)}`))[0];
      state.edit = { kind: 'note', id, phase: el.dataset.phase };
      state.noteTags = (n?.phase_ids || '').split(',').filter(Boolean);
      return render();
    }
    case 'tag-note':
      state.noteTags = state.noteTags.includes(id)
        ? state.noteTags.filter((x) => x !== id)
        : [...state.noteTags, id];
      return render();
    case 'save-note': {
      const title = $('#note-title').value.trim();
      const body = $('#note-body').value;
      if (!title) return toast('a note needs a claim for a title');
      const tags = (state.noteTags.length ? state.noteTags : [el.dataset.phase]).join(',');
      if (id === 'new') {
        await run(`INSERT INTO notes VALUES (${q(uid())}, ${q(title)}, ${q(body)}, ${q(tags)}, ${q(now())}, ${q(now())})`);
      } else {
        await run(`UPDATE notes SET title = ${q(title)}, body = ${q(body)}, phase_ids = ${q(tags)}, updated_at = ${q(now())} WHERE id = ${q(id)}`);
      }
      await touch(el.dataset.phase);
      state.edit = null;
      return after('note saved');
    }
    case 'del-note':
      await run(`DELETE FROM notes WHERE id = ${q(id)}`);
      return after();

    /* sources */
    case 'add-source': {
      const url = $(`#sr-url-${id}`).value.trim();
      const note = $(`#sr-note-${id}`).value.trim();
      if (!url || !note) return toast('a source needs the link AND the one line');
      await run(`INSERT INTO sources VALUES (${q(uid())}, ${q(url)}, ${q(note)}, ${q(now())}, ${q(id)})`);
      await touch(id);
      return after('added');
    }
    case 'del-source':
      await run(`DELETE FROM sources WHERE id = ${q(id)}`);
      return after();

    /* documents */
    case 'del-doc':
      if (!confirm('Delete this file from tracker/files/ as well?')) return;
      await deleteDoc(id);
      return after('deleted');

    /* parked */
    case 'fire-parked':
      await run(`UPDATE parked SET fired = ${el.checked ? 1 : 0}, fired_at = ${el.checked ? q(today()) : 'NULL'} WHERE id = ${q(id)}`);
      return after(el.checked ? 'trigger fired — it graduates into a concept now' : '');
    case 'add-parked': {
      const t = $('#pk-topic').value.trim();
      const g = $('#pk-trigger').value.trim();
      if (!t || !g) return toast('topic and trigger both required');
      await run(`INSERT INTO parked VALUES (${q(uid())}, ${q(t)}, ${q(g)}, 0, NULL)`);
      return after('parked');
    }
    case 'del-parked':
      await run(`DELETE FROM parked WHERE id = ${q(id)}`);
      return after();

    /* sessions */
    case 'se-kind':
      state.seKind = el.dataset.kind;
      if (timer) {
        timer.kind = el.dataset.kind;
        persistTimer();
      }
      return render();
    case 'del-session':
      await run(`DELETE FROM sessions WHERE id = ${q(id)}`);
      return after();
    case 'toggle-sessions':
      state.sessionsAll = !state.sessionsAll;
      return render();

    /* sql */
    case 'backup':
      return backup();
    case 'restore':
      return $('#restoreFile').click();
    case 'sample':
      $('#sql-in').value = SAMPLES[el.dataset.key];
      return runSql();
    case 'run-sql':
      return runSql();
  }
});

/* ---------- uploads ---------- */

async function uploadFiles(files, phaseId) {
  if (!files || !files.length) return;
  toast(`uploading ${files.length} file(s)…`);
  let failed = 0;
  for (const f of files) {
    try {
      await upload(f, phaseId);
    } catch (err) {
      failed++;
      console.error(err);
    }
  }
  await touch(phaseId);
  await after(failed ? `${files.length - failed} uploaded, ${failed} failed` : `${files.length} file(s) attached`);
}

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  if (el.dataset.action === 'upload') return uploadFiles([...el.files], el.dataset.id);

  if (el.dataset.action === 'field') {
    await run(`UPDATE phases SET ${el.dataset.field} = ${q(el.value)} WHERE id = ${q(el.dataset.id)}`);
    await touch(el.dataset.id);
    return toast('saved');
  }

  if (el.dataset.action === 'status') {
    const phases = await model();
    const i = phases.findIndex((p) => p.id === el.dataset.id);
    const p = phases[i];
    if (el.value === 'closed' && !canClose(p)) {
      el.value = p.status;
      return toast("can't close — both exit lists need entries");
    }
    const blocked = blockedBy(phases, i);
    if (el.value !== 'not started' && blocked && !confirm(`Gate not paid — ${blocked} is not closed. Continue anyway?`)) {
      el.value = p.status;
      return;
    }
    await run(`UPDATE phases SET status = ${q(el.value)}, last_touched = ${q(today())} WHERE id = ${q(el.dataset.id)}`);
    return after(NEXT_ACTION[el.value] ? `${NEXT_ACTION[el.value][0]}.` : '');
  }
});

/* ---------- drag: reorder concepts, and file drops ---------- */

const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

document.addEventListener('dragstart', (e) => {
  const h = e.target.closest?.('[data-drag]');
  if (!h) return;
  state.dragId = h.dataset.drag;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', state.dragId);
  h.closest('.phase-card')?.classList.add('dragging');
});

document.addEventListener('dragend', () => {
  state.dragId = null;
  document.querySelectorAll('.phase-card').forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after'));
});

document.addEventListener('dragover', (e) => {
  const dz = e.target.closest?.('.dropzone');
  if (dz && isFileDrag(e)) {
    e.preventDefault();
    dz.classList.add('over');
    return;
  }
  if (!state.dragId) return;
  const card = e.target.closest?.('.phase-card[data-card]');
  if (!card || card.dataset.card === state.dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const before = e.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2;
  document.querySelectorAll('.phase-card').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  card.classList.add(before ? 'drop-before' : 'drop-after');
});

document.addEventListener('dragleave', (e) => e.target.closest?.('.dropzone')?.classList.remove('over'));

document.addEventListener('drop', async (e) => {
  const dz = e.target.closest?.('.dropzone');
  if (dz && isFileDrag(e)) {
    e.preventDefault();
    dz.classList.remove('over');
    return uploadFiles([...e.dataTransfer.files], dz.dataset.phase);
  }
  if (!state.dragId) return;
  const card = e.target.closest?.('.phase-card[data-card]');
  if (!card) return;
  e.preventDefault();
  const targetId = card.dataset.card;
  const before = e.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2;
  const dragged = state.dragId;
  state.dragId = null;
  if (dragged === targetId) return render();

  const ids = (await all('SELECT id FROM phases ORDER BY pos')).map((r) => r.id).filter((x) => x !== dragged);
  const at = ids.indexOf(targetId) + (before ? 0 : 1);
  ids.splice(at, 0, dragged);
  for (let i = 0; i < ids.length; i++) await run(`UPDATE phases SET pos = ${i} WHERE id = ${q(ids[i])}`);
  return after('reordered');
});

/* ---------- keyboard ---------- */

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    if (state.edit) {
      state.edit = null;
      return render();
    }
    if (state.drawer) {
      state.drawer = false;
      localStorage.setItem('ai-lab-drawer', '0');
      return render();
    }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    if (state.tab === 'sql') return runSql();
    if (state.edit?.kind === 'note') return document.querySelector('[data-action="save-note"]')?.click();
  }
  if (e.key !== 'Enter' || e.shiftKey) return;

  const el = e.target;
  if (el.tagName !== 'INPUT' || el.type === 'checkbox') return;
  const a = el.dataset.action;
  const v = el.value.trim();
  e.preventDefault();

  if (a === 'add-break' && v) {
    const pos = (((await all(`SELECT max(pos) AS m FROM breaks WHERE phase_id = ${q(el.dataset.id)}`))[0].m) ?? -1) + 1;
    await run(`INSERT INTO breaks VALUES (${q(uid())}, ${q(el.dataset.id)}, ${q(v)}, 0, ${pos}, NULL)`);
    await touch(el.dataset.id);
    return after();
  }
  if (a === 'add-claim' && v) {
    const kind = el.dataset.kind;
    await run(`INSERT INTO claims VALUES (${q(uid())}, ${q(el.dataset.id)}, ${q(kind)}, ${q(v)}, ${q(now())})`);
    if (kind === 'cannot') {
      // §3: a gap is logged as a confusion too
      const p = (await all(`SELECT num FROM phases WHERE id = ${q(el.dataset.id)}`))[0];
      await run(`INSERT INTO confusions VALUES (${q(uid())}, ${q(v)}, ${q(p?.num || null)}, ${q(now())}, 0, NULL)`);
    }
    await touch(el.dataset.id);
    return after(kind === 'cannot' ? 'gap logged as a confusion too' : '');
  }
  if (a === 'add-conf' && v) {
    await run(`INSERT INTO confusions VALUES (${q(uid())}, ${q(v)}, ${q(el.dataset.num)}, ${q(now())}, 0, NULL)`);
    await touch(el.dataset.id);
    return after('logged');
  }
  if (a === 'add-source-input') return document.querySelector(`button[data-action="add-source"][data-id="${el.dataset.id}"]`)?.click();
  if (el.id === 'timer-note') return document.querySelector('[data-action="stop-timer"]')?.click();
  if (el.id === 'edit-box') return document.querySelector('[data-action="save-resolution"]')?.click();
  if (el.id === 'note-title') return document.querySelector('[data-action="save-note"]')?.click();
  if (el.id === 'pk-topic' || el.id === 'pk-trigger') return document.querySelector('[data-action="add-parked"]').click();
  if (el.id === 'np-num' || el.id === 'np-name') return document.querySelector('[data-action="add-phase"]').click();
});

/* ---------- backup / restore ---------- */

async function backup() {
  const data = await exportJson();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ai-lab-tracker-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('downloaded — uploaded files are not in the JSON');
}

$('#restoreFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!confirm('Replace everything in ai-lab.db with this backup?')) return;
  await load(JSON.parse(await f.text()));
  e.target.value = '';
  await after('restored');
};

/* ---------- boot ---------- */

(async () => {
  try {
    await boot();
    $('#status').textContent = 'sqlite · ai-lab.db';
    showTab('dashboard');
    tick();
  } catch (err) {
    $('#status').innerHTML = `<span class="err">server unreachable — is server.py running?</span>`;
    console.error(err);
  }
})();

window.__lab = { all, run };
