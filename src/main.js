import '@fontsource/zilla-slab/600.css';
import '@fontsource/zilla-slab/700.css';
import '@fontsource/architects-daughter/400.css';
import '@fontsource/courier-prime/400.css';
import '@fontsource/courier-prime/700.css';
import './style.css';
import { supabase, fetchAll, describeError } from './supabase.js';
import { h, toast, autosize } from './dom.js';
import {
  parseProjectLine, parseElementLine, parseName, nameFragment, connectionFor,
  ARROW_CYCLE, ARROW_GLYPH, ARROW_WORDS, TYPED_ARROW,
} from './lines.js';

const app = document.getElementById('app');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname);

let session = null;
let project = null; // { id, name, role, elements: Map, connections: [] } for the open project
let pendingFocus = null;
let trail = []; // the names walked through in this project, oldest first

// ---------------------------------------------------------------- routing

function route() {
  const [, kind, projectId, sub, elementId] = location.hash.split('/');
  if (kind === 'p' && UUID.test(projectId || '')) {
    return { view: 'project', projectId, elementId: sub === 'e' && UUID.test(elementId || '') ? elementId : null };
  }
  return { view: 'projects' };
}
const go = hash => { if (location.hash !== hash) location.hash = hash; else render(); };

async function render() {
  if (!session) return show(signInView());
  const r = route();
  try {
    if (r.view === 'project') {
      if (project?.id !== r.projectId) {
        show(shell(h('p', { class: 'quiet' }, 'opening…')));
        await loadProject(r.projectId);
        trail = [];
      }
      if (!project) return;
      // Moving within a project animates: the name you click glides into the middle.
      const animate = !!app.querySelector(`[data-project="${project.id}"]`);
      const el = r.elementId && project.elements.get(r.elementId);
      if (!el) {
        const from = trail.at(-1);
        trail = [];
        return show(shell(projectView()), { scrollToId: from, animate });
      }
      walk(el.id);
      return show(shell(focusView(el)), { animate, top: true });
    }
    project = null;
    show(shell(await projectsView()));
  } catch (error) {
    show(shell(h('div', { class: 'doc' },
      h('h1', {}, "Couldn't load this"),
      h('p', {}, describeError(error)),
      h('p', {}, h('a', { href: '#/' }, '← back to your projects')))));
  }
}

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

function show(node, { scrollToId, animate = false, top = false } = {}) {
  const swap = () => {
    app.replaceChildren(node);
    drawWeb();
    const target = pendingFocus && app.querySelector(pendingFocus);
    if (target) { target.focus({ preventScroll: top }); pendingFocus = null; }
    else if (scrollToId) app.querySelector(`[data-id="${scrollToId}"]`)?.scrollIntoView({ block: 'nearest' });
    if (top && app.querySelector('.center')?.getBoundingClientRect().top < 0) scrollTo(0, 0);
  };
  if (animate && document.startViewTransition && !REDUCED_MOTION.matches) document.startViewTransition(swap);
  else swap();
}

async function run(action, { success, busy } = {}) {
  if (busy) busy.disabled = true;
  try {
    await action();
    if (success) toast(success);
    return true;
  } catch (error) {
    toast(describeError(error), 'error');
    return false;
  } finally {
    if (busy) busy.disabled = false;
  }
}
const must = ({ data, error }) => { if (error) throw error; return data; };
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- sign in

function signInView() {
  const email = h('input', { id: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email' });
  const button = h('button', { type: 'submit' }, 'send me a link →');
  const doc = h('div', { class: 'doc signin' });

  const askForEmail = () => doc.replaceChildren(
    h('h1', {}, 'Relationships'),
    h('p', {}, 'Who you know, and how. Sign in with your email; no password.'),
    h('form', { class: 'line-form', onsubmit: send }, email, button),
  );

  async function send(e) {
    e.preventDefault();
    const address = email.value.trim();
    const ok = await run(async () => must(await supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: location.origin + location.pathname },
    })), { busy: button });
    if (!ok) return;
    doc.replaceChildren(
      h('h1', {}, 'Check your email'),
      h('p', {}, 'A sign-in link is on its way to ', h('strong', {}, address), '. Open it in this browser.'),
      h('p', { class: 'quiet' }, 'Nothing after a minute? Look in spam for a message from Supabase.'),
      IS_LOCAL && h('p', { class: 'quiet' }, 'Running locally: it’s in the ',
        h('a', { href: 'http://127.0.0.1:54324', target: '_blank', rel: 'noopener' }, 'test inbox'), '.'),
      h('p', {}, h('button', { class: 'text', onclick: () => { askForEmail(); email.focus(); } }, '← use a different email')),
    );
  }

  askForEmail();
  pendingFocus = '#email';
  return h('main', { class: 'page' }, doc);
}

