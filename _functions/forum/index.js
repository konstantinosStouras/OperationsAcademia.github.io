/* ---------------------------------------------------------------------------
   The forum's six callables, re-exported for _functions/index.js. Everything
   they share is in member.js; the identity (the one HMAC, the handle draw,
   the season's secret version) is in identity.js.
   --------------------------------------------------------------------------- */

'use strict';

const { forumJoin } = require('./join.js');
const { forumPost } = require('./post.js');
const { forumEdit } = require('./edit.js');
const { forumVote, forumThreadVotes } = require('./vote.js');
const { forumModerate } = require('./moderate.js');

module.exports = { forumJoin, forumPost, forumEdit, forumVote, forumThreadVotes, forumModerate };
