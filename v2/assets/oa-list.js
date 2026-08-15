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
    if (u.charAt(0) === '/' || u.slice(0, 2) === './') return u;
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
      if (!row.applyByDate) {
        return /until\s*filled|open\s*until|rolling/i.test(row.applyBy || '')
          ? 'Until filled'
          : 'Until filled';
      }
      return daysBetween(todayISO(), row.applyByDate) < 0 ? 'Expired' : 'Open';
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
    deadline: ['Open', 'Until filled', 'Expired'],
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
          var t = null;
          input.addEventListener('input', function () {
            clearTimeout(t);
            t = setTimeout(function () {
              sel[f.key] = input.value;
              page = 0;
              apply();
            }, 140);
          });
          wrap.appendChild(input);
        } else {
          wrap.appendChild(buildPicker(f, id));
          wrap.appendChild(buildChips(f));
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

    function buildPicker(f, id) {
      var chosen = sel[f.key];
      var multi = f.type !== 'one';
      var btn = el('button', {
        type: 'button',
        id: id,
        class: 'oa-pick-btn' + (chosen.size ? ' is-set' : ''),
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      }, [
        el('span', {
          class: 'oa-pick-label',
          text: chosen.size
            ? chosen.size + ' selected'
            : (f.placeholder || 'Choose a value'),
        }),
        el('span', { class: 'oa-pick-caret', 'aria-hidden': 'true', text: multi ? '+' : '⌄' }),
      ]);

      var menu = el('div', { class: 'oa-pick-menu', role: 'listbox', hidden: true });

      function close() {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onEsc, true);
      }
      function onOutside(e) {
        if (!menu.contains(e.target) && e.target !== btn) close();
      }
      function onEsc(e) {
        if (e.key === 'Escape') { close(); btn.focus(); }
      }

      function fill(q) {
        menu.innerHTML = '';
        if (f.searchable !== false) {
          var s = el('input', {
            class: 'oa-pick-search',
            type: 'text',
            placeholder: 'Search…',
            value: q || '',
            autocomplete: 'off',
          });
          s.addEventListener('input', function () { fill(s.value); });
          s.addEventListener('keydown', function (e) { e.stopPropagation(); });
          menu.appendChild(s);
        }
        var opts = optionsFor(f);
        var needle = fold(q || '');
        if (needle) {
          opts = opts.filter(function (o) { return fold(o.value).indexOf(needle) !== -1; });
        }
        if (!opts.length) {
          menu.appendChild(el('div', { class: 'oa-opt is-empty', text: 'No matches' }));
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
            if (!multi) close();
            buildBar();
            apply();
          });
          menu.appendChild(row);
        });
        // keep the freshly rebuilt menu open where the user left it
        if (q !== undefined && menu.querySelector('.oa-pick-search')) {
          menu.querySelector('.oa-pick-search').focus();
        }
      }

      btn.addEventListener('click', function () {
        if (menu.hidden) {
          fill('');
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
          document.addEventListener('mousedown', onOutside, true);
          document.addEventListener('keydown', onEsc, true);
          var s = menu.querySelector('.oa-pick-search');
          if (s) s.focus();
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
        listEl.appendChild(
          el('li', { class: 'oa-empty' }, [
            el('strong', { text: 'No job postings match these filters.' }),
            el('span', { text: 'Try removing a filter, or clear them all to see every posting.' }),
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
      var p = new URLSearchParams();
      filters.forEach(function (f) {
        if (f.type === 'text') {
          if (sel[f.key]) p.set(f.key, sel[f.key]);
        } else if (sel[f.key].size) {
          p.set(f.key, Array.from(sel[f.key]).join('|'));
        }
      });
      if (page > 0) p.set('page', String(page + 1));
      var qs = p.toString();
      var url = location.pathname + (qs ? '?' + qs : '') + location.hash;
      history.replaceState(null, '', url);
    }

    function readUrl() {
      var p = new URLSearchParams(location.search);
      filters.forEach(function (f) {
        // ?filterA= is the legacy Awesome Table deep link the footer and the
        // "Further info" column still emit — honour it as the text filter.
        var raw = p.get(f.key);
        if (raw === null && f.legacyParam) raw = p.get(f.legacyParam);
        if (raw === null) return;
        if (f.type === 'text') sel[f.key] = raw;
        else raw.split('|').forEach(function (v) { if (v) sel[f.key].add(v); });
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
