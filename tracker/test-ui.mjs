// UI regression test: runs app.js against a minimal DOM shim and a REAL server.
// It writes data and uploads files, so point it at a throwaway database:
//
//   python3 server.py --port 8788 --db /tmp/tracker-test.db --no-open &
//   node test-ui.mjs
//
const BASE = process.env.TRACKER_URL || 'http://127.0.0.1:8788';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => (store[k] = String(v)),
  removeItem: (k) => delete store[k],
};

const captured = {}, nodes = {}, listeners = {};
function stub(sel) {
  if (nodes[sel]) return nodes[sel];
  const n = {
    sel, dataset: {}, style: {}, hidden: false, value: '', textContent: '', checked: false,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    get innerHTML() { return captured[sel] || ''; }, set innerHTML(v) { captured[sel] = v; },
    focus() {}, setSelectionRange() {}, click() {}, scrollIntoView() {},
    querySelectorAll: () => [], closest: () => null, addEventListener() {},
  };
  return (nodes[sel] = n);
}
globalThis.document = {
  querySelector: stub,
  querySelectorAll: () => [],
  addEventListener: (t, f) => ((listeners[t] ||= []).push(f)),
  createElement: () => ({ style: {}, click() {} }),
};
globalThis.window = { scrollY: 0, scrollTo() {} };
globalThis.confirm = () => true;
globalThis.FileReader = class {
  readAsDataURL(file) {
    file.arrayBuffer().then((buf) => {
      this.result = 'data:;base64,' + Buffer.from(buf).toString('base64');
      this.onload();
    });
  }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = u.startsWith('http') ? u : BASE + u;
  for (let k = 0; k < 5; k++) { try { return await realFetch(url, o); } catch (e) { if (k === 4) throw e; } }
};

const sql = async (s) =>
  (await (await globalThis.fetch('/api/sql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: s }),
  })).json()).rows;
const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));

// start from a pristine seeded database so the suite is repeatable
await globalThis.fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

await import(new URL('./app.js', import.meta.url).href);
await wait(900);

const fire = async (type, el, extra = {}) => {
  for (const f of listeners[type] || []) await f({ target: el, preventDefault() {}, key: el._key, ...extra });
  await wait(320);
};
const mk = (dataset, extra = {}) => {
  const el = { dataset, closest: (s) => (s === '#tabs button' ? null : el), tagName: 'DIV', ...extra };
  return el;
};
const input = (dataset, value, extra = {}) =>
  ({ tagName: 'INPUT', type: 'text', value, dataset, _key: 'Enter', closest: () => null, preventDefault() {}, ...extra });
const dash = () => captured['#tab-dashboard'] || '';
const drawer = () => captured['#drawer-body'] || '';
const has = (s) => dash().includes(s);
let failures = 0;
const check = (label, cond) => { if (!cond) failures++; console.log((cond ? '  ok  ' : ' FAIL ') + label); };

const c1 = (await sql("SELECT id FROM concepts WHERE num='01'"))[0].id;
const c2 = (await sql("SELECT id FROM concepts WHERE num='02'"))[0].id;

check('renders concepts, not phases', has('tool-calling') && !/>phases</.test(dash()));
check('analytics stat strip is gone', !has('class="stats"'));
check('icons are authored svg, not emoji or unicode glyphs',
  has('<svg class="i"') && !/[\u{1F300}-\u{1FAFF}\u{2190}-\u{27BF}]/u.test(dash()));
// the ban covers the interface's own copy; seeded text is the user's spec.md, quoted verbatim
check('no em-dash in the interface copy', await (async () => {
  const fs = await import('node:fs');
  return ['app.js', 'graph.js', 'icons.js', 'index.html', 'style.css']
    .every((f) => !fs.readFileSync(new URL(f, import.meta.url), 'utf8').includes('\u2014'));
})());
// inline onclick handlers break document-level delegation — never reintroduce them
check('no inline onclick blocks event delegation', !/onclick=/.test(dash()));
check('manual session form removed', !has('data-action="add-session"') && !has('log one by hand'));

