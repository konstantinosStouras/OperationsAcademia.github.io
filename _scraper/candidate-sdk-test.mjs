// Integration regression: use the pinned real Firebase browser SDK, with a
// synthetic identity and intercepted callable response; no real user signs in.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const config = await readFile(new URL('../assets/oa-firebase.js', import.meta.url), 'utf8');
const sdk = config.match(/var SDK = '([^']+)'/)[1];
const parts = ['firebase-app-compat.js', 'firebase-functions-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];
const bundles = await Promise.all(parts.map(async file => {
  const response = await fetch(sdk + file, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Firebase SDK download failed: ' + response.status);
  return response.text();
}));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const page = await browser.newPage();
  await page.route('https://candidate-sdk.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Candidate SDK check</title>' }));
  let calls = 0;
  await page.route('https://europe-west1-operations-academia.cloudfunctions.net/readCandidateProfiles', route => {
    calls++;
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().headers().authorization, 'Bearer synthetic-token');
    assert.deepEqual(route.request().postDataJSON(), { data: {} });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: {
      rows: [{ id: 'synthetic-candidate', name: 'Synthetic Candidate', cvUrl: 'https://example.org/cv' }]
    } }) });
  });
  await page.goto('https://candidate-sdk.example/');
  for (const bundle of bundles.slice(0, 2)) await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    firebase.initializeApp({ projectId: 'operations-academia', apiKey: 'synthetic-key' });
    window.OAAccounts = { resolved: () => true, user: () => ({ uid: 'synthetic-user' }), onChange: () => {} };
    firebase.auth = () => ({ currentUser: { uid: 'synthetic-user' } });
    window.OAFB = { readyFunctions: () => Promise.resolve(firebase) };
    const functions = firebase.app().functions('europe-west1');
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

  // Exercise the actual shared loader too: Functions must execute while the
  // independent Firestore download is still held, using real compat bundles.
  for (const eager of [false, true]) {
  const loading = await browser.newPage();
  await loading.route('https://candidate-sdk.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>SDK loading order</title>' }));
  let releaseFirestore;
  const firestoreGate = new Promise(resolve => { releaseFirestore = resolve; });
  await loading.route(sdk + '*', async route => {
    const part = route.request().url().slice(sdk.length);
    if (part === 'firebase-firestore-compat.js') await firestoreGate;
    return route.fulfill({ contentType: 'text/javascript', body: bundles[parts.indexOf(part)] });
  });
  await loading.goto('https://candidate-sdk.example/');
  await loading.addScriptTag({ content: (eager ? "document.currentScript.setAttribute('data-oa-early', '');\n" : '') + config });
  const early = await loading.evaluate(async () => {
    window.__fullSdkReady = false;
    OAFB.ready().then(() => { window.__fullSdkReady = true; });
    const first = OAFB.readyFunctions(), second = OAFB.readyFunctions();
    const fb = await first;
    return { shared: first === second, full: window.__fullSdkReady,
      auth: typeof fb.auth, callable: typeof fb.app().functions('us-central1').httpsCallable('readCandidateProfiles') };
  });
  assert.deepEqual(early, { shared: true, full: false, auth: 'function', callable: 'function' },
    'real Functions SDK is ready before Firestore, with concurrent SDK requests deduplicated');
  releaseFirestore();
  await loading.waitForFunction(() => window.__fullSdkReady);
  assert.equal(await loading.evaluate(() => typeof firebase.firestore), 'function', 'existing full-SDK consumers still get Firestore');
  await loading.close();
  }
  console.log('candidate SDK: authenticated callable, early Auth/Functions loading, shared SDK requests and full-SDK compatibility passed');
} finally { await browser.close(); }
