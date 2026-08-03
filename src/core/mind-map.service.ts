import { dirname } from 'node:path';

import type { DecisionRecordRow } from './decision-record.repository.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import type { CodeMapNode, MindMapNodeDatum } from './types/code-map.types.js';

/**
 * `pup map --open` (docs/05): one self-contained local HTML file — inline CSS
 * and vanilla-JS force layout, no CDN — so the map opens offline and never
 * phones home. Node size encodes churn, fill encodes open debt (sequential
 * one-hue ramp, validated for both color schemes), edges point at dependencies.
 */
export function renderMindMapHtml(
  repoPath: string,
  nodes: CodeMapNode[],
  records: DecisionRecordRow[],
): string {
  const data = {
    repoPath,
    nodes: nodes.map((node): MindMapNodeDatum => {
      return {
        id: node.id,
        files: node.files,
        churn: node.churn,
        openDebt: node.openDebt,
        dependsOn: node.dependsOn,
        records: records
          .filter((record) =>
            (JSON.parse(record.files) as string[]).some((file) => moduleOf(file) === node.id),
          )
          .map((record) => ({
            id: record.id,
            summary: record.summary,
            createdAt: record.created_at,
          })),
      };
    }),
  };
  // `<` escaped so an id or summary containing `</script>` cannot break out of
  // the data block.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // Function replacer: a string replacement would have its $-patterns ($&, $',
  // $\`) expanded, splicing raw template text — including a real </script> —
  // into the escaped data block.
  return HTML_TEMPLATE.replace('__PUP_MAP_DATA__', () => json);
}

