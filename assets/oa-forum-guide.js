/* ---------------------------------------------------------------------------
   Operations Academia: the forum guide: the rules, the notes, and what the
   maintainer can see. ONE text, three readers:

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

   WHAT IS IN IT AND WHY. Thirteen rules, three notes and one paragraph about
   the maintainer. The rules are the owner's; the two notices are as the owner
   wrote them (nothing here is legal or immigration advice; the job market is a
   hard season); the third note is the small-population note, because a forum
   of a few hundred people is one where a detail here beside a detail there
   identifies somebody. The maintainer paragraph says plainly how a handle is
   linked to an account and that the maintainer reads and posts in both rooms
   like any member, since a site that reads something and says so nowhere is
   wrong whatever its rules allow.

   NO LINKS. The guard refuses a web address in any post, and the guide is a
   post (the seeded thread), so it carries none: no http, no www. The selftest
   pins that, and pins that text() and html() render the same rules in the
   same order.

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
    'never under your name. Thirteen rules, three notes, and a word on what the ' +
    'maintainer can see.';

  var RULES = [
    'Be respectful. Disagree with the point, never the person.',
    'No sexist, racist or otherwise demeaning content. One strike, and the handle is ' +
      'banned for the season.',
    'Never name a person: not a committee member, not a specific candidate, not a ' +
      'colleague. Departments and processes, not individuals.',
    'Do not reveal who you are, and do not try to work out who is behind a handle. Leave ' +
      'out your name, your university, your advisor and any unusual detail of your case.',
    'Say how you know. Mark a post first-hand when it happened to you and rumour when it ' +
      'did not, and say in the text when it comes from someone directly involved.',
    'No screenshots, pasted e-mails, offer letters or committee correspondence, in any form.',
    'No contact details and no links. The forum refuses an e-mail address, a phone ' +
      'number, a web address or an ORCID iD. Cite a posting by the OA posting ID printed ' +
      'on its card.',
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
    'Threads stay readable in the archive for next season\'s candidates. Write for them ' +
      'too, and use the 15-minute edit window if you need it, because after it the post ' +
      'stays as written.'
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

  var WHAT_THE_MAINTAINER_CAN_SEE = 'Your handle is assigned at random for this season and ' +
    'never shown beside your profile. The site links a handle to an account only through a ' +
    'one-way keyed hash whose secret lives in the site\'s server configuration and is ' +
    'destroyed a month after the season ends; the maintainer sees handles when reviewing ' +
    'reports, and linking a handle to a person would take a deliberate step with that ' +
    'secret. It never happens by accident. The maintainer can also read and post in both ' +
    'rooms, as an ordinary member under a handle like anyone else\'s.';

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
    out.push('');
    out.push('What the maintainer can see. ' + WHAT_THE_MAINTAINER_CAN_SEE);
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
    out += '<p class="oa-forum-maintainer"><strong>What the maintainer can see.</strong> ' +
      esc(WHAT_THE_MAINTAINER_CAN_SEE) + '</p>';
    return out;
  }

  return {
    TITLE: TITLE,
    INTRO: INTRO,
    RULES: RULES,
    NOTES: NOTES,
    WHAT_THE_MAINTAINER_CAN_SEE: WHAT_THE_MAINTAINER_CAN_SEE,
    text: text,
    html: html
  };
}));
