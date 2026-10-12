import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sources = await Promise.all(['oa-adminarea.js', 'oa-submissions.js'].map(name =>
  readFile(new URL('../assets/' + name, import.meta.url), 'utf8')));
const flush = () => new Promise(resolve => setImmediate(resolve));

function element() {
  return {
    hidden: false, dataset: {}, children: [], listeners: {}, html: '',
    get innerHTML() { return this.html; },
    set innerHTML(value) { this.html = value; this.children = []; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); },
    querySelector() { return this.details || null; }
  };
}

async function page(docs, revealed) {
  const elements = Object.fromEntries(['oa-aa', 'oa-aa-admin', 'oa-aa-guest',
    'oa-aa-tiles', 'oa-aa-cands-list', 'oa-subs', 'oa-subs-list', 'oa-subs-count']
    .map(id => [id, element()]));
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
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); }
    },
    CustomEvent: class { constructor(type) { this.type = type; } },
    OAAccounts: { onChange(fn) { auth.push(fn); }, isAdmin: () => true, setCount() {} },
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
  auth.forEach(fn => fn({ uid: 'admin' }));
  await flush();
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