// expand
await fire('click', mk({ action: 'toggle-phase', id: c1 }));
check('empty blocks wait behind an add bar instead of filling the page',
  has('addbar') && !has('A note is a claim') && !has('Read only what the wall entitles'));
check('no build machinery anywhere', !dash().includes('break on purpose') &&
  !dash().includes('data-action="add-claim"') && !dash().includes('data-key="build"'));
check('spec.md prose is still shown, read only',
  has('from spec.md') && has('One script. One model call.') && !has('data-action="field"'));
for (const key of ['confusions', 'notes', 'sources', 'documents'])
  await fire('click', mk({ action: 'reveal', id: c1, key }));
check('asking for a block shows it', has('confusions') && has('note-title') && has('one line: what it changed'));
check('the sources block is named for links too', has('sources and links'));

// confusions now live inside the concept
await fire('keydown', input({ action: 'add-conf', id: c1, num: '01' }, 'why does the retry loop not converge'));
const conf = (await sql("SELECT * FROM confusions WHERE phase_num='01'"))[0];
check('confusion logged inside the concept', !!conf && has('why does the retry loop not converge'));
await fire('click', mk({ action: 'resolve-conf', id: conf.id }, { checked: true }));
stub('#edit-box').value = 'notes/tool-schemas.md';
await fire('click', mk({ action: 'save-resolution', id: conf.id }));
const conf2 = (await sql(`SELECT * FROM confusions WHERE id='${conf.id}'`))[0];
check('resolution kept, entry not deleted', conf2.resolved === 1 && conf2.resolution === 'notes/tool-schemas.md');
check('sessions, queue and parked moved to the side panel',
  !has('interest queue') && !has('parked registry') && drawer().includes('interest queue') &&
  drawer().includes('parked registry') && drawer().includes('sessions'));
check('rail is a roadmap > track tree on the left, concepts to its right',
  dash().indexOf('class="rail"') < dash().indexOf('data-key="concepts"') &&
  has('rm-head') && has('data-action="select-track"'));
check('tracks show their own done count', /data-action="select-track"[\s\S]{0,400}0\/5/.test(dash()));


// backup/restore belong to the sql tab, not the header
await fire('click', { closest: (sel) => (sel === '#tabs button' ? { dataset: { tab: 'sql' } } : null) });
const sqlTab = captured['#tab-sql'] || '';
check('backup/restore moved into the sql tab',
  sqlTab.includes('data-action="backup"') && sqlTab.includes('data-action="restore"'));
const exported = await (await globalThis.fetch('/api/export')).json();
check('backup export returns every table', Object.keys(exported).length === 12 && exported.phases.length === 5);
await fire('click', { closest: (sel) => (sel === '#tabs button' ? { dataset: { tab: 'dashboard' } } : null) });

// notes: title and body, nothing else
await fire('click', mk({ action: 'new-note', phase: c1 }));
check('the note editor is a title and a body', has('note-title') && has('note-body') && !has('tag-note'));
stub('#note-title').value = 'the schema is a contract the model breaks';
stub('#note-body').value = 'feed errors back into the loop instead of throwing';
await fire('click', mk({ action: 'save-note', id: 'new', phase: c1 }));
const note = (await sql('SELECT * FROM notes'))[0];
check('a new note is filed against the concept it was written in', !!note && note.phase_ids === c1);
check('note body rendered under its claim', has('feed errors back into the loop'));
// notes tagged to several concepts still exist in the data; editing must not drop them
await sql(`UPDATE notes SET phase_ids='${c1},${c2}' WHERE id='${note.id}'`);
await fire('click', mk({ action: 'edit-note', id: note.id, phase: c1 }));
stub('#note-title').value = 'the schema is a contract the model breaks';
stub('#note-body').value = 'feed errors back into the loop instead of throwing';
await fire('click', mk({ action: 'save-note', id: note.id, phase: c1 }));
check('editing a multi-concept note keeps its other concepts',
  (await sql(`SELECT phase_ids FROM notes WHERE id='${note.id}'`))[0].phase_ids === `${c1},${c2}`);