// ---------------------------------------------------------------- shell

function shell(content) {
  return h('div', { class: 'page' },
    h('header', { class: 'top' },
      h('a', { class: 'mark', href: '#/' }, 'Relationships'),
      h('span', { class: 'who' }, session.user.email, ' · ',
        h('button', { class: 'text', onclick: () => supabase.auth.signOut() }, 'sign out'))),
    h('main', {}, content));
}

// ---------------------------------------------------------------- projects list

async function projectsView() {
  const projects = must(await supabase.from('projects')
    .select('id, name, updated_at, elements(count), connections(count)')
    .order('updated_at', { ascending: false }));

  const input = h('input', { id: 'new-project', maxlength: 120, placeholder: 'new project…', 'aria-label': 'New project name', autocomplete: 'off' });
  const create = async e => {
    e.preventDefault();
    if (!input.value.trim()) return;
    let created;
    const ok = await run(async () => { created = must(await supabase.rpc('create_project', { p_name: input.value })); }, { busy: input });
    if (ok) { pendingFocus = '#add-line'; go(`#/p/${created.id}`); }
  };
  pendingFocus ??= '#new-project';

  return h('div', { class: 'doc' },
    h('h1', {}, 'Projects'),
    h('ul', { class: 'outline' },
      projects.map(p => h('li', {},
        h('a', { href: `#/p/${p.id}`, class: 'name' }, p.name),
        h('span', { class: 'meta' }, plural(p.elements[0]?.count ?? 0, 'name'), ', ', plural(p.connections[0]?.count ?? 0, 'connection')))),
      h('li', { class: 'adder' }, h('form', { onsubmit: create }, input))),
    !projects.length && h('p', { class: 'quiet' }, 'A project is one list of people and how they’re connected. Name your first and press Enter.'));
}

// ---------------------------------------------------------------- project data

async function loadProject(id) {
  const [info, membership, elements, connections] = await Promise.all([
    supabase.from('projects').select('id, name').eq('id', id).maybeSingle().then(must),
    supabase.from('project_members').select('role').eq('project_id', id).eq('user_id', session.user.id).maybeSingle().then(must),
    fetchAll(() => supabase.from('elements').select(ELEMENT_COLUMNS).eq('project_id', id).order('created_at')),
    fetchAll(() => supabase.from('connections').select('id, from_element_id, to_element_id, connection_type, direction').eq('project_id', id).order('created_at')),
  ]);
  if (!info) {
    project = null;
    show(shell(h('div', { class: 'doc' },
      h('h1', {}, 'Not found'),
      h('p', {}, 'This project may have been deleted, or you don’t have access to it.'),
      h('p', {}, h('a', { href: '#/' }, '← back to your projects')))));
    return;
  }
  project = { ...info, role: membership?.role ?? 'viewer', elements: new Map(elements.map(e => [e.id, e])), connections };
}
const ELEMENT_COLUMNS = 'id, label, element_type, description, created_at';
const reload = async () => { await loadProject(project.id); render(); };
const canEdit = () => project.role === 'owner' || project.role === 'editor';
const byLabel = label => [...project.elements.values()].find(e => e.label.toLowerCase() === label.toLowerCase());
const withType = el => (el.element_type ? `${el.label} [${el.element_type}]` : el.label);

