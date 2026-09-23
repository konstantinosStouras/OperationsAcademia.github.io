#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Decide a "What's new" entry from the Actions tab: publish it, hold it, or
   take it down. Written for the owner's 2026-09-23 instruction to publish the
   position-types entry, on a day nobody was at /whats-new to press the button.

     node _scraper/publish-news.mjs --selftest              the pure halves, offline
     node _scraper/publish-news.mjs                         LIST the log, with each entry's decision
     node _scraper/publish-news.mjs --id=<entry id>         PLAN it: what the document says, and would say
     node _scraper/publish-news.mjs --id=<entry id> --write            publish it
     node _scraper/publish-news.mjs --id=<entry id> --status=removed --write

   IT IS THE BUTTON ON /whats-new, PRESSED FROM A WORKFLOW. An entry in
   changelog.json is withheld until the maintainer writes newsOverrides/{id}
   (CLAUDE.md, "Nothing on What's new publishes itself either"), and the only
   writer of that document was the Publish button on /whats-new, drawn in the
   maintainer's browser. This script writes the SAME document the button
   writes: the page's own module (assets/oa-news.js) names the collection, the
   three statuses and the patch, and nothing here spells out any of them. Two
   writers of one document that agree by construction, not by memory.

   WHY A SCRIPT AND NOT A CALLABLE: the seeder's argument. A callable is inert
   until somebody runs `firebase deploy --only functions` by hand, and
   FIREBASE_SERVICE_ACCOUNT has been a secret here for months, so this road is
   live on merge. The Admin SDK bypasses the rules; the document is held to the
   rules' own key list all the same, by the selftest.

   AN ID THE LOG DOES NOT CARRY IS REFUSED. A decision for an entry that does
   not exist would be read by nothing and sit there for ever, and a typo in the
   id would otherwise look like a run that worked.

   THE PLAN IS THE DEFAULT. Without --write the run says what the document says
   now and what it would say, and touches nothing. A decision here is never a
   one-way door: every status is one more press away, exactly as on the page.

   THE LOG IS PUBLIC AND SO IS EVERYTHING PRINTED. changelog.json is served to
   anyone who asks, so an entry's id, date and title may be printed; nothing
   here reads a person.
   --------------------------------------------------------------------------- */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { firestore } from './_mail.mjs';
import { isMain } from './_main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NEWS = require('../assets/oa-news.js');

/** The decisions a run may write: the three the page's own buttons write. */
export const STATUSES = [NEWS.APPROVED, NEWS.PENDING, NEWS.REMOVED];

/* ------------------------------------------------------------------ pure */

/** The argv the run was given. Publishing is the default; writing is not. */
export function optionsFrom(argv) {
  const val = (name) => {
    const hit = (argv || []).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).trim() : '';
  };
  return {
    id: val('id'),
    status: val('status') || NEWS.APPROVED,
    write: (argv || []).includes('--write'),
  };
}

/** The change-log entry with this id, or null. */
export function entryFor(log, id) {
  const list = log && Array.isArray(log.updates) ? log.updates : [];
  return list.find((e) => e && String(e.id) === String(id)) || null;
}

/** Why the arguments cannot be acted on, or '' when they can. No id is the
    LIST mode, not a refusal. */
export function refusalFor(o, log) {
  if (!STATUSES.includes(o.status)) {
    return `--status must be one of ${STATUSES.join(', ')}, not ${JSON.stringify(o.status)}`;
  }
  if (o.id && !entryFor(log, o.id)) {
    return `changelog.json carries no entry with the id ${JSON.stringify(o.id)}; ` +
      'a decision for it would be read by nothing';
  }
  return '';
}

/** The document a decision writes: the page's own patch, and nothing beside it. */
export function patchFor(status) {
  return NEWS.patchFor(status);
}

/** One line per entry for the LIST mode: the id, the date, what the site does
    with it today and why. All of it is public already. */
export function describe(entry, doc) {
  const status = NEWS.statusOf(entry, doc || null);
  const said = NEWS.decision(doc || null);
  const how = said ? 'by its document'
    : status === NEWS.APPROVED ? 'by its date, before the gate' : 'no document yet';
  return `${entry.id}  ${entry.date}  ${status} (${how})  ${entry.title || ''}`;
}

/* ------------------------------------------------------------------ main */

