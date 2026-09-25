/* Veil UI shell: address bar, navigation controls and the page viewport. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var frame = $('frame');
  var address = $('address-input');
  var hero = $('hero-input');
  var scheme = $('scheme-icon');
  var menu = $('menu');
  var menuBtn = $('btn-menu');
  var toastEl = $('toast');

  var current = null; // real URL currently displayed
  var loadTimer = null;

  // ---- URL helpers (mirrors the server's normalisation) ----
  function normalize(input) {
    var q = String(input || '').trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) {
      try { return new URL(q); } catch (e) { /* search */ }
    }
    if (!/\s/.test(q) && /^[^/?#]+\.[a-z0-9-]{2,}(:\d+)?([/?#].*)?$/i.test(q)) {
      try { return new URL('https://' + q); } catch (e) { /* search */ }
    }
    return null; // not an address: let the server run the configured search
  }
  function encode(u) {
    return '/p/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
  }
  function decode(href) {
    try {
      var u = new URL(href, location.href);
      if (u.origin !== location.origin) return null;
      var m = /^\/p\/(https?)\/([^/?#]+)(.*)$/i.exec(u.pathname + u.search);
      if (!m) return null;
      var r = new URL(m[1] + '://' + m[2] + (m[3] || '/'));
      r.hash = u.hash;
      return r;
    } catch (e) { return null; }
  }

  // ---- view state ----
  function setView(v) {
    body.classList.toggle('view-home', v === 'home');
    body.classList.toggle('view-browse', v === 'browse');
  }

  function setAddress(u) {
    current = u;
    if (document.activeElement !== address) address.value = u ? u.href : '';
    scheme.setAttribute('data-state', !u ? 'search' : u.protocol === 'https:' ? 'secure' : 'insecure');
    scheme.title = !u ? '' : u.protocol === 'https:' ? 'Connection to the site is encrypted' : 'Connection to the site is not encrypted';
    try {
      history.replaceState(null, '', u ? '/#' + encodeURIComponent(u.href) : '/');
    } catch (e) {}
  }

  function startLoading() {
    body.classList.remove('loaded');
    void body.offsetWidth; // restart the progress animation
    body.classList.add('loading');
    clearTimeout(loadTimer);
    loadTimer = setTimeout(stopLoading, 45000);
  }
  function stopLoading() {
    clearTimeout(loadTimer);
    if (!body.classList.contains('loading')) return;
    body.classList.remove('loading');
    body.classList.add('loaded');
  }

  function go(input) {
    var u = input instanceof URL ? input : normalize(input);
    var text = input instanceof URL ? '' : String(input || '').trim();
    if (!u && !text) return;
    setView('browse');
    startLoading();
    if (u) {
      setAddress(u);
      frame.src = encode(u);
    } else {
      address.value = text;
      scheme.setAttribute('data-state', 'search');
      frame.src = '/__px/go?q=' + encodeURIComponent(text);
    }
    address.blur();
    hero.blur();
  }

  function goHome() {
    setView('home');
    stopLoading();
    frame.removeAttribute('src');
    setAddress(null);
    document.title = 'Veil';
    setTimeout(function () { hero.focus(); }, 0);
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  // ---- forms (progressive enhancement over /__px/go) ----
  $('hero-form').addEventListener('submit', function (e) { e.preventDefault(); go(hero.value); });
  $('address-form').addEventListener('submit', function (e) { e.preventDefault(); go(address.value); });
  address.addEventListener('focus', function () { address.select(); });
  address.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { address.value = current ? current.href : ''; address.blur(); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-go')); });
  });

  // ---- navigation controls ----
  $('btn-back').addEventListener('click', function () { history.back(); });
  $('btn-forward').addEventListener('click', function () { history.forward(); });
  $('btn-home').addEventListener('click', goHome);
  $('btn-reload').addEventListener('click', function () {
    if (body.classList.contains('loading')) {
      try { frame.contentWindow.stop(); } catch (e) {}
      stopLoading();
      return;
    }
    startLoading();
    try { frame.contentWindow.location.reload(); }
    catch (e) { if (current) frame.src = encode(current); }
  });
  function openInNewTab() {
    if (current) window.open(encode(current), '_blank', 'noopener');
  }
  $('btn-newtab').addEventListener('click', openInNewTab);

  // ---- menu ----
  function closeMenu() { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = menu.hidden;
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) { var first = menu.querySelector('button:not([hidden])'); if (first) first.focus(); }
  });
  document.addEventListener('click', function (e) { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && body.classList.contains('view-browse')) {
      e.preventDefault(); address.focus();
    }
  });
  menu.addEventListener('click', function (e) {
    var action = e.target && e.target.getAttribute && e.target.getAttribute('data-action');
    if (!action) return;
    closeMenu();
    if (action === 'home') goHome();
    if (action === 'newtab') openInNewTab();
    if (action === 'copy' && current) {
      (navigator.clipboard ? navigator.clipboard.writeText(current.href) : Promise.reject())
        .then(function () { toast('Address copied'); }, function () { toast('Could not copy'); });
    }
    if (action === 'clear') {
      fetch('/__px/clear', { method: 'POST', credentials: 'same-origin', headers: { 'x-px-req': '1' } })
        .then(function (r) {
          if (!r.ok) throw new Error();
          goHome();
          toast('Session data cleared');
        })
        .catch(function () { toast('Could not clear session data'); });
    }
  });

  // ---- messages from the page runtime ----
  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow) return;
    if (e.origin !== location.origin && e.origin !== 'null') return;
    var d = e.data;
    if (!d || d.__px !== 1 || typeof d.url !== 'string') return;
    if (d.type === 'unload') { startLoading(); return; }
    var u;
    try { u = new URL(d.url); } catch (err) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    setAddress(u);
    var title = typeof d.title === 'string' ? d.title.slice(0, 200) : '';
    document.title = title ? title + ' – Veil' : 'Veil';
    if (d.type === 'loaded') stopLoading();
  });

  frame.addEventListener('load', function () {
    stopLoading();
    // Non-HTML documents (images, PDFs, error pages) carry no runtime; read
    // the location directly when the frame is same-origin.
    try {
      var href = frame.contentWindow.location.href;
      var u = decode(href);
      if (u) setAddress(u);
    } catch (e) {}
  });

  // ---- initial state: /#<encoded url> restores the last page ----
  var initial = null;
  if (location.hash.length > 1) {
    try { initial = new URL(decodeURIComponent(location.hash.slice(1))); } catch (e) { initial = null; }
  }
  if (initial && /^https?:$/.test(initial.protocol)) go(initial);
  else goHome();
})();
