/* ---------------------------------------------------------------------------
   Operations Academia — deleting an account, from both ends.

   WHAT WAS MISSING (owner, 2026-09-05): "There is no option for a user to
   completely delete their profile. You should have it within their personal
   area … Also, the admin should be able to delete a user." Neither existed.
   The account page could edit a profile and merge two accounts; the only way
   out was to write to the maintainer, and the maintainer's own only route was
   the Firebase console.

   THE TWO HALVES ARE NOT SYMMETRIC, and that is the whole design.

     A PERSON deleting their own account can do nearly all of it in their own
     browser, because the rules already let an owner withdraw their postings
     and delete their alerts, their profile, their registeredUsers mark and
     their roster row, and Firebase lets a session delete its own sign-in.
     That half is live the moment this ships, and needs no deploy.

     THE MAINTAINER CAN DO ALMOST NONE OF IT. `users/{uid}/**` is owner-only
     with no admin clause, so the admin cannot delete somebody else's e-mail
     alerts — and an alert left behind goes on mailing a deleted person for
     ever, which is the failure the account merge already records. `profiles`,
     `registeredUsers` and `userDirectory` are owner-delete too, and no
     browser can delete another account's Auth record at all.

   SO A DELETION IS A WORK ORDER, `accountDeletions/{uid}`, and the sweep that
   carries it out is `_scraper/purge-accounts.mjs` with the Admin SDK. This
   file is the ONE definition of what that order looks like and what deleting
   an account means: the account page writes it, the Admin area's roster
   writes it, the sweep reads it, and the selftest pins its keys against
   _firestore.rules both ways. Two copies of "what a deletion is" would
   disagree silently, which is the drift oa-countries.js, oa-schools.js,
   oa-jobnav.js and oa-news.js all exist to prevent.

   WHY A WORK ORDER AND NOT A CALLABLE CLOUD FUNCTION. A callable would make
   the maintainer's press instant, and it would be INERT until somebody ran
   `firebase deploy --only functions` by hand — the trap this repository has
   walked into twice and written down twice ("a feature that needs a manual
   step to become real looks installed and is not"; "a doorbell that was never
   deployed looks exactly like a site that is simply slow"). The sweep needs
   FIREBASE_SERVICE_ACCOUNT, which has been a secret here for months, and it
   runs on the jobs build's own completion, so a queued deletion is carried
   out in about the time a posting takes to publish. Live on merge, nothing to
   remember.

   EVERYTHING THE PERSON POSTED COMES OFF THE SITE, and it is said plainly
   before the button is pressed. The alternative was considered and rejected:
   leaving a job posting up means either keeping the document that carries the
   poster's own name and address, which is the opposite of deleting an
   account, or deleting it and leaving the published row ORPHANED — carried
   for ever by build-jobs.mjs and beyond anyone's reach, including the
   maintainer's. A posting nobody can correct or take down is worse for the
   school than one that is gone.

   THE ORDER MATTERS AND IS THE SAME ORDER THE MERGE USES: withdraw first,
   delete the sign-in last. A sign-in that has gone cannot write, so anything
   still owed at that point is owed for ever. Whatever the browser could not
   finish, the sweep finishes, which is why the work order is written FIRST.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.OAAccountDelete = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var COLLECTION = 'accountDeletions';

  /** Every key a BROWSER writes on a work order — the account page's own and
      the maintainer's, which are the same document with a different `by`.
      Pinned against the create rule's hasOnly() in _firestore.rules BOTH
      WAYS: a key with no rule is a permission-denied nobody can debug, and a
      rule with no writer is dead. */
  var REQUEST_KEYS = ['uid', 'by', 'email', 'name', 'askedAt', 'status'];

  /** …and every key the SWEEP adds afterwards with the Admin SDK. They are
      deliberately DISJOINT from the list above, and no browser ever updates
      one of these documents — it creates one, or deletes one it has not
      carried out yet. That is what makes an Admin-SDK stamp here safe: the
      sync-user-directory trap is a stamp that makes a document its own owner
      can no longer write, and there is no later owner write to freeze. */
  var SWEEP_KEYS = ['clearedAt', 'doneAt', 'removed', 'note'];

  /** Who asked. 'self' is the account page; 'admin' is the roster. The rules
      pin each to the account that may write it, so a work order cannot claim
      to be somebody else's decision. */
  var BY = ['self', 'admin'];

  /**   requested   nobody has touched it yet
        clearing    the account itself is gone (sign-in, alerts, details,
                    roster row, messages) and what is left is the postings'
                    own documents, which may not be deleted until the site has
                    actually stopped showing them
        done        nothing of this account is left anywhere  */
  var STATUSES = ['requested', 'clearing', 'done'];

  /** What a person types to mean it. A confirm() is what this repository uses
      for a takedown, and a takedown is reversible by editing the posting; this
      is not, so it asks for a word. */
  var CONFIRM_WORD = 'DELETE';

  function str(v, max) {
    var s = v === null || v === undefined ? '' : String(v);
    return s.length > max ? s.slice(0, max) : s;
  }

  var MAXLEN = { email: 200, name: 200, note: 500 };

  /** The work order itself, as a plain object. Pure, so both writers and the
      selftest mint the identical document, and `now` is injected rather than
      read off a clock. Empty fields are OMITTED, the way `ref` is omitted
      from a published row: an account signed in with ORCID carries no e-mail
      claim at all, and writing an empty string would make "we do not know"
      indistinguishable from "there is none". */
  function requestDoc(spec) {
    var s = spec || {};
    var uid = str(s.uid, 128);
    var by = BY.indexOf(s.by) === -1 ? '' : s.by;
    if (!uid || !by) return null;
    var doc = { uid: uid, by: by, askedAt: Number(s.now) || 0, status: 'requested' };
    var email = str(s.email, MAXLEN.email).trim();
    var name = str(s.name, MAXLEN.name).trim();
    if (email) doc.email = email;
    if (name) doc.name = name;
    return doc;
  }

  /** True only for the exact word, ignoring the spaces a paste brings with
      it. Case IS significant: a capital word typed out in full is the point
      of asking for one. */
  function matchesConfirmation(typed) {
    return String(typed === null || typed === undefined ? '' : typed).trim() === CONFIRM_WORD;
  }

  /** What this account holds, from the same survey the merge takes
      (OAAccounts.survey()). Counts only — the panel names the postings from
      the survey itself, and this is what the copy and the tests agree on. */
  function summarise(survey) {
    var s = survey || {};
    var n = function (a) { return (a && a.length) || 0; };
    return {
      alerts: n(s.alerts),
      jobs: n(s.jobs),
      cands: n(s.cands),
      places: n(s.places),
      /* Whether this browser could READ what the account holds. It decides
         what the panel can SAY and nothing else. The merge refuses to run
         without it, because nothing but that browser finishes a merge; a
         deletion is finished by the sweep, which enumerates the account with
         the Admin SDK and cannot be refused, so an unreadable survey makes
         the list incomplete and never the deletion impossible. */
      postingsOk: s.postingsOk !== false
    };
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function listWords(bits) {
    var b = bits.filter(Boolean);
    if (!b.length) return '';
    if (b.length === 1) return b[0];
    return b.slice(0, -1).join(', ') + ' and ' + b[b.length - 1];
  }

  /** The sentence above the button, in the reader's own terms. The postings
      and the alerts are said SEPARATELY and deliberately: a posting comes off
      the site, where everyone can see it went, and an alert is a subscription
      that stops arriving. Rolling the two into one list read as though an
      e-mail alert had been published somewhere. No em dash, by the house rule
      every piece of copy written since 2026-08 follows. */
  function describe(counts) {
    var c = counts || {};
    /* Nothing could be read, so "your account holds nothing you have posted"
       would be this page inventing an answer it does not have. Say what is
       true of every deletion instead: all of it goes. */
    if (c.postingsOk === false) {
      return 'This deletes your account and everything on it. Anything you have ' +
        'posted comes off the site, and your e-mail alerts, your details, your ' +
        'messages and your sign-in go with it.';
    }
    var posted = [];
    if (c.jobs) posted.push(plural(c.jobs, 'job posting'));
    if (c.cands) posted.push(plural(c.cands, 'candidate profile'));
    if (c.places) posted.push(plural(c.places, 'placement report'));
    var rest = [];
    if (c.alerts) rest.push('your ' + plural(c.alerts, 'e-mail alert'));
    rest.push('your details', 'your messages', 'your sign-in');
    return (posted.length
      ? 'This deletes your account and takes ' + listWords(posted) + ' off the site. '
      : 'Your account holds nothing you have posted. Deleting it removes ') +
      (posted.length ? capitalise(listWords(rest)) + ' go with it.'
                     : listWords(rest) + '.');
  }

  function capitalise(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /** Everything the deletion touches, for the panel's list and for the
      sweep's report. Names, not counts, so the person can see WHICH posting
      is about to come off the site. */
  function itemsOf(survey) {
    var s = survey || {};
    var out = [];
    (s.jobs || []).forEach(function (d) {
      var v = d.data || {};
      out.push({ kind: 'job', id: d.id, ref: v.ref || '',
        label: [v.institution, v.department || v.unit].filter(Boolean).join(', ') ||
               'a job posting' });
    });
    (s.cands || []).forEach(function (d) {
      var v = d.data || {};
      out.push({ kind: 'candidate', id: d.id, ref: v.ref || '',
        label: [v.first, v.last].filter(Boolean).join(' ') || 'your candidate profile' });
    });
    (s.places || []).forEach(function (d) {
      var v = d.data || {};
      out.push({ kind: 'placement', id: d.id, ref: v.ref || '',
        label: [v.first, v.last].filter(Boolean).join(' ') || 'a placement report' });
    });
    return out;
  }

  /** What the sweep leaves behind once it is finished. The work order is kept
      as a RECORD that an account was deleted on a day, and a record of a
      deleted person that still carries their name and address is the thing
      the deletion was for. So both go, and what stays is a uid, a date and
      counts. */
  function redacted(doc, now) {
    var d = doc || {};
    var out = {
      uid: d.uid, by: d.by, askedAt: d.askedAt || 0,
      status: 'done', doneAt: Number(now) || 0
    };
    if (d.clearedAt) out.clearedAt = d.clearedAt;
    if (d.removed) out.removed = d.removed;
    if (d.note) out.note = str(d.note, MAXLEN.note);
    return out;
  }

  /** WHICH PUBLISHED ROWS STILL NAME THIS ACCOUNT. `owner` is on every served
      row of all three datasets (PUBLIC_FIELDS, CANDIDATE_PUBLIC_FIELDS,
      PLACEMENT_PUBLIC_FIELDS) and is a digest of the uid, so the site's own
      published files can be asked the question directly rather than inferred
      from what a document says about itself.

      `refs` and `ids` are the belt to that braces, for the same reason
      removalSpecs reads both: a row published before the tag existed, or one
      renumbered by a same-day sibling, still answers to one of them.

      MEASURED, NEVER ASSUMED — the discipline `matchServed` and
      `partitionLive` already follow. A submission's document may only be
      deleted once no served file carries its row, because deleting it any
      earlier leaves that row an ORPHAN that build-jobs.mjs carries for ever. */
  function stillPublished(rows, spec) {
    var s = spec || {};
    var tag = s.owner || '';
    var refs = {}, ids = {};
    (s.refs || []).forEach(function (r) { if (r) refs[r] = true; });
    (s.ids || []).forEach(function (i) { if (i) ids[i] = true; });
    return (rows || []).filter(function (r) {
      if (!r) return false;
      if (tag && r.owner === tag) return true;
      if (r.ref && refs[r.ref]) return true;
      return !!(r.id && ids[r.id]);
    });
  }

  /** WHICH CONTROL A ROSTER ROW IS OFFERED, from the work order it has (or
      has not). Pure and up here with the rest of the model rather than beside
      the table that draws it, so the selftest can hold the roster to it: a
      deletion already being carried out must not be offered a Cancel button,
      because the rules refuse that and "cancelled" would be a lie. */
  function stateOf(req) {
    if (!req) return { queued: false, label: '', cancellable: false };
    if (req.status === 'done') {
      return { queued: false, label: 'Deleted', cancellable: false };
    }
    if (req.status === 'clearing') {
      return { queued: true, label: 'Deleting now', cancellable: false };
    }
    return { queued: true, label: 'Deletion queued', cancellable: true };
  }

  var api = {
    COLLECTION: COLLECTION,
    REQUEST_KEYS: REQUEST_KEYS,
    SWEEP_KEYS: SWEEP_KEYS,
    BY: BY,
    STATUSES: STATUSES,
    CONFIRM_WORD: CONFIRM_WORD,
    MAXLEN: MAXLEN,
    requestDoc: requestDoc,
    matchesConfirmation: matchesConfirmation,
    summarise: summarise,
    describe: describe,
    itemsOf: itemsOf,
    redacted: redacted,
    stillPublished: stillPublished,
    stateOf: stateOf
  };

  /* ---------------------------------------------------- the browser wiring */

  if (typeof document === 'undefined') return api;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function db() {
    return root.OAFB.ready().then(function (fb) { return fb.firestore(); });
  }

  /** The panel's own message line. `role="status"` is in the markup, so a
      change here is announced. */
  function say(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'oa-form-msg' + (kind ? ' is-' + kind : '');
  }

  /** The copy for a write the rules have not been published for yet. Every
      other panel on this site says what to press rather than showing a bare
      permission-denied, and says RELOAD FIRST, because the copy reporting a
      missing deploy may itself predate it. */
  function notDeployed(err) {
    return err && err.code === 'permission-denied';
  }

  /* It used to say "This is not switched on yet" outright, which sent the owner
     looking for a rules deploy that had happened hours earlier: the real cause
     was a second attempt being refused as an update (see the work order step).
     That is fixed, so the remaining causes really are the rules, but the copy
     no longer states one as fact before the reader has tried the cheap thing. */
  var NOT_DEPLOYED =
    'The site would not accept that. Reload the page and try once more. If it ' +
    'still says this, the database rules need publishing and the site’s ' +
    'maintainer can do it.';

  /* ------------------------------------------------- a person’s own account */

  var selfState = { open: false, survey: null, busy: false, finished: false };

  function stepLine(host, text) {
    if (!host) return;
    host.hidden = false;
    var li = document.createElement('li');
    li.textContent = text;
    host.appendChild(li);
  }

  function renderSelfPanel() {
    var host = $('pa-delete-panel');
    if (!host) return;
    var c = summarise(selfState.survey);
    var items = itemsOf(selfState.survey);

    host.innerHTML =
      '<p class="v3-pa-danger-lede" id="pa-delete-what">' + esc(describe(c)) + '</p>' +
      (items.length
        ? '<ul class="v3-pa-danger-list" id="pa-delete-list">' +
            items.map(function (i) {
              return '<li>' + esc(i.label) + ' <span class="v3-mut">(' +
                esc(i.kind === 'job' ? 'job posting'
                  : i.kind === 'candidate' ? 'candidate profile' : 'placement report') +
                ')</span></li>';
            }).join('') +
          '</ul>'
        : '') +
      (c.postingsOk
        ? ''
        : '<p class="oa-note is-warn" id="pa-delete-unread">We could not list what ' +
          'this account holds, so nothing is named above. Deleting still removes all ' +
          'of it: the site does the removal itself and does not read it from this ' +
          'page.</p>') +
      '<p class="v3-pa-danger-warn">This cannot be undone. Your sign-in is removed, and ' +
        'signing up again later starts an empty account.</p>' +
      '<p><label for="pa-delete-word">Type <strong>' + esc(CONFIRM_WORD) +
        '</strong> to confirm</label>' +
        '<input type="text" id="pa-delete-word" autocomplete="off" spellcheck="false" ' +
          'aria-describedby="pa-delete-what"></p>' +
      '<p class="v3-cta-row">' +
        '<button type="button" class="v3-btn danger" id="pa-delete-go" disabled>' +
          'Delete my account</button> ' +
        '<button type="button" class="v3-btn ghost" id="pa-delete-cancel">Keep my account</button>' +
      '</p>' +
      '<ul class="v3-pa-danger-log" id="pa-delete-log" hidden></ul>';

    var word = $('pa-delete-word');
    var go = $('pa-delete-go');
    /* THE CONFIRMATION IS THE ONLY GATE. It used to require a readable survey
       as well, and that was a dead end rather than a safeguard: the survey is
       how the panel NAMES what will go, while the removal itself is the
       sweep's, with the Admin SDK, over an account it enumerates server-side.
       Owner, 2026-09-05, on a newly registered account whose reads were still
       being refused by a token minted before it confirmed its address: the
       button was disabled and there was no way past it. */
    function refresh() {
      go.disabled = !matchesConfirmation(word.value);
    }
    word.addEventListener('input', refresh);
    refresh();
    word.focus();

    $('pa-delete-cancel').addEventListener('click', closeSelfPanel);
    go.addEventListener('click', function () { runSelfDelete(go); });
  }

  function closeSelfPanel() {
    selfState.open = false;
    show($('pa-delete-panel'), false);
    show($('pa-delete-open'), true);
    say($('pa-delete-msg'), '');
    var opener = $('pa-delete-open');
    if (opener) opener.focus();
  }

  /** THE ONE ACCOUNT THIS IS WITHHELD FROM: the maintainer's own (owner,
      2026-09-05). Deleting it would take the Admin area, the review queues and
      the roster with it, and the roster already withholds the same control on
      their own row — the personal area was the way round that.

      IT IS A GUARD AGAINST AN ACCIDENT AND NOT AN AUTHORISATION, and saying so
      is the honest half: the rules still let any owner file their own order,
      because isAdmin() is keyed on an ADDRESS rather than on an account, and a
      maintainer who genuinely means it registers again with the same address
      and is the maintainer again. What this removes is a button that deletes
      the site's own account in two presses and a typed word. */
  function isMaintainer() {
    return !!(root.OAAccounts && root.OAAccounts.isAdmin && root.OAAccounts.isAdmin());
  }

  function openSelfPanel() {
    var msg = $('pa-delete-msg');
    if (selfState.busy) return;
    if (!root.OAAccounts || !root.OAAccounts.user()) {
      say(msg, 'Sign in first.', 'err');
      return;
    }
    if (isMaintainer()) return;
    if (!root.OAFB || !root.OAFB.enabled || root.OAAccounts.failed()) {
      say(msg, 'Sign-in is unavailable at the moment, so nothing can be deleted. ' +
        'Please try again later.', 'err');
      return;
    }
    selfState.open = true;
    show($('pa-delete-open'), false);
    show($('pa-delete-panel'), true);
    $('pa-delete-panel').innerHTML = '<p class="v3-mut">Checking what this account holds…</p>';
    say(msg, '');

    root.OAAccounts.survey().then(function (s) {
      selfState.survey = s;
      if (!selfState.open) return;
      renderSelfPanel();
    })['catch'](function () {
      selfState.survey = { alerts: [], jobs: [], cands: [], places: [], postingsOk: false };
      if (selfState.open) renderSelfPanel();
    });
  }

  /**
   * The deletion itself, in the merge's own order and for the merge's own
   * reason: nothing is deleted until what depends on it has been dealt with,
   * and the sign-in goes LAST because a session that has gone cannot write.
   *
   * Every step is idempotent, and the work order is written FIRST — before
   * anything is taken down — so that a browser closed half way through, a
   * refused write or a cancelled password check leaves a record the sweep
   * finishes from. That is the one thing this flow cannot do without: without
   * the order there is no way for anything to know the account was meant to
   * go, and the person cannot ask again because their alerts, their details
   * and possibly their sign-in are already gone.
   */
  function runSelfDelete(go) {
    var msg = $('pa-delete-msg');
    var log = $('pa-delete-log');
    var cancel = $('pa-delete-cancel');
    var user = root.OAAccounts.user();
    if (!user) { say(msg, 'Sign in first.', 'err'); return; }

    selfState.busy = true;
    go.disabled = true;
    go.textContent = 'Deleting…';
    if (cancel) cancel.hidden = true;
    say(msg, 'Deleting your account…');

    var survey = selfState.survey || {};
    var uid = user.uid;
    var order = requestDoc({
      uid: uid,
      by: 'self',
      email: user.email || '',
      name: root.OAAccounts.displayName(),
      now: Date.now()
    });

    var signInGone = false;

    db().then(function (d) {
      /* 1. THE WORK ORDER, before anything is taken away. A permission-denied
            here means the rules carrying this collection are not published
            yet, and the honest answer is to change nothing at all rather than
            to start a deletion nothing could finish.

            READ FIRST, AND ONLY WRITE WHAT IS NOT THERE. The rules refuse
            every browser UPDATE of a work order, which is what makes the
            sweep's own stamps safe — and to Firestore a `set` over a document
            that already exists IS an update. So a second attempt (the first
            having stopped part way, which is exactly what the password prompt
            used to cause) was refused with a permission-denied, and the panel
            read it as rules that were never published. Reported by the owner,
            2026-09-05, on an account they could then never delete.

            A read that itself fails changes nothing: fall through to the
            write, so a genuine rules problem still surfaces as one. */
      var ref = d.collection(COLLECTION).doc(uid);
      return ref.get()['catch'](function () { return null; }).then(function (snap) {
        if (snap && snap.exists) {
          stepLine(log, 'Your request was already recorded.');
          return d;
        }
        return ref.set(order).then(function () {
          stepLine(log, 'Recorded the request.');
          return d;
        });
      });
    }).then(function (d) {
      /* 2. TAKE THE POSTINGS DOWN. A status change, never a delete: deleting
            the document leaves the published row an orphan the build carries
            for ever, which is the opposite of taking it down (the rule
            build-jobs.mjs states in as many words). The documents themselves
            are deleted by the sweep, once the site has stopped showing them. */
      var cols = [
        [root.OAFB.col.jobSubmissions, survey.jobs || []],
        [root.OAFB.col.candidateSubmissions, survey.cands || []],
        [root.OAFB.col.placementSubmissions, survey.places || []]
      ];
      var down = 0;
      return cols.reduce(function (chain, pair) {
        return chain.then(function () {
          return Promise.all((pair[1] || []).map(function (doc) {
            if (doc.data && doc.data.status === 'removed') return null;
            down++;
            return d.collection(pair[0]).doc(doc.id).update({
              status: 'withdrawn',
              updatedAt: new Date().toISOString()
            })['catch'](function () { down--; });
          }));
        });
      }, Promise.resolve()).then(function () {
        stepLine(log, down
          ? 'Took ' + plural(down, 'posting') + ' off the site.'
          : 'You had nothing posted on the site.');
        return d;
      });
    }).then(function (d) {
      /* 3. THE ALERTS, explicitly. Deleting a sign-in does not delete its
            Firestore data, and the mailer reads every alert in the database
            by collection group — so an alert left behind e-mails a person who
            no longer exists, for ever. The merge learnt this the same way. */
      var alerts = d.collection(root.OAFB.col.users).doc(uid)
        .collection(root.OAFB.col.alerts);
      return Promise.all((survey.alerts || []).map(function (a) {
        return alerts.doc(a.id)['delete']()['catch'](function () {});
      })).then(function () {
        stepLine(log, (survey.alerts || []).length
          ? 'Cancelled ' + plural(survey.alerts.length, 'e-mail alert') + '.'
          : 'You had no e-mail alerts.');
        return d;
      });
    }).then(function (d) {
      /* 4. The details, the tally and the roster row. All three are
            owner-deletes by the rules, and the tally and the row are deleted
            for the same reason the merge deletes them: the count is of
            PEOPLE, and a row left behind lists somebody who has gone. */
      return Promise.all([
        d.collection(root.OAFB.col.profiles).doc(uid)['delete']()['catch'](function () {}),
        d.collection(root.OAFB.col.registered).doc(uid)['delete']()['catch'](function () {}),
        d.collection((root.OAFB.col && root.OAFB.col.userDirectory) || 'userDirectory')
          .doc(uid)['delete']()['catch'](function () {})
      ]).then(function () { stepLine(log, 'Cleared your details.'); });
    }).then(function () {
      /* 5. …and only now the sign-in. Anything still owed after this point is
            owed for ever, which is why the sweep, not this browser, is what
            makes the promise true.

            AND IT NEVER ASKS FOR THE PASSWORD BACK. Firebase refuses to delete
            a session older than a few minutes until it is re-proved, and the
            merge asks, because nothing else can finish a merge. This can:
            the work order is already filed and the sweep removes the sign-in
            with the Admin SDK. Owner, 2026-09-05, stopped at that prompt on a
            password they did not remember, then unable to try again: "There is
            no reason we ask them to add their password." So it tries, and a
            refusal is not a failure here, it is the ordinary path for anyone
            who did not sign in a minute ago. */
      return root.OAAccounts.deleteSignIn({ reauth: false }).then(function () {
        signInGone = true;
        stepLine(log, 'Removed your sign-in.');
      })['catch'](function () {
        stepLine(log, 'Your sign-in is removed for you shortly, within about ' +
          'twenty minutes.');
      });
    }).then(function () {
      /* `finished` before `busy` goes: the sign-in has already gone, so the
         auth handler has fired or is about to, and between the two flags the
         section must never be hidden. */
      selfState.finished = true;
      selfState.busy = false;
      say(msg, '');
      var host = $('pa-delete-panel');
      host.innerHTML =
        '<h3 class="v3-h3">Your account is gone.</h3>' +
        '<p>Thank you for having been part of Operations Academia. Everything you ' +
          'posted comes off the site within a few minutes, and nothing that says ' +
          'who you were is kept.</p>' +
        (signInGone
          ? ''
          : '<p>You are signed out now, and the sign-in itself is removed for you ' +
            'within about twenty minutes. There is nothing more for you to do.</p>') +
        '<p class="v3-cta-row"><a class="v3-btn primary" href="./">Back to the site</a></p>';
      /* Sign out whatever happened above: the local memory of this account —
         the header hint with its picture, the menu counts — belongs to an
         account that no longer exists, and a shared machine must not show the
         next person any of it. */
      try { root.OAAccounts.signOut(); } catch (e) { /* already gone */ }
      forgetThisDevice(uid);
    })['catch'](function (err) {
      selfState.busy = false;
      go.disabled = false;
      go.textContent = 'Delete my account';
      if (cancel) cancel.hidden = false;
      say(msg, notDeployed(err)
        ? NOT_DEPLOYED
        : 'We could not delete the account (' +
          ((err && (err.code || err.message)) || 'unknown error') +
          '). Nothing was removed, so you can try again.', 'err');
      if (root.console) root.console.error('OA delete:', err);
    });
  }

  /** WHAT SIGNING OUT DOES NOT REACH. `signOut()` clears the header hint, the
      picture beside it and the two count caches, which is right for signing
      out: the rest is this BROWSER's working state and belongs to whoever is
      sitting there. A deletion is the case where it does not. The job form's
      unsent draft is the one that matters — it holds the poster's own name and
      address, the chair's name and address and the private note, and it is
      cleared only by a successful send — and the two per-uid latches and the
      pending marker carry the uid itself.

      Named, never a prefix sweep: a machine may be shared, and a key belonging
      to some OTHER account here is somebody else's. Each removal is wrapped,
      because a private window throws on the accessor itself. */
  function forgetThisDevice(uid) {
    var LOCAL = ['oa:jobdraft:v1', 'oaFreshJobs', 'oaAuthPending',
      'oaProfileAsked:' + uid];
    var SESSION = ['oaDir:' + uid, 'oaTally:' + uid];
    LOCAL.forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* private mode */ }
    });
    SESSION.forEach(function (k) {
      try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ }
    });
  }

  /* ------------------------------------------------- the maintainer's side */

  /** Ask for an account to be deleted, as the maintainer. Returns the work
      order that was written, so the roster can paint the row without a
      re-read. The confirmation is the caller's, because only the roster knows
      whose row was pressed. */
  function requestFor(row, now) {
    var order = requestDoc({
      uid: row && row.uid, by: 'admin',
      email: (row && row.email) || '', name: (row && row.name) || '',
      now: now || Date.now()
    });
    if (!order) return Promise.reject(new Error('no account named'));
    return db().then(function (d) {
      /* the same read-first as the account page's own, and for the same
         reason: a `set` over an order that is already filed is an UPDATE, and
         every browser update of one is refused */
      var ref = d.collection(COLLECTION).doc(order.uid);
      return ref.get()['catch'](function () { return null; }).then(function (snap) {
        return (snap && snap.exists) ? null : ref.set(order);
      });
    }).then(function () { return order; });
  }

  /** Call it off, while it is still queued. The rules refuse this once the
      sweep has started, because "cancelled" would then be a lie — the alerts
      and the sign-in are already gone. */
  function cancelFor(uid) {
    return db().then(function (d) {
      return d.collection(COLLECTION).doc(String(uid))['delete']();
    });
  }

  /** Every work order, keyed by uid, for the roster to paint from. A refused
      read answers null — unknown, never an empty map, which would draw every
      row as though nothing were queued. */
  function loadRequests() {
    return db().then(function (d) {
      return d.collection(COLLECTION).get();
    }).then(function (snap) {
      var out = Object.create(null);
      snap.forEach(function (doc) { out[doc.id] = doc.data() || {}; });
      return out;
    })['catch'](function () { return null; });
  }

  api.requestFor = requestFor;
  api.cancelFor = cancelFor;
  api.loadRequests = loadRequests;

  /* ------------------------------------------------------------------ boot */

  function boot() {
    var opener = $('pa-delete-open');
    if (!opener || !root.OAAccounts) return;
    opener.addEventListener('click', openSelfPanel);
    /* The section is drawn for a signed-in reader and for nobody else. It
       follows the auth event rather than the hint: a control that deletes an
       account must never be painted from a remembered value that the SDK then
       contradicts.

       …AND IT SURVIVES THE SIGN-OUT IT CAUSED. Deleting the sign-in fires this
       handler with a null user, and signOut() fires it again; hiding the
       section on either would take the "Your account is gone" card off the
       screen the instant it was drawn, leaving a page that says nothing at all
       happened. So a run that is under way or finished holds the section
       open. */
    root.OAAccounts.onChange(function (user) {
      show($('pa-delete'), !!user || selfState.busy || selfState.finished);
      if (!user && selfState.open && !selfState.busy && !selfState.finished) closeSelfPanel();
      /* The maintainer is offered the reason instead of the button. Painted
         here rather than once at boot because isAdmin() answers from the
         resolved session, which is exactly what this event delivers; and only
         while nothing is under way, so it cannot fight the panel. */
      if (selfState.open || selfState.busy || selfState.finished) return;
      var admin = !!user && isMaintainer();
      show($('pa-delete-open'), !!user && !admin);
      show($('pa-delete-admin'), admin);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return api;
}));
