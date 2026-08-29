/* ---------------------------------------------------------------------------
   Operations Academia — what a reader who has not registered may READ.

   ONE definition, loaded by every consumer:

     the jobs page          <script src="assets/oa-gate.js">  -> window.OAGate
     the one-pager          the same tag                      -> window.OAGate
     previous markets       the same tag                      -> window.OAGate
     the Excel download     the same tag (signedIn)           -> window.OAGate
     the selftest           createRequire(...)                -> module.exports

   THE RULE (owner, 2026-08-29, from two screenshots of the site signed out):
   a reader who is not registered and not signed in may see WHO is hiring and
   WHO is on the market — the sponsor's posting and the universities behind
   the ones beside it, every candidate's name — and nothing else. The card
   does not open on them, and the details are drawn as a blurred, unreadable
   strip so it is plain that there is something there and plain how to reach
   it. Expanding a posting in place belongs to a registered reader who has
   opened the full list.

   IT IS A NUDGE, NOT AN ACCESS CONTROL, AND IT CANNOT BE ONE HERE. This is a
   static site on GitHub Pages: `data/jobs.json` and `data/candidates.json` are
   served to anybody who asks for them, and no rule in this repository can
   change that without a backend to put them behind. So what this file decides
   is WHAT THE SITE SHOWS, which is a product decision and a real one — it is
   the difference between a page that reads as a directory of open positions
   and one that reads as a list of universities with a reason to register —
   and no page, no comment and no e-mail may describe it as security. The
   sign-in card on jobs.html says exactly that, and `selftest.mjs` pins that
   nothing claims otherwise.

   WHY THE DECISION IS TAKEN FROM THE HINT FIRST. `OAAccounts.hint()` is the
   localStorage memory of the last resolved auth state, and it is what the
   account chip is painted from — for the reason recorded in CLAUDE.md, that
   anything painted from a remembered value must be painted in its FINAL form
   or not at all. A gate resolved only when the SDK answers would show every
   signed-in reader a second of locked cards on every page load, and would
   show a signed-out one a second of details. Neither is a flash worth having,
   and the hint removes both; the real state reconciles it a moment later
   through `watch()`, which re-renders.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAGate = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var G = (typeof window !== 'undefined') ? window : {};

  /** What the strip says, per state. One place, so the pages, the sign-in
      card and the tests cannot word the same fact three ways. */
  var NOTE = 'Sign in to see the details';
  var NOTE_UNAVAILABLE = 'Sign-in is unavailable at the moment';
  var NOTE_FULL = 'Open it on the full list';

  /* A test hook, and the only one. The auth state comes from an SDK the
     browser checks cannot load, so without this every check that needs a
     detail on screen would have to stand a fake Firebase up first. It only
     ever reveals what is already in a public served file — see the header —
     so it cannot widen anything that is not already open, which is the same
     argument `OAJobEdit.__setPermissionsForTest` is written under. */
  var forced = null;

  /**
   * Is this reader signed in, as far as anything can tell RIGHT NOW?
   *
   * The one definition on the site: `assets/oa-jobexport.js` asks here too,
   * so the button that downloads the list and the cards that show it cannot
   * disagree about who is signed in. Both pages load this file first, which
   * `selftest.mjs` pins — the sponsors lesson, that a module which silently
   * falls back when its dependency is missing is right most of the time and
   * therefore the worst possible shape.
   */
  function signedIn() {
    if (forced !== null) return !forced;
    var A = G.OAAccounts;
    if (!A) return false;
    if (A.resolved && A.resolved()) return !!A.user();
    return !!(A.hint && A.hint() === 'in');
  }

  /** Nobody can sign in — no accounts module, or an SDK that could not be
      loaded (offline, a blocked CDN, an ad blocker). The reader is still
      locked, because they are still not registered, but the strip says why
      rather than offering a control that would do nothing when pressed. That
      is the wording `oa-jobexport.js` already gives its disabled button. */
  function unavailable() {
    if (forced !== null) return false;
    var A = G.OAAccounts;
    return !A || !!(A.failed && A.failed());
  }

  /** The reader may not read the details. */
  function locked() { return !signedIn(); }

  /**
   * Build the `cardOpen` a list mount declares — see the option's own block in
   * assets/oa-list.js. Returns a descriptor when a click on a card must do
   * something OTHER than open it where it stands, or null to open it there.
   *
   *   opts.note   what the strip says when locked (defaults to NOTE)
   *   opts.full   row -> href. Given, a SIGNED-IN reader is sent to the full
   *               list rather than expanding the card here: the one-pager's
   *               teaser is ten postings, and "expand it on the full list" is
   *               what the owner asked for. Omitted, they expand in place.
   */
  function cardOpen(opts) {
    opts = opts || {};
    return function (row) {
      if (locked()) {
        return {
          blur: true,
          note: unavailable() ? NOTE_UNAVAILABLE : (opts.note || NOTE),
          run: unavailable() ? null : signIn
        };
      }
      if (typeof opts.full !== 'function') return null;   // open it here
      var href = opts.full(row);
      if (!href) return null;
      return {
        blur: false,
        note: opts.fullNote || NOTE_FULL,
        run: function () { G.location.href = href; }
      };
    };
  }

  /** Offer the sign-in box, remembering which card was pressed so the reader
      lands ON it rather than at the top of a list they have to find it in
      again. `whenSignedIn` is the site's own primitive: it runs now if they
      are signed in, QUEUES if the session is still restoring — so a click in
      that window is not silently lost — and opens the box if they are not. */
  var pending = '';
  function signIn(row) {
    pending = String((row && row.id) || '');
    var A = G.OAAccounts;
    if (A && A.whenSignedIn) A.whenSignedIn(function () {});
  }

  /**
   * Re-render a mounted list whenever the auth state changes, and open the
   * card whose lock was pressed if that is what changed it.
   *
   * The gate is painted from the hint before the session restores, so the
   * list HAS to be able to change shape late — which is exactly what
   * `rerender()` was added to the engine for.
   */
  function watch(list) {
    if (!list || !list.rerender) return;
    var A = G.OAAccounts;
    if (!A || !A.onChange) return;
    A.onChange(function (user) {
      list.rerender();
      if (user && pending && list.open) {
        var id = pending;
        pending = '';
        list.open(id);
      }
    });
  }

  return {
    NOTE: NOTE,
    NOTE_UNAVAILABLE: NOTE_UNAVAILABLE,
    NOTE_FULL: NOTE_FULL,
    signedIn: signedIn,
    unavailable: unavailable,
    locked: locked,
    cardOpen: cardOpen,
    watch: watch,
    /** See `forced` above: the browser checks' only way to put a reader on
        either side of the gate without a Firebase to sign them in. */
    __setForTest: function (isLocked) {
      forced = (isLocked === null || isLocked === undefined) ? null : !!isLocked;
    }
  };
}));
