/* ---------------------------------------------------------------------------
   Operations Academia — filterable card list engine.

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

   FILTER SEMANTICS (matching what Awesome Table did, so results do not shift
   under returning visitors):
     - every filter ANDs with every other filter;
     - within one filter, selected values OR together;
     - a 'text' filter is a case/diacritic-insensitive substring match;
     - a filter with nothing selected is inert.

   Option counts are CROSS-FILTERED: each value shows how many rows it would
   yield given every OTHER active filter, so a count is never a dead end.
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

  // Diacritic-insensitive fold, so "Münster" is found by typing "munster".
  function fold(s) {
    s = String(s === null || s === undefined ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s;
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

  function todayISO() {
    var d = new Date();
    return (
      d.getFullYear() +
      '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0')
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
     here from the real dates instead means the buckets are always correct.     */

  var DERIVE = {
    deadline: function (row) {
      // No usable date — missing, or a value Date.parse cannot read. Only prose
      // that really is open-ended earns "Until filled"; a deadline the importer
      // failed to parse is NOT open-ended and must not be advertised as one.
      // (Both arms of this test used to return 'Until filled', so the check was
      // computed and thrown away and every undated row was filed open-ended.)
      var days = row.applyByDate ? daysBetween(todayISO(), row.applyByDate) : NaN;
      if (isNaN(days)) {
        return /until\s*filled|open\s*until|rolling/i.test(row.applyBy || '')
          ? 'Until filled'
          : 'Deadline not stated';
      }
      return days < 0 ? 'Expired' : 'Open';
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

  var BUCKET_ORDER = {
    deadline: ['Open', 'Until filled', 'Deadline not stated', 'Expired'],
    datePosted: ['Last 7 days', 'Last 30 days', 'Last 3 months', 'Older posts'],
  };

  /* -------------------------------------------------------------- value read */

  function valuesOf(row, f) {
    if (f.derive) return [DERIVE[f.derive](row)];
    return asArray(row[f.field]).map(function (v) { return String(v).trim(); })
      .filter(Boolean);
  }

  function matches(row, f, chosen) {
    if (f.type === 'text') {
      var needle = fold(chosen);
      if (!needle) return true;
      return asArray(f.fields || [f.field]).some(function (name) {
        return fold(row[name]).indexOf(needle) !== -1;
      });
    }
    if (!chosen || !chosen.size) return true;
    var vals = valuesOf(row, f);
    for (var i = 0; i < vals.length; i++) if (chosen.has(vals[i])) return true;
    return false;
  }

  /* ------------------------------------------------------------------ mount */

  function mount(cfg) {
    var host = document.querySelector(cfg.mount);
    if (!host) return;

    var perPage = cfg.perPage || 10;
    var filters = cfg.filters || [];
    var rows = [];
    var view = [];
    var page = 0;
    var expanded = {};

    // state: text filters hold a string, value filters hold a Set
    var sel = {};
    // pending debounce per text filter, so a rebuild can cancel it (below)
    var textTimers = {};
    filters.forEach(function (f) {
      sel[f.key] = f.type === 'text' ? '' : new Set();
    });

    host.className = 'oa-list';
    host.innerHTML = '';
    var barEl = el('div', { class: 'oa-filters' });
    var resEl = el('div', { class: 'oa-resultbar' });
    var listEl = el('ul', { class: 'oa-cards' });
    var liveEl = el('div', {
      class: 'oa-sr',
      role: 'status',
      'aria-live': 'polite',
      style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)',
    });
    host.appendChild(barEl);
    host.appendChild(resEl);
    host.appendChild(listEl);
    host.appendChild(liveEl);

    listEl.appendChild(el('li', { class: 'oa-loading', text: 'Loading job postings…' }));

    /* --------------------------------------------------------- filtering */

    // rows passing every filter EXCEPT `skipKey` — the cross-filter denominator
    function passing(skipKey) {
      return rows.filter(function (r) {
        for (var i = 0; i < filters.length; i++) {
          var f = filters[i];
          if (f.key === skipKey) continue;
          if (!matches(r, f, sel[f.key])) return false;
        }
        return true;
      });
    }

    function optionsFor(f) {
      var pool = passing(f.key);
      var counts = Object.create(null);
      pool.forEach(function (r) {
        valuesOf(r, f).forEach(function (v) {
          counts[v] = (counts[v] || 0) + 1;
        });
      });
      // include an already-selected value even when it now counts zero, so a
      // chip can always be seen and removed
      sel[f.key].forEach(function (v) { if (!(v in counts)) counts[v] = 0; });

      var names = Object.keys(counts);
      var order = f.derive && BUCKET_ORDER[f.derive];
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

    function apply() {
      view = passing(null);
      if (cfg.sort) view.sort(cfg.sort);
      var maxPage = Math.max(0, Math.ceil(view.length / perPage) - 1);
      if (page > maxPage) page = maxPage;
      render();
      syncUrl();
    }

    /* -------------------------------------------------------- filter bar */

    function anySelected() {
      return filters.some(function (f) {
        return f.type === 'text' ? !!sel[f.key] : sel[f.key].size > 0;
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
        var wrap = el('div', { class: 'oa-filter' + (f.type === 'text' ? '' : ' oa-pick') });
        var id = 'oaf-' + f.key;
        wrap.appendChild(el('label', { for: id, text: f.label }));

        if (f.type === 'text') {
          var input = el('input', {
            id: id,
            type: 'search',
            value: sel[f.key],
            placeholder: f.placeholder || '',
            autocomplete: 'off',
          });
          input.addEventListener('input', function () {
            clearTimeout(textTimers[f.key]);
            textTimers[f.key] = setTimeout(function () {
              sel[f.key] = input.value;
              page = 0;
              apply();
            }, 140);
          });
          wrap.appendChild(input);
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
            sel[f.key] = f.type === 'text' ? '' : new Set();
          });
          page = 0;
          buildBar();
          apply();
        },
      });
      clear.disabled = !anySelected();
      barEl.appendChild(el('div', { class: 'oa-filter-actions' }, [clear]));
    }

    function buildChips(f) {
      var box = el('div', { class: 'oa-chips' });
      sel[f.key].forEach(function (v) {
        box.appendChild(
          el('span', { class: 'oa-chip' }, [
            el('span', { text: v }),
            el('button', {
              type: 'button',
              'aria-label': 'Remove filter ' + v,
              text: '×',
              onclick: function () {
                sel[f.key]['delete'](v);
                page = 0;
                buildBar();
                apply();
              },
            }),
          ])
        );
      });
      return box;
    }

    function buildPicker(f, id, onPick) {
      var chosen = sel[f.key];
      var multi = f.type !== 'one';
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

      function fill(q) {
        optsEl.innerHTML = '';
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
          var row = el('label', { class: 'oa-opt' }, [
            cb,
            el('span', { class: 'oa-opt-name', text: o.value }),
            el('span', { class: 'oa-opt-n', text: String(o.count) }),
          ]);
          cb.addEventListener('change', function () {
            if (!multi) chosen.clear();
            if (cb.checked) chosen.add(o.value); else chosen['delete'](o.value);
            page = 0;
            syncBtn();
            if (!multi) close();
            // NOT a rebuild: the option counts in THIS menu are cross-filtered
            // on every OTHER filter (optionsFor skips f.key), so ticking a
            // value here cannot change them — and leaving the rows in place is
            // what keeps a multi-select menu open under the pointer.
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
          if (search) search.focus();
        } else {
          close();
        }
      });

      var box = el('div', { style: 'position:relative' }, [btn, menu]);
      return box;
    }

    /* ------------------------------------------------------------ render */

    function render() {
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
        onclick: function () { if (page > 0) { page--; render(); syncUrl(); scrollTop(); } },
      });
      var next = el('button', {
        type: 'button', 'aria-label': 'Next page', html: '&rsaquo;',
        onclick: function () {
          if ((page + 1) * perPage < view.length) { page++; render(); syncUrl(); scrollTop(); }
        },
      });
      prev.disabled = page === 0;
      next.disabled = (page + 1) * perPage >= view.length;
      resEl.appendChild(el('div', { class: 'oa-pager' }, [prev, next]));

      // cards
      listEl.innerHTML = '';
      if (!view.length) {
        // an empty DATASET is not an over-filtered search: saying "try removing
        // a filter" beside a disabled Clear button and an untouched bar sends
        // the reader hunting for something that is not there
        listEl.appendChild(
          rows.length
            ? el('li', { class: 'oa-empty' }, [
                el('strong', { text: 'No job postings match these filters.' }),
                el('span', { text: 'Try removing a filter, or clear them all to see every posting.' }),
              ])
            : el('li', { class: 'oa-empty' }, [
                el('strong', { text: 'No job postings are listed at the moment.' }),
                el('span', { text: 'Please check back soon — new postings are added as they arrive.' }),
              ])
        );
      } else {
        view.slice(page * perPage, (page + 1) * perPage).forEach(function (r) {
          listEl.appendChild(card(r));
        });
      }
      liveEl.textContent = view.length + ' postings match';
      var clear = barEl.querySelector('.oa-clear');
      if (clear) clear.disabled = !anySelected();
    }

    function scrollTop() {
      var y = host.getBoundingClientRect().top + window.pageYOffset - 80;
      window.scrollTo(window.pageXOffset, y < 0 ? 0 : y);
    }

    function card(r) {
      var c = cfg.card;
      var open = !!expanded[r.id];
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
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': bodyId,
      }, [
        badges.childNodes.length ? badges : null,
        el('p', { class: 'oa-card-title', text: c.title(r) }),
        el('p', { class: 'oa-card-sub', text: c.subtitle(r) }),
      ]);

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

      return el('li', { class: 'oa-card', id: 'job-' + r.id }, [head, body]);
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
        p['delete'](f.key);
        if (f.legacyParam) p['delete'](f.legacyParam);
      });
      p['delete']('page');
      filters.forEach(function (f) {
        if (f.type === 'text') {
          if (sel[f.key]) p.set(f.key, sel[f.key]);
        } else {
          // one parameter PER value rather than a "a|b" join: a facet value is
          // free text off the posting form, and one containing a pipe used to
          // round-trip as two values that match nothing at all
          sel[f.key].forEach(function (v) { p.append(f.key, v); });
        }
      });
      if (page > 0) p.set('page', String(page + 1));
      var qs = p.toString();
      var url = location.pathname + (qs ? '?' + qs : '') + location.hash;
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
        var all = p.getAll(f.key);
        if (!all.length && f.legacyParam) all = p.getAll(f.legacyParam);
        if (!all.length) return;
        if (f.type === 'text') sel[f.key] = all[0];
        else if (all.length > 1) {
          all.forEach(function (v) { if (v) sel[f.key].add(v); });
        } else if (all[0].indexOf('|') === -1 || facetHas(f, all[0])) {
          if (all[0]) sel[f.key].add(all[0]);
        } else {
          // ONE occurrence carrying a pipe is ambiguous — one value, or the
          // older "a|b" join that links already in the wild still use. The data
          // settles it: readUrl runs after the rows land, so a string the facet
          // really holds is taken whole.
          all[0].split('|').forEach(function (v) { if (v) sel[f.key].add(v); });
        }
      });
      var pg = parseInt(p.get('page'), 10);
      if (pg > 1) page = pg - 1;
    }

    /* -------------------------------------------------------------- load */

    fetch(cfg.data, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        return res.json();
      })
      .then(function (data) {
        rows = (Array.isArray(data) ? data : data.rows || []).filter(Boolean);
        rows.forEach(function (r, i) { if (!r.id) r.id = 'r' + i; });
        if (cfg.prepare) rows = cfg.prepare(rows);
        readUrl();
        buildBar();
        apply();
      })
      .catch(function (err) {
        listEl.innerHTML = '';
        listEl.appendChild(
          el('li', { class: 'oa-empty' }, [
            el('strong', { text: 'The job postings could not be loaded.' }),
            el('span', { text: 'Please reload the page, or let us know if it keeps happening.' }),
          ])
        );
        if (window.console) console.error('OAList: failed to load ' + cfg.data, err);
      });

    return {
      reload: function () { apply(); },
      state: sel,
    };
  }

  window.OAList = { mount: mount, safeUrl: safeUrl, fold: fold, derive: DERIVE };
})();
