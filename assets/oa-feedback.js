/* ---------------------------------------------------------------------------
   Operations Academia — feedback, and the maintainer's inbox.

   Modelled on /lit/'s feedback system. A visitor (signed in or not) leaves a
   message and up to five screenshots; the page writes ONE bounded document to
   the Firestore `feedback` collection with a page-generated ticket number, and
   a scheduled job (v2/_scraper/feedback-mailer.mjs) forwards it to the
   maintainer and sends the submitter a copy.

   The loop is closed from the repository: adding
   _feedback-resolutions/<TICKET>.md and pushing it closes the ticket and
   e-mails the submitter what was done. That file is the public record of the
   fix — which is why it must never contain the submitter's name or address
   (this repository is public; the mailer looks those up in Firestore).

   SCREENSHOT BUDGET. A Firestore document is capped at about 1 MB, and a
   base64 data URL is a third larger than the bytes it carries. Images are
   therefore re-encoded to JPEG in the browser, longest side 1400px, and the
   quality is stepped down until the whole batch fits inside SHOT_BUDGET. That
   is the difference between "attach a phone photo" working and the write
   failing with an opaque error.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var MAX_SHOTS = 5;
  var SHOT_BUDGET = 700 * 1024;    // total base64 chars across all screenshots
  var MAX_EDGE = 1400;

  var shots = [];                  // [{ name, dataUrl }]
  var pending = null;              // the shrink+encode currently in flight
  var sending = false;             // true from the moment Send is pressed

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The only screenshot shape this page ever writes: a base64 JPEG data URL
     straight out of canvas.toDataURL. Anything else in a stored `shots` array
     did not come from this form.

     That matters because the inbox below is the one place on the site where a
     STRANGER'S input is rendered to the maintainer, and `shots` is the one
     field that lands inside an HTML attribute. Anyone may create a feedback
     document — that is the point of the form — and v2/_firestore.rules bounds
     the array's LENGTH, not the contents of its items, so an entry could carry
     a double quote, break out of href="…" and run script in this origin inside
     the one session the rules trust. So: accept only this shape, drop
     everything else, and escape what survives anyway. */
  var DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

  function safeShots(arr) {
    if (!arr || typeof arr.length !== 'number') return [];
    return Array.prototype.filter.call(arr, function (u) {
      return typeof u === 'string' && u.length <= 2 * 1024 * 1024 && DATA_IMAGE.test(u);
    }).map(esc);
  }

  function say(msg, kind) {
    var m = $('fb-msg');
    if (!m) return;
    m.textContent = msg || '';
    m.className = 'oa-form-msg' + (kind ? ' is-' + kind : '');
  }

  /* Ticket shape matches /lit/'s so the two systems read the same way in an
     inbox: OA-YYMMDD-XXXX, with no I/O/0/1 to misread over the phone. */
  function makeTicket() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var buf = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    var rnd = '';
    for (var i = 0; i < 4; i++) rnd += alphabet[buf[i] % alphabet.length];
    return 'OA-' + stamp + '-' + rnd;
  }

  /* ------------------------------------------------------------ screenshots */

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('could not read ' + file.name)); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error(file.name + ' is not an image we can read')); };
        img.onload = function () {
          var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';                       // JPEG has no alpha
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /** Encode every canvas, dropping quality together until the batch fits. */
  function encodeAll(canvases) {
    var qualities = [0.82, 0.7, 0.58, 0.45, 0.35];
    for (var i = 0; i < qualities.length; i++) {
      var urls = canvases.map(function (c) { return c.toDataURL('image/jpeg', qualities[i]); });
      var total = urls.reduce(function (n, u) { return n + u.length; }, 0);
      if (total <= SHOT_BUDGET) return { urls: urls, quality: qualities[i] };
    }
    return null;
  }

  function renderThumbs() {
    var box = $('fb-thumbs');
    box.innerHTML = '';
    shots.forEach(function (s, i) {
      var fig = document.createElement('figure');
      fig.className = 'oa-thumb';
      fig.innerHTML =
        '<img src="' + s.dataUrl + '" alt="' + esc(s.name) + '">' +
        '<button type="button" aria-label="Remove ' + esc(s.name) + '">&times;</button>';
      fig.querySelector('button').addEventListener('click', function () {
        shots.splice(i, 1);
        renderThumbs();
      });
      box.appendChild(fig);
    });
  }

  function onFiles(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (!files.length || sending) return;

    // Over the cap: keep what fits, and remember the rest by NAME. The
    // encode's own say('') used to run last and wipe the warning, so the
    // extras were dropped in silence and the report went out without the
    // screenshots that mattered.
    var dropped = [];
    if (shots.length + files.length > MAX_SHOTS) {
      dropped = files.slice(Math.max(0, MAX_SHOTS - shots.length)).map(function (f) {
        return f.name || 'one image';
      });
      files = files.slice(0, MAX_SHOTS - shots.length);
      if (!files.length) {
        say('You already have ' + MAX_SHOTS + ' screenshots. Remove one to add another.', 'err');
        return;
      }
    }

    function tooMany() {
      return dropped.length
        ? dropped.join(', ') + (dropped.length > 1 ? ' were' : ' was') +
          ' not added — ' + MAX_SHOTS + ' screenshots is the limit.'
        : '';
    }

    say('Preparing the screenshots…');
    var run = Promise.all(files.map(shrink))
      .then(function (canvases) {
        var all = shots.map(function (s) { return s.canvas; }).concat(canvases);
        var enc = encodeAll(all);
        if (!enc) {
          if (!sending) say('Those images are too large even after shrinking. Please attach fewer, or crop them.', 'err');
          return;
        }
        shots = all.map(function (c, i) {
          return { name: (shots[i] && shots[i].name) || files[i - shots.length] &&
            files[i - shots.length].name || ('screenshot-' + (i + 1) + '.jpg'),
            canvas: c, dataUrl: enc.urls[i] };
        });
        renderThumbs();
        // Never blank a message the send has since written ("Sending…").
        if (!sending) say(tooMany(), dropped.length ? 'err' : '');
      })
      .catch(function (err) { if (!sending) say(err.message, 'err'); })
      .then(function () { if (pending === run) pending = null; });
    // Shrinking and encoding are asynchronous (FileReader -> decode -> canvas),
    // and `shots` is only assigned when that chain finishes. A submit landing
    // in that window used to read the OLD `shots` and file the report with no
    // screenshot at all — while reporting success. The submit handler waits on
    // this instead.
    pending = run;
  }

  /* ------------------------------------------------------------ the inbox */

  function fmtDate(v) {
    var d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
    if (!d || isNaN(+d)) return '';
    return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
  }

  var PAGE = 200;

  /* Filter in the QUERY, not after it.
     limit() is applied by the server, so fetching the newest PAGE documents of
     the whole collection and only then keeping the ones whose status matches
     the tab makes the limit a window over EVERY ticket. Past PAGE pieces of
     feedback an older ticket that is still open falls outside that window and
     vanishes from the Open tab — the maintainer reads "Nothing here" while
     unanswered reports sit in the database. */
  function fetchInbox(db, tab) {
    var col = db.collection(OAFB.col.feedback);
    if (tab === 'all') return col.orderBy('createdAt', 'desc').limit(PAGE).get();
    return col.where('status', '==', tab).orderBy('createdAt', 'desc').limit(PAGE).get()
      .catch(function (err) {
        // status+createdAt is a COMPOSITE index (v2/_firestore.indexes.json).
        // Until it is deployed Firestore answers failed-precondition; fall back
        // to the old client-side filter rather than showing an error.
        if ((err && err.code) !== 'failed-precondition') throw err;
        return col.orderBy('createdAt', 'desc').limit(PAGE).get()
          .then(function (snap) {
            return { docs: snap.docs.filter(function (d) {
              return (d.data().status || 'open') === tab;
            }) };
          });
      });
  }

  function renderInbox(db, tab) {
    var list = $('oa-inbox-list');
    list.innerHTML = '<p class="oa-hint">Loading…</p>';
    fetchInbox(db, tab)
      .then(function (snap) {
        var docs = snap.docs;
        if (!docs.length) {
          list.innerHTML = '<p class="oa-hint">Nothing here.</p>';
          return;
        }
        list.innerHTML = '';
        docs.forEach(function (d) {
          var v = d.data();
          var pics = safeShots(v.shots);
          var raw = (v.shots && v.shots.length) || 0;
          var card = document.createElement('article');
          card.className = 'oa-fb-card';
          card.innerHTML =
            '<header>' +
              '<span class="oa-ticket">' + esc(v.ticket || d.id) + '</span> ' +
              '<span class="oa-fb-status is-' + esc(v.status || 'open') + '">' +
                esc(v.status || 'open') + '</span> ' +
              '<span class="oa-hint" style="display:inline">' + esc(fmtDate(v.createdAt)) +
                (v.email ? ' &middot; ' + esc(v.email) : ' &middot; anonymous') + '</span>' +
            '</header>' +
            (pics.length
              ? '<div class="oa-thumbs">' + pics.map(function (u) {
                  return '<a href="' + u + '" target="_blank" rel="noopener"><img src="' + u + '" alt=""></a>';
                }).join('') + '</div>'
              : '') +
            // Say so rather than silently showing fewer pictures: a document
            // carrying something that is not one of our own data URLs was not
            // written by this form.
            (raw > pics.length
              ? '<p class="oa-form-msg is-err">' + (raw - pics.length) +
                ' attachment(s) on this ticket were not written by the feedback ' +
                'form and have been ignored.</p>'
              : '') +
            '<p class="oa-fb-body">' + esc(v.message || '') + '</p>' +
            (v.resolution ? '<p class="oa-fb-res"><strong>Resolution:</strong> ' +
              esc(v.resolution) + '</p>' : '') +
            '<p class="oa-hint">Close this ticket by adding ' +
              '<code>_feedback-resolutions/' + esc(v.ticket || d.id) + '.md</code> ' +
              'to the repository &mdash; the submitter is e-mailed automatically.</p>';
          list.appendChild(card);
        });
        // A truncated list must always say it is truncated, or a full page
        // reads like the end of the queue.
        if (docs.length >= PAGE) {
          var more = document.createElement('p');
          more.className = 'oa-hint';
          more.textContent = 'Showing the newest ' + PAGE +
            ' — there are older tickets than these.';
          list.appendChild(more);
        }
      })
      .catch(function (err) {
        list.innerHTML = '<p class="oa-form-msg is-err">Could not load the inbox (' +
          esc(err.code || err.message) + ').</p>';
      });
  }

  /** Which tab the maintainer is actually looking at. */
  function currentTab() {
    var on = document.querySelector('#oa-inbox-tabs .oa-tab.is-on');
    return (on && on.dataset.tab) || 'open';
  }

  function wireInbox() {
    // Only where the inbox markup exists — the Admin area since the move
    // (owner, 2026-08-21); feedback.html keeps the form and no inbox.
    if (!$('oa-inbox')) return;
    var wired = false;
    OAAccounts.onChange(function () {
      if (!OAAccounts.isAdmin()) { show($('oa-inbox'), false); return; }
      show($('oa-inbox'), true);
      OAFB.ready().then(function (fb) {
        var db = fb.firestore();
        var tabs = $('oa-inbox-tabs');
        // onChange fires on EVERY auth state change, so bind the tabs once.
        // Binding them again per change left one click firing two, then three
        // concurrent 200-document reads, all racing to write the same list.
        if (!wired) {
          wired = true;
          tabs.addEventListener('click', function (e) {
            var b = e.target.closest('.oa-tab');
            if (!b) return;
            Array.prototype.forEach.call(tabs.children, function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
            renderInbox(db, b.dataset.tab);
          });
        }
        // Re-render what is SELECTED, not always 'open' — otherwise a sign-out
        // and back in shows the open tickets under a highlighted Closed tab.
        renderInbox(db, currentTab());
      });
    });
  }

  /* -------------------------------------------------------------- wiring */

  function boot() {
    /* The inbox and the form are SEPARATE mounts since the Admin area took
       the inbox (owner, 2026-08-21): feedback.html carries the public form
       and no inbox, admin-area.html the inbox and no form. Each wires itself
       only where its markup exists, so this one file serves both pages. */
    wireInbox();

    var form = $('oa-fb-form');
    if (!form) return;
    var msg = $('fb-message');

    msg.addEventListener('input', function () {
      $('fb-count').textContent = String(msg.value.length);
    });
    $('fb-shots').addEventListener('change', onFiles);

    /* The drop zone. The real <input type=file> is visually hidden and driven
       from here, so the control can be a proper button (keyboard-reachable,
       announced) while still accepting a drag. Both paths end in onFiles, so
       there is one code path for shrinking and encoding. */
    var drop = $('fb-drop');
    if (drop) {
      drop.addEventListener('click', function () { $('fb-shots').click(); });
      ['dragenter', 'dragover'].forEach(function (e) {
        drop.addEventListener(e, function (ev) {
          ev.preventDefault();
          drop.classList.add('is-over');
        });
      });
      ['dragleave', 'drop'].forEach(function (e) {
        drop.addEventListener(e, function (ev) {
          ev.preventDefault();
          drop.classList.remove('is-over');
        });
      });
      drop.addEventListener('drop', function (ev) {
        var files = (ev.dataTransfer && ev.dataTransfer.files) || [];
        if (files.length) onFiles({ target: { files: files, value: '' } });
      });
      // Dropping an image anywhere else must not make the browser navigate to
      // it. Only cancel drags that actually carry FILES, though: cancelling
      // every drop on the page also killed dragging selected text into the
      // message box and the name/e-mail fields.
      ['dragover', 'drop'].forEach(function (e) {
        window.addEventListener(e, function (ev) {
          var types = (ev.dataTransfer && ev.dataTransfer.types) || [];
          var hasFiles = Array.prototype.indexOf.call(types, 'Files') !== -1;
          if (hasFiles && !drop.contains(ev.target)) ev.preventDefault();
        });
      });
    }

    function standDown(why) {
      var note = $('oa-offline');
      if (why) note.innerHTML = '<p>' + why + '</p>';
      show(note, true);
      form.querySelectorAll('input, textarea, button').forEach(function (n) { n.disabled = true; });
    }

    if (!window.OAFB || !OAFB.enabled) {
      standDown();
      return;
    }

    // Unlike posting a job, feedback needs no account — so the form is shown
    // to everyone. It still needs Firestore to send, though, and if the SDK
    // never loaded the button would fail only after someone had typed out
    // their whole report. Stand it down before that happens.
    OAAccounts.onChange(function () {
      if (OAAccounts.failed && OAAccounts.failed()) {
        standDown('<strong>We cannot reach the feedback service right now.</strong> ' +
          'If you use an ad blocker, allow <code>gstatic.com</code> and reload. ' +
          'Otherwise please write to ' +
          '<a href="mailto:operationsacademia@gmail.com">operationsacademia@gmail.com</a>.');
      }
    });

    // convenience: prefill from the signed-in account
    OAAccounts.onChange(function (u) {
      if (u && !$('fb-email').value) $('fb-email').value = u.email || '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = msg.value.trim();
      if (text.length < 5) {
        say('Please write a little more so we can act on it.', 'err');
        msg.focus();
        return;
      }
      var email = $('fb-email').value.trim();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        say('That does not look like an e-mail address.', 'err');
        $('fb-email').focus();
        return;
      }

      var btn = $('fb-submit');
      btn.disabled = true;

      // Send is the normal thing to press the instant a photo has been chosen,
      // and a 12 MP phone photo takes a moment to shrink. Wait for it rather
      // than filing the report with the screenshots still missing.
      if (pending) {
        say('Finishing the screenshots…');
        pending.then(send, send);
      } else {
        send();
      }

      function send() {
        sending = true;
        say('Sending…');

        var ticket = makeTicket();
        OAFB.ready().then(function (fb) {
          return fb.firestore().collection(OAFB.col.feedback).add({
            ticket: ticket,
            message: text.slice(0, 6000),
            name: $('fb-name').value.trim().slice(0, 160),
            email: email.slice(0, 200),
            shots: shots.map(function (s) { return s.dataUrl; }),
            page: (document.referrer || location.href).slice(0, 400),
            ua: navigator.userAgent.slice(0, 300),
            status: 'open',
            forwarded: false,
            createdAt: fb.firestore.FieldValue.serverTimestamp()
          });
        }).then(function () {
          $('fb-ticket').textContent = ticket;
          $('fb-done-mail').textContent = email
            ? 'We will e-mail you at ' + email + ' when it is dealt with.'
            : 'You did not leave an e-mail address, so we cannot write back — but the ' +
              'message has reached us.';
          show(form, false);
          show($('fb-done'), true);
          $('fb-done').scrollIntoView({ block: 'center', behavior: 'smooth' });
        }).catch(function (err) {
          // The report did not go anywhere, so the form is live again — and so
          // are its screenshots.
          sending = false;
          btn.disabled = false;
          var code = (err && err.code) || '';
          if (code === 'permission-denied') {
            say('Feedback is not switched on yet — the database rules have not been published.', 'err');
          } else if (/longer than|exceeds|invalid-argument/i.test(err.message || '')) {
            say('That message and its screenshots are too large to send. Please attach fewer images.', 'err');
          } else {
            say('We could not send that. Please try again in a moment.' + (code ? ' (' + code + ')' : ''), 'err');
          }
          if (window.console) console.error('feedback:', err);
        });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
