// Concept graph: draggable nodes, prerequisite edges, and the ordering they imply.
//
// An edge A → B means "A is a prerequisite of B". The concept order is a
// topological sort of that graph, so drawing edges is how you decide the path.

export const NODE_W = 200;
export const NODE_H = 62;
export const GAP_Y = 58;
export const VIEW_W = 900;
export const COL_X = Math.round((VIEW_W - NODE_W) / 2);

/** The canvas grows with the number of concepts; the path reads downward. */
export const viewH = (n) => Math.max(620, 60 + n * (NODE_H + GAP_Y));

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Default position: one vertical column, in order. Drag sideways to branch. */
export function autoPos(i) {
  return { x: COL_X, y: 40 + i * (NODE_H + GAP_Y) };
}

export const posOf = (p, i) =>
  p.x === null || p.x === undefined || p.y === null || p.y === undefined ? autoPos(i) : { x: p.x, y: p.y };

/**
 * Kahn's algorithm. Ties break on the concept's current pos, so a graph with no
 * edges leaves the order exactly as it is. Returns {order, cycle}.
 */
export function topoOrder(phases, edges) {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const indeg = new Map(phases.map((p) => [p.id, 0]));
  const out = new Map(phases.map((p) => [p.id, []]));

  for (const e of edges) {
    if (!byId.has(e.from_id) || !byId.has(e.to_id)) continue;
    out.get(e.from_id).push(e.to_id);
    indeg.set(e.to_id, indeg.get(e.to_id) + 1);
  }

  const rank = new Map(phases.map((p, i) => [p.id, i]));
  const ready = phases.filter((p) => indeg.get(p.id) === 0).map((p) => p.id);
  const order = [];

  while (ready.length) {
    ready.sort((a, b) => rank.get(a) - rank.get(b));
    const id = ready.shift();
    order.push(id);
    for (const next of out.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) ready.push(next);
    }
  }

  const cycle = order.length !== phases.length;
  return { order: cycle ? phases.map((p) => p.id) : order, cycle };
}