// sources are per concept
stub(`#sr-url-${c1}`).value = 'https://example.com/tools';
stub(`#sr-note-${c1}`).value = '';
await fire('click', mk({ action: 'add-source', id: c1 }));
check('source without the one line rejected', (await sql('SELECT count(*) c FROM sources'))[0].c === 0);
stub(`#sr-note-${c1}`).value = 'made me stop throwing on tool errors';
await fire('click', mk({ action: 'add-source', id: c1 }));
const src = (await sql('SELECT * FROM sources'))[0];
check('source attached to the concept', src && src.phase_id === c1);

// document upload
const file = new File([Buffer.from('traceback: boom\n')], 'trace.log', { type: 'text/plain' });
await fire('change', mk({ action: 'upload', id: c1 }, { files: [file] }));
await wait(500);
const doc = (await sql('SELECT * FROM docs'))[0];
check('file uploaded and attached to the concept', doc && doc.phase_id === c1 && doc.size === 16);
const served = await globalThis.fetch('/files/' + encodeURIComponent(doc.stored));
check('uploaded file is served back', served.status === 200 && (await served.text()).startsWith('traceback'));
check('document listed in the concept', has('trace.log'));

// session timer
await fire('click', mk({ action: 'start-timer', id: c1 }));
check('timer starts and shows a countdown', has('timer-count') && !!JSON.parse(store['lt-timer'] || 'null'));
check('every concept row can start its own session',
  (dash().match(/data-action="start-timer"/g) || []).length >= 4);
check('the running concept offers stop in its row',
  /data-action="stop-timer"[\s\S]{0,400}timer-count/.test(dash()));
check('starting a session moves the concept to building', (await sql(`SELECT status FROM concepts WHERE id='${c1}'`))[0].status === 'building');
check('rail marks the track holding live work', /class="live"/.test(dash()));
stub('#timer-note').value = 'wired the first tool call';
await fire('click', mk({ action: 'stop-timer' }));
const sess = (await sql('SELECT * FROM sessions'))[0];
check('stopping logs a session automatically', sess && sess.phase_num === '01' && sess.note === 'wired the first tool call' && sess.minutes >= 1);
check('timer cleared after stop', !store['lt-timer']);

// drag to reorder
const before = (await sql('SELECT num FROM concepts ORDER BY pos')).map((r) => r.num).join(',');
const handle = { dataset: { drag: c1 }, closest: (s) => (s === '[data-drag]' ? handle : { classList: { add() {}, remove() {} } }) };
await fire('dragstart', handle, { dataTransfer: { effectAllowed: '', setData() {}, types: [] } });
const targetCard = {
  dataset: { card: c2 }, offsetHeight: 40,
  getBoundingClientRect: () => ({ top: 0 }),
  classList: { add() {}, remove() {} },
};
const dropTarget = { closest: (s) => (s === '.dropzone' ? null : targetCard) };
await fire('drop', dropTarget, { clientY: 100, dataTransfer: { types: [], files: [] } });
const after = (await sql('SELECT num FROM concepts ORDER BY pos')).map((r) => r.num).join(',');
check(`drag reorder moved 01 after 02 (${before} → ${after})`, after.startsWith('02,01'));

// closing is now just the checkbox: no exit lists to satisfy
await fire('click', mk({ action: 'done', id: c1 }, { checked: true }));
check('the checkbox closes a concept outright', (await sql(`SELECT status FROM concepts WHERE id='${c1}'`))[0].status === 'closed');
await fire('click', mk({ action: 'done', id: c1 }, { checked: false }));
check('unticking reopens it', (await sql(`SELECT status FROM concepts WHERE id='${c1}'`))[0].status === 'not started');

