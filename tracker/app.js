import { boot, all, run, save, load, exportJson, upload, deleteDoc, deleteRoadmap, q, uid, today, now, TABLES } from './api.js';
import { graphHtml, mountGraph, topoOrder, autoPos } from './graph.js';
import { icon, fileIcon } from './icons.js';

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

// Storage keys were prefixed ai-lab- before the rename; carry them over once so a
// running timer, the open roadmaps and the selected track survive the change.
for (const k of ['sections', 'timer', 'track', 'collapsed', 'drawer', 'view']) {
  const old = localStorage.getItem(`ai-lab-${k}`);
  if (old !== null && localStorage.getItem(`lt-${k}`) === null) localStorage.setItem(`lt-${k}`, old);
  if (old !== null) localStorage.removeItem(`ai-lab-${k}`);
}

let state = {
  tab: 'dashboard',
  open: null,          // expanded concept id
  edit: null,          // { kind: 'trace'|'resolution'|'note', id, phase }
  noteTags: [],        // concept ids while editing a note
  showResolved: false,
  sessionsAll: false,
  newPhase: false,
  confirmDel: null,
  reveal: {},          // `${conceptId}:${block}` the user asked to see
  seKind: 'build',
  dragId: null,
  drawer: localStorage.getItem('lt-drawer') === '1',
  view: localStorage.getItem('lt-view') || 'list',
  track: localStorage.getItem('lt-track') || null,
  collapsed: JSON.parse(localStorage.getItem('lt-collapsed') || '{}'),
  sections: { ...SECTION_DEFAULTS, ...JSON.parse(localStorage.getItem('lt-sections') || '{}') },
};

const saveSections = () => localStorage.setItem('lt-sections', JSON.stringify(state.sections));

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
  if (!d) return 'not yet';
  const days = Math.round((new Date(today()) - new Date(d)) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days > 0 ? `${days}d ago` : d;
};

/* ---------- session timer ---------- */

const TIMER_MS = 60 * 60 * 1000; // one hour
let timer = JSON.parse(localStorage.getItem('lt-timer') || 'null'); // {id, num, name, startedAt, kind}

const persistTimer = () =>
  timer ? localStorage.setItem('lt-timer', JSON.stringify(timer)) : localStorage.removeItem('lt-timer');

const remainingMs = () => (timer ? Math.max(0, TIMER_MS - (Date.now() - timer.startedAt)) : 0);
const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

async function startTimer(p) {
  if (timer && timer.id !== p.id && !confirm(`A session on ${timer.num} is still running. Stop it and start this one?`))
    return;
  if (timer) await stopTimer(false, true);
  timer = { id: p.id, num: p.num, name: p.name, startedAt: Date.now(), kind: state.seKind };
  persistTimer();
  if (p.status === 'not started') await run(`UPDATE phases SET status = 'building' WHERE id = ${q(p.id)}`);
  await after(`session started, 60:00 on ${p.num}`);
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
  await after(auto ? `the hour is up, ${mins}m logged on ${t.num}` : `stopped, ${mins}m logged`);
}

function tick() {
  const chip = $('#timerchip');
  if (!timer) {
    chip.hidden = true;
    return;
  }
  const left = remainingMs();
  chip.hidden = false;
  chip.innerHTML = `${icon('clock', { size: 13 })} <b>${clock(left)}</b> ${esc(timer.num)}`;
  const inline = $('#timer-count');
  if (inline) inline.textContent = clock(left);
  document.querySelectorAll('.timer .meter > i').forEach((i) => (i.style.width = `${(1 - left / TIMER_MS) * 100}%`));
  if (left <= 0) stopTimer(true);
}
setInterval(tick, 1000);

/* ---------- shared ui bits ---------- */

function panel(key, title, count, body, { head = '', flush = false } = {}) {
  const open = state.sections[key];
  return `<section class="panel ${open ? 'open' : ''}">
    <div class="panel-head" data-action="toggle-sec" data-key="${key}" role="button" tabindex="0"
         aria-expanded="${open}">
      ${icon('chevron')}
      <span class="title">${esc(title)}</span>
      ${count !== null && count !== undefined ? `<span class="count">${count}</span>` : ''}
      <span class="right">${head}</span>
    </div>
    ${open ? `<div class="panel-body ${flush ? 'flush' : ''}">${body}</div>` : ''}
  </section>`;
}

// Status reads as shape first: ring, filled dot, barred ring, filled grey.
const statusHtml = (s) =>
  `<span class="status ${s.replace(' ', '-')}"><span class="glyph"></span>${esc(s)}</span>`;