/** Cubic bezier from the bottom port of `a` down to the top edge of `b`. */
export function edgePath(a, b) {
  const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
  const x2 = b.x + NODE_W / 2, y2 = b.y;
  const dy = Math.max(34, Math.abs(y2 - y1) * 0.45);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

export function graphHtml(phases, edges) {
  const { order, cycle } = topoOrder(phases, edges);
  const rank = new Map(order.map((id, i) => [id, i + 1]));
  const pos = new Map(phases.map((p, i) => [p.id, posOf(p, i)]));

  const edgeSvg = edges
    .filter((e) => pos.has(e.from_id) && pos.has(e.to_id))
    .map(
      (e) => `<g class="gedge" data-edge="${e.id}">
        <path class="hit" d="${edgePath(pos.get(e.from_id), pos.get(e.to_id))}" />
        <path class="line" d="${edgePath(pos.get(e.from_id), pos.get(e.to_id))}" marker-end="url(#arrow)" />
      </g>`
    )
    .join('');

  const nodeSvg = phases
    .map((p) => {
      const { x, y } = pos.get(p.id);
      const done = p.breaks.filter((b) => b.done).length;
      return `<g class="gnode ${p.status.replace(' ', '-')}" data-node="${p.id}" transform="translate(${x},${y})">
        <rect class="gbox" width="${NODE_W}" height="${NODE_H}" rx="10" />
        <circle class="gorder" cx="0" cy="0" r="11" />
        <text class="gordertext" x="0" y="4" text-anchor="middle">${rank.get(p.id) ?? '?'}</text>
        <text class="gnum" x="14" y="24">${esc(p.num)}</text>
        <text class="gname" x="36" y="24">${esc(p.name.slice(0, 20))}</text>
        <text class="gmeta" x="14" y="44">${esc(p.status)} · ${done}/${p.breaks.length} broken</text>
        <circle class="port" cx="${NODE_W / 2}" cy="${NODE_H}" r="7">
          <title>drag down to a concept this one unlocks</title>
        </circle>
      </g>`;
    })
    .join('');

  return `
    ${cycle ? '<div class="warnbox">These edges form a cycle. Order is left unchanged until you remove one.</div>' : ''}
    <div class="graph-wrap">
      <svg id="graph" width="${VIEW_W}" height="${viewH(phases.length)}"
           viewBox="0 0 ${VIEW_W} ${viewH(phases.length)}" preserveAspectRatio="xMinYMin meet">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <g id="gedges">${edgeSvg}</g>
        <g id="gnodes">${nodeSvg}</g>
        <path id="linkline" d="" />
      </svg>
    </div>
    <div class="row wrap" style="margin-top:12px;align-items:flex-start;gap:12px">
      <p class="note" style="flex:1">Drag a node to move it. Drag from its bottom dot onto another concept to say
        <em>this one comes first</em>. Click an edge to delete it, double-click a node to open it. The number is the
        position the graph puts it in: concepts reorder to match, and each one is gated on its own prerequisites.</p>
      <button class="btn" data-action="auto-layout">tidy layout</button>
    </div>`;
}

/**
 * Wire pointer interactions onto a freshly rendered <svg>. Listeners die with
 * the element on the next render, so there is nothing to tear down.
 * ctx: { onMove(id,x,y), onLink(fromId,toId), onDeleteEdge(id), onOpen(id) }
 */
export function mountGraph(svg, phases, edges, ctx) {
  if (!svg || !svg.getBoundingClientRect) return;

  const H = viewH(phases.length);
  const pos = new Map(phases.map((p, i) => [p.id, { ...posOf(p, i) }]));
  const edgeEls = [...svg.querySelectorAll('.gedge')];
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const linkline = svg.querySelector('#linkline');

  const toSvg = (evt) => {
    const r = svg.getBoundingClientRect();
    return {
      x: ((evt.clientX - r.left) / r.width) * VIEW_W,
      y: ((evt.clientY - r.top) / r.height) * H,
    };
  };

  const redrawEdgesFor = (id) => {
    for (const el of edgeEls) {
      const e = edgeById.get(el.dataset.edge);
      if (!e || (e.from_id !== id && e.to_id !== id)) continue;
      const d = edgePath(pos.get(e.from_id), pos.get(e.to_id));
      el.querySelectorAll('path').forEach((p) => p.setAttribute('d', d));
    }
  };

  // Pointer capture makes evt.target the <svg> for every move/up, so the node
  // under the cursor has to be found by hit-testing the point.
  const nodeAt = (evt) => {
    const el = svg.ownerDocument?.elementFromPoint?.(evt.clientX, evt.clientY);
    return el?.closest?.('.gnode') || null;
  };
  const highlight = (node) => {
    svg.querySelectorAll('.gnode.link-target').forEach((n) => n.classList.remove('link-target'));
    node?.classList.add('link-target');
  };

  let drag = null;  // {id, el, dx, dy, moved}
  let link = null;  // {from}

  svg.addEventListener('pointerdown', (evt) => {
    const port = evt.target.closest('.port');
    const node = evt.target.closest('.gnode');
    if (!node) return;
    const id = node.dataset.node;
    const at = toSvg(evt);
    svg.setPointerCapture?.(evt.pointerId);

    if (port) {
      link = { from: id };
      linkline.setAttribute('class', 'active');
      return;
    }
    drag = { id, el: node, dx: at.x - pos.get(id).x, dy: at.y - pos.get(id).y, moved: false };
    node.classList.add('dragging');
  });

  svg.addEventListener('pointermove', (evt) => {
    const at = toSvg(evt);
    if (link) {
      const a = pos.get(link.from);
      linkline.setAttribute('d', `M ${a.x + NODE_W / 2} ${a.y + NODE_H} L ${at.x} ${at.y}`);
      const over = nodeAt(evt);
      highlight(over && over.dataset.node !== link.from ? over : null);
      return;
    }
    if (!drag) return;
    const x = Math.max(0, Math.min(VIEW_W - NODE_W, at.x - drag.dx));
    const y = Math.max(0, Math.min(H - NODE_H, at.y - drag.dy));
    pos.set(drag.id, { x, y });
    drag.el.setAttribute('transform', `translate(${x},${y})`);
    drag.moved = true;
    redrawEdgesFor(drag.id);
  });

  svg.addEventListener('pointerup', (evt) => {
    if (link) {
      const target = nodeAt(evt);
      highlight(null);
      linkline.setAttribute('class', '');
      linkline.setAttribute('d', '');
      svg.releasePointerCapture?.(evt.pointerId);
      const to = target?.dataset.node;
      const from = link.from;
      link = null;
      if (to && to !== from) ctx.onLink(from, to);
      return;
    }
    if (!drag) return;
    const { id, el, moved } = drag;
    svg.releasePointerCapture?.(evt.pointerId);
    el.classList.remove('dragging');
    drag = null;
    if (moved) ctx.onMove(id, pos.get(id).x, pos.get(id).y);
  });

  svg.addEventListener('click', (evt) => {
    const edge = evt.target.closest('.gedge');
    if (edge) ctx.onDeleteEdge(edge.dataset.edge);
  });

  svg.addEventListener('dblclick', (evt) => {
    const node = evt.target.closest('.gnode');
    if (node) ctx.onOpen(node.dataset.node);
  });
}
