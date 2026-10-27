import '@fontsource/kalam/400.css';
import '@fontsource/kalam/700.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import './style.css';
import { supabase, fetchAll, describeError } from './supabase.js';
import { h, toast, typeTint, setTypeOrder } from './dom.js';
import { egoMap } from './map.js';

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
        show(shell(h('p', { class: 'muted' }, 'Opening project…')));
        await loadProject(r.projectId);
      }
      if (!project) return;
      return show(shell(projectView(r.elementId)));
    }
    project = null;
    show(shell(h('p', { class: 'muted' }, 'Loading your projects…')));
    show(shell(await projectsView()));
  } catch (error) {
    show(shell(h('div', { class: 'empty' },
      h('h2', {}, "This page couldn't load"),
      h('p', {}, describeError(error)),
      h('a', { href: '#/' }, 'Back to your projects'))));
  }
}

function show(node) {
  app.replaceChildren(node);
  if (pendingFocus) { app.querySelector(pendingFocus)?.focus(); pendingFocus = null; }
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

// ---------------------------------------------------------------- sign in

function signInView() {
  const email = h('input', { id: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Email me a sign-in link');
  const card = h('div', { class: 'signin card' });

  const askForEmail = () => card.replaceChildren(
    h('h1', { class: 'brand-lg' }, 'Relationship CRM'),
    h('p', { class: 'lede' }, "Track the people and organizations in your world, and how they're connected."),
    h('form', { onsubmit: send },
      h('label', { for: 'email' }, 'Email'),
      email, button),
    h('p', { class: 'fine' }, 'No password needed. We email you a link that signs you in.'),
  );

  async function send(e) {
    e.preventDefault();
    const address = email.value.trim();
    const ok = await run(async () => must(await supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: location.origin + location.pathname },
    })), { busy: button });
    if (!ok) return;
    card.replaceChildren(
      h('h1', { class: 'brand-lg' }, 'Check your email'),
      h('p', { class: 'lede' }, 'We sent a sign-in link to ', h('strong', {}, address), '. Open it in this browser to continue.'),
      IS_LOCAL && h('p', { class: 'fine' }, 'Running locally: the email is in the ',
        h('a', { href: 'http://127.0.0.1:54324', target: '_blank', rel: 'noopener' }, 'test inbox'), '.'),
      h('button', { class: 'link', onclick: () => { askForEmail(); email.focus(); } }, 'Use a different email'),
    );
  }

  askForEmail();
  pendingFocus = '#email';
  return h('main', { class: 'center' }, card);
}

// ---------------------------------------------------------------- shell

function shell(content) {
  return h('div', { class: 'page' },
    h('header', { class: 'top' },
      h('a', { class: 'brand', href: '#/' }, 'Relationship CRM'),
      h('div', { class: 'who' },
        h('span', { class: 'muted' }, session.user.email),
        h('button', { class: 'link', onclick: () => supabase.auth.signOut() }, 'Sign out'))),
    h('main', {}, content));
}

// ---------------------------------------------------------------- projects list