function connectionsOf(elementId) {
  return project.connections
    .filter(c => c.from_element_id === elementId || c.to_element_id === elementId)
    .map(c => {
      const outgoing = c.from_element_id === elementId;
      const other = project.elements.get(outgoing ? c.to_element_id : c.from_element_id);
      const arrows = c.direction === 'mutual' ? 'both' : c.direction === 'undirected' ? 'none' : outgoing ? 'out' : 'in';
      return { ...c, other, arrows };
    })
    .filter(c => c.other);
}

// Finds a name in the project or adds it. A [type] typed with an existing name updates its type.
async function ensureElement({ label, type, typeGiven }) {
  const found = byLabel(label);
  if (found) {
    if (typeGiven && type !== found.element_type) {
      must(await supabase.from('elements').update({ element_type: type }).eq('id', found.id));
      found.element_type = type;
    }
    return found;
  }
  const created = must(await supabase.from('elements').insert({ project_id: project.id, label, element_type: type }).select(ELEMENT_COLUMNS).single());
  project.elements.set(created.id, created);
  return created;
}

async function connect(fromNameOrEl, arrow, toName, kind) {
  const a = fromNameOrEl.id ? fromNameOrEl : await ensureElement(fromNameOrEl);
  const b = await ensureElement(toName);
  if (a.id === b.id) throw new Error('A name can’t connect to itself.');
  must(await supabase.from('connections').insert({
    project_id: project.id, ...connectionFor(TYPED_ARROW[arrow], a.id, b.id), connection_type: kind,
  }));
}

// Tab completes the name being typed from the project's existing names.
function withCompletion(input) {
  input.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    const frag = nameFragment(input.value);
    if (!frag) return;
    const hit = [...project.elements.values()].map(el => el.label).find(l => l.toLowerCase().startsWith(frag.toLowerCase()) && l.length > frag.length);
    if (!hit) return;
    e.preventDefault();
    input.value = input.value.slice(0, input.value.length - frag.length) + hit;
  });
  return input;
}

// ---------------------------------------------------------------- project view (the index of names)

function projectView() {
  const editable = canEdit();
  const elements = [...project.elements.values()];

  const title = autosize(h('textarea', { id: 'project-title', class: 'title', rows: 1, maxlength: 120, 'aria-label': 'Project name', disabled: !editable, spellcheck: false }));
  title.value = project.name;
  const rename = async () => {
    const name = title.value.trim();
    if (!name || name === project.name) { title.value = project.name; return; }
    if (await run(async () => must(await supabase.from('projects').update({ name }).eq('id', project.id)), { success: 'Renamed' })) project.name = name;
  };
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { title.value = project.name; title.blur(); } });
  title.addEventListener('blur', rename);

  const add = withCompletion(h('input', { id: 'add-line', maxlength: 400, autocomplete: 'off', 'aria-label': 'Add a name or a connection',
    placeholder: elements.length ? 'add a name, or  Ada [person] -> Grace : mentor' : 'add the first name…' }));
  const addLine = async e => {
    e.preventDefault();
    const parsed = parseProjectLine(add.value);
    if (!parsed) return toast('Write a name, or two names joined by -> (for example: Ada -> Grace).', 'error');
    const ok = await run(async () => {
      if (parsed.kind === 'element') {
        const existing = byLabel(parsed.name.label);
        if (existing && !parsed.name.typeGiven) throw new Error(`${existing.label} is already on the list.`);
        await ensureElement(parsed.name);
      } else await connect(parsed.from, parsed.arrow, parsed.to, parsed.type);
    }, { busy: add });
    if (ok) { pendingFocus = '#add-line'; await reload(); }
  };

  return h('div', { class: 'doc project', dataset: { project: project.id } },
    h('p', { class: 'crumb' }, h('a', { href: '#/' }, '← projects')),
    title,
    h('p', { class: 'meta' }, plural(elements.length, 'name'), ', ', plural(project.connections.length, 'connection'),
      project.role !== 'owner' ? ` · you’re ${project.role === 'editor' ? 'an editor' : 'a viewer'}` : ''),
    h('ul', { class: 'outline' },
      elements.map(el => elementItem(el, editable)),
      editable && h('li', { class: 'adder' }, h('form', { onsubmit: addLine }, add))),
    editable && h('p', { class: 'quiet syntax' },
      [['->', 'points to'], ['<-', 'comes from'], ['<->', 'both ways'], ['--', 'no direction'], ['[type]', 'after a name'], [': kind', 'names a connection'], ['Tab', 'completes']]
        .map(([key, what]) => h('span', {}, h('kbd', {}, key), what))),
    project.role === 'owner' && h('p', { class: 'footer' }, twoStep('delete this project', `really delete “${project.name}”?`, async () => {
      must(await supabase.from('projects').delete().eq('id', project.id));
      project = null;
      toast('Project deleted');
      go('#/');
    })));
}

