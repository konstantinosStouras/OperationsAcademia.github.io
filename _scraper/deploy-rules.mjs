#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — publish `_firestore.rules` to the live project.

   THE PROBLEM THIS EXISTS FOR. Six features in this repository have shipped
   "inert until the rules are redeployed" — the review queue, the news gate,
   the name fixes, the directory edits, the roster and the messaging threads —
   because deploying was believed to need an interactive login and therefore a
   human at a laptop with the CLI installed. That belief is what the Admin area
   was reporting on 2026-08-24: a Registered-users panel with the code, the
   page and the rules all committed and NOTHING on the roster, under a red line
   telling the maintainer to go and run a command.

   The belief was wrong. `firebase deploy` needs a login; publishing rules does
   not. The Admin SDK's Security Rules API releases a Firestore ruleset from
   source using a SERVICE ACCOUNT — the very credential eight workflows in this
   repository already hold as FIREBASE_SERVICE_ACCOUNT. So the deploy runs in
   CI like everything else here, and a rules change committed is a rules change
   live.

   THE CLI PATH IS UNCHANGED and remains correct: `firebase deploy --only
   firestore:rules --project operations-academia` from the repository root,
   guarded by check-project.mjs. This is the second road to the same place, not
   a replacement — and it deliberately carries that guard's OWN rule, for the
   reason the repository records twice: rules from this folder have twice been
   published into another project's database, silently, breaking every read and
   write in an unrelated app. Here the credential itself names the project, so
   the guard is exact: `project_id` in the service account must equal the
   default project in `.firebaserc`, or nothing is published.

   SCOPE IS FIRESTORE, DELIBERATELY. `_storage.rules` and the Functions still
   go through the CLI. The rules that gate this site's own panels are the
   Firestore ones; publishing a second file would double what a bad run can
   reach, and the Storage bucket name is one more thing to get wrong.

   Modes:
     --scan       report what is live against what is in the repository
     --dry-run    everything except the release
     --selftest   offline checks over the pure guards, no network
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './_main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RULES = path.join(ROOT, '_firestore.rules');
const RC = path.join(ROOT, '.firebaserc');

const argv = new Set(process.argv.slice(2));
const SCAN = argv.has('--scan');
const DRY = argv.has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const fail = (...a) => console.log('::error::' + a.join(' '));

/* ------------------------------------------------------------- pure guards */

/**
 * The service account, from JSON or from the base64 the secret is commonly
 * pasted as — the same dual parse build-candidates.mjs and every mailer does.
 * Returns null when the secret is absent or unreadable; a caller treats that
 * as "no credentials in this environment", never as a failure.
 */
