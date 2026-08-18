/* ---------------------------------------------------------------------------
   Operations Academia — My postings: the signed-in poster's own job postings.

   Reads `jobSubmissions` where uid == me — the SAME query the rules already
   allow oa-jobedit.js for deciding which cards on the public list get Edit
   buttons, so this page needs no rules change. It shows every state a posting
   of yours can be in:

     queued      Pending — the build publishes it at the next update
     published   Live on the jobs page
     withdrawn / removed   Taken down by you (editing it puts it back up:
                 saving an edit re-queues the document, which un-withdraws it)
     hidden      Taken down by the site's maintainers

   Edit goes through post-a-job.html?edit=<document id>, exactly like the Edit
   button on the public list; Take down is the same status change
   oa-jobedit.js makes (never a delete — see that file's header).

   Sorting is client-side (newest first): `where uid ==` plus `orderBy` would
   demand a composite Firestore index for a list that is almost always a
   handful of rows.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function show(el, yes) { if (el) el.hidden = !yes; }

  function col() {
    return (window.OAFB && OAFB.col && OAFB.col.jobSubmissions) || 'jobSubmissions';
  }

  /* ------------------------------------------------------------- rendering */

  function tsToMillis(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();   // Firestore Timestamp
    var d = new Date(ts);
    return isNaN(+d) ? 0 : +d;
  }

  function isoDayOf(ts) {
    var ms = tsToMillis(ts);
    return ms ? new Date(ms).toISOString().slice(0, 10) : '';
  }

  var STATUS = {
    queued:    { label: 'Pending',    cls: 'is-pending',
                 note: 'Goes live at the next update, normally within the hour.' },
    published: { label: 'Live',       cls: 'is-live', note: '' },
    withdrawn: { label: 'Taken down', cls: 'is-down',
                 note: 'You took this posting down. Edit it and save to put it back up.' },
    removed:   { label: 'Taken down', cls: 'is-down',
                 note: 'You took this posting down. Edit it and save to put it back up.' },
    hidden:    { label: 'Taken down', cls: 'is-down',
                 note: 'Taken down by the site’s maintainers — please contact us ' +
                       'if you think this is a mistake.' },
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function jobbtn(label, cls, title, onClick) {
    var b = el('button', 'oa-jobbtn ' + cls, label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', function () { onClick(b); });
    return b;
  }

  function card(id, v) {
    var st = STATUS[v.status] || STATUS.queued;
    var wrap = el('div', 'oa-my-card');

    var head = el('div', 'oa-my-head');
    head.appendChild(el('span', 'oa-my-status ' + st.cls, st.label));
    head.appendChild(el('span', 'oa-my-inst', v.institution || '(no institution)'));
    var dept = v.department || [v.school, v.unit].filter(Boolean).join(', ');
    if (dept) head.appendChild(el('span', 'oa-my-dept', dept));
    wrap.appendChild(head);

    var meta = el('p', 'oa-my-meta');
    var bits = [];
    var posted = v.postedOn || isoDayOf(v.createdAt);
    if (posted) bits.push('Posted ' + posted);
    if (v.ref) bits.push('Reference ' + v.ref);
    meta.textContent = bits.join(' · ');

    /* The advert file, in whichever state it is in. `adUploadPath` means the
       upload landed but the build has not filed it into Drive yet — the
       posting itself never waits for it (the public card says "soon to be
       available" meanwhile). */
    if (v.adUrl) {
      meta.appendChild(document.createTextNode((bits.length ? ' · ' : '') + 'Advert: '));
      var a = el('a', null, 'file');
      a.href = v.adUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      meta.appendChild(a);
    } else if (v.adUploadPath) {
      meta.appendChild(document.createTextNode(
        (bits.length ? ' · ' : '') +
        'Advert uploaded — the file link appears at the next update'));
    }
    wrap.appendChild(meta);

    if (st.note) wrap.appendChild(el('p', 'oa-my-note', st.note));

    var bar = el('div', 'oa-card-actions');
    bar.appendChild(jobbtn('Edit', 'oa-jobbtn-edit', 'Correct this posting', function () {
      location.href = 'post-a-job.html?edit=' + encodeURIComponent(id);
    }));
    if (v.status === 'queued' || v.status === 'published') {
      bar.appendChild(jobbtn('Take down', 'oa-jobbtn-del',
        'Remove this posting from the site', function (btn) {
          takeDown(id, v, btn, wrap);
        }));
    }
    wrap.appendChild(bar);

    return wrap;
  }

  function takeDown(id, v, btn, wrap) {
    var what = (v.institution || '') + (v.department ? ' — ' + v.department : '');
    if (!window.confirm(
      'Take this posting down?\n\n' + what + '\n\n' +
      'It stops appearing on the site at the next update, normally within an ' +
      'hour. Nothing is deleted — edit it later to put it back up.')) return;

    btn.disabled = true;
    btn.textContent = 'Taking down…';

    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(col()).doc(id).update({
        status: 'withdrawn',
        updatedAt: new Date().toISOString(),
      });
    }).then(function () {
      btn.remove();
      var chip = wrap.querySelector('.oa-my-status');
      chip.className = 'oa-my-status is-down';
      chip.textContent = 'Taken down';
      var note = wrap.querySelector('.oa-my-note') || wrap.insertBefore(
        el('p', 'oa-my-note'), wrap.querySelector('.oa-card-actions'));
      note.className = 'oa-my-note';
      note.textContent = 'Taken down. It disappears from the site at the next ' +
        'update — edit it and save to put it back up.';
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Take down';
      var note = wrap.querySelector('.oa-my-note') || wrap.appendChild(el('p', 'oa-my-note'));
      note.className = 'oa-my-note is-bad';
      note.textContent = err && err.code === 'permission-denied'
        ? 'You are not allowed to change this posting.'
        : 'We could not take it down. Please try again.';
      if (window.console) console.error('take down:', err);
    });
  }

  /* --------------------------------------------------------------- loading */

  var loadedFor = null;   // uid, so an auth echo does not re-query

  function load(user) {
    if (loadedFor === user.uid) return;
    loadedFor = user.uid;

    show($('oa-my-loading'), true);
    show($('oa-my-empty'), false);

    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(col()).where('uid', '==', user.uid).get();
    }).then(function (snap) {
      var docs = [];
      snap.forEach(function (d) { docs.push({ id: d.id, v: d.data() || {} }); });
      docs.sort(function (a, b) { return tsToMillis(b.v.createdAt) - tsToMillis(a.v.createdAt); });

      var list = $('oa-my-list');
      list.textContent = '';
      docs.forEach(function (d) { list.appendChild(card(d.id, d.v)); });

      show($('oa-my-loading'), false);
      show(list, docs.length > 0);
      show($('oa-my-empty'), docs.length === 0);

      /* The account menu's badge, corrected from the list we just loaded — no
         extra read, and exact the moment a posting is taken down. The badge
         counts what this page LISTS (pending, live and taken down alike), so
         clicking through never shows a different number of cards. */
      if (window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('postings', docs.length);
    }).catch(function (err) {
      loadedFor = null;   // a retry on the next auth event is fine
      show($('oa-my-loading'), false);
      var off = $('oa-offline');
      off.innerHTML = '<p><strong>We could not load your postings.</strong> ' +
        'Please check your connection and reload.</p>';
      show(off, true);
      if (window.console) console.error('my postings:', err);
    });
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    if (!window.OAFB || !OAFB.enabled) {
      show($('oa-offline'), true);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });

    // Paint the likely state immediately from the sign-in hint — the same
    // instant first paint post-a-job.html does — so the page never sits blank
    // while the SDK loads.
    var hinted = OAAccounts.hint && OAAccounts.hint();
    show($('oa-needauth'), hinted !== 'in');
    show($('oa-my-loading'), hinted === 'in');

    OAAccounts.onChange(function (user) {
      if (OAAccounts.failed && OAAccounts.failed()) {
        show($('oa-needauth'), false);
        show($('oa-my-loading'), false);
        var off = $('oa-offline');
        // the shipped text in this box says "not switched on yet" — this state
        // is different: switched on, but unreachable from here
        off.innerHTML = '<p><strong>We cannot reach the postings service right now.</strong> ' +
          'If you use an ad blocker, allow <code>gstatic.com</code> and reload.</p>';
        show(off, true);
        return;
      }
      show($('oa-needauth'), !user);
      if (user) load(user);
      else {
        loadedFor = null;
        show($('oa-my-list'), false);
        show($('oa-my-empty'), false);
        show($('oa-my-loading'), false);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
