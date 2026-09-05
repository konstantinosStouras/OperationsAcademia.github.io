/* ---------------------------------------------------------------------------
   The word lists a forum handle is drawn from: `adjective noun NN`, the
   number 10 to 99. Drawn with crypto.randomInt inside the claim transaction
   (identity.js); NOTHING about a handle is derived from the account, the
   hash, the room or the clock, so knowing every handle on the site tells a
   reader nothing about who holds one.

   RESERVED names are never drawn: `Moderator` is the handle the seeded guide
   thread is posted under, and no member may be given it or anything that
   slugs to it.
   --------------------------------------------------------------------------- */

'use strict';

const ADJ = [
  'quiet', 'amber', 'brisk', 'calm', 'candid', 'clever', 'copper', 'curious', 'dusky',
  'eager', 'early', 'even', 'fair', 'gentle', 'golden', 'hardy', 'hazel', 'honest',
  'humble', 'keen', 'kind', 'late', 'lively', 'lucid', 'mellow', 'merry', 'mild',
  'modest', 'nimble', 'noble', 'olive', 'pale', 'patient', 'plain', 'proud', 'rapid',
  'ready', 'rosy', 'rustic', 'sage', 'silver', 'sober', 'steady', 'still', 'stout',
  'subtle', 'sunny', 'swift', 'tidy', 'timid', 'true', 'upright', 'vivid', 'warm',
  'wary', 'wise', 'witty', 'young', 'zesty', 'ashen', 'bright', 'coral', 'dapper',
  'frank', 'grand', 'ivory', 'jolly', 'level', 'mossy', 'north',
];

const NOUN = [
  'heron', 'otter', 'wren', 'finch', 'badger', 'beech', 'birch', 'cedar', 'comet',
  'crane', 'dune', 'eagle', 'elm', 'ember', 'falcon', 'fern', 'fjord', 'glade', 'grove',
  'harbour', 'hawk', 'heath', 'holly', 'ibis', 'isle', 'jay', 'kestrel', 'kite', 'lark',
  'linnet', 'maple', 'marsh', 'meadow', 'moor', 'oak', 'orchard', 'osprey', 'owl',
  'pebble', 'pine', 'plover', 'quail', 'reed', 'ridge', 'river', 'robin', 'rowan',
  'sable', 'sedge', 'shore', 'sparrow', 'spruce', 'starling', 'swan', 'tern', 'thrush',
  'tide', 'valley', 'willow', 'yew', 'alder', 'aspen', 'brook', 'cliff', 'delta',
  'ferry', 'gull', 'lagoon', 'summit', 'vale',
];

/** Slugs no member may hold, whatever the draw. */
const RESERVED = ['moderator'];

module.exports = { ADJ, NOUN, RESERVED };
