const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../assets/oa-jobreview.js'), 'utf8');
const context = { window: {}, document: { readyState: 'loading', addEventListener() {} } };
vm.runInNewContext(source.replace('  function boot() {', '  window.testJobs = { readUser: readUser, userCardHtml: userCardHtml };\n  function boot() {'), context);
const rows = [
  { id: 'new', data: () => ({ status: 'queued' }) },
  { id: 'old', data: () => ({ status: 'published', reviewedAt: '2026-10-28' }) },
  { id: 'hidden', data: () => ({ status: 'hidden' }) },
  { id: 'withdrawn', data: () => ({ status: 'withdrawn' }) }
];
const db = { collection: () => ({ where: (field, op, value) => ({ get: async () => ({ docs: rows.filter(r => r.data()[field] === value) }) }) }) };
(async () => {
  const result = await context.window.testJobs.readUser(db);
  assert.deepEqual(Array.from(result.items, r => r.id).sort(), ['new', 'old']);
  assert.deepEqual(Array.from(result.hidden, r => r.id), ['hidden']);
  const html = context.window.testJobs.userCardHtml({ id: 'new', data: {
    firstName: '<Ada>', lastName: 'Lovelace', email: 'contact@example.org', authEmail: 'account@example.org'
  } });
  assert(html.includes('&lt;Ada&gt; Lovelace'));
  assert(html.includes('contact@example.org') && html.includes('account@example.org'));
  assert(!html.includes('Mark reviewed') && !html.includes('data-act="approve"'));
  assert(html.includes('data-act="takedown"') && html.includes('Open &amp; correct'));
  const { renderAlertEmail } = await import(pathToFileURL(path.join(__dirname, 'alerts-mailer.mjs')));
  const { publicRow } = await import(pathToFileURL(path.join(__dirname, 'jobs-model.mjs')));
  const privateJob = { id: 'private-test', year: 2027, institution: 'Example University',
    department: 'Operations', firstName: 'PrivateGivenName', lastName: 'PrivateFamilyName',
    email: 'private-contact@example.org', authEmail: 'private-account@example.org', uid: 'private-user-id' };
  const subscriberEmail = renderAlertEmail({ alert: { id: 'test', name: 'Jobs' },
    jobs: [privateJob], updates: [] });
  const published = JSON.stringify(publicRow(privateJob));
  for (const field of ['firstName', 'lastName', 'email', 'authEmail', 'uid']) {
    assert(!subscriberEmail.includes(privateJob[field]), 'subscriber email excludes ' + field);
    assert(!published.includes(privateJob[field]), 'public jobs exclude ' + field);
  }
  const mailer = fs.readFileSync(path.join(__dirname, 'submissions-mailer.mjs'), 'utf8');
  assert(mailer.includes("const TO = 'operations.academia@gmail.com';"), 'private notices use only the owner mailbox');
  console.log('Member jobs: published and queued jobs remain manageable, identity escaped, no review gate.');
})().catch(e => { console.error(e); process.exitCode = 1; });
