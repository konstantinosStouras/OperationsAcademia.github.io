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

### ORCID (optional, later)

`/lit/` offers "Continue with ORCID" through a generic OIDC provider. It needs
Identity Platform enabled and a client secret held in the console, so it is a
separate exercise. When you do it, add `'orcid'` to `AUTH_PROVIDERS` in
`oa-firebase.js` — the button and the sign-in path are already written.

## 4. Deploy the security rules — **before announcing anything**

```bash
npm install -g firebase-tools
firebase login

cd v2                      # the config lives here, beside the rules
firebase deploy --only firestore:rules --project operations-academia
```

`v2/firebase.json` already points the CLI at `_firestore.rules`, so that is the
whole command. (It must be run from `v2/` — the CLI refuses paths outside its
config's own directory. `v2/.firebaserc` holds a `PASTE_PROJECT_ID` placeholder
you can fill in to drop the `--project` flag.)

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
| `registeredUsers/{uid}` | world-readable but contentless (one coarse timestamp), owner-write only, no delete — it exists so the site can show a user count without exposing the user list |
| everything else | closed |

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