async function main(argv) {
  const o = optionsFrom(argv);
  const log = JSON.parse(readFileSync(path.join(HERE, '..', 'changelog.json'), 'utf8'));
  const refusal = refusalFor(o, log);
  if (refusal) {
    console.log('::error::publish-news: ' + refusal);
    process.exitCode = 1;
    return;
  }

  const D = await firestore();
  if (!D) {
    console.log('::warning::publish-news: FIREBASE_SERVICE_ACCOUNT is not set; nothing was read and nothing was written.');
    return;
  }
  const col = D.collection(NEWS.COLLECTION);
  const entries = Array.isArray(log.updates) ? log.updates : [];

  if (!o.id) {
    const snap = await col.get();
    const docs = {};
    snap.forEach((d) => { docs[d.id] = d.data(); });
    console.log(`publish-news: ${entries.length} entries in changelog.json, ${snap.size} decision document(s). ` +
      'Pass --id=<entry id> to decide one.');
    for (const e of entries) console.log('  ' + describe(e, docs[e.id]));
    return;
  }

  const entry = entryFor(log, o.id);
  const ref = col.doc(o.id);
  const before = await ref.get();
  const doc = before.exists ? before.data() : null;
  const now = NEWS.statusOf(entry, doc);
  console.log('  ' + describe(entry, doc));
  if (now === o.status) {
    console.log(`publish-news: ${o.id} is already ${o.status}; nothing to write.`);
    return;
  }
  console.log(`  ${o.id}: ${now} -> ${o.status}`);
  if (!o.write) {
    console.log('publish-news: a plan only. Pass --write to write the decision.');
    return;
  }
  const patch = patchFor(o.status);
  await ref.set(patch, { merge: true });
  console.log(`publish-news: ${NEWS.COLLECTION}/${o.id} is ${o.status} now. ` +
    'The front page and /whats-new read it on their next load; the alerts digest carries it on its next run.');
}

/* -------------------------------------------------------------- selftest */

