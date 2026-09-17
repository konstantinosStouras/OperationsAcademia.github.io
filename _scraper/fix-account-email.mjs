#!/usr/bin/env node
/**
 * CORRECT A MISTYPED SIGN-IN ADDRESS, one account at a time.
 *
 * An address is typed by a person at registration and nothing on the way in
 * can tell a typo from a real domain: `yh3660@columbia.edi` was accepted,
 * looked exactly like `columbia.edu` on the roster, and only announced itself
 * when the verification campaign's message bounced with "the domain
 * columbia.edi couldn't be found" (owner, 2026-09-17, forwarding the bounce).
 *
 * Such an account is STUCK and cannot get itself out. The address is the
 * account's identity, so the person cannot change it from the site; every
 * write they make is refused because `verified()` reads `email_verified` and
 * it can never become true; and the campaign that would ask them to confirm
 * has already stamped `verifyMail/{uid}.campaignAt`, so it will never write to
 * them again. Only the Admin SDK can correct it, which is why this is a
 * script and not a page.
 *
 * WHAT IT IS NOT. It is not a way to move an account to a different person's
 * address. Four guards make it a CORRECTION rather than a transfer, and the
 * run refuses rather than guessing at any of them:
 *
 *   1. the account is found by its CURRENT address (or its uid), and the
 *      stored address must equal `--from` exactly, so a stale instruction
 *      cannot land on whoever holds that address now;
 *   2. the new address must not already belong to another account, or the
 *      update would fail at Auth anyway and the log would be the only record;
 *   3. the LOCAL PART must be unchanged unless `--allow-local-change` is
 *      passed. A typo worth fixing here is a domain somebody mistyped; a
 *      different mailbox is a different person, and that is the line;
 *   4. nothing is written without `--write`. The default prints the plan.
 *
 * WHAT IT WRITES. `email` and `emailVerified: false` on the Auth record, and
 * then it DELETES `verifyMail/{uid}` so the campaign's once-only mark and its
 * rate limit are clear and the next press of
 * `.github/workflows/oa-verify-existing.yml` sends that account the site's
 * ordinary verification message. It sends nothing itself: one definition of
 * the verification e-mail (`renderVerifyEmail` + `siteVerifyLink`) already
 * exists and a second sender here would be the drift this repository forbids
 * everywhere.
 *
 * WHAT IT DELIBERATELY LEAVES. `userDirectory/{uid}.email` is corrected by
 * the next roster sync, which reads the address from Auth and drops one Auth
 * no longer has; and `accountKeys/email:<sha256>` still names the account
 * under the OLD address's digest, which the browser re-claims on that
 * account's next sign-in. Both self-heal, and neither is worth a second
 * writer here.
 *
 * THE LOG IS PUBLIC. A dispatched run prints into the Actions log of a public
 * repository, so every line carries the uid and a REDACTED address, never a
 * whole one and never a name.
 *
 *   node _scraper/fix-account-email.mjs --from=a@b.edi --to=a@b.edu
 *   node _scraper/fix-account-email.mjs --from=a@b.edi --to=a@b.edu --write
 *   node _scraper/fix-account-email.mjs --selftest
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMain } from './_main.mjs';
import { firebaseAdmin, redact } from './_mail.mjs';

/** The local part and the domain, or null when it is not one address. */
export function parts(address) {
  const s = String(address || '').trim();
  // one @, something either side, a dot in the domain, no whitespace
  const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(s);
  return m ? { local: m[1], domain: m[2].toLowerCase() } : null;
}

/**
 * Whether this correction is allowed, and why not when it is not.
 *
 * Pure, so the whole decision is testable without Auth: the caller hands in
 * what it read. `holder` is the account that already has the NEW address, or
 * null.
 */
export function check({ account, from, to, holder, allowLocalChange = false }) {
  const f = parts(from), t = parts(to);
  if (!f) return { ok: false, why: '--from is not an e-mail address' };
  if (!t) return { ok: false, why: '--to is not an e-mail address' };
  if (f.local === t.local && f.domain === t.domain) {
    return { ok: false, why: 'the two addresses are the same' };
  }
  if (!account) return { ok: false, why: 'no account holds that address' };
  if (String(account.email || '').toLowerCase() !== String(from).trim().toLowerCase()) {
    return { ok: false, why: 'that account’s address is not the one given, so the instruction is stale' };
  }
  if (holder && holder.uid !== account.uid) {
    return { ok: false, why: 'another account already holds the new address' };
  }
  if (f.local !== t.local && !allowLocalChange) {
    return {
      ok: false,
      why: 'the local part would change, which is a different mailbox rather than ' +
           'a mistyped domain; pass --allow-local-change if that is really meant',
    };
  }
  return { ok: true, why: '' };
}