// ---- hierarchy: roadmaps > tracks > concepts ----
await sql("INSERT INTO roadmaps VALUES ('rm-2','Imported roadmap','',1)");
await sql("INSERT INTO tracks VALUES ('tr-2','rm-2','5','Inference & GPU',0)");
await sql("INSERT INTO phases (id,num,name,status,gate,build,verify_txt,wall,earned,pos,track_id,hours,practical)"
  + " VALUES ('k-I3','I3','KV cache mechanics','not started','','','','','',0,'tr-2',3.0,'compute the cache for a 7B model')");
await fire('click', mk({ action: 'select-track', id: 'tr-2' }));
check('selecting a track swaps the concepts column', has('KV cache mechanics') && !has('tool-calling'));
await fire('click', mk({ action: 'toggle-phase', id: 'k-I3' }));
check('opening a light concept shows its checkpoint, with no label above it',
  has('compute the cache for a 7B model') && !dash().includes('practical checkpoint'));
check('every concept row carries a youtube search for itself',
  /class="btn quiet yt"[^>]*youtube\.com\/results\?search_query=KV%20cache%20mechanics/.test(dash()));
check('no status control anywhere', !dash().includes('data-action="status"') && !drawer().includes('data-action="status"'));
check('no next-action instruction copy', !dash().includes('Not read. One concrete thing'));
check('a short name borrows its track for context', await (async () => {
  await sql("INSERT INTO phases (id,num,name,status,gate,build,verify_txt,wall,earned,pos,track_id)"
    + " VALUES ('k-short','R7','Reranking','not started','','','','','',9,'tr-2')");
  await fire('click', mk({ action: 'toggle-phase', id: 'k-short' }));
  const ok = has('search_query=Reranking%20Inference%20%26%20GPU');
  await sql("DELETE FROM phases WHERE id='k-short'");
  await fire('click', mk({ action: 'toggle-phase', id: 'k-I3' }));   // leave the fixture as we found it
  return ok;
})());
check('a light concept hides an empty gate', !/KV cache[\s\S]{0,600}>gate</.test(dash()));
await fire('click', mk({ action: 'unreveal', id: 'k-I3', key: 'build' }));
check('a mistaken click can be put away again', !/KV cache[\s\S]*?break on purpose/.test(dash()));
await fire('click', mk({ action: 'reveal', id: 'k-I3', key: 'notes' }));
check('an opened empty block offers to close itself', /data-action="unreveal"[^>]*data-key="notes"/.test(dash()));
check('opening notes lands you in the editor, not on another button',
  has('note-title') && has('note-body') && has('data-action="save-note"'));
await fire('click', mk({ action: 'cancel-edit' }));
await fire('click', mk({ action: 'reveal', id: 'k-I3', key: 'confusions' }));
check('the other blocks still open onto their own input', has('conf-k-I3'));
await fire('click', mk({ action: 'done', id: 'k-I3' }, { checked: true }));
check('ticking a light concept closes it without the exit-list rule',
  (await sql("SELECT status FROM phases WHERE id='k-I3'"))[0].status === 'closed');
check('graph is scoped to the selected track',
  (await (async () => { await fire('click', mk({ action: 'set-view', view: 'graph' }));
    const only = has('KV cache') && !has('tool-calling'); 
    await fire('click', mk({ action: 'set-view', view: 'list' })); return only; })()));
await fire('click', mk({ action: 'select-track', id: 'tr-spec' }));

// ---- graph view ----
const { topoOrder, edgePath, autoPos, mountGraph } = await import(new URL('./graph.js', import.meta.url).href);