const meter = (done, total) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<span class="meter" role="img" aria-label="${done} of ${total}"><i style="width:${pct}%"></i></span>`;
};

/* ---------- data ---------- */

async function model() {
  const [phases, breaks, claims, sources, notes, docs, confusions, edges, roadmaps, tracks] = await Promise.all([
    all('SELECT * FROM phases ORDER BY pos'),
    all('SELECT * FROM breaks ORDER BY pos'),
    all('SELECT * FROM claims ORDER BY created_at'),
    all('SELECT * FROM sources ORDER BY created_at DESC'),
    all('SELECT * FROM notes ORDER BY updated_at DESC'),
    all('SELECT * FROM docs ORDER BY created_at DESC'),
    all('SELECT * FROM confusions ORDER BY created_at DESC'),
    all('SELECT * FROM edges'),
    all('SELECT * FROM roadmaps ORDER BY pos'),
    all('SELECT * FROM tracks ORDER BY pos'),
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
  phases.tracks = tracks;
  phases.roadmaps = roadmaps;
  for (const t of tracks) t.concepts = phases.filter((p) => p.track_id === t.id).sort((a, b) => a.pos - b.pos);
  for (const r of roadmaps) r.tracks = tracks.filter((t) => t.roadmap_id === r.id);
  return phases;
}

// A concept is gated by its prerequisites (graph edges). With no edges drawn it
// falls back to "the one before it in the list", which is spec section 4's default.
function blockedBy(phases, i) {
  const p = phases[i];
  if (p.prereqs?.length) {
    const open = p.prereqs
      .map((id) => phases.find((x) => x.id === id))
      .filter((x) => x && x.status !== 'closed');
    return open.length ? open.map((x) => x.num).join(', ') : null;
  }
  return i === 0 || phases[i - 1].status === 'closed' ? null : phases[i - 1].num;
}

const canClose = (p) => p.can.length > 0 && p.cannot.length > 0;

// A concept only has to satisfy the spec's exit rule once it is something you built.
const isUnit = (p) =>
  !!(p.build || p.wall || p.breaks.length || p.can.length || p.cannot.length ||
     p.notes.length || p.docs.length || p.sources.length || p.confusions.length);

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

  let track = phases.tracks.find((t) => t.id === state.track);
  if (!track) track = phases.tracks.find((t) => current && t.id === current.track_id) || phases.tracks[0];
  state.track = track?.id || null;
  const inTrack = track ? track.concepts : [];
  const trackEdges = phases.edges.filter(
    (e) => inTrack.some((p) => p.id === e.from_id) && inTrack.some((p) => p.id === e.to_id)
  );

  const chip = $('#nowchip');
  if (current) {
    chip.hidden = false;
    chip.innerHTML = `now <b>${esc(current.num)} ${esc(current.name)}</b>`;
  } else chip.hidden = true;

  const nextUp = current || inTrack.find((p) => p.status !== 'closed');
  const act = NEXT_ACTION[nextUp ? nextUp.status : 'closed'];
  const roadmap = phases.roadmaps.find((r) => r.id === track?.roadmap_id);
  const trackDone = inTrack.filter((p) => p.status === 'closed').length;

  $('#tab-dashboard').innerHTML = `
    <div class="shell">
      <nav class="rail" aria-label="roadmaps">
        <div class="rail-head">roadmaps</div>
        ${treeRail(phases)}
      </nav>
      <div class="main">
        ${nextUp
          ? `<section class="now">
              <div>
                <div class="who"><span class="code">${esc(nextUp.num)}</span>${esc(nextUp.name)}</div>
              </div>
              ${statusHtml(nextUp.status)}
              <p class="todo"><b>${act[0]}.</b> ${act[1]}</p>
              <div class="acts">
                ${timer
                  ? `<button class="btn danger" data-action="stop-timer">${icon('stop')} stop ${clock(remainingMs())}</button>`
                  : `<button class="btn primary" data-action="start-timer" data-id="${nextUp.id}">${icon('play')} start session</button>`}
                <button class="btn" data-action="open-phase" data-id="${nextUp.id}">${icon('arrowDown')} open</button>
              </div>
            </section>`
          : ''}

        ${panel('concepts',
          track ? `${roadmap ? esc(roadmap.name.split(' - ')[0].trim()) + ' / ' : ''}${esc(track.title)}` : 'concepts',
          `${trackDone}/${inTrack.length}`,
          state.view === 'graph' ? graphHtml(inTrack, trackEdges) : conceptsHtml(inTrack, phases),
          { flush: state.view === 'list',
            head: `<span class="seg">
              <button data-action="set-view" data-view="list" aria-pressed="${state.view === 'list'}">${icon('list')} list</button>
              <button data-action="set-view" data-view="graph" aria-pressed="${state.view === 'graph'}">${icon('graph')} graph</button>
            </span>
            <button class="btn quiet" data-action="new-phase-form">${icon('plus')} concept</button>` })}
      </div>
    </div>`;

  if (state.view === 'graph') mountGraph($('#graph'), inTrack, trackEdges, GRAPH_CTX);

  $('#drawer-body').innerHTML = `
    ${panel('log', 'sessions', null, sessionForm(sessions))}
    ${panel('queue', 'interest queue', `${openConf} open`, queueHtml(phases))}
    ${panel('parked', 'parked registry', `${firedParked}/${parked.length}`, parkedHtml(parked))}`;

  const badge = $('#panelbadge');
  badge.hidden = !openConf;
  badge.textContent = openConf;
  $('#drawer').classList.toggle('open', state.drawer);
  $('#backdrop').hidden = !state.drawer;
}

/* ---------- rail: roadmap > track tree ---------- */

function treeRail(phases) {
  return `${phases.roadmaps
    .map((r) => {
      const openRm = !state.collapsed[r.id];
      const all = r.tracks.flatMap((t) => t.concepts);
      const done = all.filter((p) => p.status === 'closed').length;
      return `<div class="rm">
        ${state.confirmDel === r.id
          ? `<div class="rm-confirm">
              <p>Delete <b>${esc(r.name)}</b> with ${r.tracks.length} track${r.tracks.length === 1 ? '' : 's'},
                ${all.length} concept${all.length === 1 ? '' : 's'} and everything attached to them?
                Uploaded files are removed from disk. A snapshot is written to
                <span class="mono">tracker/trash/</span> first, so this is recoverable.</p>
              <div class="row">
                <button class="btn danger" data-action="confirm-del-roadmap" data-id="${r.id}">delete</button>
                <button class="btn" data-action="cancel-del-roadmap">cancel</button>
              </div>
            </div>`
          : `<div class="rm-head" data-action="toggle-roadmap" data-id="${r.id}" role="button" tabindex="0"
             aria-expanded="${openRm}">
          ${icon('chevron')}
          <span class="name">${esc(r.name)}</span>
          <span class="count">${done}/${all.length}</span>
          <button class="iconbtn danger" data-action="del-roadmap" data-id="${r.id}"
            title="delete this roadmap" aria-label="delete roadmap">${icon('close')}</button>
        </div>`}
        ${openRm && state.confirmDel !== r.id ? `<ul class="tracks">
          ${r.tracks
            .map((t) => {
              const n = t.concepts.length;
              const d = t.concepts.filter((p) => p.status === 'closed').length;
              const live = t.concepts.some((p) => p.status === 'building' || p.status === 'walled');
              return `<li data-action="select-track" data-id="${t.id}" role="button" tabindex="0"
                  aria-current="${state.track === t.id}" class="${d === n && n ? 'complete' : ''}">
                ${t.num ? `<span class="n">${esc(t.num)}</span>` : ''}
                <span class="label" title="${esc(t.title)}">${esc(t.title)}</span>
                ${live ? `<span class="live" title="work in progress">${icon('dot', { size: 10 })}</span>` : ''}
                <span class="done">${d}/${n}</span>
              </li>`;
            })
            .join('')}
        </ul>` : ''}
      </div>`;
    })
    .join('')}
    ${phases.roadmaps.length ? '' : '<p class="empty" style="padding:12px 16px">No roadmaps. Add one below; it starts with a single track you can rename.</p>'}
    <div class="rail-add">
      <input type="text" id="rm-new" placeholder="new roadmap" data-action="add-roadmap" aria-label="add roadmap" />
    </div>`;
}

/* ---------- concepts ---------- */

function conceptsHtml(phases, allPhases = phases) {
  const cards = phases
    .map((p, i) => {
      const blocked = blockedBy(phases, i);
      const open = state.open === p.id;
      const unit = isUnit(p);
      const done = p.breaks.filter((b) => b.done).length;
      const openConf = p.confusions.filter((c) => !c.resolved).length;
      const running = timer && timer.id === p.id;

      const row = `<div class="crow" data-action="toggle-phase" data-id="${p.id}" role="button" tabindex="0"
          aria-expanded="${open}" draggable="true" data-drag="${p.id}">
        <span class="grip" title="drag to reorder">${icon('grip')}</span>
        <input type="checkbox" data-action="done" data-id="${p.id}" ${p.status === 'closed' ? 'checked' : ''}
          aria-label="done" title="done: you can explain it and did the checkpoint" />
        ${icon('chevron')}
        <span class="name"><span class="code">${esc(p.num)}</span>${esc(p.name)}</span>
        ${p.hours ? `<span class="hours">${p.hours}h</span>` : ''}
        <span class="right">
          ${running ? `<span class="status building"><span class="glyph"></span><span id="timer-count">${clock(remainingMs())}</span></span>` : ''}
          ${blocked && p.status !== 'closed' ? `<span class="status gated" title="gated: ${esc(blocked)} is not closed" aria-label="gated: ${esc(blocked)} is not closed">${icon('wall', { size: 13 })}</span>` : ''}
          ${unit ? `<span class="counts">${done}/${p.breaks.length} broken · ${p.can.length}/${p.cannot.length} exit${openConf ? ` · <span class="warn">${openConf} open</span>` : ''}</span>` : ''}
          ${unit || p.status !== 'not started' ? statusHtml(p.status) : ''}
          <select data-action="status" data-id="${p.id}" aria-label="status">
            ${STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </span>
      </div>`;

      if (!open) return `<article class="concept ${p.status === 'closed' ? 'is-closed' : ''}" data-card="${p.id}">${row}</article>`;

      const shows = (key, hasContent) => hasContent || state.reveal[`${p.id}:${key}`];
      const unitOpen = unit || state.reveal[`${p.id}:build`];
      const hasGate = p.gate && p.gate.trim() && p.gate.trim() !== 'none';

      const optional = [
        ['confusions', p.confusions.length, 'confusion'],
        ['notes', p.notes.length, 'note'],
        ['sources', p.sources.length, 'source'],
        ['documents', p.docs.length, 'file'],
      ];
      const addable = optional.filter(([key, n]) => !shows(key, n));

      return `<article class="concept open ${p.status === 'closed' ? 'is-closed' : ''}" data-card="${p.id}">${row}
        <div class="cbody">
          ${running ? timerPanel() : ''}
          ${blocked && p.status !== 'not started' && p.status !== 'closed'
            ? `<div class="warnbox">${icon('warning')} Gate not paid. ${esc(blocked)} is not closed.</div>`
            : ''}

          ${p.practical
            ? `<div class="field"><label>practical checkpoint</label>
                <div class="ro checkpoint">${icon('flask')}<span>${esc(p.practical)}</span></div></div>`
            : ''}
          ${hasGate ? `<div class="field"><label>gate</label><div class="ro">${esc(p.gate)}</div></div>` : ''}

          ${unitOpen ? unitFields(p) : ''}
          ${shows('confusions', p.confusions.length) ? confusionsBlock(p) : ''}
          ${shows('notes', p.notes.length) ? notesBlock(p, allPhases) : ''}
          ${shows('sources', p.sources.length) ? sourcesBlock(p) : ''}
          ${shows('documents', p.docs.length) ? docsBlock(p) : ''}

          ${addable.length || !unitOpen
            ? `<div class="addbar">
                <span class="note">add</span>
                ${!unitOpen
                  ? `<button class="btn" data-action="reveal" data-id="${p.id}" data-key="build">${icon('plus')} build</button>`
                  : ''}
                ${addable.map(([key, , word]) =>
                  `<button class="btn quiet" data-action="reveal" data-id="${p.id}" data-key="${key}">${icon('plus')} ${word}</button>`).join('')}
              </div>
              ${!unitOpen
                ? `<p class="note" style="margin-top:8px">This one is a checkbox: tick it when you can explain it and did the checkpoint.
                   Adding a build turns it into a unit, and the exit rule starts applying.</p>`
                : ''}`
            : ''}
        </div>
      </article>`;
    })
    .join('');

  const form = state.newPhase
    ? `<div class="concept"><div class="cbody" style="padding:16px">
        <div class="row wrap">
          <input type="text" id="np-num" placeholder="code" style="width:96px" aria-label="concept code" />
          <input type="text" id="np-name" placeholder="name" class="grow" aria-label="concept name" />
          <button class="btn primary" data-action="add-phase">add</button>
          <button class="btn" data-action="cancel-new-phase">cancel</button>
        </div>
      </div></div>`
    : '';

  return cards || form
    ? cards + form
    : '<p class="empty" style="padding:16px">No concepts in this track yet. Add one, or pick another track.</p>';
}

function unitFields(p) {
  const done = p.breaks.filter((b) => b.done).length;
  return `
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
        ${p.breaks.map((b) => breakItem(b, p.id)).join('') ||
          '<li class="empty">Name the failures you intend to cause. If nothing broke, the build was too easy.</li>'}
      </ul>
      <input type="text" placeholder="add a failure to induce" data-action="add-break" data-id="${p.id}"
        aria-label="add a failure to induce" style="margin-top:8px" />
    </div>

    <div class="two">
      <div class="field">
        <label>${icon('check', { size: 13 })} can explain without notes</label>
        <ul class="list">${p.can.map(claimItem).join('') || '<li class="empty">empty</li>'}</ul>
        <input type="text" placeholder="add a claim" data-action="add-claim" data-kind="can" data-id="${p.id}"
          aria-label="add a claim you can explain" style="margin-top:8px" />
      </div>
      <div class="field">
        <label>${icon('close', { size: 13 })} still can't explain</label>
        <ul class="list">${p.cannot.map(claimItem).join('') || '<li class="empty">empty</li>'}</ul>
        <input type="text" placeholder="add a gap, also filed as a confusion" data-action="add-claim" data-kind="cannot" data-id="${p.id}"
          aria-label="add a gap" style="margin-top:8px" />
      </div>
    </div>

    ${!canClose(p) && p.status !== 'closed' && (p.breaks.length || p.build)
      ? `<p class="note">Closes only when <em>both</em> exit lists have entries. An empty "still can't explain" means you weren't honest, not that you're done.</p>`
      : ''}
    <span hidden>${done}</span>`;
}

function timerPanel() {
  const left = remainingMs();
  return `<div class="timer">
    <span class="count" id="timer-count">${clock(left)}</span>
    <span class="note">left of the hour, logging as <b>${esc(timer.kind)}</b></span>
    <button class="btn danger" data-action="stop-timer" style="margin-left:auto">${icon('stop')} stop and log</button>
    <span class="meter"><i style="width:${(1 - left / TIMER_MS) * 100}%"></i></span>
    <input type="text" id="timer-note" placeholder="what happened, written into the session when you stop"
      aria-label="session note" />
  </div>`;
}

function breakItem(b, phaseId) {
  if (state.edit?.kind === 'trace' && state.edit.id === b.id) {
    return `<li><div class="grow">
      <div class="note" style="margin-bottom:6px">${esc(b.label)}</div>
      <textarea id="edit-box" placeholder="what actually broke, pasted from the run">${esc(b.trace)}</textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn primary" data-action="save-trace" data-id="${b.id}" data-phase="${phaseId}">save</button>
        <button class="btn" data-action="cancel-edit">cancel</button>
      </div>
    </div></li>`;
  }
  return `<li class="${b.done ? 'done' : ''}">
    <input type="checkbox" data-action="break" data-id="${b.id}" data-phase="${phaseId}" ${b.done ? 'checked' : ''}
      aria-label="induced" />
    <span class="txt">
      <span class="main">${esc(b.label)}</span>
      ${b.trace ? `<span class="sub">${esc(b.trace)}</span>` : ''}
    </span>
    <button class="iconbtn" data-action="edit-trace" data-id="${b.id}"
      title="${b.trace ? 'edit trace' : 'attach trace'}" aria-label="trace">${icon('edit')}</button>
    <button class="iconbtn danger" data-action="del-break" data-id="${b.id}" title="delete" aria-label="delete">${icon('close')}</button>
  </li>`;
}

const claimItem = (c) => `<li>
  <span class="txt"><span class="main">${esc(c.text)}</span></span>
  <button class="iconbtn danger" data-action="del-claim" data-id="${c.id}" title="delete" aria-label="delete">${icon('close')}</button>
</li>`;

/* ---------- confusions (per concept) ---------- */

function confusionsBlock(p) {
  const rows = state.showResolved ? p.confusions : p.confusions.filter((c) => !c.resolved);
  const resolved = p.confusions.filter((c) => c.resolved).length;

  return `<div class="field">
    <div class="flabel">confusions
      ${resolved ? `<span class="right"><button class="btn quiet" data-action="toggle-resolved">${state.showResolved ? 'hide' : 'show'} ${resolved} resolved</button></span>` : ''}
    </div>
    <ul class="list">
      ${rows.map(confItem).join('') ||
        `<li class="empty">Anything you couldn't explain goes here, dated. Append only: resolving strikes it through, nothing is deleted.</li>`}
    </ul>
    <input type="text" placeholder="what you couldn't explain" data-action="add-conf"
      data-id="${p.id}" data-num="${esc(p.num)}" id="conf-${p.id}" aria-label="log a confusion" style="margin-top:8px" />
  </div>`;
}

function confItem(c) {
  if (state.edit?.kind === 'resolution' && state.edit.id === c.id) {
    return `<li><div class="grow">
      <div class="note" style="margin-bottom:6px">${esc(c.text)}</div>
      <input type="text" id="edit-box" placeholder="resolved: note filename or one line" value="${esc(c.resolution || '')}" />
      <div class="row" style="margin-top:8px">
        <button class="btn primary" data-action="save-resolution" data-id="${c.id}">save</button>
        <button class="btn" data-action="cancel-edit">cancel</button>
      </div>
    </div></li>`;
  }
  return `<li class="${c.resolved ? 'done' : ''}">
    <input type="checkbox" data-action="resolve-conf" data-id="${c.id}" ${c.resolved ? 'checked' : ''} aria-label="resolved" />
    <span class="txt">
      <span class="main">${esc(c.text)}</span>
      ${c.resolved && c.resolution ? `<span class="sub">${esc(c.resolution)}</span>` : ''}
      <span class="sub">${esc((c.created_at || '').slice(0, 10))}</span>
    </span>
    ${c.resolved ? `<button class="iconbtn" data-action="edit-resolution" data-id="${c.id}" title="resolution" aria-label="resolution">${icon('edit')}</button>` : ''}
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
          <span class="main">${esc(n.title)}${others.map((o) => `<span class="tag">${esc(o.num)}</span>`).join('')}</span>
          ${n.body ? `<span class="sub body">${esc(n.body)}</span>` : ''}
          <span class="sub">${esc(relDay((n.updated_at || '').slice(0, 10)))}</span>
        </span>
        <button class="iconbtn" data-action="edit-note" data-id="${n.id}" data-phase="${p.id}" title="edit" aria-label="edit note">${icon('edit')}</button>
        <button class="iconbtn danger" data-action="del-note" data-id="${n.id}" title="delete" aria-label="delete note">${icon('close')}</button>
      </li>`;
    })
    .join('');

  return `<div class="field">
    <div class="flabel">notes
      <span class="right"><button class="btn quiet" data-action="new-note" data-phase="${p.id}">${icon('plus')} note</button></span>
    </div>
    <ul class="list">
      ${editingNew ? `<li>${noteEditor(null, p, phases)}</li>` : ''}
      ${list || (editingNew ? '' : '<li class="empty">A note is a claim, not a summary. The title states it, the body defends it to a smarter colleague.</li>')}
    </ul>
  </div>`;
}

function noteEditor(n, p, phases) {
  const tags = state.noteTags || [];
  return `<div class="grow">
    <input type="text" id="note-title" aria-label="claim"
      placeholder="the claim, e.g. kv-cache memory is linear in batch x context" value="${esc(n ? n.title : '')}" />
    <textarea id="note-body" style="margin-top:8px;min-height:120px"
      placeholder="defend it to a smarter colleague">${esc(n ? n.body : '')}</textarea>
    <div class="row wrap" style="margin-top:10px;gap:5px">
      <span class="note">belongs to</span>
      ${phases
        .map((x) => `<button class="btn quiet" data-action="tag-note" data-id="${x.id}"
          aria-pressed="${tags.includes(x.id)}"
          style="${tags.includes(x.id) ? 'color:var(--accent);border-color:var(--accent-line);background:var(--accent-wash)' : ''}">${esc(x.num)}</button>`)
        .join('')}
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-action="save-note" data-id="${n ? n.id : 'new'}" data-phase="${p.id}">save</button>
      <button class="btn" data-action="cancel-edit">cancel</button>
      <span class="note">Tag every concept it explains. A note on KV-cache belongs to three at once.</span>
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
              <span class="sub">${icon('link', { size: 12 })} <a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a></span>
            </span>
            <button class="iconbtn danger" data-action="del-source" data-id="${r.id}" title="delete" aria-label="delete source">${icon('close')}</button>
          </li>`
        )
        .join('') ||
        '<li class="empty">Read only what the wall entitles you to, then log the one line it changed.</li>'}
    </ul>
    <div class="row wrap" style="margin-top:8px">
      <input type="text" id="sr-url-${p.id}" placeholder="https://" style="flex:1 1 200px" aria-label="source link" />
      <input type="text" id="sr-note-${p.id}" placeholder="one line: what it changed in your head"
        data-action="add-source-input" data-id="${p.id}" style="flex:2 1 260px" aria-label="what it changed" />
      <button class="btn" data-action="add-source" data-id="${p.id}">add</button>
    </div>
  </div>`;
}