function elementItem(el, editable) {
  const links = connectionsOf(el.id);
  return h('li', { class: 'el', dataset: { id: el.id } },
    named(h('a', { class: 'name', href: `#/p/${project.id}/e/${el.id}` }, el.label, el.element_type && h('span', { class: 'type' }, ` [${el.element_type}]`)), el.id),
    el.description && h('span', { class: 'meta' }, ' — ', el.description.split('\n')[0].slice(0, 80)),
    links.length > 0 && h('ul', {},
      links.map(c => h('li', { class: 'conn' },
        arrowControl(c, el, editable),
        h('span', { class: 'text' },
          h('a', { href: `#/p/${project.id}/e/${c.other.id}` }, c.other.label),
          c.connection_type && h('span', { class: 'kind' }, ' : ', c.connection_type))))));
}

// Tags a name so a view transition can carry it from one place on screen to another.
// Each tag may appear only once per page, so callers name only the first copy of a name.
function named(node, id) {
  node.style.viewTransitionName = `n-${id}`;
  return node;
}

// The arrow beside a connection. Editors click it to cycle → ← ↔ —.
// In the web the glyph is drawn by position instead (left of the centre always points right).
function arrowControl(c, el, editable, glyph = ARROW_GLYPH[c.arrows]) {
  if (!editable) return h('span', { class: 'arrow', title: ARROW_WORDS[c.arrows] }, glyph);
  const next = ARROW_CYCLE[(ARROW_CYCLE.indexOf(c.arrows) + 1) % ARROW_CYCLE.length];
  return h('button', { class: 'arrow', type: 'button', title: `${el.label} ${ARROW_WORDS[c.arrows]} ${c.other.label} · click for ${ARROW_WORDS[next]}`,
    'aria-label': `${el.label} ${ARROW_WORDS[c.arrows]} ${c.other.label}. Change to ${ARROW_WORDS[next]}`,
    onclick: async e => {
      const ok = await run(async () => must(await supabase.from('connections').update(connectionFor(next, el.id, c.other.id)).eq('id', c.id)), { busy: e.currentTarget });
      if (ok) { pendingFocus = `[data-conn="${c.id}"]`; await reload(); }
    }, dataset: { conn: c.id } }, glyph);
}

// ---------------------------------------------------------------- the web (one name at the centre)
//
// The open name sits in the middle. What points to it is on the left, what it points to is on
// the right, and two-way or undirected connections sit alongside, underneath. Clicking any
// neighbour moves it to the centre; the name you left slides to wherever it now belongs.

const ZONES = [
  { key: 'up', label: 'comes from', typed: '<-', placeholder: 'who points here' },
  { key: 'down', label: 'points to', typed: '->', placeholder: 'points to…' },
  { key: 'along', label: 'alongside', typed: '<->', placeholder: 'connected with…' },
];
const ZONE_OF = { in: 'up', out: 'down', both: 'along', none: 'along' };
const FOLD = 8; // a zone with more neighbours than this shows FOLD - 1 and a "+ more" button
const expanded = new Set();

// Records a step in the walk. Returning to a name already on the path cuts the path back to it.
function walk(id) {
  const at = trail.indexOf(id);
  trail = at === -1 ? [...trail, id] : trail.slice(0, at + 1);
  trail = trail.filter(t => project.elements.has(t));
}

function degrees() {
  const count = new Map();
  for (const c of project.connections) for (const id of [c.from_element_id, c.to_element_id]) count.set(id, (count.get(id) || 0) + 1);
  return count;
}