// mountGraph: a port drag onto another node must create an edge. Pointer capture
// makes evt.target the <svg>, so this only works via point hit-testing.
{
  const handlers = {};
  const mkNode = (id) => {
    const n = { dataset: { node: id }, classList: { add() {}, remove() {} }, setAttribute() {} };
    n.closest = (sel) => (sel === '.gnode' ? n : sel === '.port' ? n.port : null);
    return n;
  };
  const A = mkNode('A'), B = mkNode('B');
  A.port = { tag: 'port' };
  const svg = {
    ownerDocument: { elementFromPoint: (x) => (x > 500 ? B : A) },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620 }),
    querySelectorAll: () => [],
    querySelector: () => ({ setAttribute() {} }),
    addEventListener: (t, f) => (handlers[t] = f),
    setPointerCapture() {}, releasePointerCapture() {},
  };
  const nodes = [
    { id: 'A', x: 0, y: 0, breaks: [], status: 'not started', num: '01', name: 'a' },
    { id: 'B', x: 0, y: 200, breaks: [], status: 'not started', num: '02', name: 'b' },
  ];
  let linked = null, moved = null;
  mountGraph(svg, nodes, [], { onLink: (f, t) => (linked = f + '->' + t), onMove: (id, x) => (moved = id) });

  handlers.pointerdown({ target: A, clientX: 100, clientY: 62, pointerId: 1 });
  handlers.pointermove({ clientX: 600, clientY: 200, pointerId: 1 });
  handlers.pointerup({ clientX: 600, clientY: 200, pointerId: 1, target: svg });
  check('dragging from a port onto another node creates the edge', linked === 'A->B');

  A.port = null;  // body drag, not the port
  handlers.pointerdown({ target: A, clientX: 50, clientY: 31, pointerId: 2 });
  handlers.pointermove({ clientX: 120, clientY: 200, pointerId: 2 });
  handlers.pointerup({ clientX: 120, clientY: 200, pointerId: 2, target: svg });
  check('dragging a node body saves its new position', moved === 'A');
}
const fake = (id, i) => ({ id, breaks: [], status: 'not started', num: id, name: id, x: null, y: null });
const P = ['a', 'b', 'c'].map(fake);
check('topo sort keeps list order when there are no edges',
  topoOrder(P, []).order.join('') === 'abc');
check('topo sort moves a prerequisite ahead of its dependent, disturbing nothing else',
  topoOrder(P, [{ id: 'e', from_id: 'c', to_id: 'a' }]).order.join('') === 'bca');
check('topo sort reports a cycle instead of guessing',
  topoOrder(P, [{ id: '1', from_id: 'a', to_id: 'b' }, { id: '2', from_id: 'b', to_id: 'a' }]).cycle === true);
check('tidy layout stacks nodes in one vertical column',
  autoPos(0).x === autoPos(3).x && autoPos(1).y > autoPos(0).y && autoPos(3).y > autoPos(1).y);
check('edges leave the bottom of a node and arrive at the top of the next',
  edgePath({ x: 0, y: 0 }, { x: 0, y: 120 }).startsWith('M 100 62') &&
  edgePath({ x: 0, y: 0 }, { x: 0, y: 120 }).endsWith('100 120'));

await fire('click', mk({ action: 'set-view', view: 'graph' }));
check('graph view renders nodes, ports and the order badge',
  has('id="graph"') && has('class="port"') && has('gordertext') && has('data-node='));

// 05 → 03: list order is 02,01,03,04,05, so 03's list-predecessor is 01.
// Gating naming 05 can only come from the edge, not from list position.
const c3 = (await sql("SELECT id FROM concepts WHERE num='03'"))[0].id;
const c5 = (await sql("SELECT id FROM concepts WHERE num='05'"))[0].id;
await sql(`INSERT INTO edges VALUES ('e-test', '${c5}', '${c3}')`);
await fire('click', mk({ action: 'set-view', view: 'list' }));
check('gating follows the graph, not list position', has('gated: 05 is not closed'));

await sql("DELETE FROM edges WHERE id = 'e-test'");
await fire('click', mk({ action: 'set-view', view: 'list' }));
check('deleting the edge releases the gate', !has('gated: 05 is not closed'));

await sql(`INSERT INTO edges VALUES ('e-test2', '${c5}', '${c3}')`);
await fire('click', mk({ action: 'apply-order' }));
const ord = (await sql('SELECT num FROM concepts ORDER BY pos')).map((r) => r.num);
check(`drawing 05 → 03 reorders concepts (${ord.join(',')})`, ord.indexOf('05') < ord.indexOf('03'));

