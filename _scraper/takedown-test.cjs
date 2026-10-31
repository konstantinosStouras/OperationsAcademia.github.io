// Offline integration check: deployed scripts run with in-memory DOM/database.
// No network, credentials, Firebase SDK, or production database is available.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const jobs = JSON.parse(fs.readFileSync(path.join(root, 'data/jobs.json'), 'utf8'));
const scripts = ['oa-takedown', 'oa-jobedit'].map(name => fs.readFileSync(path.join(root, 'assets', name + '.js'), 'utf8'));
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.textContent = ''; this.disabled = false; this.events = {}; }
  has(cls) { return this.className.split(/\s+/).includes(cls); }
  classList = {
    add: cls => { if (!this.has(cls)) this.className += ' ' + cls; },
    toggle: (cls, on) => { this.className = this.className.split(/\s+/).filter(x => x !== cls).join(' '); if (on) this.className += ' ' + cls; },
  };
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(selector) { const cls = selector.slice(1); for (const child of this.children) { if (child.has(cls)) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
  closest(selector) { return this.has(selector.slice(1)) ? this : this.parent?.closest(selector); }
  addEventListener(type, callback) { this.events[type] = callback; }
  click() { if (!this.disabled) this.events.click({ preventDefault() {}, stopPropagation() {} }); }
}
function harness({ admin = true, confirm = true, fail = false, repairFail = false } = {}) {
  const docs = new Map(), calls = [], echoes = [], confirmations = [], errors = [];
  const db = {
    collection(name) {
      assert.equal(name, 'jobSubmissions');
      return { doc(id) { return { id, update: async patch => {
        calls.push({ action: 'update', id, patch });
        if (fail) throw Object.assign(new Error('simulated refusal'), { code: 'permission-denied' });
        assert(docs.has(id), 'update never creates a replacement document');
        docs.set(id, { ...docs.get(id), ...patch });
      } }; } };
    },
    runTransaction: async callback => {
      if (repairFail) throw new Error('simulated unavailable editing record');
      return callback({
        get: async ref => ({ exists: docs.has(ref.id), data: () => docs.get(ref.id) }),
        set: (ref, value) => { calls.push({ action: 'create-handle', id: ref.id }); docs.set(ref.id, value); },
      });
    },
  };
  const window = {};
  const context = vm.createContext({ window, document: { createElement: tag => new Element(tag) },
    console: { error: (...args) => errors.push(args) },
  }, { codeGeneration: { strings: false, wasm: false } });
  window.OAFB = context.OAFB = { ready: async () => ({ firestore: () => db }), col: { jobSubmissions: 'jobSubmissions' } };
  window.OAAccounts = context.OAAccounts = { isAdmin: () => admin };
  window.OAFresh = context.OAFresh = { ...require(path.join(root, 'assets/oa-fresh.js')), stash: entry => echoes.push(entry) };
  window.confirm = message => { confirmations.push(message); return confirm; };
  vm.runInContext(scripts[0], context);
  context.OATakedown = window.OATakedown;
  vm.runInContext(scripts[1], context);
  function card(row, id, missing = false) {
    if (!missing) docs.set(id, { uid: admin ? null : 'test-owner', publishedId: row.id, ref: row.ref || '', owner: row.owner || '', status: 'published', createdAt: 'unchanged' });
    const byId = missing ? {} : { [id]: id };
    window.OAJobEdit.__setPermissionsForTest({ ready: true, admin, byId,
      bySheetId: !missing ? { [row.sourceId || row.id]: id } : {},
      byRef: !missing && row.ref ? { [row.ref]: id } : {} });
    const li = new Element('li'); li.className = 'oa-card';
    window.OAJobEdit.onCard(li, row);
    assert.equal(li.querySelector('.oa-jobbtn-del')?.textContent, 'Take down');
    return { li, button: li.querySelector('.oa-jobbtn-del') };
  }
  return { docs, calls, echoes, confirmations, card, context, errors };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const { removalSpecs, specMatches, mergeRows } = await import(pathToFileURL(path.join(root, '_scraper/jobs-model.mjs')));
  let cancellations = 0, existing = 0, repairs = 0, failures = 0, publisher = 0;
  const targetingIssues = [];
  for (const [index, row] of jobs.entries()) {
    // Cancellation must precede all writes, including missing-handle repair.
    for (const missing of [false, true]) {
      const h = harness({ confirm: false });
      const { li, button } = h.card(row, missing ? row.sourceId || row.id : 'fixture-' + index, missing);
      button.click(); await settle();
      assert.equal(h.confirmations.length, 1);
      assert(h.confirmations[0].includes(row.institution));
      assert.equal(h.calls.length, 0); assert.equal(h.echoes.length, 0);
      assert.equal(button.disabled, false); assert(!li.has('oa-card-gone'));
      cancellations++;
    }
    // Exercise the deployed button, shared write helper, UI result and publisher.
    for (const missing of [false, true]) {
      const h = harness();
      const id = missing ? row.sourceId || row.id : 'fixture-' + index;
      const { li, button } = h.card(row, id, missing);
      button.click(); assert.equal(button.disabled, true); button.click();
      await settle();
      const writes = h.calls.filter(c => c.action === 'update');
      assert.equal(writes.length, 1); assert.equal(writes[0].id, id);
      assert.equal(writes[0].patch.status, 'hidden');
      assert(Number.isFinite(Date.parse(writes[0].patch.updatedAt)));
      assert.deepEqual(Object.keys(writes[0].patch).sort(), ['status', 'updatedAt']);
      assert.equal(h.calls.filter(c => c.action === 'create-handle').length, missing ? 1 : 0);
      assert.equal(button.textContent, 'Taken down'); assert(li.has('oa-card-gone'));
      assert.equal(h.echoes.length, 1); assert.equal(h.echoes[0].docId, id); assert.equal(h.echoes[0].removed, true);
      assert(li.querySelector('.oa-card-note').textContent.includes('Nothing') === false);
      const document = { id, data: () => h.docs.get(id) };
      const removal = removalSpecs([document]);
      assert(removal.specs.some(spec => specMatches(spec, row)), 'publisher can remove ' + row.id);
      const otherRows = jobs.filter(r => r.id !== row.id);
      const accidentallyMatched = otherRows.filter(r => removal.specs.some(spec => specMatches(spec, r)));
      // build-jobs protects freshly rebuilt siblings by filtering removal IDs.
      // Carried-forward siblings (missing live records) have no such protection.
      const builtIds = new Set(otherRows.map(r => r.id));
      const normalRemoval = removal.specs.filter(spec => !spec.id || !builtIds.has(spec.id));
      assert(!otherRows.some(r => normalRemoval.some(spec => specMatches(spec, r))));
      if (accidentallyMatched.length) targetingIssues.push({ posting: row.id,
        scenario: (missing ? 'missing-handle repair' : 'existing handle') + ' with a colliding carried-forward sibling',
        rebuiltSiblingProtected: true,
        alsoMatches: accidentallyMatched.map(r => r.id) });
      const unrelated = { ...row, id: 'isolated-unrelated', ref: 'UNRELATED', owner: 'other-owner', institution: 'Unrelated Test University' };
      const published = mergeRows([row, unrelated], [], removal.specs).rows;
      assert(!published.some(r => r.id === row.id));
      assert(published.some(r => r.id === unrelated.id));
      publisher++;
      if (missing) repairs++; else { existing++; assert.equal(h.docs.get(id).createdAt, 'unchanged'); }
    }
    const h = harness({ fail: true });
    const { li, button } = h.card(row, 'fixture-' + index);
    button.click(); await settle();
    assert.equal(button.textContent, 'Take down'); assert.equal(button.disabled, false);
    assert(!li.has('oa-card-gone')); assert.equal(h.echoes.length, 0);
    assert.equal(h.docs.get('fixture-' + index).status, 'published');
    assert(li.querySelector('.oa-card-note').textContent.includes('not allowed'));
    failures++;
  }
  const owner = harness({ admin: false });
  owner.card({ id: 'test-owner-job', institution: 'Test University', ref: 'TEST-OWNER' }, 'owned-test').button.click();
  await settle(); assert.equal(owner.docs.get('owned-test').status, 'withdrawn');
  const broken = harness({ repairFail: true });
  const b = broken.card({ id: 'test-missing-job', institution: 'Test University' }, 'test-missing-job', true);
  b.button.click(); await settle();
  assert.equal(b.button.disabled, false); assert.equal(b.button.textContent, 'Take down');
  assert.equal(broken.calls.length, 0); assert.equal(broken.echoes.length, 0); assert(!b.li.has('oa-card-gone'));
  const report = { source: 'Repository scripts with simulated DOM and database', jobs: jobs.length,
    cancelledWithoutWrites: cancellations, successfulExistingRecords: existing, successfulMissingHandleRepairs: repairs,
    refusedWritesRecover: failures, publisherCasesExecuted: publisher, normalRebuiltSiblingsProtected: 'passed', posterWithdrawal: 'passed',
    unavailableHandleRecovery: 'passed', productionWrites: 0, networkAvailableInsideTest: false,
    targetingIssues, result: targetingIssues.length ? 'FAIL' : 'PASS' };
  assert.equal(targetingIssues.length, 0, 'a takedown must never match a different carried-forward posting');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