/* ------------------------------------------------------------------ the run */

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  const uid = arg('uid');
  const write = process.argv.includes('--write');
  const allowLocalChange = process.argv.includes('--allow-local-change');

  if (!to || (!from && !uid)) {
    console.log('usage: --to=<new address> with --from=<current address> or --uid=<uid>');
    console.log('       --write to apply it; without it this prints the plan');
    process.exitCode = 2;
    return;
  }

  const admin = await firebaseAdmin();
  if (!admin) {
    console.log('::warning::FIREBASE_SERVICE_ACCOUNT is not set: no account was read.');
    return;
  }
  const { auth, db } = admin;

  const lookup = async (fn) => {
    try { return await fn(); } catch (err) {
      if (err && err.code === 'auth/user-not-found') return null;
      throw err;
    }
  };

  const account = uid
    ? await lookup(() => auth.getUser(uid))
    : await lookup(() => auth.getUserByEmail(from));
  const holder = await lookup(() => auth.getUserByEmail(to));

  const verdict = check({
    account,
    from: from || (account && account.email) || '',
    to,
    holder,
    allowLocalChange,
  });

  if (!verdict.ok) {
    console.log(`::error::refused: ${verdict.why}`);
    process.exitCode = 1;
    return;
  }

  console.log(`account ${account.uid}: ${redact(account.email)} -> ${redact(to)}`);
  console.log(`  providers: ${(account.providerData || []).map((p) => p.providerId).join(', ') || 'none'}`);
  console.log(`  verified now: ${account.emailVerified}; after: false, so the address must be confirmed`);

  if (!write) {
    console.log('plan only: nothing written. Pass --write to apply it.');
    return;
  }

  await auth.updateUser(account.uid, { email: to, emailVerified: false });
  console.log('  address corrected in Auth');

  /* The campaign's once-only mark AND its rate limit live here, and the mark
     was stamped by the send that bounced. Left in place, the account can
     never be asked to confirm. */
  try {
    await db.collection('verifyMail').doc(account.uid).delete();
    console.log('  verifyMail cleared, so the campaign can write to them again');
  } catch (err) {
    console.log(`::warning::could not clear verifyMail/${account.uid}: ${(err && err.code) || 'unknown'}` +
      ' — the campaign will skip this account until it is removed by hand');
  }

  console.log('Next: press oa-verify-existing.yml with send ticked to ask them to confirm it.');
}

/* ------------------------------------------------------------- the selftest */

function selftest() {
  let pass = 0, fail = 0;
  const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + what); } };
  const acc = { uid: 'u1', email: 'yh3660@columbia.edi' };

  ok(parts('a@b.edu').domain === 'b.edu', 'parts reads the domain');
  ok(parts('a@b.edu').local === 'a', 'and the local part');
  ok(parts('nope') === null, 'and refuses a non-address');
  ok(parts('a@b') === null, 'and a domain with no dot');
  ok(parts('a b@c.edu') === null, 'and whitespace');

  // the owner's own case
  ok(check({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: null }).ok,
    'the reported typo is allowed');
  // case in the stored address must not matter
  ok(check({ account: { uid: 'u1', email: 'YH3660@Columbia.edi' }, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: null }).ok,
    'and the stored address is compared without case');

  const refuses = (opts, needle, what) => {
    const v = check(opts);
    ok(!v.ok && v.why.indexOf(needle) !== -1, what + ' (got: ' + v.why + ')');
  };
  refuses({ account: null, from: 'a@b.edi', to: 'a@b.edu', holder: null },
    'no account', 'an address nobody holds is refused');
  refuses({ account: { uid: 'u1', email: 'someone@else.edu' }, from: 'a@b.edi', to: 'a@b.edu', holder: null },
    'stale', 'an account whose address has since changed is refused');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: { uid: 'u2' } },
    'already holds', 'a new address another account holds is refused');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'someone.else@columbia.edu', holder: null },
    'local part', 'a different mailbox is refused by default');
  ok(check({ account: acc, from: 'yh3660@columbia.edi', to: 'someone.else@columbia.edu', holder: null, allowLocalChange: true }).ok,
    'and allowed only when that is said outright');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edi', holder: null },
    'the same', 'a no-op is refused');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'not an address', holder: null },
    '--to', 'a junk target is refused');

  /* THE LOG IS PUBLIC: no line may carry a whole address or a name. Read this
     file's own source, the way the roster sync's suite does. */
  const src = readOwnSource();
  const logs = src.split('\n').filter((l) => /console\.log\(/.test(l));
  ok(logs.length > 0, 'there are log lines to sweep');
  ok(!logs.some((l) => /\$\{(from|to|account\.email)\}/.test(l) && !/redact\(/.test(l)),
    'no log line interpolates a whole address without redacting it');
  ok(!logs.some((l) => /displayName/.test(l)), 'and none prints a name');
  ok(/redact\(account\.email\)/.test(src) && /redact\(to\)/.test(src),
    'both addresses are printed redacted');
  ok(!/--write/.test(src.slice(src.indexOf('await auth.updateUser')))
     || src.indexOf('if (!write)') < src.indexOf('await auth.updateUser'),
    'the plan-only return comes BEFORE the write');

  console.log(`fix-account-email selftest: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

function readOwnSource() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8');
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--selftest')) selftest();
  else main().catch((err) => { console.error(err); process.exitCode = 1; });
}