function focusView(el) {
  const editable = canEdit();
  const links = connectionsOf(el.id)
    .sort((a, b) => (a.connection_type || '').localeCompare(b.connection_type || '') || a.other.label.localeCompare(b.other.label));
  const zones = Object.fromEntries(ZONES.map(z => [z.key, links.filter(c => ZONE_OF[c.arrows] === z.key)]));
  const seen = new Set([el.id]);
  const degree = degrees();

  return h('div', { class: 'doc focus', dataset: { project: project.id } },
    h('p', { class: 'crumb' }, h('a', { href: `#/p/${project.id}` }, '← ', project.name)),
    h('div', { class: 'web' },
      svg('svg', { class: 'web-lines', 'aria-hidden': 'true' }),
      zoneView(ZONES[0], zones.up, el, editable, degree, seen),
      centreCard(el, zones, editable),
      zoneView(ZONES[1], zones.down, el, editable, degree, seen),
      zoneView(ZONES[2], zones.along, el, editable, degree, seen)),
    trailView());
}

function centreCard(el, zones, editable) {
  const total = zones.up.length + zones.down.length + zones.along.length;
  return h('section', { class: 'center', 'aria-label': el.label },
    editable ? nameEditor(el)
      : h('h1', { class: 'name' }, named(h('span', {}, el.label), el.id), el.element_type && h('span', { class: 'type' }, ` [${el.element_type}]`)),
    h('p', { class: 'meta' }, total ? [zones.up.length, ' in · ', zones.down.length, ' out · ', zones.along.length, ' alongside'] : 'not connected yet'),
    notesEditor(el, editable),
    editable && h('p', { class: 'footer' },
      twoStep('delete', `delete ${el.label}${total ? ` and ${plural(total, 'connection')}` : ''}?`, async () => {
        must(await supabase.from('elements').delete().eq('id', el.id));
        toast(`Deleted ${el.label}`);
        await loadProject(project.id);
        go(`#/p/${project.id}`);
      })));
}

function zoneView(zone, conns, centre, editable, degree, seen) {
  const key = `${centre.id}:${zone.key}`;
  const folded = conns.length > FOLD && !expanded.has(key);
  const shown = folded ? conns.slice(0, FOLD - 1) : conns;
  return h('section', { class: `zone ${zone.key}`, dataset: { zone: zone.key }, 'aria-label': `${centre.label} ${zone.label}` },
    h('h2', { class: 'zone-label' }, zone.label),
    h('ul', {},
      shown.map(c => neighbour(c, centre, zone, editable, degree.get(c.other.id) - 1, seen)),
      folded && h('li', { class: 'fold' }, h('button', { class: 'text', type: 'button', onclick: () => { expanded.add(key); render(); } },
        `+ ${conns.length - shown.length} more`)),
      !conns.length && !editable && h('li', { class: 'quiet' }, 'none'),
      editable && zoneAdder(zone, centre)));
}

function neighbour(c, centre, zone, editable, more, seen) {
  const link = h('a', { class: 'name', href: `#/p/${project.id}/e/${c.other.id}`, title: more > 0 ? `${c.other.label}: ${plural(more, 'other connection')}` : null }, c.other.label);
  if (!seen.has(c.other.id)) { seen.add(c.other.id); named(link, c.other.id); }
  return h('li', { class: 'row', dataset: { line: c.id, more: Math.min(more, 3) } },
    arrowControl(c, centre, editable, zone.key === 'along' ? ARROW_GLYPH[c.arrows] : '→'),
    h('span', { class: 'who' },
      link,
      c.connection_type && h('span', { class: 'kind' }, ' : ', c.connection_type),
      more > 0 && h('span', { class: 'more', 'aria-hidden': 'true' }, ` +${more}`)),
    editable && h('button', { class: 'text remove', type: 'button', 'aria-label': `Remove connection to ${c.other.label}`,
      onclick: async e => { if (await run(async () => must(await supabase.from('connections').delete().eq('id', c.id)), { busy: e.currentTarget })) await reload(); } }, '×'));
}

