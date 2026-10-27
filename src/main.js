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
  ARROW_CYCLE, ARROW_GLYPH, ARROW_WORDS, ARROW_TYPED, TYPED_ARROW,
} from './lines.js';

const app = document.getElementById('app');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname);

let session = null;
let project = null; // { id, name, role, elements: Map, connections: [] } for the open project
let pendingFocus = null;

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
      }
      if (!project) return;
      return show(shell(projectView(r.elementId)), r.elementId);
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

function show(node, scrollToId) {
  app.replaceChildren(node);
  const target = pendingFocus && app.querySelector(pendingFocus);
  if (target) { target.focus(); pendingFocus = null; }
  else if (scrollToId) app.querySelector(`[data-id="${scrollToId}"]`)?.scrollIntoView({ block: 'nearest' });
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

// ---------------------------------------------------------------- project view

function projectView(openId) {
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

  return h('div', { class: 'doc project' },
    h('p', { class: 'crumb' }, h('a', { href: '#/' }, '← projects')),
    title,
    h('p', { class: 'meta' }, plural(elements.length, 'name'), ', ', plural(project.connections.length, 'connection'),
      project.role !== 'owner' ? ` · you’re ${project.role === 'editor' ? 'an editor' : 'a viewer'}` : ''),
    h('ul', { class: 'outline' },
      elements.map(el => elementItem(el, el.id === openId, editable)),
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

function elementItem(el, open, editable) {
  const links = connectionsOf(el.id);
  const href = open ? `#/p/${project.id}` : `#/p/${project.id}/e/${el.id}`;
  return h('li', { class: open ? 'el open' : 'el', dataset: { id: el.id } },
    open && editable ? nameEditor(el)
      : h('a', { class: 'name', href, 'aria-expanded': String(open) }, el.label, el.element_type && h('span', { class: 'type' }, ` [${el.element_type}]`)),
    !open && el.description && h('span', { class: 'meta' }, ' — ', el.description.split('\n')[0].slice(0, 80)),
    (links.length || (open && editable)) && h('ul', {},
      links.map(c => h('li', { class: 'conn' },
        arrowControl(c, el, editable),
        h('span', { class: 'text' },
          h('a', { href: `#/p/${project.id}/e/${c.other.id}` }, c.other.label),
          c.connection_type && h('span', { class: 'kind' }, ' : ', c.connection_type),
          open && editable && h('button', { class: 'text remove', type: 'button', 'aria-label': `Remove connection to ${c.other.label}`,
            onclick: async e => { if (await run(async () => must(await supabase.from('connections').delete().eq('id', c.id)), { busy: e.currentTarget })) await reload(); } }, '×')))),
      open && editable && connectForm(el)),
    open && notesEditor(el, editable),
    open && editable && h('p', { class: 'footer' },
      h('a', { href: `#/p/${project.id}`, class: 'quiet' }, 'close'), ' · ',
      twoStep('delete', `delete ${el.label}${links.length ? ` and ${plural(links.length, 'connection')}` : ''}?`, async () => {
        must(await supabase.from('elements').delete().eq('id', el.id));
        toast(`Deleted ${el.label}`);
        await loadProject(project.id);
        go(`#/p/${project.id}`);
      })));
}

// The arrow beside a connection. Editors click it to cycle → ← ↔ —.
function arrowControl(c, el, editable) {
  const glyph = ARROW_GLYPH[c.arrows];
  if (!editable) return h('span', { class: 'arrow', title: ARROW_WORDS[c.arrows] }, glyph);
  const next = ARROW_CYCLE[(ARROW_CYCLE.indexOf(c.arrows) + 1) % ARROW_CYCLE.length];
  return h('button', { class: 'arrow', type: 'button', title: `${ARROW_WORDS[c.arrows]} · click for ${ARROW_WORDS[next]}`,
    'aria-label': `${el.label} ${ARROW_WORDS[c.arrows]} ${c.other.label}. Change to ${ARROW_WORDS[next]}`,
    onclick: async e => {
      const ok = await run(async () => must(await supabase.from('connections').update(connectionFor(next, el.id, c.other.id)).eq('id', c.id)), { busy: e.currentTarget });
      if (ok) { pendingFocus = `[data-conn="${c.id}"]`; await reload(); }
    }, dataset: { conn: c.id } }, glyph);
}

function nameEditor(el) {
  const input = h('input', { id: 'element-name', class: 'name', value: withType(el), maxlength: 260, 'aria-label': 'Name, with an optional [type]', autocomplete: 'off' });
  const save = async () => {
    const parsed = parseName(input.value);
    const type = parsed?.typeGiven ? parsed.type : null;
    if (!parsed || (parsed.label === el.label && type === (el.element_type || null))) { input.value = withType(el); return; }
    const clash = byLabel(parsed.label);
    if (clash && clash.id !== el.id) {
      toast(`There’s already a ${clash.label} in this project. Pick a different name.`, 'error');
      input.value = withType(el);
      return;
    }
    if (await run(async () => must(await supabase.from('elements').update({ label: parsed.label, element_type: type }).eq('id', el.id)), { success: 'Saved' })) await reload();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); pendingFocus = '#connect-line'; input.blur(); }
    if (e.key === 'Escape') go(`#/p/${project.id}`);
  });
  input.addEventListener('blur', save);
  return input;
}

// The new-connection line under an open name: the same two columns as a saved connection,
// so nothing shifts when it saves. Its arrow can be clicked (or typed) before the name.
const RESTING = 'press enter to add a connection';
function connectForm(el) {
  let arrows = 'out';
  const arrow = h('button', { class: 'arrow', type: 'button', title: 'direction · click to change' }, ARROW_GLYPH[arrows]);
  const setArrows = a => { arrows = a; arrow.textContent = ARROW_GLYPH[a]; arrow.setAttribute('aria-label', `New connection ${ARROW_WORDS[a]}. Change direction`); };
  setArrows('out');
  arrow.addEventListener('click', () => { setArrows(ARROW_CYCLE[(ARROW_CYCLE.indexOf(arrows) + 1) % ARROW_CYCLE.length]); input.focus(); });

  const input = withCompletion(h('input', { id: 'connect-line', maxlength: 400, autocomplete: 'off', 'aria-label': `Connect ${el.label} to…`, placeholder: RESTING }));
  input.addEventListener('focus', () => { input.placeholder = 'who [type] : how'; });
  input.addEventListener('blur', () => { input.placeholder = RESTING; });
  input.addEventListener('input', () => {
    const lead = input.value.match(/^\s*(<->|<-|->|--)\s/);
    if (lead) { setArrows(TYPED_ARROW[lead[1]]); input.value = input.value.slice(lead[0].length); }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); if (input.value) input.value = ''; else input.blur(); } });

  return h('li', { class: 'adder' }, arrow,
    h('form', { class: 'text', onsubmit: async e => {
        e.preventDefault();
        const parsed = parseElementLine(input.value, ARROW_TYPED[arrows]);
        if (!parsed) return;
        const ok = await run(async () => connect(el, parsed.arrow, parsed.to, parsed.type), { busy: input });
        if (ok) { pendingFocus = '#connect-line'; await reload(); }
      } }, input));
}

// With a name open and nothing focused: Enter jumps to its connection line, Escape closes it.
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !project || !document.querySelector('li.el.open')) return;
  const active = document.activeElement;
  const typing = active && active !== document.body && active.matches('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape' && !typing) { e.preventDefault(); go(`#/p/${project.id}`); return; }
  if (e.key !== 'Enter' || (active && active !== document.body && (typing || active.matches('button, a')))) return;
  const line = document.getElementById('connect-line');
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
