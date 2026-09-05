/* ---------------------------------------------------------------------------
   Operations Academia: what a forum post may NOT contain, decided once.

   ONE definition, loaded by both sides of the same refusal:

     forum.html             <script src="assets/oa-forum-guard.js"> -> window.OAForumGuard
                            run on every keystroke, so the refusal the function
                            would give is shown before anything is sent
     the Cloud Functions    require('../forum-guard.js'), the VENDORED copy that
                            _scraper/build-functions-vendor.mjs writes and the
                            selftest pins byte-for-byte against this file; the
                            function is the authority and refuses the same text
                            with invalid-argument {reason}
     the selftest           createRequire(...)                    -> module.exports

   WHAT IT REFUSES, and why each. The forum is anonymous, and the words are
   the one place a member can undo that for themselves or for somebody else:

     email   an e-mail address. The pattern is the EMAIL_RX literal in
             _scraper/jobs-model.mjs, copied character for character (that
             module is private to Node and a browser cannot import an .mjs);
             the selftest reads the literal out of that source and fails if
             the two ever differ.
     orcid   an ORCID iD, which names one researcher exactly.
     phone   a telephone number: nine or more digits joined by at most one
             space, dot, hyphen or bracket each. NOT eight: "2026-2027" and
             "2026-09-04" are dates people write all the time; a comma or a
             currency sign breaks the run, so "$120,000-150,000" is a salary
             range; a DOI's digits are broken by its slash.

   A WEB ADDRESS IS ALLOWED (owner, 2026-09-05: "I want users to be able to
   post links in their posts or replies"). It was refused at first, on the
   reading that mit.edu/~jane names a person as surely as a card would; the
   owner's call is that a forum where you cannot link the call for papers you
   are asking about is the poorer trade. So a link posts, the page draws it as
   a link, and the guide says in as many words that a link to your own page
   identifies you. What is still refused is a way to be CONTACTED off the
   forum, or an identifier that names exactly one researcher.

   Order matters only for the reason returned: an ORCID iD is also sixteen
   digits, and it is more useful to be told what it is.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAForumGuard = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* the literal from _scraper/jobs-model.mjs, character for character */
  var EMAIL_RX = /[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

  var ORCID_RX = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/;

  /* a run of digits, each followed by at most one closing bracket and one
     separator; a leading + or ( is allowed. The digit COUNT is judged after
     the match, since the run may hold separators. */
  var PHONE_RX = /\+?\(?(?:\d\)?[ .\-(]?){8,14}\d/g;
  var PHONE_MIN_DIGITS = 9;
  var CURRENCY = '$€£';

  function hasEmail(s) {
    EMAIL_RX.lastIndex = 0;
    return EMAIL_RX.test(s);
  }

  function hasPhone(s) {
    PHONE_RX.lastIndex = 0;
    var m;
    while ((m = PHONE_RX.exec(s)) !== null) {
      var run = m[0];
      var digits = run.replace(/\D/g, '').length;
      if (digits >= PHONE_MIN_DIGITS) {
        var before = m.index > 0 ? s.charAt(m.index - 1) : '';
        /* a currency sign in front of the run is a price, not a number to dial */
        if (CURRENCY.indexOf(before) === -1 || before === '') return true;
      }
      if (run.length === 0) PHONE_RX.lastIndex++;
    }
    return false;
  }

  /**
   * '' when the text may be posted; otherwise the reason it may not, one of
   * 'email' | 'orcid' | 'phone'. The same word the function puts in
   * its invalid-argument details, so the page can show one message for both.
   */
  function check(text) {
    var s = String(text == null ? '' : text);
    if (!s) return '';
    if (hasEmail(s)) return 'email';
    if (ORCID_RX.test(s)) return 'orcid';
    if (hasPhone(s)) return 'phone';
    return '';
  }

  /** What the page says for each reason. One table, so the refusal reads the
      same on the page and in the function's error message. */
  var WHY = {
    email: 'That looks like an e-mail address. The forum does not carry contact details.',
    orcid: 'That looks like an ORCID iD, which names one person exactly.',
    phone: 'That looks like a telephone number. The forum does not carry contact details.'
  };

  return {
    EMAIL_RX: EMAIL_RX,
    ORCID_RX: ORCID_RX,
    PHONE_RX: PHONE_RX,
    PHONE_MIN_DIGITS: PHONE_MIN_DIGITS,
    WHY: WHY,
    check: check
  };
}));
