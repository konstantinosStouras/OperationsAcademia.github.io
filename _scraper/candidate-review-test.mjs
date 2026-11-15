import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sources = await Promise.all(['oa-adminarea.js', 'oa-submissions.js'].map(name =>
  readFile(new URL('../assets/' + name, import.meta.url), 'utf8')));
const flush = () => new Promise(resolve => setImmediate(resolve));

// Only the DOM operations used by these two widgets. In particular, moving
// nodes and toggling <details> must work: the admin roster now loads on open.
function element(tagName = 'div') {
  const node = {
    tagName, className: '', hidden: false, dataset: {}, children: [], listeners: {}, html: '', attributes: {},
    get innerHTML() { return this.html; },
    set innerHTML(value) { this.html = value; this.children.forEach(child => { child.parent = null; }); this.children = []; },
    get firstChild() { return this.children[0] || null; },
    get open() { return !!this.isOpen; },
    set open(value) {
      if (!!value === this.open) return;
      this.isOpen = !!value;
      queueMicrotask(() => this.listeners.toggle?.({ target: this }));
    },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] ?? null; },
    removeAttribute(key) { delete this.attributes[key]; },
    appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; },
    insertBefore(child, before) {
      if (!before) return this.appendChild(child);
      child.remove(); child.parent = this; this.children.splice(this.children.indexOf(before), 0, child); return child;
    },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    querySelectorAll(selector) {
      const direct = selector.startsWith(':scope > ');
      const target = direct ? selector.slice(9) : selector;
      const matches = child => target.startsWith('.')
        ? child.className.split(/\s+/).includes(target.slice(1)) : child.tagName === target;
      return this.children.flatMap(child => [
        ...(matches(child) ? [child] : []), ...(direct ? [] : child.querySelectorAll(selector))
      ]);
    },
    querySelector(selector) {
      if (selector === '.oa-aa-cands-reviewed') return this.details || null;
      return this.querySelectorAll(selector)[0] || null;
    }
  };
  node.classList = { add(name) { node.className = [node.className, name].filter(Boolean).join(' '); } };
  return node;
}

async function page(docs, revealed) {
  const elements = Object.fromEntries(['oa-aa', 'oa-aa-admin', 'oa-aa-guest',
    'oa-aa-tiles', 'oa-aa-cands', 'oa-aa-cands-list', 'oa-subs', 'oa-subs-list', 'oa-subs-count']
    .map(id => [id, Object.assign(element(), { id })]));
  const panel = elements['oa-aa-cands'];
  panel.className = 'oa-panel';
  panel.appendChild(Object.assign(element('h2'), { className: 'oa-panel-h' }));
  panel.appendChild(elements['oa-aa-cands-list']);
  elements['oa-aa-admin'].appendChild(panel);
  const auth = [], listeners = {}, writes = [];
  let failWrite = false;
  const db = { collection(name) {
    let liveOnly = false;
    return {
      where() { liveOnly = true; return this; },
      count() { return { get: async () => ({ data: () => ({ count: 0 }) }) }; },
      async get() {
        const rows = name === 'candidateSubmissions' ? Object.entries(docs)
          .filter(([, d]) => !liveOnly || ['queued', 'published'].includes(d.status))
          .map(([id, d]) => ({ id, data: () => ({ ...d }) })) : [];
        return { docs: rows, forEach(fn) { rows.forEach(fn); } };
      },
      doc(id) { return { async update(patch) {
        if (failWrite) throw { code: 'permission-denied' };
        assert.ok(docs[id], 'review updates an existing profile');
        writes.push({ id, patch: { ...patch } });
        Object.assign(docs[id], patch);
      } }; }
    };
  } };
  const context = {
    document: {
      readyState: 'complete', getElementById: id => elements[id] || null,
      createElement: element,
      querySelectorAll: () => [], // Both widget scripts are loaded directly below.
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(listener => listener !== fn); },
      dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); }
    },
    // Periodic count refresh is covered by admin-live-counts-test.cjs; this
    // isolated review test has no wall-clock timers or network connections.
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    OAAccounts: { onChange(fn) { auth.push(fn); }, isAdmin: () => true, user: () => ({ uid: 'admin' }), setCount() {} },
    OAFB: { ready: async () => ({ firestore: () => db }), col: {
      candidateSubmissions: 'candidateSubmissions', feedback: 'feedback',
      messages: 'messages', registered: 'registered'
    } },
    OAReveal: { isRevealed: () => revealed,
      describeReveal: () => ({ revealed, utc: '14:00 UTC', dayLong: 'October 11' }) },
    fetch: async () => ({ ok: true, json: async () => ({ revealAt: '2026-10-11', heldCount: 2 }) })
  };
  context.window = context;
  vm.createContext(context);
  sources.forEach(source => vm.runInContext(source, context));
  const disclosure = panel.querySelector('.oa-aa-section');
  assert.ok(disclosure, 'admin boot wraps the candidate roster in a disclosure');
  assert.equal(elements['oa-aa-cands-list'].innerHTML, '', 'roster is not rendered before admission');
  // Touching a closed section prevents a later count from auto-opening it.
  disclosure.querySelector('summary').listeners.click();
  auth.forEach(fn => fn({ uid: 'admin' }));
  await flush();
  assert.equal(elements['oa-aa-guest'].hidden, true, 'admin initialization succeeds');
  assert.equal(disclosure.open, false);
  assert.equal(elements['oa-aa-cands-list'].innerHTML, '', 'closed roster stays lazy after admission');
  disclosure.open = true;
  await flush();
  assert.equal(panel.getAttribute('aria-busy'), null, 'opening the section completes its load');
  return { elements, writes, fail(value) { failWrite = value; } };
}