/* ---------- documents ---------- */

const fmtSize = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

function docsBlock(p) {
  return `<div class="field">
    <label>documents</label>
    <ul class="list">
      ${p.docs
        .map(
          (d) => `<li>
            <span style="color:var(--fg-3);line-height:0;margin-top:2px">${fileIcon(d.filename)}</span>
            <span class="txt">
              <span class="main"><a href="/files/${encodeURIComponent(d.stored)}" target="_blank" rel="noreferrer">${esc(d.filename)}</a></span>
              <span class="sub">${fmtSize(d.size || 0)} · ${esc((d.created_at || '').slice(0, 10))}</span>
            </span>
            <button class="iconbtn danger" data-action="del-doc" data-id="${d.id}" title="delete" aria-label="delete file">${icon('close')}</button>
          </li>`
        )
        .join('')}
    </ul>
    <label class="drop" data-phase="${p.id}">
      <input type="file" multiple hidden data-action="upload" data-id="${p.id}" />
      <span>${icon('upload')} drop files here or choose</span>
      <span class="dim">traces, logs, eval outputs, screenshots</span>
    </label>
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
          return `<li ${p ? `data-action="open-phase" data-id="${p.id}" role="button" tabindex="0" style="cursor:pointer"` : ''}>
            <span class="txt">
              <span class="main">${esc(c.text)}</span>
              <span class="sub">${p ? `${esc(p.num)} ${esc(p.name)} · ` : 'unfiled · '}${esc(relDay((c.created_at || '').slice(0, 10)))}</span>
            </span>
          </li>`;
        })
        .join('') || '<li class="empty">Nothing open. Confusions logged inside a concept surface here.</li>'}
    </ul>
    <p class="note" style="margin-top:10px">Every open confusion, across concepts. Pick by curiosity, not order. Entries that keep resurfacing are where depth is owed.</p>`;
}

