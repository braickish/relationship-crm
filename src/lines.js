// The one-line syntax for adding things, kept free of DOM and database code so it's easy to test.
//
//   Ada                      an element
//   Ada -> Grace             Ada points to Grace          (also: <-  <->  --)
//   Ada -> Grace : mentor    with a kind of connection
//
// Inside an element, the left side is implied: "-> Grace : mentor", or just "Grace".

const ARROWS = ['<->', '<-', '->', '--'];
const ARROW_RE = /\s*(<->|<-|->|--)\s*/;

export const DIRECTION = {
  '->': { direction: 'directed', swap: false },
  '<-': { direction: 'directed', swap: true },
  '<->': { direction: 'mutual', swap: false },
  '--': { direction: 'undirected', swap: false },
};

const clean = s => s.replace(/\s+/g, ' ').trim();

function splitKind(rest) {
  const i = rest.indexOf(':');
  return i === -1 ? [clean(rest), null] : [clean(rest.slice(0, i)), clean(rest.slice(i + 1)) || null];
}

// A line typed at the bottom of a project.
export function parseProjectLine(text) {
  const m = text.match(ARROW_RE);
  if (!m) return clean(text) ? { kind: 'element', label: clean(text) } : null;
  const left = clean(text.slice(0, m.index));
  const [right, type] = splitKind(text.slice(m.index + m[0].length));
  if (!left || !right) return null;
  return { kind: 'connection', from: left, arrow: m[1], to: right, type };
}

// A line typed under an element.
export function parseElementLine(text) {
  let t = text.trim();
  let arrow = '->';
  const lead = ARROWS.find(a => t.startsWith(a));
  if (lead) { arrow = lead; t = t.slice(lead.length); }
  const [to, type] = splitKind(t);
  return to ? { arrow, to, type } : null;
}

// The name being typed, for completion: the text after the last arrow, before any colon.
export function nameFragment(text) {
  const afterArrow = text.split(ARROW_RE).pop();
  return afterArrow.includes(':') ? null : afterArrow.trimStart();
}

export const ARROW_GLYPH = { out: '→', in: '←', both: '↔', none: '—' };