// Each zone has its own line: where you type sets the direction. A typed leading arrow still wins.
function zoneAdder(zone, centre) {
  const id = `add-${zone.key}`;
  const input = withCompletion(h('input', { id, maxlength: 400, autocomplete: 'off', 'aria-label': `Add to ${zone.label} ${centre.label}`, placeholder: `+ ${zone.placeholder}` }));
  input.addEventListener('focus', () => { input.placeholder = 'name [type] : how'; });
  input.addEventListener('blur', () => { input.placeholder = `+ ${zone.placeholder}`; });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); if (input.value) input.value = ''; else input.blur(); } });
  return h('li', { class: 'adder' }, h('form', { onsubmit: async e => {
    e.preventDefault();
    const parsed = parseElementLine(input.value, zone.typed);
    if (!parsed) return;
    const ok = await run(async () => connect(centre, parsed.arrow, parsed.to, parsed.type), { busy: input });
    if (ok) { pendingFocus = `#${id}`; await reload(); }
  } }, input));
}

function trailView() {
  if (trail.length < 2) return null;
  const steps = trail.slice(-8);
  return h('p', { class: 'trail' }, h('span', { class: 'quiet' }, 'your path '),
    trail.length > steps.length && '… › ',
    steps.map((id, i) => {
      const label = project.elements.get(id).label;
      return [i > 0 && ' › ', i === steps.length - 1 ? h('span', { class: 'here' }, label) : h('a', { href: `#/p/${project.id}/e/${id}` }, label)];
    }));
}

// ---------------------------------------------------------------- the web's lines

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const WIDE = matchMedia('(min-width: 760px)');
let webObserver;

// Draws a curve from the centre card to each neighbour, plus a few short strokes on the far side
// of neighbours that have connections of their own, so you can see the web carry on.
function drawWeb() {
  webObserver?.disconnect();
  const web = app.querySelector('.web');
  if (!web) return;
  const lines = web.querySelector('.web-lines');
  const paint = () => {
    if (!WIDE.matches) return lines.replaceChildren();
    const box = web.getBoundingClientRect();
    const rel = node => {
      const r = node.getBoundingClientRect();
      return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, x: (r.left + r.right) / 2 - box.left, y: (r.top + r.bottom) / 2 - box.top };
    };
    const card = rel(web.querySelector('.center'));
    const hubY = rel(web.querySelector('.center .name')).y;
    const want = new Map();
    const stubs = (key, x, y, angle, n) => {
      for (let i = 0; i < n; i++) {
        const a = angle + (i - (n - 1) / 2) * 0.45;
        want.set(`${key}:${i}`, { d: `M${x},${y} l${Math.cos(a) * 13},${Math.sin(a) * 13}`, cls: 'stub' });
      }
    };
    for (const row of web.querySelectorAll('.zone .row')) {
      const zone = row.closest('.zone').dataset.zone;
      const key = row.dataset.line, more = +row.dataset.more;
      const r = rel(row), who = rel(row.querySelector('.who'));
      // Rows on either side span their whole column, so the name's own box marks where the text ends.
      if (zone === 'up') {
        const x1 = r.r + 6, x2 = card.l - 4, mx = (x1 + x2) / 2;
        want.set(key, { d: `M${x1},${r.y} C${mx},${r.y} ${mx},${hubY} ${x2},${hubY}` });
        stubs(key, who.l - 6, r.y, Math.PI, more);
      } else if (zone === 'down') {
        const x1 = card.r + 4, x2 = r.l - 6, mx = (x1 + x2) / 2;
        want.set(key, { d: `M${x1},${hubY} C${mx},${hubY} ${mx},${r.y} ${x2},${r.y}` });
        stubs(key, rel(row.lastElementChild).r + 6, r.y, 0, more);
      } else {
        const y1 = card.b + 4, y2 = r.t - 4, my = (y1 + y2) / 2;
        want.set(key, { d: `M${card.x},${y1} C${card.x},${my} ${r.x},${my} ${r.x},${y2}` });
        stubs(key, r.x, r.b + 4, Math.PI / 2, more);
      }
    }
    // Reuse paths that already exist so redrawing on resize doesn't replay the ink-in animation.
    const have = new Map([...lines.children].map(p => [p.dataset.key, p]));
    for (const [key, { d, cls }] of want) {
      let path = have.get(key);
      if (!path) { path = svg('path', { pathLength: 1, class: cls || 'link' }); path.dataset.key = key; lines.append(path); }
      path.setAttribute('d', d);
      have.delete(key);
    }
    for (const stale of have.values()) stale.remove();
  };
  paint();
  webObserver = new ResizeObserver(paint);
  webObserver.observe(web);
}
WIDE.addEventListener('change', drawWeb);