/* ---------- parked ---------- */

function parkedHtml(rows) {
  return `<ul class="list">
      ${rows
        .map(
          (r) => `<li class="${r.fired ? 'done' : ''}">
            <input type="checkbox" data-action="fire-parked" data-id="${r.id}" ${r.fired ? 'checked' : ''} aria-label="trigger fired" />
            <span class="txt">
              <span class="main">${esc(r.topic)}</span>
              <span class="sub">${r.fired ? `fired ${esc(r.fired_at || '')}, write it up as a concept` : esc(r.trigger_text)}</span>
            </span>
            <button class="iconbtn danger" data-action="del-parked" data-id="${r.id}" title="delete" aria-label="delete">${icon('close')}</button>
          </li>`
        )
        .join('')}
    </ul>
    <div class="row wrap" style="margin-top:12px">
      <input type="text" id="pk-topic" placeholder="topic" class="grow" aria-label="parked topic" />
      <input type="text" id="pk-trigger" placeholder="trigger" class="grow" aria-label="trigger" />
      <button class="btn" data-action="add-parked">park</button>
    </div>
    <p class="note" style="margin-top:10px">Parked is not skipped. Tick only when the trigger has actually fired. Reading this list for interest is the failure mode it exists to prevent.</p>`;
}

/* ---------- sessions ---------- */