export function parseCreds(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

/**
 * check-project.mjs's rule, applied to the credential rather than to the CLI's
 * environment: the project the key opens must be the project this repository
 * says it deploys to. Compared against `.firebaserc` and never against a
 * literal, for the reason the guard's own selftest gives — a hardcoded id is a
 * second place for the truth to live and goes stale in silence.
 *
 * Returns '' when they agree, or a sentence naming BOTH when they do not.
 */
export function projectMismatch(credProject, rcProject) {
  const got = String(credProject || '').trim();
  const want = String(rcProject || '').trim();
  if (!want) return 'the default project could not be read from .firebaserc';
  if (!got) return `the service account names no project; .firebaserc says ${want}`;
  if (got !== want) {
    return `the service account opens ${got}, but .firebaserc says this ` +
      `repository deploys to ${want} — refusing to publish`;
  }
  return '';
}

/**
 * Is this text the FIRESTORE rules of this site? A publish is the one action
 * here that cannot be undone by the next run, so the file is checked rather
 * than trusted: an empty or truncated read would publish a document that locks
 * the whole database, and `_storage.rules` — the neighbouring file, one
 * argument away — declares a different service entirely.
 *
 * Returns '' when the source is publishable, or the reason it is not.
 */
export function sourceProblem(text) {
  const s = String(text || '');
  if (!s.trim()) return 'the rules file is empty';
  if (/^\s*service\s+firebase\.storage\b/m.test(s)) {
    return 'that file declares service firebase.storage — these are the ' +
      'Storage rules, not the Firestore ones';
  }
  if (!/rules_version\s*=/.test(s)) return "the rules file names no rules_version";
  if (!/service\s+cloud\.firestore\b/.test(s)) {
    return 'the rules file does not declare service cloud.firestore';
  }
  // A ruleset that reaches the API truncated would still be valid syntax; the
  // committed file has never been near this floor (it is ~600 lines).
  if (s.length < 200) return `the rules file is only ${s.length} bytes — truncated?`;
  return '';
}

/**
 * Is what is LIVE already what the repository holds? Compared on CONTENT, never
 * on the file name: a ruleset published by the CLI carries whatever name the
 * CLI gave it, and a run that re-published identical rules for that difference
 * alone would mint a ruleset per push for nothing.
 */
export function sameSource(liveFiles, text) {
  const live = [].concat(liveFiles || [])
    .map((f) => String((f && f.content) || '')).join('');
  return live !== '' && live === String(text || '');
}

/* -------------------------------------------------------------- the release */

async function main() {
  const source = await readFile(RULES, 'utf8');
  const rc = JSON.parse(await readFile(RC, 'utf8'));
  const want = (rc.projects && rc.projects.default) || '';

  /* The content guard runs FIRST and without credentials, so a bad rules file
     is reported by any run — including one in an environment that could never
     have published it anyway. */
  const bad = sourceProblem(source);
  if (bad) {
    fail(`refusing to publish _firestore.rules: ${bad}`);
    process.exitCode = 1;
    return;
  }

  const creds = parseCreds(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!creds) {
    /* The repository's own pattern: committable and schedulable before the
       secret exists, and a no-op that SAYS SO rather than one that looks like
       a successful deploy. */
    log('no FIREBASE_SERVICE_ACCOUNT in this environment — nothing published.');
    log(`(_firestore.rules reads clean: ${source.length} bytes for ${want})`);
    return;
  }

  const wrong = projectMismatch(creds.project_id, want);
  if (wrong) {
    fail(`rules deploy: ${wrong}`);
    process.exitCode = 1;
    return;
  }

  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    fail('firebase-admin is not installed — run `npm i firebase-admin` in the workflow');
    process.exitCode = 1;
    return;
  }
  const app = admin.default || admin;
  if (!app.apps.length) {
    app.initializeApp({ credential: app.credential.cert(creds) });
  }
  const rules = app.securityRules();

  /* What is live now. A first-ever deploy has no ruleset and throws; that is
     not an error here — it is the state this whole script exists to end. */
  let live = null;
  try {
    live = await rules.getFirestoreRuleset();
  } catch (e) {
    /* A READ FAILURE MUST NOT CAUSE A WRITE, which is this repository's rule
       everywhere else ("an unreachable source changes nothing"). Any error at
       all was swallowed and read as "not yet published", so a transient API
       blip or a permissions wobble published a fresh ruleset — every run,
       against a project-wide cap of 2500 of them, and while knowing nothing
       about what is live. The ONE case the comment above is really about is a
       project with no ruleset at all, which answers NOT FOUND; anything else
       stops the run and says so. */
    const why = String((e && e.code) || '') + ' ' + String((e && e.message) || '');
    if (!/not.?found|no such|does not exist/i.test(why)) {
      fail(`could not read the live ruleset (${e.message}). Nothing published: ` +
        'a read that fails says nothing about what is deployed, and publishing ' +
        'on it would mint a ruleset on every failed run. Try again, or check ' +
        `that the credential still holds roles/firebaserules.admin on ${want}.`);
      process.exitCode = 1;
      return;
    }
    warn(`no ruleset is published on ${want} yet — this is the first deploy`);
  }

  if (live && sameSource(live.source, source)) {
    log(`already published: the live ruleset (${live.name}, created ${live.createTime}) ` +
        'is byte-for-byte what the repository holds. Nothing to do.');
    return;
  }

  const liveBytes = live
    ? [].concat(live.source || []).map((f) => String(f.content || '')).join('').length
    : 0;
  log(`project ${want}: live ruleset ${live ? `${live.name} (${liveBytes} bytes)` : 'NONE'} ` +
      `→ publishing _firestore.rules (${source.length} bytes)`);

  if (SCAN || DRY) {
    log(SCAN ? '--scan: nothing published.' : '--dry-run: nothing published.');
    return;
  }

  const released = await rules.releaseFirestoreRulesetFromSource(source);
  log(`published ${released.name} (created ${released.createTime}).`);
  log('Every rule-gated panel on the site is live from now — no further step.');
}