function moduleOf(file: string): string {
  const dir = dirname(file);
  return dir === '.' ? '(root)' : dir;
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pup map</title>
<style>
${PAGE_THEME_CSS}
  * { margin: 0; box-sizing: border-box; }
  body {
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page); color: var(--ink);
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  header {
    padding: 10px 16px; border-bottom: 1px solid var(--grid);
    display: flex; align-items: baseline; gap: 12px;
  }
  header h1 { font-size: 14px; font-weight: 600; }
  header .repo { color: var(--ink-2); font-size: 12px; }
  main { flex: 1; display: flex; min-height: 0; }
  #chart { flex: 1; position: relative; background: var(--surface); }
  #chart svg { width: 100%; height: 100%; display: block; cursor: grab; }
  .edge { stroke: var(--baseline); stroke-width: 1.2; fill: none; }
  .node circle { stroke: var(--surface); stroke-width: 2; cursor: pointer; }
  .node.selected circle { stroke: var(--ink); }
  .node text {
    fill: var(--ink-2); font-size: 11px; text-anchor: middle;
    pointer-events: none; user-select: none;
  }
  .debt-0 { fill: var(--debt-0); } .debt-1 { fill: var(--debt-1); }
  .debt-2 { fill: var(--debt-2); } .debt-3 { fill: var(--debt-3); }
  #legend {
    position: absolute; top: 12px; left: 12px; padding: 10px 12px;
    background: var(--page); border: 1px solid var(--border); border-radius: 6px;
    font-size: 11px; color: var(--ink-2); display: grid; gap: 6px;
  }
  #legend .row { display: flex; align-items: center; gap: 6px; }
  #legend .swatch { width: 10px; height: 10px; border-radius: 50%; }
  #tooltip {
    position: absolute; pointer-events: none; display: none; max-width: 260px;
    background: var(--page); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  }
  #tooltip .t-name { font-weight: 600; margin-bottom: 2px; }
  #tooltip .t-line { color: var(--ink-2); }
  aside {
    width: 320px; border-left: 1px solid var(--grid); padding: 14px 16px;
    overflow-y: auto; background: var(--page);
  }
  aside .hint { color: var(--muted); }
  aside h2 { font-size: 13px; word-break: break-all; margin-bottom: 8px; }
  aside .metrics { color: var(--ink-2); font-size: 12px; margin-bottom: 12px; }
  aside h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); margin: 12px 0 6px;
  }
  aside ul { list-style: none; }
  aside li { padding: 2px 0; font-size: 12px; word-break: break-all; color: var(--ink-2); }
  aside .rec { border-top: 1px solid var(--grid); padding: 6px 0; }
  aside .rec .when { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header><h1>pup map</h1><span class="repo" id="repo"></span></header>
<main>
  <div id="chart">
    <svg id="svg" role="img" aria-label="Module dependency map"></svg>
    <div id="legend">
      <div class="row"><strong>size</strong>&nbsp;commits (30d)</div>
      <div class="row"><span class="swatch" style="background:var(--debt-0)"></span>0 debt
        <span class="swatch" style="background:var(--debt-1)"></span>1
        <span class="swatch" style="background:var(--debt-2)"></span>2
        <span class="swatch" style="background:var(--debt-3)"></span>3+</div>
      <div class="row">arrow &rarr; depends on &middot; click a node for detail</div>
    </div>
    <div id="tooltip"></div>
  </div>
  <aside id="panel"><p class="hint">Click a module to see its files and decision records.</p></aside>
</main>
<script id="pup-map-data" type="application/json">__PUP_MAP_DATA__</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('pup-map-data').textContent);
  document.getElementById('repo').textContent = data.repoPath;
  const svg = document.getElementById('svg');
  const NS = 'http://www.w3.org/2000/svg';
  const W = svg.clientWidth || 900, H = svg.clientHeight || 600;
  let view = { x: 0, y: 0, w: W, h: H };
  const applyView = () => svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  applyView();

  const maxChurn = Math.max(1, ...data.nodes.map((n) => n.churn));
  const radius = (n) => 12 + 18 * Math.sqrt(n.churn / maxChurn);
  const debtClass = (n) => 'debt-' + Math.min(3, n.openDebt);
  const nodes = data.nodes.map((n, i) => ({
    ...n, r: radius(n),
    x: W / 2 + (W / 3) * Math.cos((2 * Math.PI * i) / data.nodes.length),
    y: H / 2 + (H / 3) * Math.sin((2 * Math.PI * i) / data.nodes.length),
    vx: 0, vy: 0,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = nodes.flatMap((n) => n.dependsOn.filter((d) => byId.has(d)).map((d) => [n, byId.get(d)]));

  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = '<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--baseline)"/></marker>';
  svg.appendChild(defs);
  const edgeGroup = document.createElementNS(NS, 'g');
  svg.appendChild(edgeGroup);
  const edgeEls = edges.map(() => {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', 'edge');
    line.setAttribute('marker-end', 'url(#arrow)');
    edgeGroup.appendChild(line);
    return line;
  });
  const nodeEls = nodes.map((n) => {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'node');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', n.r);
    c.setAttribute('class', debtClass(n));
    const t = document.createElementNS(NS, 'text');
    t.textContent = n.id;
    g.appendChild(c); g.appendChild(t);
    svg.appendChild(g);
    g.addEventListener('click', (e) => { e.stopPropagation(); select(n, g); });
    c.addEventListener('mousemove', (e) => tooltip(n, e));
    c.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    dragify(g, n);
    return g;
  });

  function draw() {
    edges.forEach(([a, b], i) => {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      edgeEls[i].setAttribute('x1', a.x + (dx / len) * a.r);
      edgeEls[i].setAttribute('y1', a.y + (dy / len) * a.r);
      edgeEls[i].setAttribute('x2', b.x - (dx / len) * (b.r + 4));
      edgeEls[i].setAttribute('y2', b.y - (dy / len) * (b.r + 4));
    });
    nodes.forEach((n, i) => {
      nodeEls[i].setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
      nodeEls[i].querySelector('text').setAttribute('y', n.r + 14);
    });
  }

  let heat = 1;
  function tick() {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = Math.max(100, dx * dx + dy * dy);
        const f = 2600 / d2;
        a.vx += (dx / Math.sqrt(d2)) * f; a.vy += (dy / Math.sqrt(d2)) * f;
      }
      a.vx += (W / 2 - a.x) * 0.004; a.vy += (H / 2 - a.y) * 0.004;
    }
    for (const [a, b] of edges) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 150) * 0.06;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.x += n.vx * heat * 0.02; n.y += n.vy * heat * 0.02;
      n.vx *= 0.6; n.vy *= 0.6;
    }
    heat *= 0.995;
    draw();
    if (heat > 0.02) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  const tip = document.getElementById('tooltip');
  function tooltip(n, e) {
    const rect = svg.getBoundingClientRect();
    tip.innerHTML = '<div class="t-name"></div><div class="t-line"></div>';
    tip.querySelector('.t-name').textContent = n.id;
    tip.querySelector('.t-line').textContent =
      n.files.length + ' files \\u00b7 churn ' + n.churn + ' \\u00b7 ' + n.openDebt + ' open debt';
    tip.style.display = 'block';
    tip.style.left = e.clientX - rect.left + 14 + 'px';
    tip.style.top = e.clientY - rect.top + 14 + 'px';
  }

  const panel = document.getElementById('panel');
  function select(n, g) {
    document.querySelectorAll('.node.selected').forEach((el) => el.classList.remove('selected'));
    g.classList.add('selected');
    panel.innerHTML = '<h2></h2><div class="metrics"></div><h3>Files</h3><ul></ul>' +
      '<h3>Decision records</h3><div id="recs"></div>';
    panel.querySelector('h2').textContent = n.id;
    panel.querySelector('.metrics').textContent =
      n.files.length + ' files \\u00b7 churn ' + n.churn + ' (30d) \\u00b7 open debt ' + n.openDebt +
      ' \\u00b7 depends on ' + (n.dependsOn.join(', ') || 'nothing');
    const ul = panel.querySelector('ul');
    for (const f of n.files) { const li = document.createElement('li'); li.textContent = f; ul.appendChild(li); }
    const recs = panel.querySelector('#recs');
    if (!n.records.length) { recs.innerHTML = '<p class="hint">None touch this module.</p>'; }
    for (const r of n.records) {
      const div = document.createElement('div');
      div.className = 'rec';
      const when = document.createElement('div'); when.className = 'when';
      when.textContent = '#' + r.id + ' \\u00b7 ' + r.createdAt;
      const sum = document.createElement('div'); sum.textContent = r.summary;
      div.appendChild(when); div.appendChild(sum); recs.appendChild(div);
    }
  }

  function dragify(g, n) {
    g.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      n.pinned = true;
      const move = (ev) => {
        const pt = toSvg(ev);
        n.x = pt.x; n.y = pt.y; draw();
      };
      const up = () => {
        n.pinned = false; heat = Math.max(heat, 0.3); requestAnimationFrame(tick);
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  }
  function toSvg(e) {
    const rect = svg.getBoundingClientRect();
    return {
      x: view.x + ((e.clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((e.clientY - rect.top) / rect.height) * view.h,
    };
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const pt = toSvg(e);
    view.x = pt.x - (pt.x - view.x) * factor;
    view.y = pt.y - (pt.y - view.y) * factor;
    view.w *= factor; view.h *= factor;
    applyView();
  }, { passive: false });
  svg.addEventListener('mousedown', (e) => {
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    const rect = svg.getBoundingClientRect();
    const move = (ev) => {
      view.x = start.vx - ((ev.clientX - start.x) / rect.width) * view.w;
      view.y = start.vy - ((ev.clientY - start.y) / rect.height) * view.h;
      applyView();
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
})();
</script>
</body>
</html>
`;
