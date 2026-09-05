/* ---------------------------------------------------------------------------
   Operations Academia: the forum guide: the rules and the notes. ONE text,
   three readers:

     forum.html             <script src="assets/oa-forum-guide.js"> -> window.OAForumGuide
                            the guide panel at the top of every view, open until
                            the member has accepted it (html())
     the Cloud Functions    require('../forum-guide.js'), the VENDORED copy that
                            _scraper/build-functions-vendor.mjs writes and the
                            selftest pins byte-for-byte against this file; the
                            forumModerate seedGuide op renders text() itself as
                            the pinned guide thread of each room, so the panel
                            and the thread are one text and nobody can seed a
                            body of their own
     the selftest           createRequire(...)                    -> module.exports

   WHAT IS IN IT AND WHY. Thirteen rules and three notes. The rules are the
   owner's; the two notices are as the owner wrote them (nothing here is legal
   or immigration advice; the job market is a hard season); the third note is
   the small-population note, because a forum of a few hundred people is one
   where a detail here beside a detail there identifies somebody.

   THE MAINTAINER PARAGRAPH WAS REMOVED at the owner's word (2026-09-05). It
   said how a handle is linked to an account, that the key is destroyed a
   month after the season, and that the maintainer reads and posts in both
   rooms. All of it survives, in the Privacy Policy paragraph CLAUDE.md holds
   verbatim for announce day, which is where a site's disclosures belong; the
   guide is the house rules and reads as such. WHAT_THE_MAINTAINER_CAN_SEE is
   gone from this module entirely rather than left unrendered, because
   nothing merely unused counts as removed.

   RULE 5 USED TO DESCRIBE A CONTROL, and the control is gone (owner,
   2026-09-05). It read "say how you know: mark a post first-hand when it
   happened to you and rumour when it did not", which the compose box
   answered with three radio buttons. The owner removed both the buttons and
   the permission they implied: a rumour may not be posted at all, so the
   forum offers no way to declare one, and the rule now says so. Rule 1 says
   the other half of the same instruction in the owner's own words: be kind,
   and be a good colleague. What can be ENFORCED rather than only asked for
   is the tag, the one machine-readable label a post carries: TAG_BANNED in
   oa-forum-model.js refuses a thread that would advertise itself as a
   rumour. Nothing reads a body, because no honest rule could.

   NO LINKS IN THE GUIDE ITSELF, still, though the guard now allows one in an
   ordinary post: the guide is seeded as a post and a bare address in a house
   rulebook is a thing to mistype rather than to press. The selftest pins
   that, and pins that text() and html() render the same rules in the same
   order.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAForumGuide = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TITLE = 'About this forum';

  var INTRO = 'An anonymous forum in two rooms: the Candidates\' room, for the people ' +
    'holding a candidate profile for the season under way, and the Open forum, for ' +
    'every registered account. You post under a handle drawn at random for the season, ' +
    'never under your name. Thirteen rules and three notes.';

  var RULES = [
    'Be kind, and be a good colleague. Disagree with the point, never the person, ' +
      'and write nothing about a school, a department or a fellow candidate that you ' +
      'would not put your own name to.',
    'No sexist, racist or otherwise demeaning content. One strike, and the handle is ' +
      'banned for the season.',
    'Never name a person: not a committee member, not a specific candidate, not a ' +
      'colleague. Departments and processes, not individuals.',
    'Do not reveal who you are, and do not try to work out who is behind a handle. Leave ' +
      'out your name, your university, your advisor and any unusual detail of your case.',
    'No rumours and no unverified stories. Post what happened to you, or what you can ' +
      'point to; if you have only heard it, leave it out. Running down a school, a ' +
      'department or a colleague is not on either, however politely it is phrased. A ' +
      'wrong story travels a long way in a field this small, and the person it is about ' +
      'may never get to answer it.',
    'No screenshots, pasted e-mails, offer letters or committee correspondence, in any form.',
    'No contact details. The forum refuses an e-mail address, a telephone number and an ' +
      'ORCID iD, so nobody can be reached off the forum or named exactly by one. A link ' +
      'is fine, and a link to your own page, paper or profile identifies you as surely ' +
      'as your name would, so think before you paste one.',
    'One question per thread, with a specific title and one to five tags so people can ' +
      'find it. Tags are set when the question is asked.',
    'Quote fairly. A quote is a copy of the words as they stood when you replied, so ' +
      'quote in context and never to misrepresent.',
    'Vote on the words, not the handle. Like what helped, dislike what misleads, and ' +
      'leave it there; you cannot vote on your own post.',
    'Your handle is the same in both rooms this season, and changes at the July roll.',
    'Report a post rather than replying to it in anger; until the Report button arrives, ' +
      'use Send feedback and quote the thread and the post number. Moderation acts on ' +
      'what was written, never on who wrote it: a post may be removed and a handle ' +
      'warned or banned for the season. To appeal, use Send feedback and quote your handle.',
    'Threads stay readable in the archive for next season\'s candidates, so write for ' +
      'them too. Your own post is yours to edit for fifteen minutes and to delete at any ' +
      'time while the season is running; a deleted post keeps its place in the thread so ' +
      'the replies still read, and its words are gone for good.'
  ];

  var NOTES = [
    {
      lead: 'Nothing here is legal or immigration advice.',
      text: 'Rules differ by country and change often. Your university\'s international ' +
        'office, or the official government site of the country concerned, is the place ' +
        'to check before you act on anything you read here.'
    },
    {
      lead: 'The job market is a hard season, and it is normal to find it heavy.',
      text: 'Your fellow candidates here can listen, but they are not a substitute for ' +
        'support. Your university\'s counselling service, your doctor, or a trusted mentor ' +
        'is the right first call if it is getting on top of you.'
    },
    {
      lead: 'This forum is small.',
      text: 'A detail that seems harmless on its own (a sub-field, a country, a ' +
        'conference, a timeline) can identify you when it is put beside another. Write as ' +
        'if the people you are describing will read it, because some of them will.'
    }
  ];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** The guide as plain text: what the seeded thread's first post carries. */
  function text() {
    var out = [INTRO, ''];
    for (var i = 0; i < RULES.length; i++) out.push((i + 1) + '. ' + RULES[i]);
    out.push('');
    for (var j = 0; j < NOTES.length; j++) out.push(NOTES[j].lead + ' ' + NOTES[j].text);
    return out.join('\n');
  }

  /** The guide as markup, for the panel on forum.html: the same rules in the
      same order, escaped, nothing else. */
  function html() {
    var out = '<p class="oa-forum-guide-intro">' + esc(INTRO) + '</p><ol class="oa-forum-rules">';
    for (var i = 0; i < RULES.length; i++) out += '<li>' + esc(RULES[i]) + '</li>';
    out += '</ol>';
    for (var j = 0; j < NOTES.length; j++) {
      out += '<p class="oa-forum-note"><strong>' + esc(NOTES[j].lead) + '</strong> ' +
        esc(NOTES[j].text) + '</p>';
    }
    return out;
  }

  return {
    TITLE: TITLE,
    INTRO: INTRO,
    RULES: RULES,
    NOTES: NOTES,
    text: text,
    html: html
  };
}));
