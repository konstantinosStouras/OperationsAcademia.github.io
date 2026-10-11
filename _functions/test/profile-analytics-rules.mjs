import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run this test under the Firestore emulator.');
const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
const env = await initializeTestEnvironment({ projectId: 'demo-oa-analytics', firestore: { host, port: Number(port), rules: fs.readFileSync(new URL('../../_firestore.rules', import.meta.url), 'utf8') } });
try {
  const claims = { email_verified: true, email: 'owner@example.test', firebase: { sign_in_provider: 'password' } };
  const owner = env.authenticatedContext('owner', claims).firestore();
  const other = env.authenticatedContext('other', claims).firestore();
  const admin = env.authenticatedContext('admin', { ...claims, email: 'kstouras@gmail.com' }).firestore();
  const pending = env.authenticatedContext('owner', { ...claims, email_verified: false }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  for (const col of ['candidateSubmissions', 'jobSubmissions']) {
    const doc = col + '/test', report = doc + '/analytics/current';
    await env.withSecurityRulesDisabled(async ctx => { await ctx.firestore().doc(doc).set({ uid: 'owner' }); await ctx.firestore().doc(report).set({ all: { views: 42 } }); });
    await assertSucceeds(owner.doc(report).get()); await assertSucceeds(admin.doc(report).get());
    await assertFails(other.doc(report).get()); await assertFails(anon.doc(report).get()); await assertFails(pending.doc(report).get());
    await assertFails(owner.doc(report).set({ all: { views: 999 } })); await assertFails(admin.doc(report).set({ all: { views: 999 } }));
    await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc(doc).update({ uid: 'other' }));
    await assertFails(owner.doc(report).get()); await assertSucceeds(other.doc(report).get());
  }
  const data = { uid: 'owner', email: '', sid: 'test', start: 1, page: '/jobs', clicks: [{ k: 'view', t: 1 }] };
  await assertSucceeds(owner.doc('usageEventBatches/owner__test').set(data));
  await assertSucceeds(owner.doc('usageEventBatches/owner__test').set(data));
  await assertFails(owner.doc('usageEventBatches/owner__test').set({ ...data, clicks: [] }));
  await assertFails(other.doc('usageEventBatches/owner__test2').set({ ...data, sid: 'test2' }));
  await assertFails(owner.doc('usageEventBatches/owner__large').set({ ...data, sid: 'large', clicks: Array(101).fill({}) }));
  await assertFails(owner.doc('usageEventBatches/owner__test').get()); await assertFails(anon.collection('usageEventBatches').get());
  await assertSucceeds(admin.doc('usageEventBatches/owner__test').get());
  await assertSucceeds(anon.doc('usageEventBatches/anon:abc__test').set({ ...data, uid: 'anon:abc' }));
  console.log('Profile Analytics rules: owner/admin access, other/anonymous/unverified denial, transfer revocation, immutable bounded telemetry and denied client report writes passed.');
} finally { await env.cleanup(); }
