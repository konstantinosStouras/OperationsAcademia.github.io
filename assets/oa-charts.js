/* ---------------------------------------------------------------------------
   Operations Academia — the small inline-SVG chart set the analytics page
   draws itself.

   WHY WE DRAW OUR OWN. The page used to be four Google Sheets `pubchart`
   <iframe>s. Beyond having been dead since 2023 (see build-analytics.mjs),
   an embedded chart is a picture from another site: it cannot take the
   reader's theme — the old page had to apologise for this in its own lede,
   "they render in their own light styling whichever theme you are reading
   in" — it cannot be read by the page's own screen-reader table, it costs a
   third-party connection on a page that otherwise makes none, and it is
   sized in fixed pixels, so on a phone it either overflows or shrinks to
   nothing. All four of those go away by drawing the marks here.

   NO LIBRARY, because this repository has no build step and its pages load
   no CDN beyond the shared font. Five hundred lines of SVG is a smaller
   dependency than a charting bundle, and every one of them is styleable by
   assets/oa-analytics.css in both themes.

   MARK SPECS are fixed and deliberately quiet — 2px lines with round caps,
   bars capped at 24px with a 4px rounded data-end and a square foot on the
   baseline, markers at r>=4 carrying a 2px ring in the surface colour so they
   stay legible where they cross a line, hairline solid gridlines one step off
   the surface. The data is the only thing allowed to be loud.

   COLOUR IS NOT SET HERE. Every mark carries a class and the stylesheet
   paints it from the site's own theme tokens, so a chart follows the reader's
   theme with no JavaScript and no re-render. That matters for the accent in
   particular: the site's --gold and its dark-theme --brand sit at ΔE 14.9,
   below the floor at which two overlaid lines can be told apart, so the dark
   theme re-steps the chart accent (--oa-chart-accent). See the stylesheet.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OACharts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* The tooltips are built as HTML, and every label in them comes from a
     served file — a page title, a country, a referring host Google read out
     of somebody else's header. So nothing reaches innerHTML unescaped. The
     page escapes what it renders itself; this is the same rule one layer
     down, where the markup is actually assembled. */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* The band a bar may occupy is the slot minus the surface gap; the bar
     itself is then capped, so a chart with six bars has air around them
     rather than six fat slabs. */
  const BAR_MAX = 24;
  const GAP = 2;

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(node);
    return node;
  }

  /** Compact, and never a bare `toLocaleString` on an axis tick: 12.9K reads
      at a glance where 12,914 has to be counted. */
  function compact(n) {
    const v = Math.round(Number(n) || 0);
    if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(v % 1000000 ? 1 : 0) + 'M';
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 >= 100 ? 1 : 0) + 'K';
    return String(v);
  }

  const full = (n) => Math.round(Number(n) || 0).toLocaleString('en-GB');

  /** A length of time, said the way a person says it (owner, 2026-08-29:
      "convert seconds to e.g. hours, minute, seconds if seconds is too long").

      "1,952 seconds on average" is a number a reader has to divide by sixty
      before it means anything, and the page was printing exactly that under
      its most-read pages. Below a minute seconds ARE the natural unit and are
      kept; above it the next unit down is zero-padded, so a column of these
      stays aligned and "1h 5m" cannot be misread as "1h 50m". Seconds are
      dropped once hours are involved — nobody reads the seconds of an hour,
      and carrying them would imply a precision a session-duration average
      does not have. */
  function duration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '0s';
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return m ? h + 'h ' + String(m).padStart(2, '0') + 'm' : h + 'h';
    return r ? m + 'm ' + String(r).padStart(2, '0') + 's' : m + 'm';
  }

  /** The same length spelled out, for a tooltip or a table cell where the
      compact form would be the only thing on the line. */
  function durationLong(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const unit = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
    if (s < 60) return unit(s, 'second');
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return m ? unit(h, 'hour') + ' ' + unit(m, 'minute') : unit(h, 'hour');
    const r = s % 60;
    return r ? unit(m, 'minute') + ' ' + unit(r, 'second') : unit(m, 'minute');
  }

  /** A share as a percentage a reader can say out loud. Under a tenth of a
      per cent reads "<0.1%" rather than "0.0%", which would claim a category
      the source really returned is not there at all. */
  function pct(share) {
    const v = (Number(share) || 0) * 100;
    if (!v) return '0%';
    if (v < 0.1) return '<0.1%';
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + '%';
  }

  /** Round a maximum up to something a reader can divide in their head, so
      the ticks land on 0 / 500 / 1,000 rather than 0 / 437 / 874. */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const r = v / mag;
    const step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10;
    return step * mag;
  }

  /* ------------------------------------------------------------- the shell */

  /** Every chart lives in a positioned wrapper so one absolutely-positioned
      tooltip can follow the pointer, and every chart ships a <table> of the
      same numbers — visually hidden, reachable by a screen reader and by the
      "Show the numbers" toggle. A chart nobody can read is not accessible
      because it validated; it is accessible because the values are also
      available as text. */
  function shell(host, { title, desc }) {
    host.textContent = '';
    host.classList.add('oa-chart');
    const wrap = document.createElement('div');
    wrap.className = 'oa-chart-plot';
    host.appendChild(wrap);
    const tip = document.createElement('div');
    tip.className = 'oa-chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    wrap.appendChild(tip);
    const svg = el('svg', {
      class: 'oa-chart-svg',
      role: 'img',
      'aria-label': title || '',
      preserveAspectRatio: 'none',
    });
    if (desc) el('desc', {}, svg).textContent = desc;
    wrap.insertBefore(svg, tip);
    return { wrap, svg, tip };
  }

  function showTip(tip, wrap, x, y, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const w = tip.offsetWidth || 120;
    /* clamp inside the plot: a tooltip that runs off the right edge on the
       last point is the commonest way this goes wrong on a phone */
    let left = x - w / 2;
    if (left < 4) left = 4;
    if (left + w > box.width - 4) left = Math.max(4, box.width - w - 4);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  }

  /** A visually-hidden table of the same numbers, plus the toggle that shows
      it. Built from the same array the marks were, so it cannot disagree. */
  function table(host, cols, rows, { open = false } = {}) {
    const details = document.createElement('details');
    details.className = 'oa-chart-table';
    if (open) details.open = true;
    const sum = document.createElement('summary');
    sum.textContent = 'Show the numbers';
    details.appendChild(sum);
    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    cols.forEach((c) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      r.forEach((cell, i) => {
        const td = document.createElement(i ? 'td' : 'th');
        if (!i) td.scope = 'row';
        td.textContent = cell;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    details.appendChild(t);
    host.appendChild(details);
  }

  /* ---------------------------------------------------------------- a line */

  /**
   * One or two series over the same x. Two is the most this page ever needs
   * (a daily count and its rolling mean), which is why there is a legend rule
   * rather than a categorical palette: at one series the title already names
   * what is plotted and a one-swatch legend would only restate it.
   *
   * opts: { points:[{x,label,tip}], series:[{name,values,kind,area}], yLabel }
   */
  function line(host, opts) {
    const pts = opts.points || [];
    const series = (opts.series || []).filter((s) => s && s.values);
    const { wrap, svg, tip } = shell(host, { title: opts.title, desc: opts.desc });

    const W = 900, H = opts.height || 260;
    const pad = { t: 12, r: 14, b: 26, l: 44 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = H + 'px';

    if (!pts.length) return;

    let max = 0;
    series.forEach((s) => s.values.forEach((v) => { if (v != null && v > max) max = v; }));
    const top = niceMax(max || 1);
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const X = (i) => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
    const Y = (v) => pad.t + ih - (v / top) * ih;

    /* gridlines first, and recessive: they carry the values that are not
       directly labelled and nothing more */
    const g = el('g', { class: 'oa-grid' }, svg);
    for (let i = 0; i <= 4; i++) {
      const v = (top / 4) * i;
      const y = Y(v);
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }, g);
      el('text', { x: pad.l - 8, y: y + 4, class: 'oa-tick oa-tick-y' }, g).textContent = compact(v);
    }

    /* x ticks: a handful of dates, never one per day — 4,500 labels is a grey
       smear, and the tooltip carries the rest */
    const every = Math.max(1, Math.ceil(pts.length / 6));
    const gx = el('g', { class: 'oa-grid' }, svg);
    for (let i = 0; i < pts.length; i += every) {
      el('text', { x: X(i), y: H - 8, class: 'oa-tick oa-tick-x' }, gx).textContent = pts[i].label;
    }

    series.forEach((s) => {
      const cls = s.kind || 'brand';
      const d = [];
      let open = false;
      s.values.forEach((v, i) => {
        if (v == null) { open = false; return; }
        d.push((open ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1));
        open = true;
      });
      if (!d.length) return;
      s.nodes = [];
      if (s.area) {
        /* a wash, never a saturated block */
        const first = s.values.findIndex((v) => v != null);
        const last = s.values.length - 1;
        s.nodes.push(el('path', {
          class: 'oa-area oa-' + cls,
          d: d.join(' ') + ` L ${X(last).toFixed(1)} ${Y(0)} L ${X(first).toFixed(1)} ${Y(0)} Z`,
        }, svg));
      }
      s.nodes.push(el('path', {
        class: 'oa-line oa-' + cls + (s.dashed ? ' oa-dashed' : ''), d: d.join(' '),
      }, svg));
    });

    /* the hover layer: a crosshair and one tooltip for the whole x, which is
       what a reader of a time series actually wants — not a hit target per
       dot, which at this density would be unhittable */
    const rule = el('line', { class: 'oa-crosshair', y1: pad.t, y2: pad.t + ih, x1: -9, x2: -9 }, svg);
    const dots = series.map((s) => el('circle', {
      class: 'oa-dot oa-' + (s.kind || 'brand'), r: 4, cx: -9, cy: -9,
    }, svg));

    function at(clientX) {
      const box = svg.getBoundingClientRect();
      const rel = ((clientX - box.left) / box.width) * W;
      let i = Math.round(((rel - pad.l) / iw) * (pts.length - 1));
      i = Math.max(0, Math.min(pts.length - 1, i));
      return i;
    }

    function move(e) {
      const i = at(e.clientX);
      const x = X(i);
      rule.setAttribute('x1', x); rule.setAttribute('x2', x);
      rule.classList.add('on');
      let html = '<b>' + pts[i].label2 + '</b>';
      let ty = pad.t;
      series.forEach((s, si) => {
        const v = s.hidden ? null : s.values[i];
        if (v == null) {
          dots[si].setAttribute('cx', -9);
          dots[si].classList.remove('on');
          return;
        }
        dots[si].setAttribute('cx', x);
        dots[si].setAttribute('cy', Y(v));
        dots[si].classList.add('on');
        ty = Math.min(ty || 1e9, Y(v));
        html += '<span><i class="oa-key oa-' + (s.kind || 'brand') + '"></i>' +
          s.name + ' <b>' + full(v) + '</b></span>';
      });
      const box = svg.getBoundingClientRect();
      showTip(tip, wrap, (x / W) * box.width, ((ty - 8) / H) * box.height, html);
    }

    function leave() {
      rule.classList.remove('on');
      dots.forEach((d) => d.classList.remove('on'));
      tip.hidden = true;
    }

    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerleave', leave);

    /* THE KEYBOARD READS IT TOO. A crosshair driven only by a pointer is a
       figure a keyboard reader can reach the numbers of solely by opening the
       table below it — which is the fallback, not the chart. The plot takes
       focus, the arrows walk the days, Home and End jump to the ends, and
       Escape puts the crosshair away. */
    let at_ = -1;
    function place(i) {
      at_ = Math.max(0, Math.min(pts.length - 1, i));
      move({ clientX: svg.getBoundingClientRect().left +
        (X(at_) / W) * svg.getBoundingClientRect().width });
    }
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'application');
    wrap.setAttribute('aria-label',
      (opts.title || 'Chart') + ' — use the arrow keys to read each day');
    wrap.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (step) { place(at_ < 0 ? 0 : at_ + step); e.preventDefault(); return; }
      if (e.key === 'Home') { place(0); e.preventDefault(); return; }
      if (e.key === 'End') { place(pts.length - 1); e.preventDefault(); return; }
      if (e.key === 'Escape') { leave(); at_ = -1; }
    });
    wrap.addEventListener('blur', leave);

    /* THE LEGEND IS A CONTROL, not a caption. Two lines over one another is
       the most a reader can hold at once, and the whole point of the mean is
       comparison — so either can be put away and brought back. Hiding is
       never a one-way door here either: the entry stays, pressed-out. */
    if (series.length >= 2) {
      legend(host, series, (s, on) => {
        s.hidden = !on;
        (s.nodes || []).forEach((n) => { n.style.display = on ? '' : 'none'; });
        leave();
      });
    }
    table(host,
      [opts.xTitle || 'Day'].concat(series.map((s) => s.name)),
      pts.map((p, i) => [p.label2].concat(series.map((s) => s.values[i] == null ? '—' : full(s.values[i])))));
  }

  /** A legend is the dependable identity channel and is always present for
      two or more series — never colour-matching alone. Given an `onToggle` it
      becomes a control as well: each entry is a real <button> carrying
      aria-pressed, so a keyboard and a screen reader get the same switch a
      pointer does. */
  function legend(host, series, onToggle) {
    const box = document.createElement('div');
    box.className = 'oa-chart-legend' + (onToggle ? ' oa-chart-legend-on' : '');
    series.forEach((s) => {
      const item = document.createElement(onToggle ? 'button' : 'span');
      if (onToggle) {
        item.type = 'button';
        item.setAttribute('aria-pressed', 'true');
      }
      item.innerHTML = '<i class="oa-key oa-' + (s.kind || 'brand') +
        (s.dashed ? ' oa-dashed' : '') + '"></i>';
      item.appendChild(document.createTextNode(s.name));
      if (onToggle) {
        item.addEventListener('click', () => {
          const on = item.getAttribute('aria-pressed') !== 'true';
          item.setAttribute('aria-pressed', on ? 'true' : 'false');
          onToggle(s, on);
        });
      }
      box.appendChild(item);
    });
    host.appendChild(box);
  }

  /* -------------------------------------------------------------- columns */

  /** Vertical bars over a small, named set — the weekday rhythm and the
      month-of-year season. `note` rides the tooltip so a thin bar can be read
      as thin rather than as an absence. */
  function columns(host, opts) {
    const items = opts.items || [];
    const { wrap, svg, tip } = shell(host, { title: opts.title, desc: opts.desc });
    const W = 900, H = opts.height || 220;
    const pad = { t: 22, r: 8, b: 28, l: 44 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = H + 'px';
    if (!items.length) return;

    /* An EMPTY bucket is not a zero. A month the record has never covered
       drawn as a zero-height bar reads as "nobody came in September", which on
       a job-market site is worse than missing — it is backwards. So it draws
       no bar at all, its label is muted, and its tooltip says which it is. */
    const top = niceMax(Math.max.apply(null, items.map((i) => i.value)) || 1);
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const slot = iw / items.length;
    const bw = Math.min(BAR_MAX, slot - GAP * 2);
    const base = pad.t + ih;

    const g = el('g', { class: 'oa-grid' }, svg);
    for (let i = 0; i <= 3; i++) {
      const v = (top / 3) * i;
      const y = base - (v / top) * ih;
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }, g);
      el('text', { x: pad.l - 8, y: y + 4, class: 'oa-tick oa-tick-y' }, g).textContent = compact(v);
    }

    const real = items.filter((i) => !i.empty);
    const peak = real.length ? real.reduce((a, b) => (b.value > a.value ? b : a), real[0]) : null;

    items.forEach((it) => {
      const i = items.indexOf(it);
      const cx = pad.l + slot * i + slot / 2;
      const h = Math.max(0, (it.value / top) * ih);
      const x = cx - bw / 2;
      /* 4px rounded data-end, square foot on the baseline: one path rather
         than a rounded rect, which would round the foot too and lift the bar
         off its own axis */
      const r = Math.min(4, h);
      const y = base - h;
      el('path', {
        class: 'oa-bar oa-' + (it.kind || (it === peak ? 'accent' : 'brand')),
        d: (h <= 0 || it.empty) ? '' :
          `M${x} ${base} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + bw - r} ${y} ` +
          `Q${x + bw} ${y} ${x + bw} ${y + r} L${x + bw} ${base} Z`,
      }, svg);

      el('text', {
        x: cx, y: H - 9,
        class: 'oa-tick oa-tick-x' + (it.empty ? ' oa-tick-empty' : ''),
      }, svg).textContent = it.short || it.label;

      /* label the extreme only — a number on every column is chaos and goes
         unread */
      if (it === peak) {
        el('text', { x: cx, y: y - 8, class: 'oa-value' }, svg).textContent = full(it.value);
      }

      /* The hit area takes FOCUS as well as a pointer, so the same tooltip is
         reachable by tabbing. A column chart whose numbers can only be had by
         hovering is a chart half the readers cannot read. */
      const shown = opts.format ? opts.format(it.value) : full(it.value);
      const hit = el('rect', {
        class: 'oa-hit', x: pad.l + slot * i, y: pad.t, width: slot, height: ih,
        tabindex: 0, role: 'img',
        'aria-label': it.label + ': ' + (it.empty ? 'no data' : shown +
          (opts.unit ? ' ' + opts.unit : '')),
      }, svg);
      const say = () => {
        const box = svg.getBoundingClientRect();
        showTip(tip, wrap, (cx / W) * box.width, ((it.empty ? base - 6 : y - 6) / H) * box.height,
          '<b>' + esc(it.label) + '</b>' +
          (it.empty ? '' :
            '<span>' + esc(opts.unit || '') + ' <b>' + esc(shown) + '</b></span>') +
          (it.note ? '<span class="oa-tip-note">' + esc(it.note) + '</span>' : ''));
      };
      const hide = () => { tip.hidden = true; };
      hit.addEventListener('pointerenter', say);
      hit.addEventListener('focus', say);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('blur', hide);
    });

    table(host, [opts.xTitle || '', opts.unit || 'Value'],
      /* an em dash, never a 0: the table must not say the thing the bar was
         redrawn to stop saying */
      items.map((i) => [i.label, i.empty ? '—' : (opts.format ? opts.format(i.value) : full(i.value))]));
  }

  /* ------------------------------------------------------------------ bars */

  /** Horizontal bars, for things whose labels are names rather than dates —
      the pages, the countries, the referrers. The value rides the tip of the
      bar, OUTSIDE it, so a label can never be clipped by its own mark.

      EVERY ROW ANSWERS, and that is the part that was missing: this was the
      one figure on the page a reader could not interrogate at all. A row now
      takes a pointer AND focus, and says the one thing a ranked list never
      shows on its face — what SHARE of the whole it is. The share is taken
      from `opts.total` where the caller has the pre-cut total (see
      `breakdown` in the model), so the leader of a top-ten is not reported as
      a proportion of the ten that happened to fit. */
  function bars(host, opts) {
    const all = opts.items || [];
    const items = all.slice(0, opts.limit || 12);
    host.textContent = '';
    host.classList.add('oa-chart', 'oa-chart-bars');
    if (!items.length) return;

    const wrap = document.createElement('div');
    wrap.className = 'oa-chart-plot';
    host.appendChild(wrap);
    const tip = document.createElement('div');
    tip.className = 'oa-chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    wrap.appendChild(tip);

    const top = Math.max.apply(null, items.map((i) => i.value)) || 1;
    const total = Number(opts.total) ||
      all.reduce((n, i) => n + (Number(i.value) || 0), 0);
    const show = (v) => (opts.format ? opts.format(v) : full(v));

    const list = document.createElement('ol');
    list.className = 'oa-barlist';
    items.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'oa-bar-row';
      li.tabIndex = 0;
      const share = total ? it.value / total : 0;
      li.setAttribute('aria-label', it.label + ': ' + show(it.value) +
        (opts.unit ? ' ' + opts.unit : '') + (total ? ', ' + pct(share) : ''));

      const head = document.createElement('div');
      head.className = 'oa-bar-head';
      const name = document.createElement('span');
      name.className = 'oa-bar-name';
      if (it.href) {
        const a = document.createElement('a');
        a.href = it.href;
        a.textContent = it.label;
        name.appendChild(a);
      } else {
        name.textContent = it.label;
      }
      const val = document.createElement('span');
      val.className = 'oa-bar-val';
      val.textContent = show(it.value) + (opts.unit ? ' ' + opts.unit : '');
      head.appendChild(name);
      head.appendChild(val);

      const track = document.createElement('div');
      track.className = 'oa-bar-track';
      const fill = document.createElement('div');
      fill.className = 'oa-bar-fill';
      fill.style.width = Math.max(1.5, (it.value / top) * 100) + '%';
      track.appendChild(fill);
      li.appendChild(head);
      li.appendChild(track);
      if (it.sub) {
        const sub = document.createElement('div');
        sub.className = 'oa-bar-sub';
        sub.textContent = it.sub;
        li.appendChild(sub);
      }

      const say = () => {
        const box = wrap.getBoundingClientRect();
        const r = li.getBoundingClientRect();
        showTip(tip, wrap, (r.left - box.left) + Math.min(140, r.width / 2),
          (r.top - box.top) - 6,
          '<b>' + esc(it.label) + '</b>' +
          '<span>' + esc(show(it.value)) +
          (opts.unit ? ' ' + esc(opts.unit) : '') + '</span>' +
          (total ? '<span class="oa-tip-note">' + esc(pct(share)) +
            ' of ' + esc(full(total)) + (opts.unit ? ' ' + esc(opts.unit) : '') +
            '</span>' : '') +
          (it.note ? '<span class="oa-tip-note">' + esc(it.note) + '</span>' : ''));
      };
      const hide = () => { tip.hidden = true; };
      li.addEventListener('pointerenter', say);
      li.addEventListener('focus', say);
      li.addEventListener('pointerleave', hide);
      li.addEventListener('blur', hide);

      list.appendChild(li);
    });
    wrap.appendChild(list);

    table(host,
      [opts.xTitle || '', opts.unit || 'Value'].concat(total ? ['Share'] : [])
        .concat(opts.subTitle ? [opts.subTitle] : []),
      items.map((i) => [i.label, show(i.value)]
        .concat(total ? [pct(total ? i.value / total : 0)] : [])
        .concat(opts.subTitle ? [i.sub || '—'] : [])));
  }

  /* ------------------------------------------------------------ a share bar

     ONE bar, cut into its parts — for a split that only means anything as a
     proportion (which devices people read on, which channel brought them).

     DELIBERATELY NOT A PIE. A pie asks a reader to compare angles, which is
     the comparison people are worst at; a single stacked bar asks them to
     compare lengths along one axis, which is the one they are best at, and it
     survives a phone, where a pie's labels do not.

     Colour is NOT the only channel: every part is named with its percentage
     in the legend beneath, and the legend is in the same order as the bar. A
     part too thin to carry a label still has a legend row, a focus stop and a
     tooltip. */
  function share(host, opts) {
    const all = opts.items || [];
    const items = all.slice(0, opts.limit || 6);
    host.textContent = '';
    host.classList.add('oa-chart', 'oa-chart-share');
    if (!items.length) return;

    const total = Number(opts.total) ||
      all.reduce((n, i) => n + (Number(i.value) || 0), 0);
    if (!total) return;

    const wrap = document.createElement('div');
    wrap.className = 'oa-chart-plot';
    host.appendChild(wrap);
    const tip = document.createElement('div');
    tip.className = 'oa-chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    wrap.appendChild(tip);

    const bar = document.createElement('div');
    bar.className = 'oa-share-bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', (opts.title || 'Share') + ': ' +
      items.map((i) => i.label + ' ' + pct(i.value / total)).join(', '));
    wrap.appendChild(bar);

    const legendBox = document.createElement('div');
    legendBox.className = 'oa-chart-legend oa-share-legend';

    items.forEach((it, i) => {
      const cls = 'oa-cat-' + ((i % 6) + 1);
      const frac = it.value / total;
      const seg = document.createElement('span');
      seg.className = 'oa-share-seg ' + cls;
      seg.style.width = (frac * 100).toFixed(3) + '%';
      seg.tabIndex = 0;
      seg.setAttribute('aria-label', it.label + ': ' + pct(frac) +
        ', ' + full(it.value) + (opts.unit ? ' ' + opts.unit : ''));

      const say = () => {
        const box = wrap.getBoundingClientRect();
        const r = seg.getBoundingClientRect();
        showTip(tip, wrap, (r.left - box.left) + r.width / 2, (r.top - box.top) - 6,
          '<b>' + esc(it.label) + '</b>' +
          '<span>' + esc(pct(frac)) + ' &middot; ' + esc(full(it.value)) +
          (opts.unit ? ' ' + esc(opts.unit) : '') + '</span>');
      };
      const hide = () => { tip.hidden = true; };
      seg.addEventListener('pointerenter', say);
      seg.addEventListener('focus', say);
      seg.addEventListener('pointerleave', hide);
      seg.addEventListener('blur', hide);
      bar.appendChild(seg);

      const key = document.createElement('span');
      key.innerHTML = '<i class="oa-key ' + cls + '"></i>';
      key.appendChild(document.createTextNode(it.label + ' ' + pct(frac)));
      legendBox.appendChild(key);
    });

    host.appendChild(legendBox);
    table(host, [opts.xTitle || '', opts.unit || 'Value', 'Share'],
      items.map((i) => [i.label, full(i.value), pct(i.value / total)]));
  }

  return { line, columns, bars, share, compact, full, duration, durationLong, pct,
    niceMax, BAR_MAX };
}));