async function selftest() {
  let n = 0;
  const ok = (c, why) => { n++; if (!c) { console.error('FAIL: ' + why); process.exitCode = 1; } };
  const eqs = (a, b, why) => ok(JSON.stringify(a) === JSON.stringify(b),
    `${why} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

  /* --- the arguments ----------------------------------------------------- */
  const dflt = optionsFrom([]);
  eqs([dflt.id, dflt.status, dflt.write], ['', NEWS.APPROVED, false],
    'with nothing passed it lists the log, would publish, and writes nothing');
  const asked = optionsFrom(['--id=forum-2026-09', '--status=removed', '--write']);
  eqs([asked.id, asked.status, asked.write], ['forum-2026-09', NEWS.REMOVED, true],
    'every option is read as given');
  ok(!optionsFrom(['--id=x']).write, '--write is never implied by naming an entry');
  ok(optionsFrom(['--id= spaced ']).id === 'spaced', 'an id is trimmed, since a dispatch input may carry a space');

  /* --- the statuses and the refusals ------------------------------------- */
  eqs(STATUSES, ['approved', 'pending', 'removed'],
    'the three decisions are the ones the page writes and the rules accept');
  const log = { updates: [{ id: 'a-1', date: '2026-09-01', title: 'A' }] };
  ok(/--status must be one of/.test(refusalFor({ id: 'a-1', status: 'published' }, log)),
    'a status the page does not know is refused');
  ok(/no entry with the id/.test(refusalFor({ id: 'nope', status: 'approved' }, log)),
    'an id the log does not carry is refused: a decision for it would be read by nothing');
  ok(refusalFor({ id: 'a-1', status: 'approved' }, log) === '', 'a real id and a real status pass');
  ok(refusalFor({ id: '', status: 'approved' }, log) === '', 'and no id is the LIST mode, not a refusal');
  ok(entryFor(log, 'a-1') && entryFor(log, 'a-1').title === 'A', 'entryFor finds the entry');
  ok(entryFor({}, 'a-1') === null && entryFor(null, 'a-1') === null,
    'and answers null on a log with no list rather than throwing');

  /* --- the patch is the page's own --------------------------------------- */
  const p = patchFor('approved');
  eqs(Object.keys(p).sort(), ['hidden', 'status', 't'],
    'the document carries the status, hidden in step with it, and a stamp');
  ok(p.status === 'approved' && p.hidden === false && typeof p.t === 'number',
    'a publication reads as not hidden, with a numeric stamp');
  ok(patchFor('removed').hidden === true,
    'a removal is hidden too, so an older cached page reads it the same way');
  for (const k of Object.keys(p)) ok(NEWS.DOC_KEYS.includes(k), `every key written (${k}) is one the rules allow`);
  eqs({ ...patchFor('pending'), t: 0 }, { ...NEWS.patchFor('pending'), t: 0 },
    'and it is the page\'s own patchFor, not a copy of it');

  /* --- the committed log ------------------------------------------------- */
  const real = JSON.parse(readFileSync(path.join(HERE, '..', 'changelog.json'), 'utf8'));
  ok(Array.isArray(real.updates) && real.updates.length > 10, 'the committed change log reads');
  ok(real.updates.every((e) => e && typeof e.id === 'string' && e.id.length > 0),
    'and every entry has an id to decide on');
  const ids = real.updates.map((e) => e.id);
  ok(new Set(ids).size === ids.length, 'no two entries share an id, or one decision would cover both');

  /* --- the LIST line ----------------------------------------------------- */
  const line = describe({ id: 'a-1', date: '2026-09-01', title: 'A title' }, null);
  ok(/a-1/.test(line) && /pending/.test(line) && /no document yet/.test(line) && /A title/.test(line),
    'an entry after the gate with no document is pending, and the line says why');
  ok(/approved \(by its date/.test(describe({ id: 'old', date: '2026-01-01', title: 'Old' }, null)),
    'an entry before the gate is approved by its date');
  ok(/removed \(by its document\)/.test(describe({ id: 'a-1', date: '2026-09-01' }, { status: 'removed' })),
    'a document decides');
  ok(/removed \(by its document\)/.test(describe({ id: 'a-1', date: '2026-09-01' }, { hidden: true })),
    'and a pre-gate {hidden: true} document reads as a removal, the page\'s own reading');

  /* --- the writer half, scanned with its comments gone --------------------

     BOUNDED AT BOTH ENDS AND ITS LENGTH ASSERTED: the header explains the
     things the code must not do, by name, and the fixtures below spell out
     status words, so a scan over the whole file would be satisfied only by
     deleting the explanation. */
  const src = readFileSync(path.join(HERE, 'publish-news.mjs'), 'utf8');
  const cut = src.indexOf('async function selftest');
  const writerHalf = src.slice(src.indexOf('import path'), cut);
  ok(cut > 3000 && writerHalf.length > 2500, 'the scanned slice is the writer half, not an empty string');
  const code = writerHalf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/firestore\(\)/.test(code) && !/initializeApp/.test(code),
    'the Admin SDK handle is _mail.mjs\'s, the one definition');
  ok(/NEWS\.COLLECTION/.test(code) && !/['"]newsOverrides['"]/.test(code),
    'the collection is named through the module, never spelt out');
  ok(/NEWS\.patchFor\(/.test(code) && !/hidden:\s*(?:true|false)/.test(code) && !/status:\s*['"]/.test(code),
    'the document is the page\'s own patch; nothing here builds one of its own');
  ok(!/\.delete\(/.test(code), 'nothing here deletes a decision: absence means pending, and a removal is a status');
  const mainSrc = code.slice(code.indexOf('async function main'));
  ok(mainSrc.indexOf('refusalFor(') < mainSrc.indexOf('await firestore()'),
    'the arguments are refused before the database is opened');
  ok(mainSrc.indexOf('if (!o.write)') < mainSrc.indexOf('.set('),
    'main() writes nothing before it has read --write');
  ok(/\.set\(patch, \{ merge: true \}\)/.test(mainSrc),
    'and the write is a MERGE, as the page\'s own save is, so a title the maintainer reworded there is kept');
  ok(mainSrc.indexOf('now === o.status') < mainSrc.indexOf('if (!o.write)'),
    'an entry already in the asked-for state writes nothing, with or without --write');

  console.log(`publish-news selftest: ${n} checks passed`);
}

/* Only when RUN, never when imported: selftest.mjs imports this file for its
   pure halves, and a module that reached for Firestore on import would read
   the log on every run of the suite. */
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) await selftest();
  else await main(argv);
}
