# E-mail verification on registration: setup

**What it does.** A person who registers on the site with an e-mail address
and a password is sent a message with a link, and the account is unusable
until they press it. Google sign-ins arrive already verified by Google, and
ORCID sign-ins carry no e-mail claim, so neither is gated. The rules enforce
it (`verified()` in `_firestore.rules`, on every write a signed-in user makes),
the browser locks the page and shows a "Check your inbox" card until the link
is pressed, and the message itself is the site's own: rendered by
`_functions/verify-email.js` in the live palette and sent from the site's
mailbox by the Cloud Function `sendVerificationEmail` in `_functions/index.js`.

**Until the function is deployed the site still works.** The browser tries
the function first and, when it cannot be reached, falls back to Firebase's
own `sendEmailVerification`. That message comes from
`noreply@operations-academia.firebaseapp.com` in Firebase's own template, and
its link lands on `verify-email.html` with no code once Firebase has applied
it. So a fresh deploy of the site is never stranded; what the function adds is
the branded message from the site's own address, and the rate limit.

**Every password account that already exists is gated too.** `verified()`
reads the token's `email_verified` claim and there is no date before which an
account is excused, and the Firestore rules publish themselves after a green
check on master. So from the moment the rules land, every account registered
with an e-mail address and a password BEFORE the gate is pending on its next
sign-in: it sees the "Check your inbox" card, nothing on the site works for
it, and no message was ever sent to it, because none of those accounts
registered through the path that sends one. The card says so honestly (it
promises a message only on the registration path) and its button reads "Send
the e-mail", which is the one press those accounts need: it sends the
message, they press the link, and the account is ordinary again. Google and
ORCID accounts are untouched. If the roster is large, a line to the
registered users saying "sign in once and press Send the e-mail" saves the
questions.

## 1. The mailbox to send from

The function reads the same four names the scheduled mailers use
(`_SETUP-EMAIL.md` section 1 describes the values: for Gmail,
`smtp.gmail.com`, port `587`, the full address and a 16-character app
password). Here they live in Google Secret Manager rather than in the
repository's Actions secrets, so they have to be set once more, for the
function:

```
firebase functions:secrets:set SMTP_HOST --project operations-academia
firebase functions:secrets:set SMTP_PORT --project operations-academia
firebase functions:secrets:set SMTP_USER --project operations-academia
firebase functions:secrets:set SMTP_PASS --project operations-academia
```

Paste each value when prompted. The message is sent as
`Operations Academia <SMTP_USER>`, and the footer names
`operationsacademia@gmail.com` as the address for questions.

## 2. Deploy the function

From the repository root, after a `git pull`:

```
npm install --prefix _functions
firebase deploy --only functions --project operations-academia
```

`npm install` first, always: the CLI discovers functions by LOADING
`_functions/index.js`, and this function requires `nodemailer`, which a
checkout that predates it has never installed. Without the install the load
dies and the deploy reports a discovery error over code that is fine.

**Read the deployed list back and count FIVE.** The deploy prints one line
per function and there must be five of them: `publishOnChange`,
`publishOnCandidateChange`, `publishOnReview`, `recordVisit` and
`sendVerificationEmail`. Then

```
firebase functions:list --project operations-academia
```

must list the same five, all on `nodejs22`. Four means the deploy ran from a
checkout without this function, which prints "Deploy complete!" over the
older set (`_SETUP-INSTANT-PUBLISH.md` records how that happened once).

Always pass `--project`: the CLI remembers an "active project" per directory,
and a deploy from this folder has already gone into another project's
database once (see CLAUDE.md).

## 3. Two things the project must already have

* **The site's domain is an authorised domain** in Firebase Authentication
  (Authentication, Settings, Authorised domains). It is, since sign-in works,
  and the function's `generateEmailVerificationLink` refuses with
  `auth/unauthorized-continue-uri` if it ever stops being.
* **The functions' service account may mint links.** The default compute
  service account carries the role already; if a deploy ever moves the
  function onto another account, it needs Firebase Authentication Admin.

## 4. How to test

1. Register on the site with a throwaway address and a password. The page
   locks and the "Check your inbox" card opens, naming the address.
2. The message arrives from the site's mailbox within a few seconds, subject
   "Verify your e-mail address for Operations Academia", with the site's logo
   and one button. Look in spam the first time.
3. Press the button. It opens `verify-email.html` on the site, which applies
   the code and shows "Your e-mail address is verified" with a button to the
   account page. Back on the site, the cards open and the chip shows the name.
4. `firebase functions:log --project operations-academia` shows
   `verification e-mail sent` with the account id and a redacted address, and
   never the link or the code.
5. In Firestore, `verifyMail/{uid}` now holds `sentAt`, `day` and `count`.
   Pressing "Send the e-mail again" inside 90 seconds is refused with
   `resource-exhausted` and the card says the last message went a moment ago;
   the seventh press in a UTC day is refused the same way, and the card
   prints the function's own reason ("That is enough messages for today"),
   not the 90-second one. The slot is reserved in a transaction BEFORE the
   send, so ten presses fired in the same second send one message, not ten;
   a send that fails gives the slot back.

To test the fallback, deploy nothing and register: the message then comes
from Firebase's own address in its own template, and pressing its link lands
on `verify-email.html` with no code, which shows the verified state once the
account has been reloaded.

## 5. The Storage rules still deploy by hand

`_storage.rules` gates an upload (an advertisement or a CV) on the same
`verified()` test as every Firestore write, so an unverified password
account cannot upload a file through the SDK either. Unlike the Firestore
rules, the Storage rules do NOT publish themselves; after any change to that
file run, from the repository root:

```
firebase deploy --only storage --project operations-academia
```

## What is deliberately not done

* No client may write `verifyMail`; the catch-all rule and an explicit block
  both close it, so the limit cannot be lifted from a browser.
* The function mails the address on the TOKEN only. There is no way to have a
  verification link sent to an address the caller typed.
* The renderer imports nothing from `_scraper/`: `firebase deploy` ships only
  the `_functions` directory, so the message's chrome is a deploy-local copy
  of the shape `_scraper/_mail.mjs` uses. Change the wording in
  `_functions/verify-email.js`, and nowhere else.
