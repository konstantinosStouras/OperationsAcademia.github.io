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

  var uid = 0;

  /**
   * Attach a picker to an existing <input type="text">.
   *
   *   options   [{ v, n }] or ['a','b'] — v is the value, n its usage count
   *   preferred []          — values to float to the top (the chosen
   *                           university's own schools, say) and mark
   *   hint      string      — one line under the list explaining `preferred`
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
      preferred: [],
      hint: opts.hint || '',
      max: opts.max || 60,
      open: false,
      active: -1,
      rows: [],
    };

    function setOptions(list_) {
      state.options = (list_ || []).map(function (o) {
        return typeof o === 'string' ? { v: o, n: 0 } : { v: o.v, n: o.n || 0 };
      }).filter(function (o) { return o.v; });
    }

    function setPreferred(list_) {
      state.preferred = (list_ || []).slice();
      if (state.open) render();
    }

    setOptions(opts.options);
    setPreferred(opts.preferred);

    function matches() {
      var needle = input.value;
      var pref = {};
      for (var i = 0; i < state.preferred.length; i++) pref[fold(state.preferred[i])] = true;

      var out = [];
      for (var j = 0; j < state.options.length; j++) {
        var o = state.options[j];
        var s = score(o.v, needle);
        if (!s) continue;
        out.push({ v: o.v, n: o.n, s: s, pref: !!pref[fold(o.v)] });
      }
      out.sort(function (a, b) {
        if (a.pref !== b.pref) return a.pref ? -1 : 1;      // this university's own, first
        if (b.s !== a.s) return b.s - a.s;                   // then how well it matches
        if (b.n !== a.n) return b.n - a.n;                   // then how often it is used
        return a.v.localeCompare(b.v);
      });
      return out;
    }

    function render() {
      var found = matches();
      var typed = String(input.value || '').trim();
      var exact = found.some(function (o) { return fold(o.v) === fold(typed); });

      list.innerHTML = '';
      state.rows = [];

      if (state.hint && state.preferred.length && !typed) {
        var h = document.createElement('p');
        h.className = 'oa-combo-hint';
        h.textContent = state.hint;
        list.appendChild(h);
      }

      var shown = found.slice(0, state.max);
      for (var i = 0; i < shown.length; i++) {
        var o = shown[i];
        var row = document.createElement('div');
        row.className = 'oa-combo-opt' + (o.pref ? ' is-pref' : '');
        row.id = id + '-opt-' + i;
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
        list.appendChild(row);
        state.rows.push(row);
      }

      if (found.length > shown.length) {
        var more = document.createElement('p');
        more.className = 'oa-combo-more';
        more.textContent = 'Keep typing to narrow ' + (found.length - shown.length) + ' more.';
        list.appendChild(more);
      }

      /* The "Other" case, offered rather than hidden behind a mode switch: if
         what is typed is not already a known name, taking this row is what
         adds it to the list everyone else sees from the next build on. */
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
        list.appendChild(add);
        state.rows.push(add);
      }

      if (!state.rows.length) {
        var empty = document.createElement('p');
        empty.className = 'oa-combo-empty';
        empty.textContent = 'Nothing matches. Type the full name to add it.';
        list.appendChild(empty);
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
                        setPreferred: setPreferred,
                        close: close };
    return input.__oaCombo;
  }

  window.OACombo = { attach: attach, fold: fold, score: score };
})();