for (const revealed of [false, true]) {
  const docs = {
    done: { first: 'Already reviewed', status: 'published', reviewedAt: '2026-10-10T12:00:00Z' },
    next: { first: 'New profile', status: 'queued', email: 'private@example.test' }
  };
  const p = await page(docs, revealed);
  const roster = p.elements['oa-aa-cands-list'];
  assert.match(roster.innerHTML, /<details class="oa-aa-cands-reviewed"><summary>Reviewed profiles \(1\)/);
  const [pending, archived] = roster.innerHTML.split('<details');
  assert.match(pending, /New profile/);
  assert.doesNotMatch(pending, /Already reviewed/);
  assert.match(archived, /Already reviewed/);
  assert.match(archived, /data-act="edit"/);
  assert.match(archived, /data-act="takedown"/);
  assert.equal(p.elements['oa-subs-count'].textContent, '1 profile');

  const card = p.elements['oa-subs-list'].children[0];
  const message = {};
  card.querySelector = () => message;
  const button = { disabled: false };
  const click = () => card.listeners.click({ target: { closest: () => button } });
  p.fail(true);
  click();
  await flush();
  assert.equal(button.disabled, false, 'failed review can be retried');
  assert.match(message.textContent, /permission-denied/);
  assert.equal(p.elements['oa-subs-count'].textContent, '1 profile');
  assert.doesNotMatch(roster.innerHTML, /Reviewed profiles \(2\)/);

  p.fail(false);
  const before = { ...docs.next };
  roster.details = { open: true };
  click();
  await flush();
  assert.deepEqual(Object.keys(p.writes[0].patch), ['reviewedAt']);
  const { reviewedAt, ...after } = docs.next;
  assert.ok(Number.isFinite(Date.parse(reviewedAt)));
  assert.deepEqual(after, before, 'review preserves publication and profile data');
  assert.equal(p.elements['oa-subs-count'].textContent, 'nothing');
  assert.equal(p.elements['oa-subs-list'].children.length, 0);
  assert.match(p.elements['oa-subs-list'].innerHTML, /Nothing waiting/);
  assert.match(roster.innerHTML, /Nothing waiting/);
  assert.match(roster.innerHTML, /<details class="oa-aa-cands-reviewed" open><summary>Reviewed profiles \(2\)/);

  const reloaded = await page(docs, revealed);
  assert.match(reloaded.elements['oa-aa-cands-list'].innerHTML,
    /<details class="oa-aa-cands-reviewed"><summary>Reviewed profiles \(2\)/,
    'saved reviews remain collapsed after reload, before and after reveal');
  assert.equal(reloaded.elements['oa-subs-count'].textContent, 'nothing');
}
console.log('Candidate review: existing marks, immediate removal, reload, reveal, and failed writes passed.');
