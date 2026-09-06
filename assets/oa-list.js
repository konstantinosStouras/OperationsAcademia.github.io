/* ---------------------------------------------------------------------------
   Operations Academia — filterable card list engine.  (v3 vendored copy)

   KEEP IN SYNC with /assets/oa-list.js. This copy adds two options the
   one-page v3 site needs and nothing else:

     urlPrefix: 'c_'   several engines share ONE page, so each namespaces the
                       query-string keys it owns (c_area, c_page, …). Default
                       '' — byte-identical behaviour to the root engine, and
                       the jobs mount keeps '' so legacy ?filterA= links work.
     strings: {...}    the loading/empty/error wording, so the candidates and
                       placements mounts do not need the MutationObserver
                       rewording hack the separate pages used.

   Replaces Awesome Table. Vanilla ES5-compatible JS, no build step, no CDN, no
   jQuery. One global: window.OAList.

   Deliberately DATASET-GENERIC. A page describes its dataset with a config
   object and this file does the rest, so the jobs / candidates / placements /
   past-postings pages can all share it:

       OAList.mount({
         mount:   '#oa-jobs',
         data:    './data/jobs.json',
         perPage: 10,
         filters: [ ...field descriptors... ],
         card:    { title, subtitle, badges, rows }
       });

   `source: fn` may stand in for `data`: a function returning a promise of the
   rows, for a list whose dataset is not a served file (the forum reads its
   threads from Firestore). Everything after the rows land is the same.

   FILTER SEMANTICS (matching what Awesome Table did, so results do not shift
   under returning visitors):
     - every filter ANDs with every other filter;
     - within one filter, selected values OR together — unless the filter
       declares `match: 'all'`, when a row passes only if it carries EVERY
       selected value (the jobs page's Characteristics: a reader ticking
       "PhD" and "Research seminars" wants a department that has both);
     - a 'text' filter is a case/diacritic-insensitive substring match;
     - a filter with nothing selected is inert.

   Option counts are CROSS-FILTERED: each value shows how many rows it would
   yield given every OTHER active filter, so a count is never a dead end. For
   an all-of filter the count is what ticking that value ON TOP OF the ones
   already ticked would leave, which is the only honest number under AND.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === false || v === undefined) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  /* Diacritic-insensitive, so "Münster" is found by typing "munster", and
     punctuation-insensitive, so a search for "Operations and Information
     Systems" finds the department the site spells "Operations & Information
     Systems". Both sides of every comparison are folded the same way, so this
     only ever finds MORE — no search that worked before stops working.

     It matters beyond tidiness: one department is written both ways across the
     postings, and assets/oa-schools.js now publishes one of them. A reader who
     bookmarked ?filterA=<the other one> must still find it. */
  function fold(s) {
    s = String(s === null || s === undefined ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
  }

  /* An ALL-CAPS needle is an acronym, and the site no longer prints acronyms:
     "Department of Industrial Engineering & Operations Research (IEOR)" is
     published as "Industrial Engineering and Operations Research", so a reader
     — or an alert — asking for IEOR found nothing at all. The initials of the
     words that remain are exactly what was dropped, so they are matched too.
     Skips the joining words an acronym skips ("and", "of", "the", "for",
     "in"), and only ever finds MORE. */
  var ACRONYM = /^[A-Z]{2,6}$/;
  var JOINERS = ' and of the for in a an at on to ';

  function initials(s) {
    var words = String(s == null ? '' : s)
      .replace(/&/g, ' and ')
      .split(/[^A-Za-z0-9]+/);
    var out = '', i;
    for (i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w || JOINERS.indexOf(' ' + w.toLowerCase() + ' ') !== -1) continue;
      out += w.charAt(0).toLowerCase();
    }
    return out;
  }

  function asArray(v) {
    if (v === null || v === undefined || v === '') return [];
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [v];
  }

  // A same-origin, http(s)-only href. A dataset row is operator-supplied, but
  // this page is public and a row could carry "javascript:" — never trust it.
  function safeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') {
      // "//host/path" is protocol-relative — it points at ANOTHER origin, not
      // at this site, and the URL parser reads a backslash there the same way.
      // So a leading slash only counts as relative when what follows is not
      // another slash or backslash.
      var next = u.charAt(1);
      return next === '/' || next === '\\' ? '' : u;
    }
    if (u.slice(0, 2) === './') return u;
    return '';
  }

  /* UTC, not local: the pipeline and oa-jobnav.js decide "expired" and
     "which page" on the UTC day, so a local reading bucketed a card as
     Expired around midnight on a page the UTC rule still placed it on. */
  function todayISO() {
    var d = new Date();
    return (
      d.getUTCFullYear() +
      '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(d.getUTCDate()).padStart(2, '0')
    );
  }

  function daysBetween(aISO, bISO) {
    var a = Date.parse(aISO + 'T00:00:00Z');
    var b = Date.parse(bISO + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return NaN;
    return Math.round((b - a) / 86400000);
  }

  /* --------------------------------------------------- derived (bucket) fields

     The Google Sheet held "Deadline" and "Date posted" as spreadsheet FORMULA
     columns, so their values froze at whatever the last edit computed — every
     row in the export reads "Older posts" regardless of age. Computing them
     here from the real dates instead means the buckets are always correct.

     THE DEADLINE VOCABULARY IS THE VENDOR PAGE'S OWN, and matching it exactly
     is the point: the live Awesome Table view offers three values and only
     three — "Closing soon", "Expired", "Until filled" — so a returning visitor
     finds the same choices in the same words. It used to read "Open" here,
     which is a fourth word for a list that has never had one.

     "Closing soon" therefore covers EVERY deadline still ahead, not a near
     window: the vendor page shows no fourth bucket for a posting whose closing
     date is months out, so a narrower reading would have to invent one.       */

  var DERIVE = {
    deadline: function (row) {
      // No closing date on record — the sheet's "Until filled." postings.
      // (The writers guarantee the two cannot disagree: a row whose prose says
      // "until filled"/"rolling" carries NO date, in every pipeline and in the
      // served file — see import-sheet.mjs and rowFromSubmission.)
      if (!row.applyByDate) return 'Until filled';
      // a deadline that falls TODAY is still open, hence < 0 rather than <= 0
      return daysBetween(todayISO(), row.applyByDate) < 0 ? 'Expired' : 'Closing soon';
    },
    /* The SUGGESTED apply-by — the first-review / full-consideration date a
       posting names beside (or instead of) its hard deadline (`reviewDate`,
       see jobs-model.mjs healReviewDate). Its own vocabulary, because the
       deadline one above is the vendor page's and means something else:
       a review date passing does not close a search, so "Expired" would be
       the wrong word for it. */
    review: function (row) {
      if (!row.reviewDate) return 'No review date';
      return daysBetween(todayISO(), row.reviewDate) < 0 ? 'Review passed' : 'Review ahead';
    },
    datePosted: function (row) {
      if (!row.posted) return 'Older posts';
      var age = daysBetween(row.posted, todayISO());
      if (isNaN(age)) return 'Older posts';
      if (age <= 7) return 'Last 7 days';
      if (age <= 30) return 'Last 30 days';
      if (age <= 90) return 'Last 3 months';
      return 'Older posts';
    },
  };

  /* The order the values are offered in. Deadline follows the vendor page's
     list exactly, down to the order the three sit in. */
  var BUCKET_ORDER = {
    deadline: ['Closing soon', 'Expired', 'Until filled'],
    review: ['Review ahead', 'Review passed', 'No review date'],
    datePosted: ['Last 7 days', 'Last 30 days', 'Last 3 months', 'Older posts'],
  };

  /* -------------------------------------------------------------- value read */

  function valuesOf(row, f) {
    if (f.derive) return [DERIVE[f.derive](row)];
    return asArray(row[f.field]).map(function (v) { return String(v).trim(); })
      .filter(Boolean);
  }

  /* One term against one row. */
  function textHit(row, f, term) {
    var needle = fold(term);
    if (!needle) return true;
    var acr = ACRONYM.test(String(term).trim()) ? String(term).trim().toLowerCase() : '';
    return asArray(f.fields || [f.field]).some(function (name) {
      if (fold(row[name]).indexOf(needle) !== -1) return true;
      return !!acr && initials(row[name]).indexOf(acr) !== -1;
    });
  }

  function matches(row, f, chosen, draft) {
    if (f.type === 'text') {
      /* SEVERAL TERMS, AND THEY ARE OR'd — which is the only reading that can
         return anything. A posting has ONE institution, so "columbia" AND
         "insead" is empty by construction; what a reader typing both means is
         "either of these". The half-typed word in the box counts as one more
         term, so the list narrows as it always did while a term is being
         added rather than freezing until Enter.

         A single term behaves exactly as before, which is what keeps every
         saved link and every other list page unchanged. */
      /* A TERM THAT FOLDS TO NOTHING IS NOT A TERM. `textHit` answers true
         for an empty needle, and the terms are OR'd — so a draft of a space,
         a hyphen or a bracket, which every reader types in the middle of a
         name, matched EVERY row and turned the whole filter off while its
         banked chips still said otherwise. Dropped instead: the chips go on
         narrowing, and a box holding only punctuation narrows nothing of its
         own, which is what it means. */
      var terms = [];
      if (chosen) chosen.forEach(function (t) { if (fold(t)) terms.push(t); });
      if (draft && fold(draft)) terms.push(draft);
      if (!terms.length) return true;
      return terms.some(function (t) { return textHit(row, f, t); });
    }
    if (!chosen || !chosen.size) return true;
    var vals = valuesOf(row, f);
    if (f.match === 'all') {
      /* ALL OF THEM (owner, 2026-09-04): a reader who ticks "PhD" and
         "Research seminars" under Characteristics wants a department that
         has BOTH, so every ticked value must be on the row. Any-of stays the
         default and is what Entry level means — "Assistant Professor or
         Post-Doc" is two things the same person could take. */
      var missing = false;
      chosen.forEach(function (v) { if (vals.indexOf(v) === -1) missing = true; });
      return !missing;
    }
    for (var i = 0; i < vals.length; i++) if (chosen.has(vals[i])) return true;
    return false;
  }

  /* ------------------------------------------------------------------ mount */

  function mount(cfg) {
    var host = document.querySelector(cfg.mount);
    if (!host) return;

    var perPage = cfg.perPage || 10;
    var filters = cfg.filters || [];
    // v3: several engines share one page — each namespaces its URL keys.
    var prefix = cfg.urlPrefix || '';
    // v3: per-dataset wording for the states the engine paints itself.
    var STR = {
      loading: 'Loading job postings…',
      emptyFiltered: 'No job postings match these filters.',
      emptyFilteredHint: 'Try removing a filter, or clear them all to see every posting.',
      emptyData: 'No job postings are listed at the moment.',
      emptyDataHint: 'Please check back soon — new postings are added as they arrive.',
      loadError: 'The job postings could not be loaded.',
      loadErrorHint: 'Please reload the page, or let us know if it keeps happening.',
      unit: 'postings',
      /* the one-posting focus (cfg.focusParam) — see the block above apply() */
      focusOne: 'Showing one posting on its own.',
      focusClear: 'Show all postings',
      focusMissing: 'That posting is not on this page.',
      focusMissingHint: '',
      focusOtherLead: 'Look for it on '
    };
    if (cfg.strings) {
      for (var sk in cfg.strings) {
        if (Object.prototype.hasOwnProperty.call(cfg.strings, sk)) STR[sk] = cfg.strings[sk];
      }
    }
    var rows = [];
    var loaded = false;       // the dataset has landed (or failed) — see rerender
    var loadFailed = false;
    var view = [];
    var page = 0;
    var expanded = {};

    /* ------------------------------------------------ the one-posting focus

       `cfg.focusParam` names a URL parameter carrying ONE row's id, and while
       it is set the list shows that row and nothing else: the filter bar and
       the result bar go away (the same treatment an empty dataset gets), the
       card is opened, and a bar above it offers the way back to the whole
       list.

       IT IS NOT A FILTER, and that is the point. A filter narrows what is
       already passing, so a posting that fails one — or that sits on page 4 of
       10 — is not on screen; the whole reason /admin-area links here is to put
       a NAMED posting in front of the maintainer with its Edit and Take down
       controls on it, whatever the reader last searched for. So the row is
       taken from `rows`, ahead of every filter and every page. */
    var focusParam = cfg.focusParam || '';
    var focusId = '';
    var focusTitleWas = '';
    /* which pager button was pressed, so its replacement can take the focus */
    var pagerFocus = '';
    var focusOpened = false;   // the card is opened once, not on every render
    var focusScrolled = false; // …and scrolled to once, on the render that finds it
    /* A focus that arrived as `#job-<id>` — see readUrl(). The fragment is
       dropped from the URL on the first sync, or "Show all postings" would
       clear the state and a reload would put it straight back. */
    var focusDropHash = false;

    /* EVERY filter's selection is a Set, text ones included — a text filter now
       holds the terms that have been committed with Enter, exactly as a picker
       holds the values that have been ticked, so chips, Clear, the URL and the
       cross-filter counts all treat the two the same. */
    var sel = {};
    // the page-declared action buttons currently in the bar, so render() can
    // refresh them (rebuilt by buildBar, which empties the bar)
    var actionEls = [];
    // what is typed but not yet committed, per text filter
    var drafts = {};
    // pending debounce per text filter, so a rebuild can cancel it (below)
    var textTimers = {};
    filters.forEach(function (f) {
      sel[f.key] = new Set();
      drafts[f.key] = '';
    });

    host.className = 'oa-list';
    host.innerHTML = '';
    var barEl = el('div', { class: 'oa-filters' });
    var resEl = el('div', { class: 'oa-resultbar' });
    var focusEl = el('div', { class: 'oa-focusbar', hidden: true });
    var listEl = el('ul', { class: 'oa-cards' });
    var liveEl = el('div', {
      class: 'oa-sr',
      role: 'status',
      'aria-live': 'polite',
      style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)',
    });
    host.appendChild(barEl);
    host.appendChild(resEl);
    host.appendChild(focusEl);
    host.appendChild(listEl);
    host.appendChild(liveEl);

    listEl.appendChild(el('li', { class: 'oa-loading', text: STR.loading }));

    /* --------------------------------------------------------- filtering */

    // rows passing every filter EXCEPT `skipKey` — the cross-filter denominator
    function passing(skipKey) {
      return rows.filter(function (r) {
        for (var i = 0; i < filters.length; i++) {
          var f = filters[i];
          if (f.key === skipKey) continue;
          if (!matches(r, f, sel[f.key], drafts[f.key])) return false;
        }
        return true;
      });
    }

    function optionsFor(f) {
      var pool = passing(f.key);
      var counts = Object.create(null);
      if (f.match === 'all' && sel[f.key].size) {
        /* UNDER AND, A COUNT IS "WHAT TICKING THIS AS WELL WOULD LEAVE". The
           any-of count below (rows carrying the value, given every OTHER
           filter) would overstate every option the moment one is ticked:
           with "PhD" chosen, "MBA 82" reads as 82 postings a tick would
           show, where a tick shows the postings that have BOTH. So the rows
           counted are the ones already carrying every ticked value, and a
           ticked value's own count is therefore the current result.

           Every value the other filters allow is still LISTED, at 0 where
           nothing has it beside what is ticked — a value that vanished from
           the menu would read as the site having lost it, and "MBA 0" says
           the true thing: no posting here offers both. */
        pool.forEach(function (r) {
          var vals = valuesOf(r, f);
          var carriesAll = matches(r, f, sel[f.key]);
          vals.forEach(function (v) {
            counts[v] = (counts[v] || 0) + (carriesAll ? 1 : 0);
          });
        });
      } else {
        pool.forEach(function (r) {
          valuesOf(r, f).forEach(function (v) {
            counts[v] = (counts[v] || 0) + 1;
          });
        });
      }
      // include an already-selected value even when it now counts zero, so a
      // chip can always be seen and removed
      sel[f.key].forEach(function (v) { if (!(v in counts)) counts[v] = 0; });

      var names = Object.keys(counts);
      /* A filter may declare its own value order (`order: [...]`) — the
         universities directory's "Last edited" buckets read newest-first,
         which alphabetical sorting would shuffle. Derived buckets keep their
         built-in order exactly as before. */
      var order = (f.derive && BUCKET_ORDER[f.derive]) || f.order;
      names.sort(function (a, b) {
        if (order) {
          var ia = order.indexOf(a), ib = order.indexOf(b);
          if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        }
        if (f.sort === 'count' && counts[b] !== counts[a]) return counts[b] - counts[a];
        return a.localeCompare(b);
      });
      return names.map(function (n) { return { value: n, count: counts[n] }; });
    }

    /** The focused row, or null — either nothing is focused, or the id names
        a posting this page does not carry (it rolled into the other season, or
        it has been taken down since the link was drawn). */
    function focusRow() {
      if (!focusId) return null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].id) === focusId) return rows[i];
      }
      return null;
    }

    /** Back to the whole list. The parameter goes with it, so a reload — or a
        link copied from here — is the list and not the one posting again. */
    function clearFocus() {
      if (!focusId) return;
      focusId = '';
      focusOpened = false;
      focusScrolled = false;
      page = 0;
      apply();
    }

    function apply() {
      var one = focusRow();
      if (focusId) {
        /* ahead of every filter and every page — see the block by focusId */
        view = one ? [one] : [];
        if (one && !focusOpened) {
          expanded[one.id] = true; focusOpened = true;
          /* The permalink the Admin area and the poster's e-mail hand out
             opened under the list page's generic title; the tab, the
             history and a bookmark now say WHICH posting. */
          var t = [one.institution || one.name, one.department].filter(Boolean).join(' — ');
          if (t) {
            if (!focusTitleWas) focusTitleWas = document.title;
            document.title = t + ' · ' + focusTitleWas;
          }
        }
        if (!one && focusTitleWas) { document.title = focusTitleWas; focusTitleWas = ''; }
      } else {
        view = passing(null);
        if (cfg.sort) view.sort(cfg.sort);
        /* ...AND WHEN THE FOCUS IS LEFT. The restore was inside the focused
           branch, so it ran when a focused id turned out not to be here and
           never when the reader pressed "Show all postings": the tab, the
           history entry and a bookmark went on naming the one posting that
           was no longer on screen. */
        if (focusTitleWas) { document.title = focusTitleWas; focusTitleWas = ''; }
      }
      var maxPage = Math.max(0, Math.ceil(view.length / perPage) - 1);
      if (page > maxPage) page = maxPage;
      render();
      syncUrl();
    }

    /* -------------------------------------------------------- filter bar */

    function anySelected() {
      return filters.some(function (f) {
        return sel[f.key].size > 0 || !!drafts[f.key];
      });
    }

    function buildBar() {
      // A pending text debounce closes over the <input> this rebuild is about
      // to throw away. Left running it fires against the detached node and
      // pushes the old typed value back into `sel` — so Clear filters emptied
      // the bar while the list stayed filtered by text shown nowhere.
      filters.forEach(function (f) { clearTimeout(textTimers[f.key]); });
      barEl.innerHTML = '';
      filters.forEach(function (f) {
        /* `className` lets a page address ONE filter's wrapper — the
           universities directory hides its "Last edited" filter from
           everybody but the maintainer that way. Visibility only: hiding a
           control grants nothing, exactly like every admin panel here. */
        var wrap = el('div', {
          class: 'oa-filter' + (f.type === 'text' ? '' : ' oa-pick') +
                 (f.className ? ' ' + f.className : ''),
        });
        /* Prefixed by the mount, or two lists on one page (the home page's
           candidates and placements both filter on `name`) mint one id and
           the second label points at the first input. */
        var id = 'oaf-' + (cfg.urlPrefix || '') + f.key;
        wrap.appendChild(el('label', { for: id, text: f.label }));

        if (f.type === 'text') {
          var input = el('input', {
            id: id,
            type: 'search',
            value: drafts[f.key],
            placeholder: f.placeholder || '',
            autocomplete: 'off',
          });
          var textChips = buildChips(f);
          /* Only while something is being typed: a permanent instruction is
             noise once the reader has understood it, and this one has to earn
             its space in a bar that is already seven controls wide. */
          var hint = el('p', { class: 'oa-filter-hint', text: 'Press Enter to add it as a filter' });
          hint.hidden = !drafts[f.key];

          input.addEventListener('input', function () {
            hint.hidden = !input.value.trim();
            clearTimeout(textTimers[f.key]);
            textTimers[f.key] = setTimeout(function () {
              drafts[f.key] = input.value;
              page = 0;
              apply();
            }, 140);
          });

          /* ENTER COMMITS THE TERM. The box empties and the word becomes a
             chip, so the next one can be typed straight away — the reader
             collects institutions rather than replacing one with the next.
             Nothing is lost by not pressing it: the draft filters live and is
             carried in the URL either way. */
          input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var term = input.value.trim();
            /* The pending debounce is cancelled here, so this handler now owns
               whatever the box says — INCLUDING when it says nothing. Returning
               early on an empty box stranded the last debounced word in
               drafts[key]: the list stayed filtered by a term shown in no chip
               and in no box, and syncUrl kept putting it in the address bar.
               Erasing the box and pressing Enter now means what it looks like. */
            clearTimeout(textTimers[f.key]);
            if (!term) {
              if (drafts[f.key]) {
                drafts[f.key] = '';
                page = 0;
                apply();
              }
              return;
            }
            // the same term twice is one chip, not two that filter identically
            sel[f.key].add(term);
            drafts[f.key] = '';
            input.value = '';
            hint.hidden = true;
            page = 0;
            /* Only the chips are redrawn, never the whole bar: rebuilding it
               would throw away this very input and take the keyboard with it,
               which is the same reason picking a facet value refreshes chips
               alone (see below). */
            refreshChips(f, textChips);
            apply();
            input.focus();
          });

          wrap.appendChild(input);
          wrap.appendChild(hint);
          wrap.appendChild(textChips);
        } else {
          // Picking a value used to call buildBar(), which emptied this very
          // node — tearing down the menu the reader was standing in, so a
          // multi-select facet had to be reopened for every single value (and
          // keyboard focus fell back to <body> each time). Refresh only the
          // chips instead and leave the open menu alone.
          var chipsBox = buildChips(f);
          var onPick = function () {
            var fresh = buildChips(f);
            wrap.replaceChild(fresh, chipsBox);
            chipsBox = fresh;
            apply(); // render() re-reads the Clear button's disabled state
          };
          wrap.appendChild(buildPicker(f, id, onPick));
          wrap.appendChild(chipsBox);
        }
        barEl.appendChild(wrap);
      });

      var clear = el('button', {
        type: 'button',
        class: 'oa-clear',
        text: 'Clear filters',
        onclick: function () {
          filters.forEach(function (f) {
            sel[f.key] = new Set();
            drafts[f.key] = '';
          });
          page = 0;
          buildBar();
          apply();
        },
      });
      clear.disabled = !anySelected();
      /* The empty <label> is a SPACER, and a real one on purpose. Clear has no
         label of its own, so in a top-aligned bar it would sit a label's
         height above the controls it belongs with. Reserving that height with
         a hard-coded pixel value means guessing at type the stylesheet owns —
         and getting it wrong silently, which is what a first attempt did. A
         node styled by the same rules as a real label is always exactly the
         right height, whatever the design later does to it. It is a <span>
         rather than a <label> so that anything enumerating this bar's labels —
         a screen reader, or the test that pins their names — still sees only
         the real ones. */
      var actionsCell = el('div', { class: 'oa-filter oa-filter-actions' }, [
        el('span', { 'aria-hidden': 'true', class: 'oa-label-spacer', html: '&nbsp;' }),
        clear,
      ]);

      /* PAGE-DECLARED ACTIONS, rendered by the engine because the engine OWNS
         this bar: buildBar() empties barEl (Clear filters calls it), so a
         control a page appended for itself would silently disappear the first
         time somebody cleared their filters — and reappear nowhere. A page
         declares what it wants here instead, and gets it back on every
         rebuild.

         `refresh` is called from render(), beside the Clear button's own
         disabled state, so an action that reads the CURRENT result — the jobs
         page's Excel download says how many postings it would write — is never
         a step behind the list. */
      actionEls = [];
      (cfg.actions || []).forEach(function (a) {
        if (!a) return;
        var btn = el('button', {
          type: 'button',
          class: 'oa-action ' + (a.className || ''),
          text: a.label || '',
          onclick: function () { if (a.onClick) a.onClick(apiSnapshot(), btn); },
        });
        actionEls.push({ def: a, btn: btn });
        actionsCell.appendChild(btn);
      });

      barEl.appendChild(actionsCell);
    }

    /* What an action is handed: the postings on screen, in the order they are
       on screen, and what is filtering them. A SNAPSHOT — `view` is rebuilt in
       place by apply(), so handing the array itself out would let a caller
       hold a reference that changes under it. */
    function apiSnapshot() {
      return {
        view: view.slice(),
        rows: rows.slice(),
        total: rows.length,
        filters: activeFilters(),
      };
    }

    /** Every filter with something selected, in bar order: what a reader would
        have to describe to say what they were looking at. The half-typed word
        counts, because it is narrowing the list they can see. `match` says
        how the values combine — 'all' for a filter whose values must ALL be
        on a row, 'any' otherwise — so a consumer describing the search (the
        Excel download's About sheet) can write "and" where "or" would be a
        lie about what the reader was shown. */
    function activeFilters() {
      var out = [];
      filters.forEach(function (f) {
        var values = [];
        sel[f.key].forEach(function (v) { values.push(v); });
        if (f.type === 'text' && drafts[f.key]) values.push(drafts[f.key]);
        if (values.length) {
          out.push({ key: f.key, label: f.label, values: values,
            match: f.match === 'all' ? 'all' : 'any' });
        }
      });
      return out;
    }

    /* A chip is ONE button: clicking anywhere on the blue area drops that value
       from the filter, and the × is decoration rather than the only target.
       Reported by the owner — the chip is what reads as the thing to click, and
       a 9-pixel × is a target nobody should have to hit, least of all on a
       phone. It is also what stouras.com/lit/ does, so the two sites behave the
       same way.

       Hence a <button> wrapping two <span>s and not the other way round: a
       button inside a button is invalid, so making the chip clickable means
       the × stops being one. */
    function buildChips(f) {
      return refreshChips(f, el('div', { class: 'oa-chips' }));
    }

    /* Refill an EXISTING chips node rather than replacing it, so a caller can
       hold on to its reference — the text filter's Enter handler does, because
       rebuilding the bar there would throw away the input the reader is still
       typing in. */
    function refreshChips(f, box) {
      box.innerHTML = '';
      sel[f.key].forEach(function (v) {
        box.appendChild(
          el('button', {
            type: 'button',
            class: 'oa-chip',
            title: 'Remove filter “' + v + '”',
            'aria-label': 'Remove filter ' + v,
            onclick: function () {
              sel[f.key]['delete'](v);
              page = 0;
              buildBar();
              apply();
            },
          }, [
            el('span', { class: 'oa-chip-label', text: v }),
            el('span', { class: 'oa-chip-x', 'aria-hidden': 'true', text: '×' }),
          ])
        );
      });
      return box;
    }

    function buildPicker(f, id, onPick) {
      var chosen = sel[f.key];
      var multi = f.type !== 'one';
      var allOf = multi && f.match === 'all';
      /* WHAT TICKING SEVERAL MEANS, said where the reader is choosing. An
         all-of picker reads exactly like its any-of neighbours — the same
         "2 selected", the same chips — and nothing else on the bar says that
         here the values narrow rather than widen. A page may word it for its
         own dataset (`hint`); the engine's own wording is the fallback. It is
         drawn INSIDE the menu rather than under the control: the bar is
         already eight controls wide and two chips deep on a 320px phone, and
         a menu has its own room. The button carries it as a title too, for
         a pointer that hovers before it presses. */
      var hint = f.hint || (allOf ? 'Tick several and a posting must have every one of them.' : '');
      var btnLabel = el('span', {
        class: 'oa-pick-label',
        text: chosen.size
          ? chosen.size + ' selected'
          : (f.placeholder || 'Choose a value'),
      });
      var btn = el('button', {
        type: 'button',
        id: id,
        class: 'oa-pick-btn' + (chosen.size ? ' is-set' : ''),
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        title: hint || null,
      }, [
        btnLabel,
        el('span', { class: 'oa-pick-caret', 'aria-hidden': 'true', text: multi ? '+' : '⌄' }),
      ]);

      // the button's own summary, refreshed in place now that a tick no longer
      // rebuilds the bar around it
      function syncBtn() {
        btn.className = 'oa-pick-btn' + (chosen.size ? ' is-set' : '');
        btnLabel.textContent = chosen.size
          ? chosen.size + ' selected'
          : (f.placeholder || 'Choose a value');
      }

      var menu = el('div', { class: 'oa-pick-menu', role: 'listbox', hidden: true });
      if (hint) menu.appendChild(el('p', { class: 'oa-pick-hint', text: hint }));

      /* The search box is created ONCE and never re-rendered. It used to be
         rebuilt inside fill() on every keystroke and then re-focused, which put
         the caret back at position 0 — so the next character landed in FRONT of
         the last one and "sing" was typed into the box as "gnis", matching
         nothing. Only the option rows below it are redrawn. */
      var search = null;
      if (f.searchable !== false) {
        search = el('input', {
          class: 'oa-pick-search',
          type: 'text',
          placeholder: 'Search…',
          autocomplete: 'off',
        });
        search.addEventListener('input', function () { fill(search.value); });
        search.addEventListener('keydown', function (e) { e.stopPropagation(); });
        menu.appendChild(search);
      }
      var optsEl = el('div', { class: 'oa-pick-opts' });
      menu.appendChild(optsEl);

      function close() {
        menu.hidden = true;
        // drop the rows with it: their counts are cross-filtered and go stale
        // the moment another filter moves, and a closed picker used to carry no
        // options at all (the bar was rebuilt around it)
        optsEl.innerHTML = '';
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onEsc, true);
      }
      function onOutside(e) {
        // containment, not identity: the button holds a label span and a caret
        // span, so a mousedown on the words closed the menu here and the click
        // that followed reopened it — the toggle looked dead.
        if (!menu.contains(e.target) && !btn.contains(e.target)) close();
      }
      function onEsc(e) {
        if (e.key === 'Escape') { close(); btn.focus(); }
      }

      /* The count spans of the rows on screen, by value — so an all-of tick
         can refresh the numbers IN PLACE (recount below) without redrawing
         the rows, which would throw away the checkbox that was just pressed
         and the keyboard focus with it. */
      var countEls = Object.create(null);

      function recount() {
        var fresh = optionsFor(f);
        var by = Object.create(null);
        fresh.forEach(function (o) { by[o.value] = o.count; });
        for (var v in countEls) countEls[v].textContent = String(v in by ? by[v] : 0);
      }

      function fill(q) {
        optsEl.innerHTML = '';
        countEls = Object.create(null);
        var opts = optionsFor(f);
        var needle = fold(q || '');
        if (needle) {
          opts = opts.filter(function (o) { return fold(o.value).indexOf(needle) !== -1; });
        }
        if (!opts.length) {
          optsEl.appendChild(el('div', { class: 'oa-opt is-empty', text: 'No matches' }));
        }
        opts.forEach(function (o) {
          var cb = el('input', { type: multi ? 'checkbox' : 'radio', name: id });
          cb.checked = chosen.has(o.value);
          var nEl = el('span', { class: 'oa-opt-n', text: String(o.count) });
          countEls[o.value] = nEl;
          var row = el('label', { class: 'oa-opt' }, [
            cb,
            el('span', { class: 'oa-opt-name', text: o.value }),
            nEl,
          ]);
          cb.addEventListener('change', function () {
            if (!multi) chosen.clear();
            if (cb.checked) chosen.add(o.value); else chosen['delete'](o.value);
            page = 0;
            syncBtn();
            if (!multi) close();
            // NOT a rebuild: the option counts in an any-of menu are
            // cross-filtered on every OTHER filter (optionsFor skips f.key),
            // so ticking a value here cannot change them — and leaving the
            // rows in place is what keeps a multi-select menu open under the
            // pointer. An ALL-OF menu's counts do move with its own ticks
            // (each is "what ticking this as well would leave"), so those are
            // refreshed in place, rows and focus untouched.
            if (allOf) recount();
            onPick();
          });
          optsEl.appendChild(row);
        });
      }

      btn.addEventListener('click', function () {
        if (menu.hidden) {
          if (search) search.value = '';
          fill('');
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
          document.addEventListener('mousedown', onOutside, true);
          document.addEventListener('keydown', onEsc, true);

          /* Keep the menu on screen. The phone layout puts pickers two per
             row, and a right-column menu — left-aligned, up to 320px wide —
             ran off the viewport's right edge. Measured after it is shown,
             not guessed from column position, so it holds at any width and
             any number of filters. */
          menu.classList.remove('oa-menu-right');
          var mr = menu.getBoundingClientRect();
          if (mr.right > document.documentElement.clientWidth - 8) {
            menu.classList.add('oa-menu-right');
          }

          /* Autofocusing the search box is right for a keyboard, wrong for a
             thumb: on a phone it throws the on-screen keyboard over the very
             options the tap asked to see. */
          if (search && !window.matchMedia('(pointer: coarse)').matches) {
            search.focus();
          }
        } else {
          close();
        }
      });

      var box = el('div', { style: 'position:relative' }, [btn, menu]);
      return box;
    }

    /* ------------------------------------------------------------ render */

    function render() {
      // An empty DATASET has nothing to search (owner, 2026-08-17): the class
      // hides the filter bar, count and pager (v3.css) until data exists —
      // an over-filtered search (rows exist, view empty) keeps them all.
      host.classList.toggle('oa-data-empty', !rows.length);
      /* ONE posting, shown on its own: the same treatment, for the same
         reason — a filter bar over a list of one narrows nothing, and a
         pager reading "1 - 1 / 1" is noise. The bar above the card says
         what is happening and offers the way back (oa-list.css). */
      host.classList.toggle('oa-focus', !!focusId);
      renderFocusBar();

      // result bar
      resEl.innerHTML = '';
      var from = view.length ? page * perPage + 1 : 0;
      var to = Math.min(view.length, (page + 1) * perPage);
      resEl.appendChild(
        el('span', {
          class: 'oa-count',
          text: view.length === rows.length
            ? from + ' - ' + to + ' / ' + view.length
            : from + ' - ' + to + ' / ' + view.length + ' (of ' + rows.length + ')',
        })
      );
      var prev = el('button', {
        type: 'button', 'aria-label': 'Previous page', html: '&lsaquo;',
        onclick: function () {
          if (page > 0) { page--; pagerFocus = 'prev'; render(); syncUrl(); scrollTop(); }
        },
      });
      var next = el('button', {
        type: 'button', 'aria-label': 'Next page', html: '&rsaquo;',
        onclick: function () {
          if ((page + 1) * perPage < view.length) {
            page++; pagerFocus = 'next'; render(); syncUrl(); scrollTop();
          }
        },
      });
      prev.disabled = page === 0;
      next.disabled = (page + 1) * perPage >= view.length;
      resEl.appendChild(el('div', { class: 'oa-pager' }, [prev, next]));
      /* THE PAGER MUST NOT DROP THE KEYBOARD. render() rebuilds this bar, so
         the button just pressed is gone and focus falls to <body>: a reader
         turning pages from the keyboard had to Tab all the way back in for
         every page. The replacement takes it; if the press is what disabled
         it — the last page, or the first — its sibling does, because focus on
         a disabled button goes nowhere. preventScroll, since scrollTop() has
         the last word on where the reader is looking. */
      if (pagerFocus) {
        var want = pagerFocus === 'next' ? next : prev;
        var other = pagerFocus === 'next' ? prev : next;
        pagerFocus = '';
        var takes = want.disabled ? other : want;
        if (!takes.disabled) {
          try { takes.focus({ preventScroll: true }); } catch (e) { takes.focus(); }
        }
      }

      // cards
      listEl.innerHTML = '';
      if (!view.length) {
        /* THREE empty states, not two. A focused id this page does not carry
           is not an over-filtered search either: "try removing a filter" is
           advice about a bar that is not even on screen, and the reader is
           not searching — they followed a link to one posting. The engine
           says so and the PAGE says where else to look, because only the page
           knows what the other one is called. */
        listEl.appendChild(
          focusId
            ? el('li', { class: 'oa-empty' }, [
                el('strong', { text: STR.focusMissing }),
                STR.focusMissingHint
                  ? el('span', { html: STR.focusMissingHint })
                  : null,
                /* THE WAY OUT CARRIES THE POSTING WITH IT. A bare link to the
                   other page lands the reader at the top of a list of five
                   hundred, which is the complaint this whole mode exists to
                   remove, reappearing on the recovery path. The PAGE names the
                   other page — only it can — and the engine adds the id, which
                   it is holding. Built as a node with its href set as a
                   property, so an id off the URL is never interpolated into
                   markup. */
                focusOtherLink(),
                /* and the id as TEXT, for the same reason */
                el('span', { class: 'oa-focus-id', text: focusId }),
              ])
            : rows.length
              ? el('li', { class: 'oa-empty' }, [
                  el('strong', { text: STR.emptyFiltered }),
                  el('span', { text: STR.emptyFilteredHint }),
                ])
              : el('li', { class: 'oa-empty' }, [
                  el('strong', { text: STR.emptyData }),
                  el('span', { text: STR.emptyDataHint }),
                ])
        );
      } else {
        view.slice(page * perPage, (page + 1) * perPage).forEach(function (r) {
          listEl.appendChild(card(r));
        });
      }
      liveEl.textContent = view.length + ' ' + STR.unit + ' match';
      var clear = barEl.querySelector('.oa-clear');
      if (clear) clear.disabled = !anySelected();
      var snap = null;
      actionEls.forEach(function (a) {
        if (!a.def.refresh) return;
        if (!snap) snap = apiSnapshot();
        try { a.def.refresh(a.btn, snap); } catch (e) {
          if (window.console) console.error('OAList: action refresh failed', e);
        }
      });
      maybeScrollToFocus();
    }

    /** "Look for it on <the other page>", carrying the id. Null when the page
        declared no other page — the engine cannot know what one is called. */
    function focusOtherLink() {
      var other = cfg.focusOther;
      if (!focusId || !other || !other.href) return null;
      var a = el('a', { class: 'oa-focus-other',
        text: STR.focusOtherLead + (other.label || 'the other page') });
      a.href = other.href + (other.href.indexOf('?') === -1 ? '?' : '&') +
        encodeURIComponent(prefix + focusParam) + '=' + encodeURIComponent(focusId);
      return a;
    }

    /** The bar above a focused card: what is being shown, and the way back.
        Rebuilt on every render so the button is never a stale closure. */
    function renderFocusBar() {
      focusEl.innerHTML = '';
      focusEl.hidden = !focusId;
      if (!focusId) return;
      focusEl.appendChild(el('span', {
        class: 'oa-focus-msg',
        text: view.length ? STR.focusOne : STR.focusMissing,
      }));
      focusEl.appendChild(el('button', {
        type: 'button',
        class: 'oa-focus-clear',
        text: STR.focusClear,
        onclick: clearFocus,
      }));
    }

    function scrollTop() {
      var y = host.getBoundingClientRect().top + window.pageYOffset - 80;
      window.scrollTo(window.pageXOffset, y < 0 ? 0 : y);
    }

    /** A focused posting is scrolled to ONCE, on the render that first draws
        it. The list sits well below the fold on both pages, so a link that
        opens one posting has to land on it — but re-scrolling on every render
        would yank the page away from a maintainer who is reading the card. */
    function maybeScrollToFocus() {
      if (!focusId || focusScrolled || !view.length) return;
      focusScrolled = true;
      scrollTop();
    }

    /* ------------------------------------------------ cfg.cardOpen (the gate)

       WHAT A CLICK ON A CARD'S HEAD DOES. Called for each card as it is drawn;
       return nothing to open it where it stands, which is the default and what
       every list did before this existed, or a descriptor to do something else:

           { note:  what the strip under the head says
             blur:  draw the details as an unreadable strip (the locked shape)
             run:   what the click does — or null, when there is nothing it can
                    usefully do (nobody can sign in, so the strip explains
                    rather than offering a control that would sit there dead) }

       A card with a descriptor RENDERS NO BODY AT ALL. Not a hidden one, not
       a blurred copy of the real values — the values are not put into the
       document, because a blur over real text is a picture of a lock rather
       than a lock, and this engine should not be in the business of drawing
       one. What IS drawn is the LABELS of the rows this posting would have
       shown: they are the page's own static wording rather than anything the
       row says, they are true (a card without a suggested date does not
       advertise one), and blurred they give the reader the shape of what an
       account is worth. See assets/oa-gate.js for who decides, and for why
       this is a decision about what the site SHOWS and never about access —
       every dataset here is a served file anybody may fetch.

       The head keeps `aria-expanded`/`aria-controls` only while it really is a
       disclosure; a button that navigates or opens a dialog and claims to
       expand a region that is not there is worse than an unlabelled one, so
       the locked head carries its purpose as its title instead. */
    function cardOpen(r) {
      if (typeof cfg.cardOpen !== 'function') return null;
      var d;
      try { d = cfg.cardOpen(r); } catch (e) {
        if (window.console) console.error('OAList: cardOpen failed', e);
        return null;
      }
      return (d && typeof d === 'object') ? d : null;
    }

    /** The row labels a card WOULD have shown — never a value, and only the
        rows that would really have been drawn (the engine skips an empty one,
        so a card must not preview a row it does not have). */
    function lockPreview(r) {
      var out = [];
      ((cfg.card.rows && cfg.card.rows(r)) || []).forEach(function (kv) {
        if (kv && (kv.value || kv.html) && kv.label) out.push(kv.label);
      });
      return out.join('  ·  ');
    }

    function card(r) {
      var c = cfg.card;
      var gate = cardOpen(r);
      var open = !gate && !!expanded[r.id];
      var bodyId = 'oa-body-' + r.id;

      var badges = el('div', { class: 'oa-badges' });
      (c.badges ? c.badges(r) : []).forEach(function (b) {
        badges.appendChild(
          el('span', { class: 'oa-label ' + (b.cls || 'oa-label-primary'), text: b.text })
        );
      });

      var head = el('button', {
        type: 'button',
        class: 'oa-card-head',
        'aria-expanded': gate ? null : (open ? 'true' : 'false'),
        'aria-controls': gate ? null : bodyId,
        title: gate ? gate.note : null,
      }, [
        badges.childNodes.length ? badges : null,
        el('p', { class: 'oa-card-title', text: c.title(r) }),
        el('p', { class: 'oa-card-sub', text: c.subtitle(r) }),
      ]);

      /* THE LOCKED CARD — head, a strip, and no body. The note is real text
         rather than an aria-hidden decoration: it is the only thing on the
         card that says what the click will do, and it has to reach a screen
         reader too. The blurred run beside it is decoration and says so. */
      if (gate) {
        var strip = el('div', {
          class: 'oa-card-lock' + (gate.blur ? ' is-blurred' : ''),
        }, [
          gate.blur
            ? el('span', {
                class: 'oa-card-lock-blur', 'aria-hidden': 'true',
                text: lockPreview(r),
              })
            : null,
          el('span', { class: 'oa-card-lock-note', text: gate.note }),
        ]);
        if (typeof gate.run === 'function') {
          head.addEventListener('click', function () { gate.run(r); });
        } else {
          head.disabled = true;
        }
        /* TWO classes, and the distinction is not cosmetic. `oa-card-gated`
           says the card does not open HERE — true of a signed-in reader's
           teaser card, which opens on the full list instead. `oa-card-locked`
           says the reader may not read it at all. A single class named
           "locked" on a signed-in reader's card is a statement in the
           document that is not true, and the styling keyed on it (the
           padlock) then says it out loud. */
        var lockedLi = el('li', {
          class: 'oa-card oa-card-gated' + (gate.blur ? ' oa-card-locked' : ''),
          id: 'job-' + r.id,
        }, [head, strip]);
        if (typeof cfg.onCard === 'function') {
          try { cfg.onCard(lockedLi, r); } catch (e2) { if (window.console) console.error(e2); }
        }
        return lockedLi;
      }

      var table = el('table', { class: 'oa-kv' });
      var tbody = el('tbody');
      (c.rows(r) || []).forEach(function (kv) {
        if (!kv || (!kv.value && !kv.html)) return;
        var td = el('td');
        if (kv.html) td.innerHTML = kv.html;
        else td.textContent = kv.value;
        tbody.appendChild(el('tr', null, [el('th', { scope: 'row', text: kv.label }), td]));
      });
      table.appendChild(tbody);

      var body = el('div', { class: 'oa-card-body', id: bodyId });
      body.hidden = !open;
      body.appendChild(table);

      head.addEventListener('click', function () {
        var nowOpen = body.hidden;
        body.hidden = !nowOpen;
        head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        expanded[r.id] = nowOpen;
      });

      var li = el('li', { class: 'oa-card', id: 'job-' + r.id }, [head, body]);

      /* A hook rather than a built-in "edit" button, because this engine is
         deliberately dataset-generic — it renders Candidates and Placements
         too, which have nothing to edit. Whoever mounts the list decides what,
         if anything, belongs on a card. */
      if (typeof cfg.onCard === 'function') {
        try { cfg.onCard(li, r); } catch (e) { if (window.console) console.error(e); }
      }
      return li;
    }

    /* ------------------------------------------------------- url <-> state

       Filter state lives in the query string so a filtered view is
       shareable and survives a reload — the vendor's tables could not do
       this, and the site already links into them with ?filterA=.          */

    var syncing = false;

    function syncUrl() {
      if (syncing) return;
      // Seed from the URL the visitor actually arrived on and clear only the
      // keys this engine owns. Rebuilding from an empty set deleted every
      // foreign parameter — utm_*, gclid, a mail-shot token — a second after
      // the page painted.
      var p = new URLSearchParams(location.search);
      filters.forEach(function (f) {
        p['delete'](prefix + f.key);
        if (f.legacyParam) p['delete'](f.legacyParam);
      });
      p['delete'](prefix + 'page');
      /* The engine owns the focus parameter too, or "Show all postings" would
         drop the card and leave the URL still naming it — one reload and the
         reader is back on the single posting they had just left. */
      if (focusParam) p['delete'](prefix + focusParam);
      filters.forEach(function (f) {
        if (f.type === 'text') {
          /* One parameter per term, like a facet — a shared link carries every
             institution the reader collected, not just the last one. The
             half-typed draft goes too: a link copied mid-search must find what
             the sender was looking at, and it comes back as a chip, which is
             the only unambiguous thing to restore it as. */
          sel[f.key].forEach(function (v) { p.append(prefix + f.key, v); });
          if (drafts[f.key]) p.append(prefix + f.key, drafts[f.key]);
        } else {
          // one parameter PER value rather than a "a|b" join: a facet value is
          // free text off the posting form, and one containing a pipe used to
          // round-trip as two values that match nothing at all
          sel[f.key].forEach(function (v) { p.append(prefix + f.key, v); });
        }
      });
      if (page > 0) p.set(prefix + 'page', String(page + 1));
      if (focusParam && focusId) p.set(prefix + focusParam, focusId);
      var qs = p.toString();
      /* A `#job-` fragment goes: it is this engine's own, it is said in the
         query string now, and leaving both would make the state un-clearable
         — "Show all postings" would drop the card while the URL still named
         one, and a reload would put it straight back. Every other hash is
         somebody else's and is carried through untouched. */
      var hash = focusDropHash ? '' : location.hash;
      focusDropHash = false;
      var url = location.pathname + (qs ? '?' + qs : '') + hash;
      history.replaceState(null, '', url);
    }

    // does this facet actually hold `v` as one of its values?
    function facetHas(f, v) {
      for (var i = 0; i < rows.length; i++) {
        if (valuesOf(rows[i], f).indexOf(v) !== -1) return true;
      }
      return false;
    }

    function readUrl() {
      var p = new URLSearchParams(location.search);
      filters.forEach(function (f) {
        // ?filterA= is the legacy Awesome Table deep link the footer and the
        // "Further info" column still emit — honour it as the text filter.
        var all = p.getAll(prefix + f.key);
        if (!all.length && f.legacyParam) all = p.getAll(f.legacyParam);
        if (!all.length) return;
        /* Text and facet read the same way now. A legacy ?filterA= deep link
           (the universities map's "Further info" column still emits one) lands
           as a chip, which is strictly better than the bare text it used to
           set: the reader can see what is filtering the list and remove it. */
        if (f.type === 'text') {
          // trimmed BEFORE the test, or `?institution=%20` lands as an empty chip
          all.forEach(function (v) { var t = String(v || '').trim(); if (t) sel[f.key].add(t); });
          return;
        }
        var add = function (v) {
          if (!v) return;
          // a value this filter used to publish under another name, so a link
          // someone bookmarked or shared still selects what they meant
          if (f.legacyValues && f.legacyValues[v]) v = f.legacyValues[v];
          sel[f.key].add(v);
        };
        if (all.length > 1) {
          // a single-select filter takes ONE value from a link, the last named
          if (f.type === 'one') add(all[all.length - 1]); else all.forEach(add);
        } else if (all[0].indexOf('|') === -1 || facetHas(f, all[0])) {
          add(all[0]);
        } else {
          // ONE occurrence carrying a pipe is ambiguous — one value, or the
          // older "a|b" join that links already in the wild still use. The data
          // settles it: readUrl runs after the rows land, so a string the facet
          // really holds is taken whole.
          all[0].split('|').forEach(add);
        }
      });
      var pg = parseInt(p.get(prefix + 'page'), 10);
      if (pg > 1) page = pg - 1;
      if (!focusParam) return;
      focusId = String(p.get(prefix + focusParam) || '').trim();

      /* A LINK ALREADY COPIED still works. `#job-<id>` is what /admin-area
         emitted before this existed, and it is also the anchor a rendered
         card carries (card() ids every `li` that way), so somebody's
         bookmark may hold one. Nothing ever acted on it — v3.js looks the
         fragment up at boot, before the list has fetched anything, and finds
         nothing — so reading it here is the first time such a link does what
         it says. The query parameter wins where both are present.

         THE FRAGMENT IS DROPPED BY ITS SHAPE, not by which source won.
         Setting the flag inside the branch below would leave it on a URL
         carrying BOTH forms: "Show all postings" would clear the state, the
         hash would survive the sync, and a reload would focus again — on the
         OTHER posting. `#job-` is this engine's own fragment now, so it goes
         whenever the engine is the thing reading it. */
      focusDropHash = /^#job-./.test(location.hash);
      if (!focusId && focusDropHash) {
        try {
          focusId = decodeURIComponent(location.hash.slice(5)).trim();
        } catch (e) { focusId = location.hash.slice(5); }
      }
    }

    /* -------------------------------------------------------------- load */

    /* `cfg.source` is a function answering the rows itself, for a dataset
       that is not a served file (the forum's threads, read from Firestore
       under the rules). It deliberately skips `load()`, and with it the
       OAFresh echo overlay that path applies: the echo is about a POSTING
       saved in this browser, and nothing a source answers has one. */
    (typeof cfg.source === 'function' ? Promise.resolve().then(cfg.source) : load(cfg.data))
      .then(function (data) {
        loaded = true;
        rows = (Array.isArray(data) ? data : data.rows || []).filter(Boolean);
        rows.forEach(function (r, i) { if (!r.id) r.id = 'r' + i; });
        if (cfg.prepare) rows = cfg.prepare(rows);
        readUrl();
        buildBar();
        apply();
      })
      .catch(function (err) {
        loadFailed = true;
        paintLoadError();
        if (window.console) console.error('OAList: failed to load ' + (cfg.data || STR.unit), err);
      });

    function paintLoadError() {
      listEl.innerHTML = '';
      listEl.appendChild(
        el('li', { class: 'oa-empty' }, [
          el('strong', { text: STR.loadError }),
          el('span', { text: STR.loadErrorHint }),
        ])
      );
    }

    return {
      reload: function () { apply(); },
      /* Re-run the render with the rows already loaded. Sign-in resolves AFTER
         the first paint, so the controls a signed-in user may see have to be
         able to arrive late without refetching the dataset. */
      rerender: function () {
        /* NOT BEFORE THE DATA. The gate and the edit layer both re-render on
           the auth event, which fires synchronously when the session is
           already resolved — usually before the fetch lands — and render()
           read zero rows as an EMPTY dataset: "No job postings are listed at
           the moment" painted over the loading state, and over the fetch
           error too. Until the rows are here there is nothing to redraw. */
        if (loadFailed) { paintLoadError(); return; }
        if (!loaded) return;
        render();
      },
      /* Open ONE card, from the page rather than from a click. What lets a
         reader who pressed a locked card and then signed in land on the
         posting they pressed, rather than on the list they would have to find
         it in again (assets/oa-gate.js `watch`).

         IT ANSWERS WHETHER IT DID, and that is what makes it usable on a page
         carrying SEVERAL lists. The one-pager mounts two gated ones — the
         jobs teaser and the candidates — and both watch the same auth state,
         so a caller holding one id has to be able to ask which list owns it
         rather than handing it to whichever happens to be notified first.
         Ownership is membership in this list's own rows; a row filtered out
         of the current view is still this list's, and opening it means it is
         open when the filter is cleared. */
      open: function (id) {
        var key = String(id == null ? '' : id);
        if (!key) return false;
        var found = false;
        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i] && rows[i].id) === key) { found = true; break; }
        }
        if (!found) return false;
        /* ...AND THE CARD HAS TO BE ONE THAT CAN OPEN. A gated card renders no
           body at all (see cfg.cardOpen): on the one-pager's teasers a press
           carries the reader to the full list instead. Answering true for one
           of those spent oa-gate.js's pending id on nothing — the reader
           pressed a locked card, signed in, and the card they pressed stayed
           shut. "Whether it opened" is what this answers. */
        if (cardOpen(rows[i])) return false;
        expanded[key] = true;
        render();
        return true;
      },
      rows: function () { return rows.slice(); },
      /* What the list is SHOWING, in the order it is showing it — the whole
         filtered set, not the current page. What a download of "these
         postings" has to mean. */
      view: function () { return view.slice(); },
      /** Every filter with something selected. */
      activeFilters: activeFilters,
      /** The id currently shown on its own, or '' — what a page needs to say
          "you are looking at one posting" in its own chrome. */
      focused: function () { return focusId; },
      /** Show one posting on its own, from the page rather than from the URL.
          Same state either way: the URL follows, so the view is shareable. */
      focus: function (id) {
        if (!focusParam) return;
        var next = String(id == null ? '' : id).trim();
        if (next === focusId) return;
        focusId = next;
        focusOpened = false;
        focusScrolled = false;
        page = 0;
        apply();
      },
      state: sel,
    };
  }

  /* ------------------------------------------------------- reading a file

     ONE request per file per page, however many things want it. The home page
     asked for data/jobs.json twice — 117 KB each, on every visit — because the
     launcher card's selects and the ten-most-recent list each fetched it for
     themselves; the second copy was pure waste on a page whose whole point is
     to be light. Anything that wants a served dataset asks here.

     `no-cache` REVALIDATES, it does not skip the cache: the browser still
     sends the request and still gets a 304 with no body when nothing has
     changed, so this costs a round trip and not a download. Without it the
     reader is served whatever their browser last stored — GitHub Pages ships
     these files with ten minutes of freshness — so a posting published a
     minute ago was invisible to anyone who had opened the page recently, and
     the site looked slow long after the pipeline had stopped being.

     A FAILED read is not remembered: the entry is dropped so the next caller
     tries again, rather than every list on the page inheriting one flaky
     request. */
  var loading = Object.create(null);

  function load(url) {
    if (loading[url]) return loading[url];
    loading[url] = fetch(url, { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        return res.json();
      })
      /* The edit the person using THIS browser just saved, overlaid before
         anything renders (assets/oa-fresh.js) — so a correction shows here
         immediately while the build publishes it for everyone else. A page
         without the module, any other URL, and the common empty-stash case
         all pass straight through. */
      .then(function (data) {
        return (typeof window !== 'undefined' && window.OAFresh)
          ? window.OAFresh.apply(url, data) : data;
      })
      .catch(function (err) { delete loading[url]; throw err; });
    return loading[url];
  }

  /* An ISO day the way the site writes dates — "September 8, 2026". The
     browser twin of jobs-model.mjs longDate(), for the card rows that render
     a stored date (the suggested apply-by) rather than stored prose. */
  function longDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return names[+m[2] - 1] + ' ' + (+m[3]) + ', ' + (+m[1]);
  }

  window.OAList = { mount: mount, load: load, safeUrl: safeUrl, fold: fold,
    derive: DERIVE, longDate: longDate };
})();
