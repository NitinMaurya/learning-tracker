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
const has = (s) => dash().includes(s);
let failures = 0;
const check = (label, cond) => { if (!cond) failures++; console.log((cond ? '  ok  ' : ' FAIL ') + label); };

const c1 = (await sql("SELECT id FROM concepts WHERE num='01'"))[0].id;
const c2 = (await sql("SELECT id FROM concepts WHERE num='02'"))[0].id;

check('renders concepts, not phases', has('concept 01') && !/>phases</.test(dash()));
check('analytics stat strip is gone', !has('class="stats"'));
// inline onclick handlers break document-level delegation — never reintroduce them
check('no inline onclick blocks event delegation', !/onclick=/.test(dash()));
check('manual session form removed', !has('data-action="add-session"') && !has('log one by hand'));

// expand
await fire('click', mk({ action: 'toggle-phase', id: c1 }));
check('concept expands with all sections', has('break on purpose') && has('confusions') && has('notes') && has('sources') && has('documents'));

// breaks + trace
const b1 = (await sql(`SELECT id FROM breaks WHERE phase_id='${c1}' ORDER BY pos`))[0].id;
await fire('click', mk({ action: 'break', id: b1, phase: c1 }, { checked: true }));
await fire('click', mk({ action: 'edit-trace', id: b1 }));
stub('#edit-box').value = 'ValidationError: city';
await fire('click', mk({ action: 'save-trace', id: b1, phase: c1 }));
check('break + trace persist', (await sql(`SELECT done, trace FROM breaks WHERE id='${b1}'`))[0].trace === 'ValidationError: city');

// confusions now live inside the concept
await fire('keydown', input({ action: 'add-conf', id: c1, num: '01' }, 'why does the retry loop not converge'));
const conf = (await sql("SELECT * FROM confusions WHERE phase_num='01'"))[0];
check('confusion logged inside the concept', !!conf && has('why does the retry loop not converge'));
await fire('click', mk({ action: 'resolve-conf', id: conf.id }, { checked: true }));
stub('#edit-box').value = 'notes/tool-schemas.md';
await fire('click', mk({ action: 'save-resolution', id: conf.id }));
const conf2 = (await sql(`SELECT * FROM confusions WHERE id='${conf.id}'`))[0];
check('resolution kept, entry not deleted', conf2.resolved === 1 && conf2.resolution === 'notes/tool-schemas.md');
const drawer = () => captured['#drawer-body'] || '';
check('sessions, queue and parked moved to the side panel',
  !has('interest queue') && !has('parked registry') && drawer().includes('interest queue') &&
  drawer().includes('parked registry') && drawer().includes('sessions'));
check('progress sits in the left rail, concepts to its right',
  dash().indexOf('class="rail"') < dash().indexOf('data-key="concepts"') &&
  has('rail-list') && !has('<th>wall hit?</th>'));
check('rail entries link to their concept', /class="row-link[^"]*" data-action="open-phase"/.test(dash()));
check('rail shows names only — no pills, bars or counts inside it',
  !/rail-list[\s\S]{0,900}(class="pill|class="bar|✓)/.test(dash()));

// backup/restore belong to the sql tab, not the header
await fire('click', { closest: (sel) => (sel === '#tabs button' ? { dataset: { tab: 'sql' } } : null) });
const sqlTab = captured['#tab-sql'] || '';
check('backup/restore moved into the sql tab',
  sqlTab.includes('data-action="backup"') && sqlTab.includes('data-action="restore"'));
const exported = await (await globalThis.fetch('/api/export')).json();
check('backup export returns every table', Object.keys(exported).length === 10 && exported.phases.length === 5);
await fire('click', { closest: (sel) => (sel === '#tabs button' ? { dataset: { tab: 'dashboard' } } : null) });

// notes, tagged across concepts
await fire('click', mk({ action: 'new-note', phase: c1 }));
stub('#note-title').value = 'the schema is a contract the model breaks';
stub('#note-body').value = 'feed errors back into the loop instead of throwing';
await fire('click', mk({ action: 'tag-note', id: c2 }));
await fire('click', mk({ action: 'save-note', id: 'new', phase: c1 }));
const note = (await sql('SELECT * FROM notes'))[0];
check('note saved with multi-concept tags', !!note && note.phase_ids.includes(c1) && note.phase_ids.includes(c2));
check('note body rendered under its claim', has('feed errors back into the loop'));

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
check('timer starts and shows a countdown', has('timer-count') && !!JSON.parse(store['ai-lab-timer'] || 'null'));
check('starting a session moves the concept to building', (await sql(`SELECT status FROM concepts WHERE id='${c1}'`))[0].status === 'building');
check('rail highlights the concept being worked on, with a running-timer mark',
  /<li class="row-link now[^"]*"[^>]*>[\s\S]{0,200}railtimer/.test(dash()));
stub('#timer-note').value = 'wired the first tool call';
await fire('click', mk({ action: 'stop-timer' }));
const sess = (await sql('SELECT * FROM sessions'))[0];
check('stopping logs a session automatically', sess && sess.phase_num === '01' && sess.note === 'wired the first tool call' && sess.minutes >= 1);
check('timer cleared after stop', !store['ai-lab-timer']);

// exit lists + close rule
await fire('keydown', input({ action: 'add-claim', kind: 'can', id: c1 }, 'the schema is a contract'));
await fire('keydown', input({ action: 'add-claim', kind: 'cannot', id: c1 }, 'why validation retries loop'));
check('cannot-claim also files a confusion', (await sql("SELECT count(*) c FROM confusions WHERE text='why validation retries loop'"))[0].c === 1);
const selBad = mk({ action: 'status', id: c2 }, { value: 'closed' });
await fire('change', selBad);
check('close refused with empty exit lists', (await sql(`SELECT status FROM concepts WHERE id='${c2}'`))[0].status === 'not started');
const selOk = mk({ action: 'status', id: c1 }, { value: 'closed' });
await fire('change', selOk);
check('close allowed once both lists filled', (await sql(`SELECT status FROM concepts WHERE id='${c1}'`))[0].status === 'closed');

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
check('gating follows the graph, not list position', has('gated · concept 05'));

await sql("DELETE FROM edges WHERE id = 'e-test'");
await fire('click', mk({ action: 'set-view', view: 'list' }));
check('deleting the edge releases the gate', !has('gated · concept 05'));

await sql(`INSERT INTO edges VALUES ('e-test2', '${c5}', '${c3}')`);
await fire('click', mk({ action: 'apply-order' }));
const ord = (await sql('SELECT num FROM concepts ORDER BY pos')).map((r) => r.num);
check(`drawing 05 → 03 reorders concepts (${ord.join(',')})`, ord.indexOf('05') < ord.indexOf('03'));

console.log(`\ndashboard bytes: ${dash().length} | leaks: ${/undefined|NaN|\[object Object\]/.test(dash())}`);
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