/* ---------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };
  const eq = (got, want, what) => ok(got === want,
    `${what}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);

  /* --- the credential ---------------------------------------------------- */
  eq(parseCreds(''), null, 'no secret parses to null, never to a throw');
  eq(parseCreds('not json at all'), null, 'and neither does junk');
  eq((parseCreds('{"project_id":"p"}') || {}).project_id, 'p', 'plain JSON is read');
  eq((parseCreds(Buffer.from('{"project_id":"p"}').toString('base64')) || {}).project_id,
    'p', 'and so is the base64 the secret is commonly pasted as');

  /* --- the project guard, which is the whole safety argument -------------- */
  eq(projectMismatch('operations-academia', 'operations-academia'), '',
    'a credential for this project publishes');
  ok(/stouras-answerarena/.test(projectMismatch('stouras-answerarena', 'operations-academia')),
    'a credential for ANOTHER project is refused, and the message names it');
  ok(/operations-academia/.test(projectMismatch('stouras-answerarena', 'operations-academia')),
    'and names the one it should have been');
  ok(projectMismatch('', 'operations-academia') !== '',
    'a credential naming no project is refused, never assumed');
  ok(projectMismatch('operations-academia', '') !== '',
    'and an unreadable .firebaserc refuses too — never a default');

  /* --- the content guard ------------------------------------------------- */
  const good = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{d}/documents {\n" +
    '    // '.padEnd(200, 'x') + '\n  }\n}\n';
  eq(sourceProblem(good), '', 'the real shape of this file publishes');
  ok(sourceProblem('') !== '', 'an empty file never publishes');
  ok(sourceProblem('   \n ') !== '', 'and neither does a whitespace one');
  ok(/firebase\.storage/.test(sourceProblem(
    "rules_version = '2';\nservice firebase.storage {\n" + 'x'.repeat(300) + '\n}\n')),
  'the STORAGE rules are refused by name — the neighbouring file, one argument away');
  ok(sourceProblem('service cloud.firestore { }' + 'x'.repeat(300)) !== '',
    'a file with no rules_version is refused');
  ok(sourceProblem("rules_version = '2';\nservice cloud.firestore {}") !== '',
    'and one too short to be this repository\'s rules is refused as truncated');

  /* --- the no-op ---------------------------------------------------------- */
  eq(sameSource([{ name: 'firestore.rules', content: good }], good), true,
    'live rules identical to the repository are a no-op, whatever the file is NAMED');
  eq(sameSource([{ name: '_firestore.rules', content: good }], good + '\n'), false,
    'a single changed byte publishes');
  eq(sameSource([], good), false, 'no live ruleset at all is never "already published"');
  eq(sameSource(null, good), false, 'and neither is an unreadable one');

  console.log(fails.length
    ? `deploy-rules selftest: ${fails.length} FAILED, ${pass} passed\n\n  ${fails.join('\n  ')}`
    : `deploy-rules selftest: ${pass} checks passed`);
  return fails.length === 0;
}

/* IMPORTING THIS FILE MUST NOT PUBLISH ANYTHING. Every CLI here is guarded by
   isMain, and on this one the guard is the difference between a module the
   selftest can read the pure halves out of and a module that attempts a
   deploy the moment anything imports it. */
if (!isMain(import.meta.url)) {
  // imported: the exports above are the whole of it
} else if (argv.has('--selftest')) {
  process.exit(selftest() ? 0 : 1);
} else {
  main().catch((e) => {
    fail(`rules deploy failed: ${e.message}`);
    /* The one failure worth naming, because it is the only one a person has to
       go and fix in a console rather than in this repository. */
    if (/permission|PERMISSION_DENIED|forbidden|403/i.test(String(e.message))) {
      fail('the service account is missing the Firebase Rules permission. Grant it ' +
        '"Firebase Rules Admin" (roles/firebaserules.admin) on the project in the ' +
        'Google Cloud console → IAM, then run this again.');
    }
    process.exit(1);
  });
}
