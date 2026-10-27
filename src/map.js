import rough from 'roughjs';
import { typeTint } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const MAX_SHOWN = 12;

const svgEl = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const seedOf = id => [...id].reduce((n, ch) => (n * 33 + ch.charCodeAt(0)) >>> 0, 7) % 100000;

// A hand-sketched map of one element and its direct connections.
// neighbors: [{ id, label, type, arrows: 'out' | 'in' | 'both' | 'none' }]
export function egoMap(center, neighbors, onPick) {
  const W = 560, H = 330, cx = W / 2, cy = H / 2, rx = 205, ry = 122;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'egomap', role: 'img',
    'aria-label': `${center.label} and ${neighbors.length} connected element${neighbors.length === 1 ? '' : 's'}` });
  const rc = rough.svg(svg);
  let seed = seedOf(center.id);
  const o = (x = {}) => ({ stroke: 'currentColor', strokeWidth: 1.6, roughness: 1.3, bowing: 1.1, seed: ++seed, ...x });
  const put = (node, cls) => { if (cls) node.setAttribute('class', cls); svg.append(node); return node; };
  const head = (fx, fy, x, y) => {
    const a = Math.atan2(y - fy, x - fx);
    for (const s of [-0.45, 0.45]) put(rc.line(x, y, x - 11 * Math.cos(a + s), y - 11 * Math.sin(a + s), o()));
  };

  const shown = neighbors.slice(0, MAX_SHOWN);
  const nodes = shown.map((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(shown.length, 1);
    const label = clip(n.label, 20);
    return { ...n, label, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), w: Math.min(170, 26 + label.length * 7.4) };
  });

  const cLabel = clip(center.label, 22), cw = Math.min(210, 40 + cLabel.length * 9);
  // Distance from a box's centre to its edge (plus a gap) along the unit vector (ux, uy).
  const toEdge = (hw, hh, ux, uy) => Math.min(Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity);

  // Edges first, so the notes sit on top of them; each edge stops at the box edges so arrowheads show.
  for (const n of nodes) {
    const dx = n.x - cx, dy = n.y - cy, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const s = toEdge(cw / 2 + 5, 29, ux, uy), e = toEdge(n.w / 2 + 5, 21, ux, uy);
    const sx = cx + ux * s, sy = cy + uy * s, ex = n.x - ux * e, ey = n.y - uy * e;
    put(rc.line(sx, sy, ex, ey, o({ strokeWidth: 1.4 })), 'edge');
    if (n.arrows === 'out' || n.arrows === 'both') head(sx, sy, ex, ey);
    if (n.arrows === 'in' || n.arrows === 'both') head(ex, ey, sx, sy);
  }

  put(rc.rectangle(cx - cw / 2, cy - 24, cw, 48, o({ stroke: 'none', fill: 'currentColor', fillStyle: 'solid' })), `tint-${typeTint(center.element_type)}`);
  put(rc.rectangle(cx - cw / 2, cy - 24, cw, 48, o({ strokeWidth: 2.2 })));
  put(svgEl('text', { x: cx, y: cy + 6, class: 'center-label' }, cLabel));

  for (const n of nodes) {
    const g = put(svgEl('g', { class: 'node', tabindex: '0', role: 'link', 'aria-label': `Open ${n.label}` }));
    g.append(rc.rectangle(n.x - n.w / 2, n.y - 16, n.w, 32, o({ stroke: 'none', fill: 'currentColor', fillStyle: 'solid' })));
    g.lastChild.setAttribute('class', `tint-${typeTint(n.type)}`);
    g.append(rc.rectangle(n.x - n.w / 2, n.y - 16, n.w, 32, o()));
    g.append(svgEl('text', { x: n.x, y: n.y + 5 }, n.label));
    g.addEventListener('click', () => onPick(n.id));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(n.id); } });
  }

  if (!neighbors.length) put(svgEl('text', { x: cx, y: cy + 70, class: 'hint' }, 'No connections yet. Add one below.'));
  if (neighbors.length > MAX_SHOWN) put(svgEl('text', { x: W - 8, y: H - 8, class: 'hint end' }, `+${neighbors.length - MAX_SHOWN} more in the list below`));
  return svg;
}
