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

**1. Register an ORCID API client.** Sign in at
<https://orcid.org> → your name → **Developer tools**. You need a verified
e-mail and at least one public record item before it will let you. Create a
client and set the redirect URI to:

```
https://operations-academia.firebaseapp.com/__/auth/handler
```

That is Firebase's own callback, not a page on this site. You get a **client
ID** (`APP-XXXXXXXXXXXXXXXX`) and a **client secret**.

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
