/* ---------------------------------------------------------------------------
   Operations Academia: the forum's SHAPE: rooms, keys, bounds, tags, limits.

   ONE definition, loaded by every consumer:

     forum.html             <script src="assets/oa-forum-model.js"> -> window.OAForumModel
     the Cloud Functions    require('../forum-model.js'), a VENDORED copy that
                            _scraper/build-functions-vendor.mjs writes and the
                            selftest pins byte-for-byte against this file
     the selftest           createRequire(...)                    -> module.exports

   WHY THE KEYS LIVE HERE. Every forum document is written by the Cloud
   Functions and by nothing else (every content path in _firestore.rules is
   `allow write: if false`), so there is no hasOnly() list in the rules to pin
   a client write against. What the selftest pins instead is this file against
   the WRITERS: each `@doc <kind>` block in _functions/forum/*.js may use only
   the keys named under KEYS[kind], and every key named here must be written
   somewhere. Both ways, so a key nobody writes and a write nobody declared
   both fail the build. That is what keeps "no forum document carries a uid,
   an e-mail address, a name or a profile id" a statement about the code
   rather than a hope: the lists below carry no such key, and the scan would
   refuse a writer that added one.

   The one exception is named: `candidateMarkers/{uid}` carries `sub`, the
   candidateSubmissions id the marker points at. It is keyed on the uid, owned
   by the account, read by the rules to decide room access, and never sits
   beside a handle.

   TWO ROOMS UNDER ONE HANDLE SCHEME. `candidates` needs a current-season
   profile (or the maintainer); `open` needs a verified sign-in. The handle is
   keyed on the season and the account, never on the room, so one person has
   one handle in both rooms for the season. The room is a PATH segment
   (forumSeasons/{Y}/rooms/{room}/threads/...), so the rules read it without a
   document read.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAForumModel = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The two rooms, and the only two. The rules compare the path segment
      against each by name (never a regex), and the selftest pins that list
      against this one both ways. */
  var ROOMS = ['candidates', 'open'];

  function isRoom(v) {
    return ROOMS.indexOf(String(v)) !== -1;
  }

  /** Every key the functions may write, per kind of document. Step 1 kinds
      only; the kinds moderation and messaging add later (hidden, report,
      mailHead, mailItem) arrive with their writers, so the writer scan is
      never satisfied by a list nothing writes. */
  var KEYS = {
    /* forumSeasons/{Y}: the season head. `secretVersion` is the Secret
       Manager VERSION the season's handles are derived under (a number, never
       the secret); `guides` maps each room to its pinned guide thread. Step 2
       adds `secretDestroyedAt` when the 1 August housekeeping destroys the
       previous season's version. */
    season: ['season', 'createdAt', 'secretVersion', 'guides'],
    /* forumSeasons/{Y}/rooms/{room}/threads/{tid}. `accepted` is the id of
       the post the ASKER ticked as the answer, '' when none: one field, on
       one document, so the list card can say a question is answered without
       reading a post per card and the thread view can mark it with what it
       has already read. The post itself carries no flag, because two places
       saying the same thing is two places that can disagree. */
    thread: ['season', 'room', 'title', 'tags', 'by', 't', 'lastAt', 'lastBy', 'n',
      'excerpt', 'score', 'accepted', 'pinned', 'locked', 'hidden'],
    /* .../threads/{tid}/posts/{pid}. `quote` is a COPY {n, by, text} taken
       at reply time, so a later edit or removal of the quoted post never
       rewrites the reply. `up`/`down` are the like and dislike tallies.
       `hidden` with `hiddenBy: 'author'` is a post its own author deleted:
       the body is erased and the slot kept, because `n` is how replies name
       it. Moderation's own removals arrive with the report queue.
       THERE IS NO `kind`: a post used to carry one of three self-declared
       labels (plain, first-hand, rumour) and the owner removed all three on
       2026-09-05. A post is somebody saying something; the forum has no
       label for saying it second hand, because a rumour may not be posted
       at all. */
    post: ['season', 'room', 'tid', 'n', 'by', 'body', 't', 'editedAt',
      'up', 'down', 'quote', 'hidden', 'hiddenBy'],
    /* the nested quote map on a post */
    quote: ['n', 'by', 'text'],
    /* .../posts/{pid}/votes/{H}: the voter's own hash is the id; the document
       carries the direction and the minute, nothing else. Closed to every
       client in both directions. */
    vote: ['v', 't'],
    /* forumTags/{Y}_{room}: one tally map per season and room */
    tags: ['counts'],
    /* forumHandles/{H}: the handle and its sanctions and counters. NO uid. */
    handle: ['season', 'handle', 'joinedAt', 'guideAt', 'status', 'warnings', 'day',
      'dayThreads', 'dayPosts', 'dayVotes', 'lastPostAt'],
    /* forumNames/{slug}: the reverse index, handle slug -> hash. `key` is the
       one field on any forum document that holds a hash. */
    name: ['season', 'key'],
    /* candidateMarkers/{uid}: the membership marker the rules re-read. The
       one document keyed on a uid, and it carries a profile id, never a
       handle. */
    marker: ['sub', 'year', 'joinedAt']
  };

  /** Text bounds, in characters. The functions refuse anything longer with
      invalid-argument {reason:'bounds'}; the page shows the same numbers. */
  var BOUNDS = { title: 120, body: 4000, excerpt: 200, quote: 600, handle: 40, tag: 24 };

  /** The curated tags, offered first in the compose picker. Free tags are
      allowed beside them (normalised through slug()); `about` is the guide
      thread's own tag. Slugs only, 2 to 24 characters of [a-z0-9-].

      `rumour` WAS ON THIS LIST and is deliberately off it (owner,
      2026-09-05). The list is what the site SUGGESTS, and suggesting the
      word is the site nudging people towards the thing rule 5 asks them not
      to do. NOTHING HERE REFUSES A TAG, and that is the owner's own
      correction: a first draft of this change refused a short list of
      rumour-ish slugs outright, and the answer was *"don't remove the
      possibility users use the tag rumour on a post... what I was saying is
      let's not nudge users to post rumours and gossips."* So a poster who
      types the word still gets the tag. The guide is where the rule lives;
      the picker simply stops offering it. */
  var TAGS = [
    'about', 'interviews', 'first-round', 'flyouts', 'job-talk', 'offers',
    'negotiation', 'startup', 'teaching', 'teaching-release', 'research-statement',
    'cv', 'references', 'timelines', 'deadlines', 'waiting', 'rejections', 'visas',
    'relocation', 'two-body', 'family', 'wellbeing', 'europe', 'asia',
    'north-america', 'uk', 'australia', 'industry', 'postdoc', 'tenure',
    'committees'
  ];

  var TAG_MIN = 1;
  var TAG_MAX = 5;
  /** How many distinct slugs one season-and-room tally document counts. A
      free tag past the cap is still stored on its thread and drawn as a chip;
      it is simply not tallied, so the one hot document cannot grow without
      bound. */
  var TAG_COUNT_CAP = 400;

  /** Per handle, per UTC day; `gapMs` is the minimum between two posts. The
      refusal carries the counter's NAME and never a count. */
  var RATE = { threads: 3, posts: 40, votes: 60, gapMs: 20000 };

  /* THERE IS NO EDIT WINDOW (owner, 2026-09-06: "the user can delete and
     edit the post any time"). A member's own post is theirs to edit and to
     delete for as long as the season is running; the one thing that holds a
     post is a QUESTION with a live answer under it, which cannot be deleted
     until every answer has gone (see _functions/forum/delete.js). The
     fifteen-minute constant the page drew a countdown from is gone from the
     model rather than set to infinity, so no writer can measure against it.
   */

  /* THERE IS NO KINDS LIST, and its absence is the point (owner,
     2026-09-05: "I don't understand why a user should select plain and
     first-hand, perhaps remove these"). A post carried '', 'first-hand' or
     'rumour', and both halves of that were wrong: the choice asked every
     poster a question they had no reason to answer, and one of the answers
     offered was the thing the guide now forbids. Removed from the model
     rather than narrowed to one value, so no writer can send one and no
     reader can draw one. */

  /** The handle reserved for the guide thread; the word lists never draw it. */
  var MODERATOR = 'Moderator';

  /** `quiet heron 42` -> `quiet-heron-42`; a free tag -> its slug. Lower case,
      accents folded to their base letter, anything that is not a letter or a
      digit becomes one hyphen, hyphens trimmed, cut to the tag bound. */
  function slug(s) {
    var v = String(s == null ? '' : s).toLowerCase();
    if (typeof v.normalize === 'function') v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    v = v.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return v.slice(0, BOUNDS.tag).replace(/-+$/, '');
  }

  var TAG_RX = /^[a-z0-9-]{2,24}$/;

  function tagOk(t) {
    return typeof t === 'string' && TAG_RX.test(t);
  }

  /** 1 to 5 slugs, each well formed, no repeats. The page normalises through
      slug() before asking; the function asks about what it was actually sent. */
  function tagsOk(tags) {
    if (!Array.isArray(tags) || tags.length < TAG_MIN || tags.length > TAG_MAX) return false;
    var seen = {};
    for (var i = 0; i < tags.length; i++) {
      if (!tagOk(tags[i]) || seen[tags[i]]) return false;
      seen[tags[i]] = true;
    }
    return true;
  }

  /** Epoch milliseconds rounded DOWN to the minute: the only clock a forum
      document carries. A post's instant is not needed by anyone reading it,
      and a minute cannot be joined exactly to any other record of the same
      moment. */
  function minute(now) {
    var ms = now == null ? Date.now() : Number(now);
    return Math.floor(ms / 60000) * 60000;
  }

  /** The UTC day, for the per-handle counters. */
  function today(now) {
    return new Date(now == null ? Date.now() : now).toISOString().slice(0, 10);
  }

  return {
    ROOMS: ROOMS,
    isRoom: isRoom,
    KEYS: KEYS,
    BOUNDS: BOUNDS,
    TAGS: TAGS,
    TAG_MIN: TAG_MIN,
    TAG_MAX: TAG_MAX,
    TAG_COUNT_CAP: TAG_COUNT_CAP,
    TAG_RX: TAG_RX,
    RATE: RATE,
    MODERATOR: MODERATOR,
    slug: slug,
    tagOk: tagOk,
    tagsOk: tagsOk,
    minute: minute,
    today: today
  };
}));
