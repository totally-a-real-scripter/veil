/*
 * Veil AI assistant panel.
 *
 * Model output is untrusted: it is rendered with a small Markdown renderer
 * that builds DOM nodes with textContent only (no innerHTML), and links are
 * restricted to http(s) and opened through the proxy.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var panel = $('ai-panel');
  var logEl = $('ai-log');
  var empty = $('ai-empty');
  var form = $('ai-form');
  var input = $('ai-input');
  var sendBtn = $('ai-send');
  var fab = $('ai-fab');
  var toolbarBtn = $('btn-ai');
  if (!panel) return;

  var messages = []; // { role: 'user'|'assistant', content }
  var controller = null;
  var enabled = false;
  var lastFocus = null;

  // ---------------------------------------------------------------- status
  var statusList = $('ai-status');
  var ISSUE_TEXT = {
    'rate limited': 'at its free limit, resting',
    'out of free credits': 'out of free credits',
    'key rejected': 'API key rejected',
    'model not found': 'model not available',
    'unreachable': 'server can\u2019t reach it',
    'too slow': 'too slow, resting',
    'provider error': 'having problems',
    'request rejected': 'rejected a request',
    'empty answer': 'returned an empty answer',
  };
  function renderStatus(s) {
    if (!statusList || !s || !Array.isArray(s.providers)) return;
    statusList.textContent = '';
    if (s.providers.length < 2 && s.providers.every(function (p) { return p.available && !p.issue; })) return;
    s.providers.forEach(function (p) {
      var li = document.createElement('li');
      var ok = p.available && !p.issue;
      li.className = ok ? 'ok' : p.available ? 'warn' : 'bad';
      var name = document.createElement('b');
      name.textContent = p.name;
      li.appendChild(name);
      li.appendChild(document.createTextNode(ok ? ' ready' : ' \u2013 ' + (ISSUE_TEXT[p.issue] || (p.available ? 'recovering' : 'resting'))));
      li.title = p.model;
      statusList.appendChild(li);
    });
  }
  function refreshStatus() {
    return fetch('/__px/ai/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { renderStatus(s); return s; })
      .catch(function () { return null; });
  }

  refreshStatus()
    .then(function (s) {
      if (!s || !s.enabled) return;
      enabled = true;
      $('ai-name').textContent = s.name || 'AI';
      $('ai-model').textContent = s.model || '';
      if (Array.isArray(s.providers) && s.providers.length > 1) {
        $('ai-model').title = 'Tries in order, switching when one hits its free limit:\n' +
          s.providers.map(function (p, i) { return (i + 1) + '. ' + p.name + ' (' + p.model + ')'; }).join('\n');
      }
      input.placeholder = 'Message ' + (s.name || 'AI');
      fab.hidden = false;
      toolbarBtn.hidden = false;
      document.dispatchEvent(new CustomEvent('veil:ai-ready'));
    })
    .catch(function () {});

  // ---------------------------------------------------------------- open/close
  function open() {
    if (!enabled) return;
    if (panel.hidden) lastFocus = document.activeElement;
    if (panel.hidden) refreshStatus();
    panel.hidden = false;
    body.classList.add('ai-open');
    autosize(); // size correctly now that the panel is visible
    setTimeout(function () { input.focus(); }, 30);
  }
  function close() {
    panel.hidden = true;
    body.classList.remove('ai-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function toggle() { panel.hidden ? open() : close(); }

  fab.addEventListener('click', open);
  toolbarBtn.addEventListener('click', toggle);
  $('ai-close').addEventListener('click', close);
  $('ai-new').addEventListener('click', function () {
    stop();
    messages = [];
    Array.prototype.slice.call(logEl.querySelectorAll('.msg')).forEach(function (n) { n.remove(); });
    empty.hidden = false;
    input.focus();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); close(); }
    // Ctrl/Cmd + J toggles the assistant.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j' && enabled) { e.preventDefault(); toggle(); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-prompt]'), function (b) {
    b.addEventListener('click', function () { ask(b.getAttribute('data-prompt')); });
  });

  // ---------------------------------------------------------------- composer
  function autosize() {
    input.style.height = 'auto';
    if (input.scrollHeight > 0) input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    sendBtn.disabled = !panel.classList.contains('busy') && !input.value.trim();
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (panel.classList.contains('busy')) { stop(); return; }
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    send(text);
  });
  autosize();

  /** Open the panel and send `text` (used by the home-screen "Ask AI" button). */
  function ask(text) {
    text = String(text || '').trim();
    if (!text || !enabled) return;
    open();
    if (panel.classList.contains('busy')) { input.value = text; autosize(); return; }
    send(text);
  }

  // ---------------------------------------------------------------- chat
  function addMessage(role, text) {
    empty.hidden = true;
    var row = document.createElement('div');
    row.className = 'msg ' + role;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user') bubble.textContent = text;
    row.appendChild(bubble);
    logEl.appendChild(row);
    scrollDown(true);
    return { row: row, bubble: bubble };
  }

  function scrollDown(force) {
    var nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120;
    if (force || nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  function setBusy(b) {
    panel.classList.toggle('busy', b);
    sendBtn.setAttribute('aria-label', b ? 'Stop generating' : 'Send');
    autosize();
  }

  function stop() {
    if (controller) controller.abort();
  }

  function send(text) {
    messages.push({ role: 'user', content: text });
    addMessage('user', text);
    respond();
  }

  function respond() {
    var view = addMessage('assistant', '');
    var typing = document.createElement('span');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>'; // static markup, no model data
    view.bubble.appendChild(typing);

    var answer = '';
    var source = '';
    var frame = 0;
    var finished = false;
    function paint(final) {
      if (final) {
        // Cancel any queued streaming frame so it can't redraw over the final
        // render (which would drop the action bar and re-add the cursor).
        finished = true;
        if (frame) cancelAnimationFrame(frame);
      }
      frame = 0;
      renderMarkdown(answer, view.bubble);
      if (!final) view.bubble.lastElementChild && view.bubble.lastElementChild.classList.add('cursor');
      scrollDown(false);
    }
    function schedule() {
      if (!frame && !finished) frame = requestAnimationFrame(function () { paint(false); });
    }

    controller = new AbortController();
    var ctrl = controller;
    setBusy(true);

    fetch('/__px/ai/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-px-req': '1' },
      body: JSON.stringify({ messages: messages }),
      signal: ctrl.signal,
    })
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            throw new Error(j.error || 'The assistant is unavailable right now.');
          });
        }
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        var failure = null;
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += decoder.decode(res.value, { stream: true });
            var nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              var line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line) continue;
              var ev;
              try { ev = JSON.parse(line); } catch (e) { continue; }
              if (typeof ev.p === 'string') source = ev.p + (typeof ev.m === 'string' ? ' \u00b7 ' + ev.m : '');
              if (typeof ev.t === 'string') { answer += ev.t; schedule(); }
              if (ev.error) failure = ev.error;
            }
            return pump();
          });
        }
        return pump().then(function () { if (failure) throw new Error(failure); });
      })
      .then(function () {
        paint(true);
        if (!answer) throw new Error('The assistant returned an empty answer.');
        messages.push({ role: 'assistant', content: answer });
        addActions(view, answer, source);
      })
      .catch(function (err) {
        var aborted = ctrl.signal.aborted;
        if (answer) {
          paint(true);
          // Keep partial answers in the conversation so follow-ups make sense.
          messages.push({ role: 'assistant', content: answer + (aborted ? '' : '\n\n[incomplete]') });
          addActions(view, answer, source);
        } else {
          typing.remove();
          // Drop the unanswered question so a retry doesn't send it twice.
          messages.pop();
        }
        if (!aborted) showError(view, err && err.message ? err.message : 'Something went wrong.', !answer);
        else if (!answer) view.row.remove();
      })
      .then(function () {
        if (controller === ctrl) controller = null;
        setBusy(false);
        refreshStatus();
      });
  }

  function showError(view, message, canRetry) {
    var box = document.createElement('div');
    box.className = 'msg-error';
    var t = document.createElement('span');
    t.textContent = message;
    box.appendChild(t);
    if (canRetry) {
      var question = null;
      // The failed question is the last user bubble.
      var users = logEl.querySelectorAll('.msg.user .bubble');
      if (users.length) question = users[users.length - 1].textContent;
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', function () {
        view.row.remove();
        if (question) { messages.push({ role: 'user', content: question }); respond(); }
      });
      box.appendChild(retry);
    }
    view.bubble.appendChild(box);
    scrollDown(true);
  }

  function addActions(view, text, source) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';
    if (source) {
      var src = document.createElement('span');
      src.className = 'msg-source';
      src.textContent = source; // textContent: provider/model names are server config, still never HTML
      bar.appendChild(src);
    }
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () { copyText(text, copy); });
    bar.appendChild(copy);
    view.bubble.appendChild(bar);
  }

  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  }

  // ---------------------------------------------------------------- markdown
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Render a safe subset of Markdown into `target` using DOM APIs only. */
  function renderMarkdown(src, target) {
    target.textContent = '';
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var i = 0;
    var para = [];
    function flushPara() {
      if (!para.length) return;
      var p = el('p');
      para.forEach(function (line, idx) {
        if (idx) p.appendChild(document.createElement('br'));
        inline(line, p);
      });
      target.appendChild(p);
      para = [];
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushPara();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++; // closing fence (or end while streaming)
        target.appendChild(codeBlock(code.join('\n'), fence[1]));
        continue;
      }
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        var hn = el(h[1].length <= 2 ? 'h3' : 'h4');
        inline(h[2], hn);
        target.appendChild(hn);
        i++;
        continue;
      }
      var li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        var ordered = /\d/.test(li[1]);
        var list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          var m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m || /\d/.test(m[1]) !== ordered) break;
          var item = el('li');
          inline(m[2], item);
          list.appendChild(item);
          i++;
        }
        target.appendChild(list);
        continue;
      }
      if (!line.trim()) { flushPara(); i++; continue; }
      para.push(line);
      i++;
    }
    flushPara();
  }

  function codeBlock(text, lang) {
    var pre = el('pre');
    var head = el('div', 'code-head');
    head.appendChild(el('span', null, lang || 'code'));
    var btn = el('button', 'code-copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', function () { copyText(text, btn); });
    head.appendChild(btn);
    pre.appendChild(head);
    pre.appendChild(el('code', null, text));
    return pre;
  }

  // Inline: `code`, **bold**, *italic* / _italic_, [text](http(s) url), bare URLs.
  var INLINE_SRC = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.source;
  function inline(text, parent) {
    // A fresh regex per call: this function recurses (bold/italic contents),
    // and a shared global regex's lastIndex would be clobbered.
    var INLINE = new RegExp(INLINE_SRC, 'g');
    var last = 0;
    var m;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.appendChild(el('code', null, m[1].slice(1, -1)));
      else if (m[2]) { var b = el('strong'); inline(m[2].slice(2, -2), b); parent.appendChild(b); }
      else if (m[3]) { var it = el('em'); inline(m[3].slice(1, -1), it); parent.appendChild(it); }
      else if (m[4]) parent.appendChild(link(m[4].slice(1, m[4].indexOf('](')), m[5]));
      else if (m[6]) parent.appendChild(link(m[6], m[6]));
      last = INLINE.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /** Links open in the proxy viewport (never directly, never javascript:). */
  function link(label, href) {
    var u;
    try { u = new URL(href); } catch (e) { return document.createTextNode(label); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return document.createTextNode(label);
    var a = el('a', null, label);
    a.href = '/p/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
    a.rel = 'noopener noreferrer';
    a.addEventListener('click', function (e) {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      if (window.Veil && window.Veil.go) window.Veil.go(u);
      if (window.innerWidth <= 640) close();
    });
    return a;
  }

  window.VeilAI = { open: open, ask: ask, isEnabled: function () { return enabled; } };
})();