// ---------------------------------------------------------------- editing the centre

function nameEditor(el) {
  const input = autosize(h('textarea', { id: 'element-name', class: 'name', rows: 1, maxlength: 260, 'aria-label': 'Name, with an optional [type]', autocomplete: 'off', spellcheck: false }));
  input.value = withType(el);
  named(input, el.id);
  const changed = () => {
    const parsed = parseName(input.value);
    return parsed && (parsed.label !== el.label || (parsed.typeGiven ? parsed.type : null) !== (el.element_type || null)) ? parsed : null;
  };
  const save = async () => {
    const parsed = changed();
    if (!parsed) { input.value = withType(el); return; }
    const clash = byLabel(parsed.label);
    if (clash && clash.id !== el.id) {
      toast(`There’s already a ${clash.label} in this project. Pick a different name.`, 'error');
      input.value = withType(el);
      return;
    }
    const type = parsed.typeGiven ? parsed.type : null;
    if (await run(async () => must(await supabase.from('elements').update({ label: parsed.label, element_type: type }).eq('id', el.id)), { success: 'Saved' })) await reload();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (changed()) { pendingFocus = '#add-down'; input.blur(); } else document.getElementById('add-down')?.focus();
    }
    if (e.key === 'Escape') { input.value = withType(el); go(`#/p/${project.id}`); }
  });
  input.addEventListener('blur', save);
  return input;
}

// With a name at the centre and nothing focused: Enter jumps to its "points to" line, Escape goes back to the list.
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !project || !document.querySelector('.web')) return;
  const active = document.activeElement;
  const typing = active && active !== document.body && active.matches('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape' && !typing) { e.preventDefault(); go(`#/p/${project.id}`); return; }
  if (e.key !== 'Enter' || (active && active !== document.body && (typing || active.matches('button, a')))) return;
  const line = document.getElementById('add-down');
  if (line) { e.preventDefault(); line.focus(); }
});

function notesEditor(el, editable) {
  if (!editable) return el.description && h('p', { class: 'notes-text' }, el.description);
  const notes = autosize(h('textarea', { id: 'element-notes', class: 'notes', maxlength: 5000, rows: 1, placeholder: 'notes…', 'aria-label': `Notes about ${el.label}` }));
  notes.value = el.description || '';
  notes.addEventListener('blur', async () => {
    const description = notes.value.trim() || null;
    if (description === (el.description || null)) return;
    if (await run(async () => must(await supabase.from('elements').update({ description }).eq('id', el.id)), { success: 'Notes saved' })) el.description = description;
  });
  return notes;
}

// A destructive text button: the first click asks, the second within five seconds does it.
function twoStep(label, question, action) {
  const button = h('button', { class: 'text danger', type: 'button' }, label);
  let armed = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = question;
      armed = setTimeout(() => { armed = null; button.textContent = label; }, 5000);
      return;
    }
    clearTimeout(armed);
    await run(action, { busy: button });
  });
  return button;
}

// ---------------------------------------------------------------- start

supabase.auth.onAuthStateChange((event, s) => {
  const changed = (s?.user?.id ?? null) !== (session?.user?.id ?? null);
  session = s;
  if (location.search.includes('code=')) history.replaceState(null, '', location.pathname + location.hash);
  if (changed) { project = null; render(); }
});
window.addEventListener('hashchange', render);
const { data } = await supabase.auth.getSession();
session = data.session;
render();
