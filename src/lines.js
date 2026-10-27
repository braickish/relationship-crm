// The one-line syntax for adding things, kept free of DOM and database code so it's easy to test.
//
//   Ada                               a name
//   Ada Lovelace [person]             a name with a type
//   Ada -> Grace                      Ada points to Grace          (also: <-  <->  --)
//   Ada -> Grace : mentor             with a kind of connection
//   Ada [person] -> Acme [org] : funds
//
// Under a name, the left side is implied: "Grace : mentor", or "<- Acme [org] : funds".

const ARROWS = ['<->', '<-', '->', '--'];
const ARROW_RE = /\s*(<->|<-|->|--)\s*/;
const TYPE_RE = /\s*\[([^\]]*)\]\s*$/;

export const DIRECTION = {
  '->': { direction: 'directed', swap: false },
  '<-': { direction: 'directed', swap: true },
  '<->': { direction: 'mutual', swap: false },
  '--': { direction: 'undirected', swap: false },
};

// How a connection looks from one of its ends, in the order a click on its arrow cycles through.
export const ARROW_CYCLE = ['out', 'in', 'both', 'none'];
export const ARROW_GLYPH = { out: '→', in: '←', both: '↔', none: '—' };
export const ARROW_WORDS = { out: 'points to', in: 'comes from', both: 'both ways', none: 'no direction' };
export const ARROW_TYPED = { out: '->', in: '<-', both: '<->', none: '--' };
export const TYPED_ARROW = { '->': 'out', '<-': 'in', '<->': 'both', '--': 'none' };

const clean = s => s.replace(/\s+/g, ' ').trim();

// "Ada Lovelace [person]" -> { label: 'Ada Lovelace', type: 'person' }. An empty [] clears the type.
export function parseName(text) {
  const m = text.match(TYPE_RE);
  const label = clean(m ? text.slice(0, m.index) : text);
  if (!label) return null;
  return m ? { label, type: clean(m[1]) || null, typeGiven: true } : { label, type: null, typeGiven: false };
}

function splitKind(rest) {
  const i = rest.indexOf(':');
  return i === -1 ? [rest, null] : [rest.slice(0, i), clean(rest.slice(i + 1)) || null];
}

// A line typed at the bottom of a project.
export function parseProjectLine(text) {
  const m = text.match(ARROW_RE);
  if (!m) {
    const name = parseName(text);
    return name && { kind: 'element', name };
  }
  const from = parseName(text.slice(0, m.index));
  const [right, type] = splitKind(text.slice(m.index + m[0].length));
  const to = parseName(right);
  if (!from || !to) return null;
  return { kind: 'connection', from, arrow: m[1], to, type };
}

// A line typed under a name. A leading arrow, if typed, overrides the arrow chosen by clicking.
export function parseElementLine(text, arrow = '->') {
  let t = text.trim();
  const lead = ARROWS.find(a => t.startsWith(a));
  if (lead) { arrow = lead; t = t.slice(lead.length); }
  const [left, type] = splitKind(t);
  const to = parseName(left);
  return to ? { arrow, to, type } : null;
}

// The name being typed, for completion: the text after the last arrow, before any colon or bracket.
export function nameFragment(text) {
  const afterArrow = text.split(ARROW_RE).pop();
  return /[:[]/.test(afterArrow) ? null : afterArrow.trimStart();
}

// The from/to/direction that make a connection look like `arrows` from element `selfId`.
export function connectionFor(arrows, selfId, otherId) {
  if (arrows === 'in') return { from_element_id: otherId, to_element_id: selfId, direction: 'directed' };
  return { from_element_id: selfId, to_element_id: otherId,
    direction: arrows === 'both' ? 'mutual' : arrows === 'none' ? 'undirected' : 'directed' };
}
