// Integration regression: use the pinned real Firebase browser SDK, with a
// synthetic identity and intercepted callable response; no real user signs in.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const config = await readFile(new URL('../assets/oa-firebase.js', import.meta.url), 'utf8');
const sdk = config.match(/var SDK = '([^']+)'/)[1];
const bundles = await Promise.all(['firebase-app-compat.js', 'firebase-functions-compat.js'].map(async file => {
  const response = await fetch(sdk + file, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Firebase SDK download failed: ' + response.status);
  return response.text();
}));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const page = await browser.newPage();
  await page.route('https://candidate-sdk.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Candidate SDK check</title>' }));
  let calls = 0;
  await page.route('https://us-central1-operations-academia.cloudfunctions.net/readCandidateProfiles', route => {
    calls++;
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().headers().authorization, 'Bearer synthetic-token');
    assert.deepEqual(route.request().postDataJSON(), { data: {} });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: {
      rows: [{ id: 'synthetic-candidate', name: 'Synthetic Candidate', cvUrl: 'https://example.org/cv' }]
    } }) });
  });
  await page.goto('https://candidate-sdk.example/');
  for (const bundle of bundles) await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    firebase.initializeApp({ projectId: 'operations-academia', apiKey: 'synthetic-key' });
    window.OAAccounts = { resolved: () => true, user: () => ({ uid: 'synthetic-user' }), onChange: () => {} };
    firebase.auth = () => ({ currentUser: { uid: 'synthetic-user' } });
    window.OAFB = { readyFunctions: () => Promise.resolve(firebase) };
    const functions = firebase.app().functions('us-central1');
    functions._delegate.contextProvider.auth = { getToken: async () => ({ accessToken: 'synthetic-token' }) };
  });
  const oldCallFails = await page.evaluate(() => {
    try { firebase.functions('us-central1'); return false; } catch { return true; }
  });
  assert.equal(oldCallFails, true, 'real SDK rejects a region passed as the app argument');
  await page.addScriptTag({ content: await readFile(new URL('../assets/oa-candidate-data.js', import.meta.url), 'utf8') });
  const rows = await page.evaluate(() => OACandidateData.load());
  assert.equal(rows[0].name, 'Synthetic Candidate');
  assert.equal(rows[0].cvUrl, 'https://example.org/cv');
  assert.equal(calls, 1, 'loader reaches the authenticated callable with the real SDK');
  console.log('candidate SDK: real Firebase compat client sends authenticated request and loads full profiles; former invalid app call rejected');
} finally { await browser.close(); }