async function projectsView() {
  const projects = must(await supabase.from('projects')
    .select('id, name, updated_at, elements(count), connections(count)')
    .order('updated_at', { ascending: false }));

  const name = h('input', { id: 'new-project', required: true, maxlength: 120, placeholder: 'e.g. Board members, Neighborhood partners' });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Create project');
  const create = async e => {
    e.preventDefault();
    let created;
    const ok = await run(async () => { created = must(await supabase.rpc('create_project', { p_name: name.value })); }, { busy: button });
    if (ok) go(`#/p/${created.id}`);
  };

  return h('section', { class: 'projects' },
    h('h1', {}, 'Your projects'),
    h('form', { class: 'inline', onsubmit: create },
      h('label', { for: 'new-project', class: 'sr' }, 'New project name'), name, button),
    projects.length
      ? h('ul', { class: 'notes' }, projects.map((p, i) => h('li', {},
          h('a', { class: `note tint-${(i % 6) + 1}`, href: `#/p/${p.id}` },
            h('strong', {}, p.name),
            h('span', {}, plural(p.elements[0]?.count ?? 0, 'element'), ' · ', plural(p.connections[0]?.count ?? 0, 'connection')),
            h('small', {}, 'Updated ', new Date(p.updated_at).toLocaleDateString())))))
      : h('div', { class: 'empty' },
          h('h2', {}, 'No projects yet'),
          h('p', {}, 'A project holds one map of relationships. Name your first one above.')));
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- project data

async function loadProject(id) {
  const [info, membership, elements, connections] = await Promise.all([
    supabase.from('projects').select('id, name').eq('id', id).maybeSingle().then(must),
    supabase.from('project_members').select('role').eq('project_id', id).eq('user_id', session.user.id).maybeSingle().then(must),
    fetchAll(() => supabase.from('elements').select('id, label, element_type, description, created_at').eq('project_id', id).order('label')),
    fetchAll(() => supabase.from('connections').select('id, from_element_id, to_element_id, connection_type, direction, description').eq('project_id', id).order('created_at')),
  ]);
  if (!info) {
    project = null;
    show(shell(h('div', { class: 'empty' },
      h('h2', {}, 'Project not found'),
      h('p', {}, "It may have been deleted, or you don't have access to it."),
      h('a', { href: '#/' }, 'Back to your projects'))));
    return;
  }
  project = { ...info, role: membership?.role ?? 'viewer', elements: new Map(elements.map(e => [e.id, e])), connections };
  setTypeOrder([...elements].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(e => e.element_type));
}
const reload = async () => { await loadProject(project.id); render(); };
const canEdit = () => project.role === 'owner' || project.role === 'editor';

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

// ---------------------------------------------------------------- project view

function projectView(elementId) {
  const selected = elementId ? project.elements.get(elementId) : null;
  return h('div', { class: 'workspace' },
    elementsPanel(selected),
    h('section', { class: 'detail' },
      selected ? elementDetail(selected)
        : elementId ? h('div', { class: 'empty' }, h('h2', {}, 'Element not found'), h('p', {}, 'It may have been deleted.'))
        : projectOverview()));
}

function elementsPanel(selected) {
  const elements = [...project.elements.values()];
  const counts = new Map();
  for (const c of project.connections) for (const id of [c.from_element_id, c.to_element_id]) counts.set(id, (counts.get(id) || 0) + 1);

  const items = elements.map(e => h('li', { dataset: { search: `${e.label} ${e.element_type || ''}`.toLowerCase() } },
    h('a', { href: `#/p/${project.id}/e/${e.id}`, class: e.id === selected?.id ? 'current' : null, 'aria-current': e.id === selected?.id ? 'page' : null },
      h('span', { class: `dot tint-${typeTint(e.element_type)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'label' }, e.label),
      e.element_type && h('span', { class: 'type' }, e.element_type),
      h('span', { class: 'count', title: plural(counts.get(e.id) || 0, 'connection') }, counts.get(e.id) || 0))));
  const list = h('ul', { class: 'element-list' }, items);
  const noMatch = h('p', { class: 'muted', hidden: true }, 'No elements match.');
  const filter = h('input', { id: 'filter', type: 'search', placeholder: 'Filter elements', 'aria-label': 'Filter elements',
    oninput: () => {
      const q = filter.value.trim().toLowerCase();
      let any = false;
      for (const li of items) { li.hidden = !!q && !li.dataset.search.includes(q); any ||= !li.hidden; }
      noMatch.hidden = any || !elements.length;
    } });

  return h('aside', { class: 'elements' },
    h('a', { class: 'project-name', href: `#/p/${project.id}` }, project.name),
    canEdit() && addElementForm(),
    elements.length > 6 && filter,
    elements.length ? list : h('p', { class: 'muted' }, 'No elements yet. Add a person, organization, or idea above.'),
    noMatch);
}

function typeOptions(id, values) {
  return h('datalist', { id }, [...new Set(values.filter(Boolean))].sort().map(v => h('option', { value: v })));
}

function addElementForm() {
  const label = h('input', { id: 'new-element-label', required: true, maxlength: 200, placeholder: 'Name' , 'aria-label': 'Element name' });
  const type = h('input', { id: 'new-element-type', maxlength: 60, placeholder: 'Type (optional)', list: 'element-types', 'aria-label': 'Element type' });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Add');
  return h('form', { class: 'add-element', onsubmit: async e => {
      e.preventDefault();
      const ok = await run(async () => must(await supabase.from('elements').insert({
        project_id: project.id, label: label.value.trim(), element_type: type.value.trim() || null,
      })), { busy: button, success: `Added ${label.value.trim()}` });
      if (ok) { pendingFocus = '#new-element-label'; await reload(); }
    } },
    label, type, button,
    typeOptions('element-types', [...project.elements.values()].map(e => e.element_type)));
}

function projectOverview() {
  const editable = project.role === 'owner' || project.role === 'editor';
  const name = h('input', { id: 'project-name', value: project.name, maxlength: 120, required: true, 'aria-label': 'Project name', disabled: !editable });
  const save = h('button', { type: 'submit', disabled: true }, 'Rename');
  name.addEventListener('input', () => { save.disabled = !name.value.trim() || name.value.trim() === project.name; });

  return h('div', { class: 'overview' },
    h('form', { class: 'title-form', onsubmit: async e => {
        e.preventDefault();
        if (await run(async () => must(await supabase.from('projects').update({ name: name.value.trim() }).eq('id', project.id)), { busy: save, success: 'Project renamed' })) await reload();
      } },
      name, editable && save),
    h('p', { class: 'stats' }, plural(project.elements.size, 'element'), ' · ', plural(project.connections.length, 'connection'),
      ' · You are ', project.role === 'owner' ? 'the owner' : `a${project.role === 'editor' ? 'n' : ''} ${project.role}`),
    h('div', { class: 'empty' },
      h('h2', {}, project.elements.size ? 'Pick an element' : 'Start with a few elements'),
      h('p', {}, project.elements.size
        ? 'Choose an element on the left to see its connections and add new ones.'
        : 'Add the people, organizations or ideas in this project. Then open one to connect it to the others.')),
    project.role === 'owner' && dangerButton('Delete project', `Delete “${project.name}” and everything in it`, async () => {
      must(await supabase.from('projects').delete().eq('id', project.id));
      project = null;
      toast('Project deleted');
      go('#/');
    }));
}

// Two-step destructive button: the first click arms it for five seconds.
function dangerButton(label, confirmLabel, action) {
  const button = h('button', { class: 'danger', type: 'button' }, label);
  let armed = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = `${confirmLabel}?`;
      button.classList.add('armed');
      armed = setTimeout(() => { armed = null; button.textContent = label; button.classList.remove('armed'); }, 5000);
      return;
    }
    clearTimeout(armed);
    await run(action, { busy: button });
  });
  return h('div', { class: 'danger-zone' }, button);
}

// ---------------------------------------------------------------- element detail

function elementDetail(el) {
  const editable = canEdit();
  const links = connectionsOf(el.id);
  const label = h('input', { id: 'el-label', value: el.label, maxlength: 200, required: true, disabled: !editable, 'aria-label': 'Name' });
  const type = h('input', { id: 'el-type', value: el.element_type || '', maxlength: 60, list: 'element-types-detail', disabled: !editable, placeholder: 'Type' });
  const desc = h('textarea', { id: 'el-desc', maxlength: 5000, rows: 3, disabled: !editable, placeholder: editable ? 'Notes about this element' : '' });
  desc.value = el.description || '';
  const save = h('button', { type: 'submit', disabled: true }, 'Save changes');
  const dirty = () => { save.disabled = !label.value.trim() || (label.value === el.label && type.value === (el.element_type || '') && desc.value === (el.description || '')); };
  for (const f of [label, type, desc]) f.addEventListener('input', dirty);

  const form = h('form', { class: 'element-form', onsubmit: async e => {
      e.preventDefault();
      if (await run(async () => must(await supabase.from('elements').update({
        label: label.value.trim(), element_type: type.value.trim() || null, description: desc.value.trim() || null,
      }).eq('id', el.id)), { busy: save, success: 'Saved' })) await reload();
    } },
    h('div', { class: 'title-row' }, h('span', { class: `dot lg tint-${typeTint(el.element_type)}`, 'aria-hidden': 'true' }), label),
    h('div', { class: 'field-row' },
      h('label', { for: 'el-type' }, 'Type'), type,
      typeOptions('element-types-detail', [...project.elements.values()].map(e => e.element_type))),
    h('label', { for: 'el-desc' }, 'Notes'), desc,
    editable && h('div', { class: 'actions' }, save));

  return h('article', { class: 'element' },
    form,
    h('figure', { class: 'map card' },
      egoMap(el, links.map(c => ({ id: c.other.id, label: c.other.label, type: c.other.element_type, arrows: c.arrows })),
        id => go(`#/p/${project.id}/e/${id}`))),
    h('h2', {}, 'Connections ', h('span', { class: 'muted' }, `(${links.length})`)),
    editable && addConnectionForm(el),
    links.length
      ? h('ul', { class: 'connection-list' }, links.map(c => connectionRow(c, editable)))
      : h('p', { class: 'muted' }, 'No connections yet.'),
    editable && dangerButton('Delete element', `Delete ${el.label} and its ${plural(links.length, 'connection')}`, async () => {
      must(await supabase.from('elements').delete().eq('id', el.id));
      toast(`Deleted ${el.label}`);
      await loadProject(project.id);
      go(`#/p/${project.id}`);
    }));
}

const ARROW = { out: '→', in: '←', both: '↔', none: '—' };

function connectionRow(c, editable) {
  return h('li', {},
    h('span', { class: 'arrow', title: { out: 'Outgoing', in: 'Incoming', both: 'Mutual', none: 'No direction' }[c.arrows] }, ARROW[c.arrows]),
    h('a', { href: `#/p/${project.id}/e/${c.other.id}` },
      h('span', { class: `dot tint-${typeTint(c.other.element_type)}`, 'aria-hidden': 'true' }), c.other.label),
    c.connection_type && h('span', { class: 'chip' }, c.connection_type),
    c.description && h('span', { class: 'muted small' }, c.description),
    editable && h('button', { class: 'link remove', type: 'button', 'aria-label': `Remove connection to ${c.other.label}`,
      onclick: async e => {
        if (await run(async () => must(await supabase.from('connections').delete().eq('id', c.id)), { busy: e.currentTarget, success: 'Connection removed' })) await reload();
      } }, 'Remove'));
}

function addConnectionForm(el) {
  const others = [...project.elements.values()].filter(e => e.id !== el.id);
  const target = h('input', { id: 'conn-target', required: true, maxlength: 200, list: 'conn-targets', autocomplete: 'off', placeholder: 'Type a name' });
  const type = h('input', { id: 'conn-type', maxlength: 60, list: 'conn-types', placeholder: 'e.g. mentor, funds, knows' });
  const direction = h('select', { id: 'conn-dir' },
    h('option', { value: 'out' }, `${el.label} → other`),
    h('option', { value: 'in' }, `other → ${el.label}`),
    h('option', { value: 'mutual' }, 'Both ways'),
    h('option', { value: 'undirected' }, 'No direction'));
  const hint = h('p', { class: 'fine', hidden: true });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Add connection');

  const match = () => {
    const q = target.value.trim().toLowerCase();
    return others.find(e => e.label.toLowerCase() === q);
  };
  target.addEventListener('input', () => {
    const name = target.value.trim();
    hint.hidden = !name || !!match();
    hint.textContent = `“${name}” isn't in this project yet. Adding the connection will create it.`;
  });

  return h('form', { class: 'add-connection card', onsubmit: async e => {
      e.preventDefault();
      const ok = await run(async () => {
        let other = match();
        if (!other) {
          other = must(await supabase.from('elements').insert({ project_id: project.id, label: target.value.trim() }).select('id').single());
        }
        const [from, to] = direction.value === 'in' ? [other.id, el.id] : [el.id, other.id];
        must(await supabase.from('connections').insert({
          project_id: project.id, from_element_id: from, to_element_id: to,
          connection_type: type.value.trim() || null,
          direction: ['mutual', 'undirected'].includes(direction.value) ? direction.value : 'directed',
        }));
      }, { busy: button, success: 'Connection added' });
      if (ok) { pendingFocus = '#conn-target'; await reload(); }
    } },
    h('div', { class: 'grid' },
      h('div', {}, h('label', { for: 'conn-target' }, 'Connect to'), target),
      h('div', {}, h('label', { for: 'conn-type' }, 'Kind of connection'), type),
      h('div', {}, h('label', { for: 'conn-dir' }, 'Direction'), direction),
      h('div', { class: 'submit' }, button)),
    hint,
    h('datalist', { id: 'conn-targets' }, others.map(o => h('option', { value: o.label }, o.element_type || ''))),
    typeOptions('conn-types', project.connections.map(c => c.connection_type)));
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
