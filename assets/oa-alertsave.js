/* ---------------------------------------------------------------------------
   Operations Academia — save the jobs page's current search as an e-mail alert.

   ONE definition, loaded by BOTH sides, like assets/oa-jobexport.js:

     jobs.html     the button in the filter bar, and the URL it goes to
     alerts.html   the reader of that URL, which fills the create form
     the checks    createRequire(...)(...) -> module.exports

   so the page that WRITES the hand-over and the page that READS it cannot
   disagree about its shape, and _scraper/selftest.mjs drives the pure half
   (carry / url / read / suggestName / note) offline.

   WHAT IS CARRIED, AND WHAT IS NOT
   --------------------------------
   The jobs page has eight filters; an alert can express four of them
   (assets/oa-alert-match.js: `text`, `type[]`, `level[]`, `country[]`). So:

     University search  -> criteria.text — THE FIRST TERM ONLY. The matcher
                           searches one substring across the institution and
                           the department; the jobs page ORs several terms.
                           "utah princeton" as one needle matches NOTHING, so
                           joining them would hand the reader an alert that
                           never sends. The rest are reported as dropped.
     Type               -> criteria.type[]
     Entry level        -> criteria.level[]     (any-of on both sides)
     Location           -> criteria.country[]   through OACountries.canon, so
                           a link carrying a legacy alias ("USA") lands as the
                           name the alerts page offers ("United States").

   Characteristics, the two deadline buckets, the date-posted window and the
   one-posting focus (?job=) are NOT carried — nothing in an alert can hold
   them — and their keys travel as `dropped` so the alerts page can say what
   it left out, in one line, rather than silently widening the search. A
   deadline bucket has a stand-in the note points at: the "Postings closing
   within 7 days" topic.

   THE TRANSPORT IS THE URL, one key per value like the jobs page's own links
   (alerts.html?prefill=1&text=…&level=…&level=…&country=…&dropped=chars).
   The alerts page puts it into sessionStorage the moment it loads and strips
   the parameters from the address with history.replaceState, so a reload
   after the form was filled does not fill it again — and a reader who
   arrives signed OUT keeps the prefill across the sign-in, because the stash
   outlives the URL and is consumed only once the form can be drawn.

   THE GATE IS THE EXCEL DOWNLOAD'S: the site's own `whenSignedIn` — run now
   if signed in, queued while the session restores, the sign-in box if not.
   The button is disabled with nothing filtered: an alert for EVERY posting
   already exists as the "New job postings" topic with no filters, and the
   tooltip says so rather than handing the reader an empty form.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-countries.js'));
  } else {
    root.OAAlertSave = factory(root.OACountries);
  }
}(typeof self !== 'undefined' ? self : this, function (OACountries) {
  'use strict';

  /* The window, named INSIDE the factory — the UMD wrapper's `root` is the
     wrapper's own parameter (the oa-jobexport.js lesson). Null under Node. */
  var G = (typeof window !== 'undefined') ? window : null;

  var PAGE = 'alerts.html';
  var FLAG = 'prefill';                    // ?prefill=1 says "read the rest"
  var LIST_KEYS = ['type', 'level', 'country'];
  var DROP_KEY = 'dropped';
  var OWN_KEYS = [FLAG, 'text'].concat(LIST_KEYS, [DROP_KEY]);
  var STASH = 'oaAlertPrefill';            // sessionStorage, one page hop
  var TEXT_MAX = 120;                      // the alerts form's own maxlength

  /* The jobs-page filters an alert cannot hold, in the words the note uses.
     Keyed on the filter's `key` in jobs.html's mount (plus two of this
     module's own: `terms` for the university search terms after the first,
     `job` for the ?job= focus). A key not listed here is still reported —
     as "the <key> filter" — never dropped silently. */
  var DROPPED = {
    chars: 'the characteristics you ticked',
    review: 'the suggested-deadline bucket',
    deadline: 'the final-deadline bucket',
    posted: 'the date-posted window',
    terms: 'every university search term after the first',
    job: 'the one posting you had open on its own'
  };

  /* Every word a reader sees, in one place, so the check can pin that none
     carries an em dash and that the disabled state names the topic that
     already covers "everything". */
  var COPY = {
    label: '✉ Save as e-mail alert',
    save: 'Save this search as an e-mail alert: be told when a new posting ' +
      'matches these filters.',
    saveSignedOut: 'Save this search as an e-mail alert: be told when a new ' +
      'posting matches these filters. Free, with an account.',
    noFilter: 'Set a filter first. To be told about every new posting, open ' +
      'E-mail alerts, tick "New job postings" and leave the filters blank.',
    unavailable: 'Sign-in is unavailable at the moment, so saving an alert is too.',
    filled: 'Filled in from your search on the jobs page. Check the boxes, ' +
      'name the alert and press Create alert.',
    notCarried: 'Not carried over, because an alert cannot filter on ',
    deadlines: 'Tick "Postings closing within 7 days" to be reminded of ' +
      'deadlines instead.'
  };

  function txt(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  function arr(v) {
    if (v == null) return [];
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [v];
  }

  function uniq(list) {
    var seen = Object.create(null), out = [];
    list.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }

  /* Through the ONE country table where it is loaded; otherwise the value as
     the jobs page held it. That is safe rather than a silent fallback: the
     alerts page normalises every stored country through the same table
     again (OAAlertMatch.normalise), so the worst an absent module costs here
     is a tick box the receiving page canonicalises on arrival. */
  function canonCountry(v) {
    var s = txt(v);
    return (s && OACountries && OACountries.canon) ? OACountries.canon(s) : s;
  }

  /* ------------------------------------------------------------- the pure half */

  /**
   * What the jobs page's filters become.
   *
   * @param filters  OAList's activeFilters(): [{ key, label, values, match }]
   * @param focused  the ?job= id the page is showing on its own, or ''
   * @returns { criteria: { text, type[], level[], country[] }, dropped: [] },
   *          or null when nothing is filtered — there is nothing to save then,
   *          and the button is disabled for the same reason.
   */
  function carry(filters, focused) {
    var c = { text: '', type: [], level: [], country: [] };
    var dropped = [];
    var any = false;
    arr(filters).forEach(function (f) {
      if (!f || !f.key) return;
      var vals = arr(f.values).map(txt).filter(Boolean);
      if (!vals.length) return;
      any = true;
      switch (f.key) {
        case 'institution':
          c.text = vals[0].slice(0, TEXT_MAX);
          if (vals.length > 1) dropped.push('terms');
          break;
        case 'type': c.type = uniq(vals); break;
        case 'level': c.level = uniq(vals); break;
        case 'country': c.country = uniq(vals.map(canonCountry)); break;
        default: dropped.push(String(f.key));
      }
    });
    if (!any) return null;
    if (txt(focused)) dropped.push('job');
    return { criteria: c, dropped: uniq(dropped) };
  }

  /** alerts.html?prefill=1&text=…&level=…&country=…&dropped=chars,deadline */
  function url(carried) {
    var p = new URLSearchParams();
    p.set(FLAG, '1');
    var c = (carried && carried.criteria) || {};
    if (txt(c.text)) p.set('text', txt(c.text).slice(0, TEXT_MAX));
    LIST_KEYS.forEach(function (k) {
      uniq(arr(c[k]).map(txt)).forEach(function (v) { p.append(k, v); });
    });
    var d = uniq(arr(carried && carried.dropped).map(txt));
    if (d.length) p.set(DROP_KEY, d.join(','));
    return PAGE + '?' + p.toString();
  }

  /**
   * The hand-over read back off a query string. Null unless ?prefill=1 is
   * there AND it carries something — a bare flag fills nothing and says
   * nothing. Countries go through the table on this side too, so a link
   * somebody edited by hand still lands on a name the form offers.
   */
  function read(search) {
    var p = new URLSearchParams(String(search == null ? '' : search));
    if (p.get(FLAG) !== '1') return null;
    var c = {
      text: txt(p.get('text')).slice(0, TEXT_MAX),
      type: uniq(p.getAll('type').map(txt)),
      level: uniq(p.getAll('level').map(txt)),
      country: uniq(p.getAll('country').map(canonCountry))
    };
    var dropped = uniq(String(p.get(DROP_KEY) || '').split(',').map(function (k) {
      return txt(k).toLowerCase().replace(/[^a-z_-]/g, '');
    }));
    var any = !!c.text || c.type.length || c.level.length || c.country.length ||
      dropped.length;
    return any ? { criteria: c, dropped: dropped } : null;
  }

  /** The query string with this module's keys removed and every other one
      kept — ?unsubscribe= and ?topic= are somebody else's and stay. */
  function strip(search) {
    var p = new URLSearchParams(String(search == null ? '' : search));
    OWN_KEYS.forEach(function (k) { p['delete'](k); });
    var qs = p.toString();
    return qs ? '?' + qs : '';
  }

  function join(list, sep) {
    return list.join(sep);
  }

  /** "Assistant Professor in United States" — a name the reader can keep or
      replace; it becomes the e-mail's subject line. */
  function suggestName(criteria) {
    var c = criteria || {};
    var levels = uniq(arr(c.level).map(txt));
    var types = uniq(arr(c.type).map(txt));
    var countries = uniq(arr(c.country).map(txt));
    var s = levels.length ? join(levels, ' or ')
      : types.length ? join(types, ' or ') + ' posts'
        : 'Job postings';
    if (txt(c.text)) s += ' matching “' + txt(c.text) + '”';
    if (countries.length) s += ' in ' + join(countries, ' or ');
    return s.slice(0, TEXT_MAX);
  }

  /** "the characteristics you ticked, the final-deadline bucket and the
      date-posted window" */
  function words(dropped) {
    var names = uniq(arr(dropped).map(txt)).map(function (k) {
      return DROPPED[k] || ('the ' + k + ' filter');
    });
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  /** The one line the alerts page shows over a filled-in form. */
  function note(carried) {
    var d = uniq(arr(carried && carried.dropped).map(txt));
    var s = COPY.filled;
    if (d.length) {
      s += ' ' + COPY.notCarried + (d.length > 1 ? 'them' : 'it') + ': ' + words(d) + '.';
      if (d.indexOf('deadline') !== -1 || d.indexOf('review') !== -1) s += ' ' + COPY.deadlines;
    }
    return s;
  }

  /* ------------------------------------------------- the alerts page's half

     The stash outlives the URL: the address is stripped the moment the page
     loads, and what it said waits in sessionStorage until the form can be
     drawn — which for a signed-out reader is after they sign in. One tab,
     one hop, and taken exactly once. A browser that refuses storage (a
     private window with it disabled) keeps it in this variable instead, so
     the same page load still fills the form. */
  var held = null;

  function storage() {
    try { return G && G.sessionStorage; } catch (e) { return null; }
  }

  /** Read the hand-over off the current address, keep it, strip the address.
      Returns what was read (or null), for the caller's own bookkeeping. */
  function stash() {
    if (!G || !G.location) return null;
    var got = read(G.location.search);
    if (!got) return null;
    held = got;
    var st = storage();
    try { if (st) st.setItem(STASH, JSON.stringify(got)); } catch (e) { /* held in memory */ }
    try {
      if (G.history && G.history.replaceState) {
        G.history.replaceState(null, '',
          G.location.pathname + strip(G.location.search) + (G.location.hash || ''));
      }
    } catch (e) { /* the address stays; the stash is what is read */ }
    return got;
  }

  /** The hand-over, ONCE: whatever was stashed, removed as it is returned. */
  function take() {
    var got = null;
    var st = storage();
    try {
      var raw = st && st.getItem(STASH);
      if (raw) { st.removeItem(STASH); got = JSON.parse(raw); }
    } catch (e) { got = null; }
    if (!got) got = held;
    held = null;
    if (!got || !got.criteria) return null;
    return {
      criteria: {
        text: txt(got.criteria.text).slice(0, TEXT_MAX),
        type: uniq(arr(got.criteria.type).map(txt)),
        level: uniq(arr(got.criteria.level).map(txt)),
        country: uniq(arr(got.criteria.country).map(canonCountry))
      },
      dropped: uniq(arr(got.dropped).map(txt))
    };
  }

  /* --------------------------------------------------- the jobs page's half */

  /* Asked of the ONE definition (assets/oa-gate.js), like the Excel download,
     so this button and the cards can never disagree about who is reading. No
     silent fallback when the module is missing: it says no. */
  function signedIn() {
    var Gate = G && G.OAGate;
    return !!(Gate && Gate.signedIn());
  }

  /**
   * The OAList action descriptor — declared here, rendered by the engine
   * (see `actions` in assets/oa-list.js), beside the Excel download.
   *
   * @param opts.focused  a function returning the ?job= id the list is
   *                      showing on its own, or '' — the engine's snapshot
   *                      does not carry it, and it is reported as dropped.
   */
  function action(opts) {
    opts = opts || {};
    return {
      key: 'alert',
      className: 'oa-alert-save',
      label: COPY.label,

      refresh: function (btn, api) {
        var A = G.OAAccounts;
        var set = arr(api && api.filters).some(function (f) {
          return f && arr(f.values).length;
        });
        if (!A || !G.OAGate || (A.failed && A.failed())) {
          btn.disabled = true;
          btn.title = COPY.unavailable;
        } else if (!set) {
          btn.disabled = true;
          btn.title = COPY.noFilter;
        } else {
          btn.disabled = false;
          btn.title = signedIn() ? COPY.save : COPY.saveSignedOut;
        }
        btn.setAttribute('aria-label', btn.title);
      },

      onClick: function (api) {
        var A = G.OAAccounts;
        if (!A) return;
        /* THE GATE — the Excel download's, verbatim in intent: run now when
           signed in, queue while the session restores, offer the sign-in
           box otherwise. A nudge (the page's lock over the bar) is not an
           authorisation; the module refuses on its own. */
        A.whenSignedIn(function () { go(api, opts); });
      }
    };
  }

  function go(api, opts) {
    var focused = '';
    try { focused = opts.focused ? txt(opts.focused()) : ''; } catch (e) { focused = ''; }
    var carried = carry(api && api.filters, focused);
    if (!carried) return '';
    var href = url(carried);
    if (G && G.location) G.location.assign(href);
    return href;
  }

  return {
    PAGE: PAGE,
    FLAG: FLAG,
    OWN_KEYS: OWN_KEYS,
    STASH: STASH,
    DROPPED: DROPPED,
    COPY: COPY,
    carry: carry,
    url: url,
    read: read,
    strip: strip,
    suggestName: suggestName,
    words: words,
    note: note,
    stash: stash,
    take: take,
    action: action,
    signedIn: signedIn
  };
}));
