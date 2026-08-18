/* ---------------------------------------------------------------------------
   Operations Academia — a search-as-you-type picker over a known vocabulary.

   WHAT IT IS. A text input with a listbox under it. On focus it offers every
   value already used on the site, most-used first; typing narrows the list;
   Enter or a click fills the field. Typing something the list does not contain
   is allowed and is offered explicitly as "Use <what you typed> — a new name",
   so a school opening a new department is never stuck.

   WHY NOT A <select> PLUS AN "OTHER" BOX. That is the shape the brief asked
   for, and one control does the same work with less to get wrong: the search
   box, the option list and the "other" case collapse into a single field that
   is already a text input, so the form's validation, its required-field
   handling and its submitted value need no special case for "the user picked
   Other". The affordances the brief wanted are all here — a list to choose
   from, a filter that shrinks it as you type, and a way to enter something new.

   THE CASCADE. A picker can be given a SCOPE — the schools at the chosen
   university, the departments in the chosen school — and then it offers that
   scope under a heading instead of the whole site's list. Typing still
   searches everything, under a second heading, because the scope is a HINT and
   not a restriction: a university opens a school, a school opens a department,
   and neither must be unpostable. The scope is never a filter over the options
   list either — a university's own spelling of a name ("Operations Management
   group") is not always the one the whole site uses most ("Operations
   Management Area"), so scope values are offered as given and matched to the
   options list by name IDENTITY (assets/oa-names.js) purely to read the
   posting count off it.

   ACCESSIBILITY. The pattern is the ARIA 1.2 combobox: the input owns
   `role=combobox`, `aria-expanded` and `aria-activedescendant`; the list is a
   `role=listbox` of `role=option`. Up/Down move, Enter takes, Escape closes,
   Tab closes and keeps what is typed. It degrades to a plain text input with
   no JavaScript, which is exactly what the field was before.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  /* Fold case, accents and punctuation so "Universite Paris" finds
     "Université Paris-Saclay" and "st gallen" finds "St. Gallen". */
  function fold(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Rank a value against what has been typed. Higher is better; 0 excludes.
   * A prefix beats a word start beats a substring, so typing "man" puts
   * "Management Science" above "Supply Chain Management".
   */
  function score(value, needle) {
    if (!needle) return 1;
    var v = fold(value), n = fold(needle);
    if (!n) return 1;
    if (v === n) return 100;
    if (v.indexOf(n) === 0) return 50;
    if (v.indexOf(' ' + n) !== -1) return 25;
    if (v.indexOf(n) !== -1) return 10;

    // every typed word appears somewhere: "ops mgmt" style partial recall
    var words = n.split(' ').filter(Boolean);
    for (var i = 0; i < words.length; i++) if (v.indexOf(words[i]) === -1) return 0;
    return 5;
  }

  /* Two spellings of one place are one name — the rule the vocabulary was
     built with (assets/oa-names.js). Falls back to the plain fold if that file
     is not on the page, which only costs a duplicate row in the list. */
  function nameKey(v) {
    return (window.OANames && window.OANames.key) ? window.OANames.key(v) : fold(v);
  }

  var uid = 0;

  /**
   * Attach a picker to an existing <input type="text">.
   *
   *   options   [{ v, n }] or ['a','b'] — v is the value, n its usage count
   *   scope     { label, values, other, more } — the names that belong under
   *             what has already been chosen (see setScope)
   *   max       number      — options rendered at once (the list is scrollable;
   *                           this is about DOM size, not about hiding values)
   */
  function attach(input, opts) {
    if (!input || input.__oaCombo) return null;
    opts = opts || {};

    var id = 'oa-combo-' + (++uid);
    var wrap = document.createElement('div');
    wrap.className = 'oa-combo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var list = document.createElement('div');
    list.className = 'oa-combo-list';
    list.id = id + '-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');

    var state = {
      options: [],
      counts: {},
      scope: { label: '', values: [], other: '', more: '' },
      max: opts.max || 60,
      open: false,
      active: -1,
      rows: [],
    };

    function setOptions(list_) {
      state.options = (list_ || []).map(function (o) {
        return typeof o === 'string' ? { v: o, n: 0 } : { v: o.v, n: o.n || 0 };
      }).filter(function (o) { return o.v; });

      /* how many postings are behind a name, by IDENTITY — so a scope offering
         a university's own spelling still shows the site-wide count */
      state.counts = {};
      for (var i = 0; i < state.options.length; i++) {
        var k = nameKey(state.options[i].v);
        if (k && !(k in state.counts)) state.counts[k] = state.options[i].n;
      }
    }

    /**
     * Narrow the picker to the names that belong under what has already been
     * chosen — a university's schools, a school's departments.
     *
     *   label   heading over the scope ("Schools at Tulane University")
     *   values  the names in it, spelled as the vocabulary spells them there
     *   other   heading over everything else, shown once the user types
     *   more    the line that says the rest of the site is a search away
     *
     * Calling it with nothing puts the whole site's list back, which is what
     * clearing the university above does.
     */
    function setScope(scope) {
      scope = scope || {};
      state.scope = {
        label: scope.label || '',
        values: (scope.values || []).filter(Boolean),
        other: scope.other || 'Elsewhere on the site',
        more: scope.more || '',
      };
      if (state.open) render();
    }

    setOptions(opts.options);
    setScope(opts.scope);

    /** Rank a list of {v, n} against what has been typed. Higher is better. */
    function rank(items, needle) {
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var s = score(items[i].v, needle);
        if (!s) continue;
        out.push({ v: items[i].v, n: items[i].n, s: s });
      }
      out.sort(function (a, b) {
        if (b.s !== a.s) return b.s - a.s;     // how well it matches
        if (b.n !== a.n) return b.n - a.n;     // then how often it is used
        return a.v.localeCompare(b.v);
      });
      return out;
    }

    /* A heading opens a `role=group` and the options that follow go inside it,
       which is how ARIA 1.2 groups options within a listbox — the visible
       heading itself is hidden from the reading order because the group's own
       label already carries it. */
    var group = null;

    function heading(text) {
      group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', text);
      var h = document.createElement('p');
      h.className = 'oa-combo-group';
      h.setAttribute('aria-hidden', 'true');
      h.textContent = text;
      group.appendChild(h);
      list.appendChild(group);
    }

    function note(cls, text) {
      var p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      group = null;
      list.appendChild(p);
    }

    function optionRow(o, inScope) {
      var row = document.createElement('div');
      row.className = 'oa-combo-opt' + (inScope ? ' is-pref' : '');
      row.id = id + '-opt-' + state.rows.length;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');

      var name = document.createElement('span');
      name.className = 'oa-combo-name';
      name.textContent = o.v;
      row.appendChild(name);

      if (o.n > 1) {
        var n = document.createElement('span');
        n.className = 'oa-combo-n';
        n.textContent = o.n + ' postings';
        row.appendChild(n);
      }
      row.__value = o.v;
      (group || list).appendChild(row);
      state.rows.push(row);
    }

    function render() {
      var needle = input.value;
      var typed = String(needle || '').trim();
      var scope = state.scope;

      list.innerHTML = '';
      state.rows = [];
      group = null;

      var inScope = scope.values.length
        ? rank(scope.values.map(function (v) {
            return { v: v, n: state.counts[nameKey(v)] || 0 };
          }), needle)
        : [];

      var seen = {};
      for (var i = 0; i < inScope.length; i++) seen[nameKey(inScope[i].v)] = true;
      var rest = rank(state.options, needle).filter(function (o) {
        return !seen[nameKey(o.v)];
      });

      /* With a scope in force, BROWSING offers what belongs under the choice
         already made and TYPING still searches the whole site — which is the
         difference between a helpful narrowing and a list that hides the
         answer. A scope that matches nothing steps out of the way entirely. */
      var showRest = !scope.values.length || !!typed || !inScope.length;

      var exact = typed && inScope.concat(showRest ? rest : []).some(function (o) {
        return nameKey(o.v) === nameKey(typed);
      });

      var over = 0, room = state.max;
      if (inScope.length) {
        if (scope.label) heading(scope.label);
        var mine = inScope.slice(0, room);
        over += inScope.length - mine.length;
        room -= mine.length;
        for (i = 0; i < mine.length; i++) optionRow(mine[i], true);
      }

      if (showRest && rest.length) {
        /* the heading is drawn whenever a scope was in force, even when
           nothing in it matched — otherwise the list silently widens and the
           reader is left wondering where the school's own departments went */
        if (scope.values.length && scope.other) heading(scope.other);
        var others = rest.slice(0, Math.max(0, room));
        over += rest.length - others.length;
        for (i = 0; i < others.length; i++) optionRow(others[i], false);
      } else if (!showRest && scope.more) {
        note('oa-combo-more', scope.more);
      }

      if (over > 0) note('oa-combo-more', 'Keep typing to narrow ' + over + ' more.');

      /* The "Other" case, offered rather than hidden behind a mode switch: if
         what is typed is not already a known name, taking this row is what
         adds it to the list everyone else sees from the next build on. A
         spelling that differs only in punctuation, a leading "The" or a
         trailing "Department" is NOT a new name, so it is not offered as one —
         the row it matches is already in the list above. */
      if (typed && !exact) {
        var add = document.createElement('div');
        add.className = 'oa-combo-opt oa-combo-add';
        add.id = id + '-opt-' + state.rows.length;
        add.setAttribute('role', 'option');
        add.setAttribute('aria-selected', 'false');
        add.innerHTML = '<span class="oa-combo-plus" aria-hidden="true">+</span>';
        var t = document.createElement('span');
        t.className = 'oa-combo-name';
        t.textContent = 'Use “' + typed + '” — a name not on the list yet';
        add.appendChild(t);
        add.__value = typed;
        group = null;
        list.appendChild(add);
        state.rows.push(add);
      }

      if (!state.rows.length) {
        note('oa-combo-empty', 'Nothing matches. Type the full name to add it.');
      }

      if (state.active >= state.rows.length) state.active = state.rows.length - 1;
      paintActive();
    }

    function paintActive() {
      for (var i = 0; i < state.rows.length; i++) {
        var on = i === state.active;
        state.rows[i].classList.toggle('is-active', on);
        state.rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (state.active >= 0 && state.rows[state.active]) {
        input.setAttribute('aria-activedescendant', state.rows[state.active].id);
        var el = state.rows[state.active];
        var top = el.offsetTop, bottom = top + el.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function open() {
      if (state.open) return;
      state.open = true;
      state.active = -1;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();
    }

    function close() {
      if (!state.open) return;
      state.open = false;
      state.active = -1;
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function take(value) {
      input.value = value;
      close();
      // let the form's own validation and any dependent picker react
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('input', function () { open(); state.active = -1; render(); });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!state.open) { open(); return; }
        if (!state.rows.length) return;
        var d = e.key === 'ArrowDown' ? 1 : -1;
        state.active = (state.active + d + state.rows.length + 1) % (state.rows.length + 1) - 1;
        if (state.active < 0) state.active = d > 0 ? 0 : state.rows.length - 1;
        paintActive();
      } else if (e.key === 'Enter') {
        if (state.open && state.active >= 0 && state.rows[state.active]) {
          e.preventDefault();                       // do not submit the form
          take(state.rows[state.active].__value);
        } else {
          close();
        }
      } else if (e.key === 'Escape') {
        if (state.open) { e.stopPropagation(); close(); }
      } else if (e.key === 'Tab') {
        close();
      }
    });

    // mousedown, not click: blur would close the list before click landed
    list.addEventListener('mousedown', function (e) {
      var row = e.target.closest ? e.target.closest('.oa-combo-opt') : null;
      if (!row) return;
      e.preventDefault();
      take(row.__value);
    });

    document.addEventListener('mousedown', function (e) {
      if (!wrap.contains(e.target)) close();
    });

    input.__oaCombo = { setOptions: function (o) { setOptions(o); if (state.open) render(); },
                        setScope: setScope,
                        close: close };
    return input.__oaCombo;
  }

  window.OACombo = { attach: attach, fold: fold, score: score, key: nameKey };
})();