function sessionForm(sessions) {
  const shown = state.sessionsAll ? sessions : sessions.slice(0, 6);
  const dryOver = sessions.filter((s) => s.kind === 'dry' && (s.minutes || 0) > 90).length;

  return `<div class="flabel">next session logs as</div>
    <span class="seg">
      ${['build', 'break', 'read', 'dry']
        .map((k) => `<button data-action="se-kind" data-kind="${k}" aria-pressed="${state.seKind === k}">${k}</button>`)
        .join('')}
    </span>
    <p class="note" style="margin-top:10px">
      ${timer
        ? `Running on ${esc(timer.num)} ${esc(timer.name)}. Stop it there, or <a href="#" data-action="stop-timer">stop and log now</a>.`
        : 'Press start on a concept. It runs an hour and logs itself. There is no manual entry.'}
    </p>
    ${dryOver ? `<div class="warnbox" style="margin-top:12px">${icon('warning')} ${dryOver} dry session${dryOver > 1 ? 's' : ''} over the 90 minute box.</div>` : ''}
    <ul class="list" style="margin-top:12px;border-top:1px solid var(--line);padding-top:4px">
      ${shown
        .map(
          (s) => `<li>
            <span class="txt">
              <span class="main">${esc(s.note || 'no note')}</span>
              <span class="sub">${esc(s.on_date)} · ${esc(s.kind)}${s.phase_num ? ' · ' + esc(s.phase_num) : ''} · <span class="${s.kind === 'dry' && s.minutes > 90 ? 'err' : ''}">${s.minutes || 0}m</span></span>
            </span>
            <button class="iconbtn danger" data-action="del-session" data-id="${s.id}" title="delete" aria-label="delete session">${icon('close')}</button>
          </li>`
        )
        .join('') || '<li class="empty">No sessions yet. They appear when the timer stops.</li>'}
    </ul>
    ${sessions.length > 6 ? `<button class="btn quiet" data-action="toggle-sessions" style="margin-top:10px">${state.sessionsAll ? 'show less' : `show all ${sessions.length}`}</button>` : ''}`;
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
  el.innerHTML = `<div class="main">
    <section class="panel open">
      <div class="panel-head" style="cursor:default">
        <span class="title">sqlite console</span>
        <span class="count">learning-tracker.db</span>
        <span class="right">
          <button class="btn" data-action="backup" title="download every table as JSON">${icon('download')} backup</button>
          <button class="btn" data-action="restore" title="replace the database from a JSON backup">${icon('upload')} restore</button>
          <button class="btn primary" data-action="run-sql">run</button>
        </span>
      </div>
      <div class="panel-body">
        <div class="row wrap" style="margin-bottom:10px">
          ${Object.keys(SAMPLES)
            .map((k) => `<button class="btn quiet" data-action="sample" data-key="${esc(k)}">${esc(k)}</button>`)
            .join('')}
        </div>
        <textarea id="sql-in" spellcheck="false" aria-label="sql">${esc(SAMPLES['concept progress'])}</textarea>
        <p class="note" style="margin-top:10px">
          Tables: <span class="mono">${TABLES.join(', ')}</span>. <span class="mono">concepts</span> is a view over
          <span class="mono">phases</span>, which is what the storage still calls them. Writes land straight in the file.
          Backup covers every table; uploaded files in <span class="mono">tracker/files/</span> are not in the JSON.
        </p>
        <div id="sql-out" style="margin-top:16px"></div>
      </div>
    </section>
  </div>`;
}

