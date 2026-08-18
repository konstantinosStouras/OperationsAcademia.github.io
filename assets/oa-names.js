/* ---------------------------------------------------------------------------
   Operations Academia — one spelling per university, school and department.

   ONE definition, loaded by BOTH sides, exactly like oa-countries.js:

     the browser   <script src="assets/oa-names.js">      -> window.OANames
     the build     createRequire(...)('.../oa-names.js')  -> module.exports

   WHY THIS EXISTS. The country had a closed list to canon() against; a school
   never can — a university may open a department tomorrow, so the posting form
   must stay a free-text field. What CAN be pinned is the IDENTITY of a name:
   whether two spellings are the same place. "A.B. Freeman School of Business"
   and "Freeman School of Business" are one school posted twice, "Management
   Science", "Management Science Department" and "Management Sciences Area" are
   one department posted three times, and every one of them was its own entry
   in the posting form's list — which is what the poster in the screenshot saw
   and what this file ends.

   key() IS THE IDENTITY, NOT A DISPLAY NAME. It is deliberately lossy — it
   lower-cases, drops donor initials and trailing "Department"/"Area"/"Group"
   — and is never shown to anyone. The name a reader sees is always a spelling
   somebody actually wrote: the vocabulary picks the fullest, most-used one
   (the site's own Universities directory wins where it knows the name) and
   offers THAT.

   THE RULES, and why each one is safe:

     1. case, accents and punctuation      "St. Gallen" = "St Gallen"
     2. a leading "The"                    "The Fuqua School of Business"
     3. a LEADING run of single letters    "A.B. Freeman", "C. T. Bauer"
        — only leading, so the "A&M" in "Texas A&M University" is untouched
     4. "and" (so "&" and "and" agree)     "Finance & Management"
     5. a plural "s" on a word of 4+
        letters not ending -ss/-us/-is/-as  "Management Sciences"
        — the last guard is what keeps "Texas", "Kansas", "Illinois" and
          "campus" whole; every merge it makes in the committed data is real
     6. trailing "Department", "Dept",
        "Area", "Group", "Division",
        "Unit", "Section"                  "Operations Management Group"
        — a qualifier, not a name: never the whole key, so a unit actually
          called "Department" survives rule 6 intact

   Two DIFFERENT places are never merged by these rules: they only remove
   noise that varies between spellings of one name. And merging is only ever
   used to pick which spelling to OFFER — a poster may still type anything.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OANames = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Trailing qualifiers (rule 6), singular — rule 5 has already run. */
  var TAIL_WORDS = [
    'department', 'dept', 'area', 'group', 'division', 'unit', 'section'
  ];

  /** Whitespace collapsed and stray separators trimmed; nothing else. */
  function clean(v) {
    return String(v == null ? '' : v)
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
      .trim();
  }

  /** Case, accents and punctuation folded away (rule 1). */
  function fold(v) {
    return String(v == null ? '' : v)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Rule 5, guarded so "Texas"/"Kansas"/"Illinois"/"campus" stay whole. */
  function singular(word) {
    return (word.length >= 4 && /s$/.test(word) && !/(ss|us|is|as)$/.test(word))
      ? word.slice(0, -1)
      : word;
  }

  /**
   * The identity of a name: two spellings of one place give one key.
   * Never displayed — see the header for why each rule is safe.
   */
  function key(v) {
    var t = fold(v).split(' ').filter(Boolean);
    if (!t.length) return '';

    if (t[0] === 'the') t = t.slice(1);                       // 2
    while (t.length > 1 && t[0].length === 1) t = t.slice(1);  // 3
    t = t.filter(function (w) { return w !== 'and'; });        // 4
    t = t.map(singular);                                       // 5
    while (t.length > 1 && TAIL_WORDS.indexOf(t[t.length - 1]) !== -1) {
      t = t.slice(0, -1);                                      // 6
    }
    return t.join(' ');
  }

  /** True when two names are the same place. Two empties are not a match. */
  function same(a, b) {
    var ka = key(a);
    return !!ka && ka === key(b);
  }

  /**
   * A key -> name index over an array of names, or over an object's keys
   * (which is the shape data/vocab.json's byUniversity and bySchool have).
   * The first spelling wins, so pass the vocabulary — it has already chosen.
   */
  function index(names) {
    var list = Array.isArray(names) ? names : Object.keys(names || {});
    var out = {};
    for (var i = 0; i < list.length; i++) {
      var v = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].v);
      var k = key(v);
      if (k && !(k in out)) out[k] = v;
    }
    return out;
  }

  /**
   * The spelling the site publishes for `v`, given an index() of known names.
   * A name the index has never seen comes back CLEANED BUT UNCHANGED — like
   * oa-countries' canon(), this must never invent a place.
   */
  function canon(v, idx) {
    var s = clean(v);
    if (!s || !idx) return s;
    var hit = idx[key(s)];
    return hit || s;
  }

  return {
    TAIL_WORDS: TAIL_WORDS,
    clean: clean,
    fold: fold,
    singular: singular,
    key: key,
    same: same,
    index: index,
    canon: canon
  };
}));
