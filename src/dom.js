// Tiny DOM helper. User data only ever reaches the page as text nodes, never as HTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 2500);
}

// Six sticky-note tints for element types. Each project assigns them in the order its types first
// appear, so the first six types always get different colours. Untyped elements stay grey.
let tints = new Map();
export function setTypeOrder(types) {
  tints = new Map();
  for (const t of types) {
    const key = t?.trim().toLowerCase();
    if (key && !tints.has(key)) tints.set(key, 1 + (tints.size % 6));
  }
}
export function typeTint(type) {
  return tints.get(type?.trim().toLowerCase()) ?? 0;
}