async function runSql() {
  const sql = $('#sql-in').value.trim();
  const out = $('#sql-out');
  if (!sql) return;
  out.innerHTML = '<p class="note">running</p>';
  try {
    const rows = await all(sql);
    if (!rows.length) return void (out.innerHTML = '<p class="note">ok, 0 rows</p>');
    const cols = Object.keys(rows[0]);
    out.innerHTML = `<div class="scroll"><table>
        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] === null ? '' : r[c])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p class="note" style="margin-top:10px">${rows.length} row${rows.length > 1 ? 's' : ''}</p>`;
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e.message || e)}</p>`;
  }
}

/* ---------- graph ---------- */

// Concept order follows the graph: a topological sort of the prerequisite edges.
async function applyGraphOrder(phases) {
  const { order, cycle } = topoOrder(phases, phases.edges);
  if (cycle) return 'cycle found, order left alone';
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
    if (back.length) return toast('that would point both ways, delete the other edge first');
    await run(`INSERT INTO edges VALUES (${q(uid())}, ${q(from)}, ${q(to)})`);
    const phases = await model();
    const { cycle } = topoOrder(phases, phases.edges);
    if (cycle) {
      await run(`DELETE FROM edges WHERE from_id = ${q(from)} AND to_id = ${q(to)}`);
      return after('that edge would make a cycle, not added');
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
    localStorage.setItem('lt-view', 'list');
    render().then(() => document.querySelector('.concept.open')?.scrollIntoView({ block: 'center' }));
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
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
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
      localStorage.setItem('lt-drawer', state.drawer ? '1' : '0');
      return render();

    case 'select-track':
      state.track = id;
      state.open = null;
      localStorage.setItem('lt-track', id);
      return render();
    case 'del-roadmap':
      state.confirmDel = id;
      state.collapsed[id] = true;
      return render();
    case 'cancel-del-roadmap':
      state.confirmDel = null;
      return render();
    case 'confirm-del-roadmap': {
      const gone = (await all(`SELECT id FROM tracks WHERE roadmap_id = ${q(id)}`)).map((t) => t.id);
      const res = await deleteRoadmap(id);
      state.confirmDel = null;
      if (gone.includes(state.track)) {
        state.track = null;
        localStorage.removeItem('lt-track');
      }
      return after(`deleted ${res.concepts} concept${res.concepts === 1 ? '' : 's'}` +
        (res.files ? ` and ${res.files} file${res.files === 1 ? '' : 's'}` : '') +
        `, saved to trash/${res.snapshot}`);
    }
    case 'toggle-roadmap':
      state.collapsed[id] = !state.collapsed[id];
      localStorage.setItem('lt-collapsed', JSON.stringify(state.collapsed));
      return render();
    case 'done': {
      const p = (await model()).find((x) => x.id === id);
      if (el.checked && isUnit(p) && !canClose(p)) {
        el.checked = false;
        return toast("can't close, both exit lists need entries");
      }
      await run(`UPDATE phases SET status = ${el.checked ? "'closed'" : "'not started'"},
        last_touched = ${q(today())} WHERE id = ${q(id)}`);
      return after('');
    }
    case 'add-track': {
      const t = $('#tr-new').value.trim();
      if (!t) return;
      const rm = el.dataset.roadmap;
      const pos = (((await all(`SELECT max(pos) AS m FROM tracks WHERE roadmap_id = ${q(rm)}`))[0].m) ?? -1) + 1;
      await run(`INSERT INTO tracks VALUES (${q(uid())}, ${q(rm)}, '', ${q(t)}, ${pos})`);
      return after('track added');
    }
    case 'set-view':
      state.view = el.dataset.view;
      localStorage.setItem('lt-view', state.view);
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

    case 'open-phase': {
      const p = (await all(`SELECT track_id FROM phases WHERE id = ${q(id)}`))[0];
      if (p?.track_id) {
        state.track = p.track_id;
        localStorage.setItem('lt-track', p.track_id);
      }
      state.open = id;
      state.view = 'list';
      localStorage.setItem('lt-view', 'list');
      state.sections.concepts = true;
      saveSections();
      await render();
      document.querySelector('.concept.open')?.scrollIntoView({ block: 'center' });
      return;
    }
    case 'reveal':
      state.reveal[`${id}:${el.dataset.key}`] = true;
      return render();
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
      return after(el.checked ? 'broken, write the trace down' : '');
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
      const pos = (((await all(`SELECT max(pos) AS m FROM phases WHERE track_id = ${q(state.track)}`))[0].m) ?? -1) + 1;
      await run(`INSERT INTO phases (id,num,name,status,gate,build,verify_txt,wall,earned,pos,last_touched,track_id)
        VALUES (${q(uid())}, ${q(num)}, ${q(name)}, 'not started', '', '', '', '', '', ${pos}, NULL, ${q(state.track)})`);
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
      return after(el.checked ? 'trigger fired, it graduates into a concept now' : '');
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
      return toast("can't close, both exit lists need entries");
    }
    const blocked = blockedBy(phases, i);
    if (el.value !== 'not started' && blocked && !confirm(`Gate not paid. ${blocked} is not closed. Continue anyway?`)) {
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
  h.closest('.concept')?.classList.add('dragging');
});

document.addEventListener('dragend', () => {
  state.dragId = null;
  document.querySelectorAll('.concept').forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after'));
});

document.addEventListener('dragover', (e) => {
  const dz = e.target.closest?.('.dropzone');
  if (dz && isFileDrag(e)) {
    e.preventDefault();
    dz.classList.add('over');
    return;
  }
  if (!state.dragId) return;
  const card = e.target.closest?.('.concept[data-card]');
  if (!card || card.dataset.card === state.dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const before = e.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2;
  document.querySelectorAll('.concept').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
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
  const card = e.target.closest?.('.concept[data-card]');
  if (!card) return;
  e.preventDefault();
  const targetId = card.dataset.card;
  const before = e.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2;
  const dragged = state.dragId;
  state.dragId = null;
  if (dragged === targetId) return render();

  const ids = (await all(`SELECT id FROM phases WHERE track_id = ${q(state.track)} ORDER BY pos`)).map((r) => r.id).filter((x) => x !== dragged);
  const at = ids.indexOf(targetId) + (before ? 0 : 1);
  ids.splice(at, 0, dragged);
  for (let i = 0; i < ids.length; i++) await run(`UPDATE phases SET pos = ${i} WHERE id = ${q(ids[i])}`);
  return after('reordered');
});

/* ---------- keyboard ---------- */

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    if (state.confirmDel) {
      state.confirmDel = null;
      return render();
    }
    if (state.edit) {
      state.edit = null;
      return render();
    }
    if (state.drawer) {
      state.drawer = false;
      localStorage.setItem('lt-drawer', '0');
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
  if (el.dataset.action === 'add-roadmap' && v) {
    const pos = (((await all('SELECT max(pos) AS m FROM roadmaps'))[0].m) ?? -1) + 1;
    const id = uid();
    await run(`INSERT INTO roadmaps VALUES (${q(id)}, ${q(v)}, '', ${pos})`);
    await run(`INSERT INTO tracks VALUES (${q(uid())}, ${q(id)}, '', 'first track', 0)`);
    return after('roadmap added');
  }
  if (el.dataset.action === 'add-track') return document.querySelector('[data-action="add-track"]')?.click();
  if (el.id === 'pk-topic' || el.id === 'pk-trigger') return document.querySelector('[data-action="add-parked"]').click();
  if (el.id === 'np-num' || el.id === 'np-name') return document.querySelector('[data-action="add-phase"]').click();
});

/* ---------- backup / restore ---------- */

async function backup() {
  const data = await exportJson();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `learning-tracker-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('downloaded. Uploaded files are not in the JSON');
}

$('#restoreFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!confirm('Replace everything in learning-tracker.db with this backup?')) return;
  await load(JSON.parse(await f.text()));
  e.target.value = '';
  await after('restored');
};

/* ---------- boot ---------- */

(async () => {
  try {
    await boot();
    // the shell ships without icon markup; one source for glyphs is icons.js
    const closeBtn = $('#drawer .drawer-head .iconbtn');
    if (closeBtn) closeBtn.innerHTML = icon('close');
    $('#status').textContent = 'sqlite · learning-tracker.db';
    showTab('dashboard');
    tick();
  } catch (err) {
    $('#status').innerHTML = `<span class="err">server unreachable, is server.py running?</span>`;
    console.error(err);
  }
})();

window.__lab = { all, run };
