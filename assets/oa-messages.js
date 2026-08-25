/* ---------------------------------------------------------------------------
   Operations Academia — the reader's side of a message thread (messages.html).

   ONE THREAD, the person's own, at messages/{their uid}. The maintainer opens
   it from the Admin area's roster; this page reads it and replies.

   ONLY THE MAINTAINER CAN START ONE, and that is deliberate: a visitor who
   wants to raise something has the Feedback page, which is built for it
   (ticketed, screenshots, answered by e-mail). This direction exists so the
   maintainer can reach a registered account — about their posting, their
   candidate profile, or the site — without needing their address in a mail
   client. So a person with no thread sees "no messages" and a pointer to
   Feedback, never a compose box that would write a document the rules refuse.

   WHAT THE RULES LET THIS PAGE DO (see _firestore.rules, `messages`):
     · read its own thread and every message in it;
     · add a message whose `from` is 'user' — the rules pin that, so neither
       side can put words in the other's mouth;
     · set `userUnread` to zero (marking it read);
     · record a reply on the thread head — `lastAt`, `lastFrom: 'user'` and
       `needsAdmin: true`, which it may only RAISE. The queue on the Admin
       area cannot be emptied by the person waiting in it.
   Everything else is refused, including editing or deleting a message: a
   thread whose history either party can rewrite is not a record of anything.

   INERT UNTIL THE RULES ARE REDEPLOYED:
       firebase deploy --only firestore:rules --project operations-academia
   Until then this page says so rather than showing a bare permission-denied.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function day(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    try { return new Date(ms).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  var MAXLEN = (window.OAUsers && window.OAUsers.MAXLEN) || { body: 5000 };
  var THREADS = (window.OAUsers && window.OAUsers.THREADS) || 'messages';
  var ITEMS = (window.OAUsers && window.OAUsers.ITEMS) || 'items';

  var loadedFor = null;

  function render(db, uid, head, items) {
    var list = $('oa-msg-list');
    if (!list) return;

    if (!items.length) {
      show(list, false);
      show($('oa-msg-empty'), true);
      if (window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('messages', 0);
      return;
    }
    show($('oa-msg-empty'), false);
    show(list, true);

    list.innerHTML =
      '<ul class="oa-u-thread">' + items.map(function (m) {
        var mine = m.from === 'user';
        return '<li class="oa-u-msg is-' + (mine ? 'me' : 'them') + '">' +
          '<span class="oa-u-who">' + (mine ? 'You' : 'Operations Academia') + '</span>' +
          '<span class="oa-u-when">' + esc(day(m.t)) + '</span>' +
          '<p>' + esc(m.body).replace(/\n/g, '<br>') + '</p></li>';
      }).join('') + '</ul>' +
      '<div class="oa-msg-reply">' +
        '<label for="oa-msg-body"><strong>Reply</strong></label>' +
        '<textarea id="oa-msg-body" rows="4" maxlength="' + MAXLEN.body + '" ' +
          'placeholder="Write your reply…"></textarea>' +
        '<p><button type="button" class="button blue" id="oa-msg-send">Send reply</button> ' +
        '<span class="oa-form-msg" id="oa-msg-out" role="status"></span></p>' +
      '</div>';

    var b = $('oa-msg-send');
    if (b) b.addEventListener('click', function () { reply(db, uid, head); });

    /* THE BADGE COUNTS WHAT IS UNREAD, not how many messages the page lists —
       the one badge on this site whose number is deliberately not the number
       of cards below it, because a read conversation is not an empty one.
       Corrected here from the document already loaded, the same
       exact-where-the-data-is-already-loaded rule my-postings and alerts
       follow. */
    var unread = head && typeof head.userUnread === 'number' ? head.userUnread : 0;
    if (window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('messages', unread);

    // …and reading the page IS reading them. Best-effort: a refused write
    // leaves the badge as it was rather than lying about it.
    if (unread > 0) {
      db.collection(THREADS).doc(uid).set({ userUnread: 0 }, { merge: true })
        .then(function () {
          if (!stillOurs(uid)) return;      // signed out mid-flight
          if (window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('messages', 0);
        })['catch'](function () { /* rules not deployed — the badge stays honest */ });
    }
  }

  function reply(db, uid, head) {
    var ta = $('oa-msg-body');
    var out = $('oa-msg-out');
    var body = ta ? String(ta.value || '').trim() : '';
    if (!body) {
      if (out) { out.className = 'oa-form-msg is-err'; out.textContent = 'Write something first.'; }
      return;
    }
    if (body.length > MAXLEN.body) {
      if (out) { out.className = 'oa-form-msg is-err'; out.textContent = 'That is longer than ' + MAXLEN.body + ' characters.'; }
      return;
    }
    var btn = $('oa-msg-send');
    if (btn) btn.disabled = true;
    if (out) { out.className = 'oa-form-msg'; out.textContent = 'Sending…'; }

    var now = Date.now();
    var thread = db.collection(THREADS).doc(uid);
    thread.collection(ITEMS).add({ from: 'user', body: body, t: now })
      .then(function () {
        /* Only the three keys the rules allow an owner to touch when
           replying, and needsAdmin only ever RAISED. */
        return thread.update({ lastAt: now, lastFrom: 'user', needsAdmin: true });
      })
      .then(function () {
        if (ta) ta.value = '';
        /* Re-read so the reply appears. The uid latch must NOT be cleared to
           do it — clearing it is what would let a second click, or an auth
           echo, post the same reply again. */
        return load(db, uid).then(function () {
          var after = $('oa-msg-out');
          if (after) { after.className = 'oa-form-msg is-ok'; after.textContent = 'Sent.'; }
        });
      })['catch'](function (err) {
        var live = $('oa-msg-send');
        if (live) live.disabled = false;
        if (btn) btn.disabled = false;
        if (out) {
          out.className = 'oa-form-msg is-err';
          out.textContent = err && err.code === 'permission-denied'
            ? 'Messaging is not switched on yet — please try again later.'
            : 'Could not send (' + (err && (err.code || err.message)) + ').';
        }
      });
  }

  /* The account can change while a read is in flight — sign out, then sign in
     as someone else. Without this the older read wins: the previous person's
     thread is painted, and their unread count is written into the new
     account's menu badge. The same `stillOurs` guard loadProfile applies. */
  function stillOurs(uid) { return loadedFor === uid; }

  function load(db, uid) {
    var thread = db.collection(THREADS).doc(uid);
    return Promise.all([
      thread.get(),
      thread.collection(ITEMS).orderBy('t').get()
    ]).then(function (both) {
      if (!stillOurs(uid)) return;
      var head = both[0] && both[0].exists ? (both[0].data() || {}) : null;
      var items = [];
      both[1].forEach(function (d) { items.push(d.data() || {}); });
      show($('oa-msg-loading'), false);
      render(db, uid, head, items);
    })['catch'](function (err) {
      if (!stillOurs(uid)) return;
      loadedFor = null;                        // a retry must be possible
      show($('oa-msg-loading'), false);
      var list = $('oa-msg-list');
      show(list, true);
      if (list) {
        list.innerHTML = '<p class="oa-form-msg is-err">' +
          (err && err.code === 'permission-denied'
            ? 'Messaging is not switched on yet.'
            : 'Could not load your messages (' + esc(err && (err.code || err.message)) + ').') +
          '</p>';
      }
    });
  }

  function boot() {
    if (!window.OAAccounts || !window.OAFB || !$('oa-msg-list')) return;

    var btn = $('oa-needauth-btn');
    if (btn) btn.addEventListener('click', function () { OAAccounts.openAuth(); });

    /* Paint the likely state from the hint before Firebase resolves, so a
       signed-in reader does not see "please sign in" flash first. */
    var hinted = OAAccounts.hint && OAAccounts.hint();
    show($('oa-needauth'), hinted !== 'in');
    show($('oa-msg-loading'), hinted === 'in');

    OAAccounts.onChange(function (user) {
      if (OAAccounts.failed && OAAccounts.failed()) {
        show($('oa-needauth'), false);
        show($('oa-msg-loading'), false);
        show($('oa-offline'), true);
        return;
      }
      if (!user) {
        loadedFor = null;
        show($('oa-needauth'), true);
        show($('oa-msg-loading'), false);
        show($('oa-msg-list'), false);
        show($('oa-msg-empty'), false);
        return;
      }
      show($('oa-needauth'), false);
      if (loadedFor === user.uid) return;      // onChange fires on every auth event
      loadedFor = user.uid;
      show($('oa-msg-loading'), true);
      OAFB.ready().then(function (fb) { return load(fb.firestore(), user.uid); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
