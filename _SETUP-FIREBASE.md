# Switching on the Firebase side

Everything in `/v2/` that needs a database — sign-in, posting a job, e-mail
alerts, feedback — is **inert until this is done**. Each page says so plainly
instead of failing, and the job postings list works either way because it reads
a static file. So there is no rush and no half-broken state.

Budget: the free Spark plan is enough. Nothing here needs Blaze.

---

## 1. Create the project

<https://console.firebase.google.com> → **Add project**.

- Name it something obvious: `operations-academia`.
- Google Analytics: **off**. The site already has its own; a second one only
  complicates the privacy policy.

## 2. Add a web app and copy its config

Project settings → **Your apps** → **Web** (`</>`), nickname
`operationsacademia.org`. Do **not** tick Firebase Hosting — GitHub Pages
serves the site.

Copy the `firebaseConfig` object it shows you into
**`v2/assets/oa-firebase.js`**, replacing the `PASTE_…` placeholders:

```js
var FB_CONFIG = {
  apiKey: 'AIza…',
  authDomain: 'operations-academia.firebaseapp.com',
  projectId: 'operations-academia',
  storageBucket: 'operations-academia.appspot.com',
  messagingSenderId: '…',
  appId: '1:…'
};
```

**A web config is not a secret.** It identifies the project to the browser and
is visible in the page source of every Firebase site on the internet. What
protects your data is the rules in step 4, which is why they must be deployed
before you tell anyone the site is live.

Commit that file. The moment it lands, `OAFB.enabled` flips true and the sign-in
control, the posting form, alerts and feedback all come alive.

## 3. Turn on the sign-in methods

Authentication → **Get started** → Sign-in method:

- **Google** — enable. Set the support e-mail.
- **Email/Password** — enable. Leave "Email link (passwordless)" off.

Then Authentication → Settings → **Authorized domains**, and add:

- `operationsacademia.org`
- `www.operationsacademia.org`
- `konstantinosstouras.github.io` (only if you ever preview from that host)

`localhost` is there by default, which is what makes local testing work.

### ORCID — the button is live, the provider is not

**"Continue with ORCID" is already on the sign-in modal**, exactly as on
`/lit/`. Until the three steps below are done, pressing it answers
`auth/operation-not-allowed`, which the modal reports as *"That sign-in method
is not switched on for this site yet. Please use one of the others for now."*
Nothing breaks; ORCID just does not work yet.

Verified against your project on 2026-08-15:

```
providerId=oidc.orcid  -> OPERATION_NOT_ALLOWED : Use of this method requires GCIP
providerId=google.com  -> INVALID_IDP_RESPONSE   (i.e. configured and working)
```

ORCID is a **generic OIDC** provider, and Firebase only offers those once the
project is upgraded to **Identity Platform** (GCIP). That upgrade is free for
the first 50,000 monthly active users — far more than this site will see — but
it is a deliberate step, and it puts the project on a Cloud billing account.

**1. Add this site's callback to your existing ORCID API client.** Sign in at
<https://orcid.org> → your name → **Developer tools**, and add a **redirect
URI**:

```
https://operations-academia.firebaseapp.com/__/auth/handler
```

That is Firebase's own callback, not a page on this site.

**Do NOT look for a way to register a second client — there isn't one.** ORCID
issues exactly **one public API client per ORCID iD**; a further set of
credentials needs ORCID membership (the Member API) or a request to
`support@orcid.org`. The intended way to cover several apps is one client with
several redirect URIs, which is what the existing client
(`APP-VWG4YW59MEUCRQE2`, shared with `stouras.com/lit`) already does. Keep the
entries that are there — `https://www.stouras.com/lit/` and
`https://lit-paper-browser.firebaseapp.com/__/auth/handler` — and add this one
alongside them; they are not alternatives.

So the **client ID** and **client secret** for step 2 are the ones already
shown on that page, not new values.

Two consequences of sharing the client, both accepted deliberately:

- The ORCID authorisation screen shows the *client's* name and description, and
  there is only one client — so both sites present the same app name. Rename it
  on the developer-tools page to something that covers both if the current name
  reads as belonging to one of them. Cosmetic only.
- The secret protects both sites at once. It lives only in the two Firebase
  consoles; rotating it means updating both.

**2. Add the OIDC provider in Firebase.** Authentication → Sign-in method →
**Add new provider** → **OpenID Connect**. Firebase will offer the Identity
Platform upgrade here; accept it.