// ---- importing a roadmap from markdown (the model call is stubbed) ----
const md = '# Distributed Systems\n## Consensus\n- C1 Raft leader election (2h)\n';
const parsed = await (await globalThis.fetch('/api/import-parse', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ markdown: md }) })).json();
check('the document names the roadmap, not the filename', parsed.proposal.name === 'Distributed Systems');
check('a markdown file becomes a roadmap proposal',
  parsed.ok && parsed.proposal.name === 'Distributed Systems' &&
  parsed.proposal.tracks.length === 2 && parsed.proposal.concepts === 3 && parsed.proposal.hours === 6.5);

const bad = await (await globalThis.fetch('/api/import-commit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ proposal: { name: 'x', tracks: [{ title: 't', concepts: [{ name: '' }] }] } }) })).json();
check('a proposal with nothing usable is refused', !!bad.error);

const roadmapsBefore = (await sql('SELECT count(*) c FROM roadmaps'))[0].c;
await fire('change', mk({ action: 'import-file' }, { files: [new File([Buffer.from(md)], 'roadmap.md', { type: 'text/markdown' })], value: '' }));
await wait(1500);
check('the file is previewed, not imported', has('Nothing is written until you press import') &&
  has('Distributed Systems') && (await sql('SELECT count(*) c FROM roadmaps'))[0].c === roadmapsBefore);
await fire('click', mk({ action: 'import-cancel' }));
check('cancel writes nothing', (await sql('SELECT count(*) c FROM roadmaps'))[0].c === roadmapsBefore);

await fire('change', mk({ action: 'import-file' }, { files: [new File([Buffer.from(md)], 'roadmap.md', { type: 'text/markdown' })], value: '' }));
await wait(1500);
await fire('click', mk({ action: 'import-commit' }));
await wait(1200);
const imported = (await sql("SELECT id FROM roadmaps WHERE name='Distributed Systems'"))[0];
check('importing writes the roadmap, its tracks and its concepts', !!imported &&
  (await sql(`SELECT count(*) c FROM tracks WHERE roadmap_id='${imported.id}'`))[0].c === 2 &&
  (await sql("SELECT count(*) c FROM phases WHERE num='C1'"))[0].c === 1);
const c1row = (await sql("SELECT hours, practical FROM phases WHERE num='C1'"))[0];
check('hours and the checkpoint text come across', c1row.hours === 2 && !!c1row.practical);
await globalThis.fetch('/api/delete-roadmap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: imported.id }) });

// ---- deleting a roadmap cascades, and stops at the roadmap's own edge ----
await sql("INSERT INTO roadmaps VALUES ('rm-x','Doomed','',9)");
await sql("INSERT INTO tracks VALUES ('tr-x','rm-x','1','only track',0)");
await sql("INSERT INTO phases (id,num,name,status,gate,build,verify_txt,wall,earned,pos,track_id)"
  + " VALUES ('k-x1','X1','doomed concept','not started','','','','','',0,'tr-x')");
await sql("INSERT INTO breaks VALUES ('b-x1','k-x1','a failure',0,0,NULL)");
await sql("INSERT INTO claims VALUES ('cl-x1','k-x1','can','a claim','2026-01-01')");
await sql("INSERT INTO sources VALUES ('s-x1','https://x','changed my mind','2026-01-01','k-x1')");
await sql("INSERT INTO edges VALUES ('e-x1','k-x1','k-x1')");
await sql("INSERT INTO confusions VALUES ('cf-x1','doomed confusion','X1','2026-01-01',0,NULL)");
await sql("INSERT INTO sessions VALUES ('se-x1','2026-01-01','X1','build',30,'doomed session')");
// one note spans both roadmaps, one belongs only to the doomed concept
await sql(`INSERT INTO notes VALUES ('n-shared','shared claim','','${c1},k-x1','2026-01-01','2026-01-01')`);
await sql("INSERT INTO notes VALUES ('n-only','doomed claim','','k-x1','2026-01-01','2026-01-01')");

const upload = new File([Buffer.from('doomed bytes')], 'doomed.log', { type: 'text/plain' });
await fire('change', mk({ action: 'upload', id: 'k-x1' }, { files: [upload] }));
await wait(400);
const doomedDoc = (await sql("SELECT stored FROM docs WHERE phase_id='k-x1'"))[0];
check('setup: the doomed roadmap has a file on disk',
  !!doomedDoc && (await globalThis.fetch('/files/' + encodeURIComponent(doomedDoc.stored))).status === 200);

await fire('click', mk({ action: 'del-roadmap', id: 'rm-x' }));
check('the roadmap delete control can actually appear', await (async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('style.css', import.meta.url), 'utf8');
  const reveal = css.slice(css.indexOf('.iconbtn:focus-visible') - 400, css.indexOf('.iconbtn:focus-visible'));
  return reveal.includes('.rm-head:hover .iconbtn');
})());
check('the drawer close button gets a glyph', (nodes['#drawer .drawer-head .iconbtn']?.innerHTML || '').includes('<svg'));
check('delete asks first, naming what goes',
  dash().includes('rm-confirm') && dash().includes('Doomed') && dash().includes('tracker/trash/'));
await fire('click', mk({ action: 'cancel-del-roadmap' }));
check('cancel leaves the roadmap alone', (await sql("SELECT count(*) c FROM roadmaps WHERE id='rm-x'"))[0].c === 1);

await fire('click', mk({ action: 'del-roadmap', id: 'rm-x' }));
await fire('click', mk({ action: 'confirm-del-roadmap', id: 'rm-x' }));
const gone = async (q) => (await sql(q))[0].c === 0;
check('roadmap, its tracks and concepts are gone',
  await gone("SELECT count(*) c FROM roadmaps WHERE id='rm-x'") &&
  await gone("SELECT count(*) c FROM tracks WHERE roadmap_id='rm-x'") &&
  await gone("SELECT count(*) c FROM phases WHERE track_id='tr-x'"));
check('everything attached to those concepts goes with them',
  await gone("SELECT count(*) c FROM breaks WHERE phase_id='k-x1'") &&
  await gone("SELECT count(*) c FROM claims WHERE phase_id='k-x1'") &&
  await gone("SELECT count(*) c FROM sources WHERE phase_id='k-x1'") &&
  await gone("SELECT count(*) c FROM edges WHERE from_id='k-x1'") &&
  await gone("SELECT count(*) c FROM docs WHERE phase_id='k-x1'") &&
  await gone("SELECT count(*) c FROM confusions WHERE id='cf-x1'") &&
  await gone("SELECT count(*) c FROM sessions WHERE id='se-x1'"));
check('a snapshot is written before anything is deleted', await (async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'trash');
  if (!fs.existsSync(dir)) return false;
  const newest = fs.readdirSync(dir).filter((f) => f.includes('Doomed')).sort().pop();
  if (!newest) return false;
  const snap = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
  fs.rmSync(path.join(dir, newest));
  return snap.roadmap[0].name === 'Doomed' && snap.phases.length === 1 &&
         snap.breaks.length === 1 && snap.sessions.length === 1 && snap.docs.length === 1;
})());
check('the uploaded file is removed from disk',
  (await globalThis.fetch('/files/' + encodeURIComponent(doomedDoc.stored))).status === 404);
const shared = (await sql("SELECT phase_ids FROM notes WHERE id='n-shared'"))[0];
check('a note shared with another roadmap survives, minus the tag',
  !!shared && shared.phase_ids === c1 && await gone("SELECT count(*) c FROM notes WHERE id='n-only'"));
check('the other roadmap is untouched',
  (await sql("SELECT count(*) c FROM phases WHERE track_id='tr-spec'"))[0].c === 5 &&
  (await sql(`SELECT count(*) c FROM breaks WHERE phase_id='${c1}'`))[0].c > 0);

console.log(`\ndashboard bytes: ${dash().length} | leaks: ${/undefined|NaN|\[object Object\]/.test(dash())}`);
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
