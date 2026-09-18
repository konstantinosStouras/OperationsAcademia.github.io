/* ---------------------------------------------------------------------------
   Operations Academia — TAKING A JOB POSTING DOWN, in ONE place.

   Owner, 2026-09-18, of a test posting of their own: "add a button here at the
   bottom to 'delete' a job posting once opened for edit. I have posted a test
   posting and can't delete it now... Add also a delete button next to the
   button 'Mark reviewed'."

   Both halves were real, and neither was a missing capability — the rules have
   let a poster withdraw their own posting and the maintainer hide any of them
   since the day they were written. What was missing is a CONTROL on the two
   screens the maintainer actually lands on: the edit form (`post-a-job?edit=`,
   which is where "Open & correct" on the Admin area takes them) and the
   user-added card on /admin-area. Take down lived on the CARD LISTS alone
   (oa-jobedit.js on the jobs page, previous markets and the map; oa-myjobs.js
   on My postings) — and a posting whose season has rolled is on Previous
   markets rather than /jobs, so the one control that could take the owner's
   test posting down was on neither page they were looking at.

   WHY THIS IS A MODULE RATHER THAN A THIRD COPY. There were already TWO
   copies of this eight-line write, and they had DRIFTED, which is the failure
   `oa-countries.js`, `oa-schools.js`, `oa-news.js` and `oa-jobnav.js` all
   exist to prevent: oa-jobedit.js echoed the takedown into this browser's
   own view of the list and oa-myjobs.js did not, and one promised "within a
   few minutes" while the other promised "at the next update, normally within
   an hour" — a cadence the instant-publish doorbell has made false since
   2026-08-27. Adding the owner's two buttons as two more copies would have
   made four. So this file owns the whole of what a takedown IS — the status,
   the stamp, the echo and the words — and every surface is a caller.
   `selftest.mjs` pins that no caller writes a status of its own.

   TAKING A POSTING DOWN IS A STATUS CHANGE, NEVER A DOCUMENT DELETE, and
   that is not a preference. `build-jobs.mjs` CARRIES a row no live document
   accounts for (its "orphans" pass, so the served file only ever shrinks
   because a posting was taken down and never because a document is missing),
   so deleting the document would leave the row on the site for ever with
   nothing anywhere able to reach it — no Edit, no Take down, no correction.
   The rules say the same thing from their end: `allow delete` is the
   maintainer's, and it is the one thing that must not be pressed here.

   WHO TOOK IT DOWN is the status. `hidden` is the maintainer, `withdrawn` the
   poster, and the build reads the difference: a withdrawal is stamped
   `removed` once it has taken effect, while `hidden` STAYS hidden and is
   re-applied on every run. Recorded the wrong way round, a maintainer's
   takedown would be undone by the poster's next edit. The question is asked
   of `OAAccounts.isAdmin()`, the site's one definition of the maintainer, and
   with that module absent the answer is `withdrawn` — the narrower status,
   which still takes the row off the site and is the one the rules let an
   ordinary owner write.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  /** The label every surface gives the control, so three screens cannot
      disagree about what the thing is called. */
  var LABEL = 'Take down';

  /** How long the site takes, in the words every other surface of this page
      already uses. `publishOnChange` rings the build the moment a posting
      changes, so it is minutes — not the "next update, normally within an
      hour" one of the two old copies promised. If the cadence ever changes,
      change it HERE and all four surfaces follow. */
  var WHEN = 'within a few minutes';

  function col() {
    return (window.OAFB && OAFB.col && OAFB.col.jobSubmissions) || 'jobSubmissions';
  }

  /** The maintainer, or nobody: see the header on why absence means the
      poster's own narrower status rather than the maintainer's. */
  function amAdmin() {
    return !!(window.OAAccounts && OAAccounts.isAdmin && OAAccounts.isAdmin());
  }

  function statusFor(isAdmin) { return isAdmin ? 'hidden' : 'withdrawn'; }

  /** Which posting, in the words the card and the form both show: the
      institution, and the line under it where the row has one. A row from the
      served file carries `department` already joined; a Firestore document
      carries the two parts it is joined from. */
  function describe(row) {
    var r = row || {};
    var line = String(r.department || '').trim() ||
      [r.school, r.unit].map(function (s) { return String(s || '').trim(); })
        .filter(Boolean).join(', ');
    return (String(r.institution || '').trim() || 'this posting') +
      (line ? ' — ' + line : '');
  }

  function message(row) {
    return 'Take this posting down?\n\n' + describe(row) + '\n\n' +
      'It stops appearing on the site ' + WHEN + '. Nothing is deleted: the ' +
      'posting keeps its record, and editing it and saving puts it back up.';
  }

  /**
   * Ask first. Separate from run() so each surface keeps its own button
   * state and its own message line, while the WORDS stay one definition — a
   * confirmation that described a takedown differently from what the takedown
   * does is the drift this file was made to end.
   */
  function confirmTakedown(row) {
    return window.confirm(message(row));
  }

  /**
   * Take it down. `id` is the jobSubmissions document; `row` is what the
   * screen is showing, read for its `ref` and for the echo.
   *
   * Resolves with the status written, so a caller can say which it was.
   */
  function run(opts) {
    var o = opts || {};
    var id = String(o.id || '');
    var row = o.row || {};
    if (!id) return Promise.reject(new Error('no document id'));

    var status = statusFor(amAdmin());

    return OAFB.ready().then(function (fb) {
      /* update(), never set(): the rules pin `createdAt` two-sidedly, and a
         set() would carry the posting date back as a fresh value. */
      return fb.firestore().collection(col()).doc(id).update({
        status: status,
        updatedAt: new Date().toISOString(),
      });
    }).then(function () {
      /* THE ECHO (assets/oa-fresh.js). The build takes the row off the site
         for everybody else; this takes it off the list in THIS browser at
         once, so the person who pressed the button does not go back to the
         jobs page and find the posting they have just taken down still on it.
         Best-effort: a page that does not load the module loses the echo and
         nothing else. */
      if (window.OAFresh) OAFresh.stash({ docId: id, ref: row.ref || '', removed: true });
      return { status: status };
    });
  }

  /** The one wording for a refusal, so three surfaces cannot explain it three
      ways. `permission-denied` is the one cause worth naming: it is the answer
      to somebody else's posting, and the only one the reader can act on. */
  function failure(err) {
    return err && err.code === 'permission-denied'
      ? 'You are not allowed to change this posting.'
      : 'We could not take it down. Please try again.';
  }

  window.OATakedown = {
    LABEL: LABEL,
    WHEN: WHEN,
    statusFor: statusFor,
    describe: describe,
    message: message,
    confirm: confirmTakedown,
    run: run,
    failure: failure,
  };
})();