| Field | Value |
|---|---|
| Provider ID | **`oidc.orcid`** — must match exactly; the code asks for this string |
| Name | ORCID |
| Client ID | from step 1 |
| Issuer (URL) | `https://orcid.org` |
| Client secret | from step 1 |
| Grant type | Code flow |

**3. Nothing to change in this repository.** `AUTH_PROVIDERS` in
`v2/assets/oa-firebase.js` already lists `'orcid'`, and `oa-accounts.js`
already builds the provider with `new fb.auth.OAuthProvider('oidc.orcid')`.
The button starts working the moment step 2 is saved.

To check it afterwards without clicking anything, re-run the probe:

```bash
curl -s -X POST \
 "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=<apiKey>" \
 -H 'Content-Type: application/json' \
 -d '{"postBody":"id_token=fake&providerId=oidc.orcid",
      "requestUri":"http://localhost","returnSecureToken":true}'
```

`OPERATION_NOT_ALLOWED` means still not configured. Anything about an invalid
or unparseable token means it *is* configured — the request got as far as
being rejected on its fake credential, which only happens once the provider
exists.

**If you would rather not upgrade to Identity Platform**, remove `'orcid'` from
`AUTH_PROVIDERS` and the button disappears. Google and e-mail/password cover
everyone; ORCID is a convenience for a community that mostly has one.

### What switching ORCID on brings with it: duplicate accounts

ORCID's OIDC hands Firebase **no e-mail address**, so Firebase cannot see that
the person pressing "Continue with ORCID" is the one who registered with Google
last month. It makes them a second account. (Two different Gmail addresses do
the same thing, and always could.) Each account holds its own alerts and its own
job postings, and neither can see the other's.

That is handled, not merely acknowledged — see **the merge**, below, and the
long comment above `openMerge` in `v2/assets/oa-accounts.js`:

- **Prevention.** Edit profile offers *Enable "Continue with ORCID"/"…Google"
  for this account*, which attaches that sign-in to the account you already
  have. Afterwards the other button lands you here rather than starting a
  second account, and no duplicate can form.
- **Detection.** Every session claims its identity keys in `accountKeys`. A key
  already held by another uid is one person with two accounts; an ORCID-only
  registration that trips it is offered the merge on the spot, and any other
  account is told once.
- **Repair.** Edit profile → *Merge this account into another of mine*. The
  account you keep signs in on a second Firebase app — both are then proved at
  once — and the alerts, the job postings and any details the kept account was
  missing move across before anything is deleted.

The detection half is INERT until the `accountKeys` rule is deployed (step 4);
the prevention and the merge work as soon as ORCID does. Nothing in the merge
depends on ORCID: it merges any two accounts, whatever they sign in with.

## 4. Deploy the security rules — **before announcing anything**

```bash
npm install -g firebase-tools
firebase login

cd <this repository>       # the ROOT: the config lives here, beside the rules
firebase deploy --only firestore:rules
```

`firebase.json` at the repository ROOT already points the CLI at
`_firestore.rules`, and `.firebaserc` already names the project
(`operations-academia`), so that is the whole command — no `--project` flag.

**These paths moved with the 2026-08-17 promotion.** The config used to live in
`v2/` and this page used to say `cd v2`; it does not any more, and running the
old command deploys nothing (or the wrong thing). The CLI refuses any path
outside its own config's directory, which is why the config sits at the root
beside the rules rather than next to the pages that read them.

**DEPLOYING IS A STEP SOMEBODY HAS TO REMEMBER.** No workflow runs
`firebase deploy` — nothing in CI can, since it needs an interactive login —
so a rules change committed here is NOT live until this command is run by
hand. Every feature the rules gate stays inert in the meantime, which is the
designed failure (a refused write says so) but is indistinguishable from a bug
if you have forgotten the step. **Run it after every change to
`_firestore.rules`.** The rules currently in the repository and not yet
deployed at the time of writing include the 34-key posting ceiling, the
`newsOverrides` and `usageSessions` blocks, and the `rowOverrides` block that
makes the frozen archives editable at all.

Firestore must exist first: Firestore
Database → **Create database** → production mode → a region near your readers
(`eur3` or `nam5`). The region cannot be changed afterwards.

Until these are deployed every write is refused, and the forms say so rather
than appearing to work.

What the rules do:

| Collection | Who can do what |
|---|---|
| `jobSubmissions` | anyone signed in may create one, pinned to their own uid and to `status: 'queued'`; they may read, correct and withdraw **their own**; only the maintainer may delete or mark one featured |
| `feedback` | **anyone** may create one, bounded to 5 screenshots and ~16 fields; only the maintainer may read the collection |
| `users/{uid}/**` | the owner only — this is where alert subscriptions live |
| `profiles/{uid}` | the owner only |
| `registeredUsers/{uid}` | world-readable but contentless (one coarse timestamp), owner-write only; an account may delete **its own** mark, which is what a merge does with the duplicate it removes |
| `accountKeys/{key}` | one document per identity (`orcid:<iD>`, `email:<sha256>`) saying which uid holds it; readable one-at-a-time by anyone signed in, never listable, writable only for yourself. It is how the site notices one person has two accounts |
| `newsOverrides/{id}` | world-readable; only the maintainer writes or deletes one. Curates the "What's new" list in place — `changelog.json` stays the source of truth and an override hides or rewords one entry |
| `rowOverrides/{id}` | world-readable; only the maintainer writes or deletes one. The same idea over the three FROZEN ARCHIVES — `data/past-postings.json`, `data/recent-faculty.json`, `data/universities.json` — which are written once by the legacy import and have no other write path. Each document is `<dataset>__<rowId>` and carries only the fields it changes, or `hidden: true`. It is deliberately NOT an add path: a school the archive does not carry is added upstream, in the sheet the import reads |
| everything else | closed |

`jobSubmissions` carries a **second** `allow update`, for the account merge. A
posting is a top-level document owned by a `uid` field, and the first rule pins
that field — so without this one, merging an account away would strand every
posting it had made under a sign-in that no longer exists: unwithdrawable,
uncorrectable, for ever. The branch lets the **current owner** change
`uid`/`mergedFrom`/`mergedAt` **and nothing else** (`diff().affectedKeys()`
does the pinning), so a merge cannot be used to edit a posting behind the rules
that normally bound it, and `featured` stays as untouchable as it is above.

`isAdmin()` in the rules hardcodes `kstouras@gmail.com` **and requires a
verified e-mail**. Change it there if that address ever changes; the copy in
`oa-firebase.js` only decides whether an admin panel is *drawn*.

## 5. Create the service account for the scheduled jobs

The GitHub Actions that publish postings and send e-mail use the Admin SDK,
which bypasses the rules. Project settings → **Service accounts** →
**Generate new private key**. You get a JSON file.

In the repository: Settings → Secrets and variables → Actions → **New
repository secret**:

- Name: `FIREBASE_SERVICE_ACCOUNT`
- Value: the entire contents of that JSON file

**This one *is* a secret.** It can read and write everything, ignoring the
rules. Never commit it. If it leaks, revoke the key in the console and generate
another. `oa-checks.yml` fails the build if a `BEGIN PRIVATE KEY` block ever
appears under `v2/`.

The scripts also accept the JSON base64-encoded, if your paste keeps getting
mangled by newlines.

## 6. Check it

1. Open `/v2/post-a-job.html`. The header should offer **Sign in** rather than
   a greyed-out label.
2. Sign in with Google. The form appears with your e-mail filled in.
3. Post a test job.
4. Actions → **OA jobs — publish queued postings** → Run workflow. It should
   report `+1 new` and commit to `v2/data/jobs.json`.
5. `/v2/jobs.html` shows it.
6. Delete the test posting: Firestore console → `jobSubmissions` → set its
   `status` to `hidden`, then run the workflow again. It disappears from the
   list.

If step 4 reports "no Firebase credentials", the secret is not set or is not
valid JSON. If it reports `permission-denied`, the rules were not deployed.

---

## Storage (not used, deliberately)

The old Google Form uploaded a PDF of the advertisement to Drive. The new form
asks for a **link** instead. That is a real change and worth knowing about:

- Almost every posting already has a public advertisement URL — 80 of 80 in the
  imported data — and roughly 60% additionally had a PDF.
- Accepting uploads means Firebase Storage, its own rules, a size budget, and a
  standing obligation to host other institutions' files indefinitely.

If you decide you want uploads back, the field and its validation are the small
part; the Storage bucket, its rules, and a retention policy are the real work.
It is listed in `_PLAN.md` as a deliberate follow-up rather than an oversight.
