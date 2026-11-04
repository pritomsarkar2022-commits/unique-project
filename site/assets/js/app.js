/* Material interactions plus the analyzer flow. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var API = new URL('index.php', location.href).href;

  /* ---------- theme ---------- */
  var themeBtn = $('#theme-toggle'), themeIcon = $('#theme-icon');
  function paintTheme() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (themeIcon) { themeIcon.firstElementChild.setAttribute('href', '#ic-' + (dark ? 'light_mode' : 'dark_mode')); }
    if (themeBtn) { themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme'); }
  }
  paintTheme();
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('vd_theme', next); } catch (e) {}
      paintTheme();
    });
  }

  /* ---------- app bar elevation ---------- */
  var bar = $('#appbar');
  if (bar) {
    var onScroll = function () { bar.classList.toggle('raised', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- ripple ---------- */
  document.addEventListener('pointerdown', function (ev) {
    var host = ev.target.closest('.btn, .fab, .btn-icon, .quality, .chip');
    if (!host) { return; }
    var r = document.createElement('span');
    r.className = 'ripple';
    var rect = host.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    r.style.width = r.style.height = size + 'px';
    r.style.left = (ev.clientX - rect.left - size / 2) + 'px';
    r.style.top = (ev.clientY - rect.top - size / 2) + 'px';
    host.appendChild(r);
    setTimeout(function () { r.remove(); }, 520);
  });

  /* ---------- snackbar ---------- */
  function snack(text, actionLabel, action) {
    var host = $('#snackbar-host');
    if (!host) { return; }
    var el = document.createElement('div');
    el.className = 'snackbar';
    el.setAttribute('role', 'status');
    var span = document.createElement('span');
    span.className = 'body-md';
    span.style.flex = '1 1 auto';
    span.textContent = text;
    el.appendChild(span);
    if (actionLabel && action) {
      var b = document.createElement('button');
      b.className = 'btn btn-text';
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', function () { action(); close(); });
      el.appendChild(b);
    }
    host.appendChild(el);
    var t = setTimeout(close, 5200);
    function close() { clearTimeout(t); el.classList.add('out'); setTimeout(function () { el.remove(); }, 240); }
    return close;
  }
  window.vdSnack = snack;

  /* ---------- text field ---------- */
  function bindField(input) {
    var field = input.closest('.field');
    if (!field) { return; }
    var sync = function () { field.classList.toggle('has-value', input.value.trim() !== ''); };
    input.addEventListener('focus', function () { field.classList.add('is-focus'); });
    input.addEventListener('blur', function () { field.classList.remove('is-focus'); sync(); });
    input.addEventListener('input', function () { sync(); field.classList.remove('is-error'); });
    sync();
  }
  var urlInput = $('#url');
  if (urlInput) { bindField(urlInput); }

  $$('.field input').forEach(bindField);

  var pasteBtn = $('#paste-btn');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async function () {
      try {
        var text = await navigator.clipboard.readText();
        if (!text) { snack('Your clipboard is empty.'); return; }
        urlInput.value = text.trim();
        urlInput.dispatchEvent(new Event('input'));
        urlInput.focus();
        if (/^https?:\/\//i.test(text.trim())) { runAnalyze(); }
      } catch (e) {
        snack('The browser blocked clipboard access. Paste with Ctrl V.', 'How', function () {
          snack('Click the box, then press Ctrl V on Windows or Command V on a Mac.');
        });
        urlInput.focus();
      }
    });
  }

  /* ---------- state ---------- */
  var state = { job: null, sources: [], activeId: null, hls: null, expires: 0, title: '' };
  var results = $('#results'), goBtn = $('#go-btn'), goLabel = $('#go-label'), busy = $('#busy-bar'), badge = $('#job-state');

  function setBusy(on) {
    if (goBtn) { goBtn.disabled = on; }
    if (goLabel) { goLabel.textContent = on ? 'Reading that page' : 'Find the video'; }
    if (busy) { busy.classList.toggle('hide', !on); busy.classList.toggle('indeterminate', on); }
    if (badge) {
      badge.innerHTML = on
        ? '<span class="spinner" style="width:14px;height:14px"></span> Working'
        : '<svg class="ic" style="font-size:15px"><use href="#ic-bolt"/></svg> Ready';
    }
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function fmtBytes(n) {
    if (!n || n < 1) { return 'unknown'; }
    var u = ['B', 'KB', 'MB', 'GB'], i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
    return (n / Math.pow(1024, i)).toFixed(n / Math.pow(1024, i) < 10 ? 2 : 1) + ' ' + u[i];
  }
  function fmtDur(sec) {
    if (!sec && sec !== 0) { return 'unknown'; }
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
  }
  function fmtCountdown(ts) {
    var left = Math.max(0, ts - Math.floor(Date.now() / 1000));
    var m = Math.floor(left / 60), s = left % 60;
    return left <= 0 ? 'expired' : (m ? m + 'm ' : '') + s + 's left';
  }

  /* ---------- analyze ---------- */
  var form = $('#analyze-form');
  if (form) { form.addEventListener('submit', function (e) { e.preventDefault(); runAnalyze(); }); }

  function runAnalyze() {
    var url = (urlInput.value || '').trim();
    if (!url) {
      urlInput.closest('.field').classList.add('is-error');
      snack('Paste a video link first.');
      urlInput.focus();
      return;
    }
    setBusy(true);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 75000);

    fetch(API + '?r=analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
      body: 'url=' + encodeURIComponent(url),
      credentials: 'same-origin',
      signal: ctrl.signal
    }).then(function (r) {
      return r.json().catch(function () { throw new Error('This site answered with something unexpected. Reload the page and try again.'); });
    }).then(function (data) {
      clearTimeout(timer);
      setBusy(false);
      if (!data.ok) { renderError(data); return; }
      renderResult(data);
    }).catch(function (err) {
      clearTimeout(timer);
      setBusy(false);
      var msg = err && err.name === 'AbortError'
        ? 'That host is being slow. It often works on a second try.'
        : (err && err.message) || 'Network problem.';
      renderError({ error: msg, hint: 'Try again, or paste a different link from the same video.' });
    });
  }
  window.vdReanalyze = runAnalyze;

  function renderError(data) {
    var gated = data.code === 'gated';
    // A host that took the platform's whole budget gets the same treatment as a gate:
    // both hints end in "paste it into Stream address", so the field has to be open.
    var useStream = gated || data.code === 'slow';
    var page = (urlInput.value || '').trim();
    var hint = gated
      ? 'Open the video in your browser, copy its .m3u8 or file address, and use Stream address below. That save runs on your device.'
      : (data.hint || '');
    results.innerHTML =
      '<div class="notice err" style="flex-direction:column;align-items:stretch;gap:12px">' +
      '<div style="display:flex;gap:10px;align-items:flex-start">' +
      '<svg class="ic"><use href="#ic-cloud_off"/></svg>' +
      '<div><b class="label-lg">' + esc(data.error || 'No luck.') + '</b>' +
      (hint ? '<div style="margin-top:4px;opacity:.85">' + esc(hint) + '</div>' : '') +
      '</div></div>' +
      '<div class="row-flex">' +
      '<button class="btn btn-tonal btn-sm" type="button" onclick="vdReanalyze()"><svg class="ic"><use href="#ic-refresh"/></svg> Try again</button>' +
      (useStream && /^https?:\/\//i.test(page)
        ? '<a class="btn btn-outlined btn-sm" href="' + esc(page) + '" target="_blank" rel="noopener"><svg class="ic"><use href="#ic-open_in_new"/></svg> Open the player</a>'
        : '') +
      '<button class="btn btn-text btn-sm" type="button" onclick="document.getElementById(\'url\').focus()"><svg class="ic"><use href="#ic-edit"/></svg> Change link</button>' +
      '</div></div>';
    if (useStream) {
      var fold = document.querySelector('.direct');
      if (fold) { fold.open = true; }
    }
    results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function kindIcon(k) {
    return k === 'hls' ? 'high_res' : (k === 'ts' ? 'movie' : 'movie_filter');
  }

  function renderResult(data) {
    state.job = data.job;
    state.sources = data.sources || [];
    state.expires = data.expiresAt || 0;
    state.title = data.title || '';
    if (!state.sources.length) { renderError({ error: 'No file came back.', hint: 'The page shows a player, but its file would not answer.' }); return; }

    // Prefer a real mp4, then the fattest stream.
    var best = state.sources.filter(function (s) { return s.kind === 'mp4'; })[0] || state.sources[0];
    state.activeId = best.id;

    var rows = state.sources.map(function (s) { return sourceBlock(s, s.id === state.activeId); }).join('');

    results.innerHTML =
      '<div class="result-card">' +
      '<div class="result-grid">' +
      playerHtml(best) +
      '<div class="meta-panel">' +
      '<div class="row-flex" style="gap:8px">' +
      '<span class="badge"><svg class="ic" style="font-size:15px"><use href="#ic-' + kindIcon(best.kind) + '"/></svg>' + esc(sLabel(best)) + '</span>' +
      (best.height ? '<span class="badge badge-ok">' + best.height + 'p</span>' : '') +
      (best.size ? '<span class="badge">' + fmtBytes(best.size) + '</span>' : '') +
      '<span class="badge badge-warn" id="exp">' + fmtCountdown(state.expires) + '</span>' +
      '</div>' +
      '<div class="meta-title">' + esc(data.title || 'Video') + '</div>' +
      '<div>' + kv('Host page', hostOf(data.pageUrl)) +
      (best.duration ? kv('Length', fmtDur(best.duration)) : '') +
      '</div>' +
      '<div class="stack" style="gap:8px">' +
      '<div class="title-sm">Choose the file</div>' +
      '<div class="quality-list">' + rows + '</div>' +
      '</div>' +
      '<div class="actions" id="actions"></div>' +
      (data.notices && data.notices.length
        ? data.notices.map(function (n) { return '<div class="notice warn"><svg class="ic"><use href="#ic-warning"/></svg><span>' + esc(n) + '</span></div>'; }).join('')
        : '') +
      '</div></div></div>';

    $$('.quality', results).forEach(function (el) {
      el.addEventListener('click', function () { select(el.dataset.id); });
    });
    mountPlayer(best);
    select(state.activeId);
    tickExpiry();
    results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }
  function sLabel(s) {
    if (s.kind === 'hls') { return 'Video stream'; }
    if (s.kind === 'ts') { return 'Raw stream'; }
    return s.label || 'MP4 file';
  }
  var EXT_BY_MIME = {
    'video/mp4': 'MP4',
    'video/webm': 'WEBM',
    'video/x-matroska': 'MKV',
    'video/mp2t': 'TS',
    'video/quicktime': 'MOV',
    'application/vnd.apple.mpegurl': 'M3U8',
    'application/x-mpegurl': 'M3U8'
  };
  function extLabel(s) {
    if (s.kind === 'hls') { return 'saves as MP4'; }
    if (s.kind === 'ts') { return '.ts file'; }
    var byMime = EXT_BY_MIME[(s.mime || '').toLowerCase()];
    if (byMime) { return byMime; }
    var k = String(s.kind || '').toUpperCase();
    return /^(MP4|WEBM|MKV|TS|MOV)$/.test(k) ? k : '';
  }
  function kv(k, v) { return '<div class="kv"><b>' + esc(k) + '</b><span>' + esc(v || '') + '</span></div>'; }

  function sourceBlock(s, active) {
    var subs = [];
    if (s.height) { subs.push(s.height + 'p'); }
    if (s.bitrate) { subs.push(Math.round(s.bitrate / 1000) + ' kbps'); }
    if (s.size) { subs.push(fmtBytes(s.size)); }
    if (s.variants && s.variants.length > 1) { subs.push(s.variants.length + ' qualities'); }
    subs.push(extLabel(s));
    return '<label class="quality' + (active ? ' is-best' : '') + '" data-id="' + esc(s.id) + '">' +
      '<input type="radio" name="src"' + (active ? ' checked' : '') + '>' +
      '<svg class="ic muted"><use href="#ic-' + kindIcon(s.kind) + '"/></svg>' +
      '<span class="q-main"><span class="title-sm">' + esc(s.label || sLabel(s)) + '</span>' +
      '<span class="q-sub">' + esc(subs.filter(Boolean).join(' · ')) + '</span></span>' +
      (s.note ? '<svg class="ic" title="' + esc(s.note) + '" style="color:var(--md-error)"><use href="#ic-error"/></svg>' : '') +
      '</label>';
  }

  function playerHtml(s) {
    return '<div class="player" id="player-box">' +
      '<video id="player" playsinline preload="metadata"' + (s.kind === 'mp4' || s.kind === 'webm' ? ' controls' : '') + '></video>' +
      '<button class="play-badge" id="play-badge" type="button" aria-label="Play preview"><svg class="ic"><use href="#ic-play_arrow"/></svg></button>' +
      '</div>';
  }

  function mountPlayer(s) {
    var v = $('#player');
    if (!v) { return; }
    if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
    v.removeAttribute('src');
    v.load();

    if (s.kind === 'hls') {
      if (v.canPlayType('application/vnd.apple.mpegurl') !== '' && !window.Hls) {
        v.setAttribute('src', s.previewUrl);
        v.setAttribute('controls', '');
      } else {
        loadHls(function () {
          if (!window.Hls || !window.Hls.isSupported()) { fallbackDirect(s); return; }
          var hls = new window.Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 20000 });
          state.hls = hls;
          hls.on(window.Hls.Events.ERROR, function (ev, d) {
            if (!d.fatal) { return; }
            if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); }
            else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); }
          });
          hls.loadSource(s.previewUrl);
          hls.attachMedia(v);
          v.setAttribute('controls', '');
        });
      }
    } else {
      v.setAttribute('src', s.previewUrl);
      v.setAttribute('controls', '');
    }
    var badgeBtn = $('#play-badge');
    if (badgeBtn) {
      badgeBtn.addEventListener('click', function () {
        badgeBtn.style.display = 'none';
        var p = v.play();
        if (p && p.catch) { p.catch(function () { snack('The browser blocked autoplay. Press play on the video.'); }); }
      });
    }
    v.addEventListener('loadedmetadata', function () { if (badgeBtn) { badgeBtn.style.opacity = '.35'; } });
  }

  function fallbackDirect(s) {
    var v = $('#player');
    v.setAttribute('src', s.previewUrl);
    v.setAttribute('controls', '');
  }

  var hlsLoading = false, hlsQueue = [];
  function loadHls(cb) {
    if (window.Hls) { cb(); return; }
    hlsQueue.push(cb);
    if (hlsLoading) { return; }
    hlsLoading = true;
    var sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
    sc.onload = function () { var q = hlsQueue.slice(); hlsQueue = []; q.forEach(function (f) { f(); }); };
    sc.onerror = function () {
      hlsLoading = false;
      snack('The stream player did not load. The download below still works.');
    };
    document.head.appendChild(sc);
  }

  /* ---------- selection + actions ---------- */
  function select(id) {
    var s = state.sources.filter(function (x) { return x.id === id; })[0];
    if (!s) { return; }
    state.activeId = id;
    $$('.quality', results).forEach(function (el) {
      var on = el.dataset.id === id;
      el.classList.toggle('is-best', on);
      el.querySelector('input').checked = on;
    });
    mountPlayer(s);
    paintActions(s);
  }

  function paintActions(s) {
    var host = $('#actions');
    if (!host) { return; }
    var isStream = s.kind === 'hls' || s.kind === 'ts';
    var fmt = extLabel(s) || 'file';
    host.innerHTML =
      (isStream
        ? '<button class="btn btn-filled btn-lg" type="button" id="save-btn"><svg class="ic"><use href="#ic-merge"/></svg> Save as MP4</button>'
        : '<a class="btn btn-filled btn-lg" id="dl-link" href="' + esc(s.downloadUrl) + '" download><svg class="ic"><use href="#ic-download"/></svg> Download ' + esc(fmt) + '</a>') +
      '<button class="btn btn-tonal" type="button" id="copy-btn"><svg class="ic"><use href="#ic-link"/></svg> Copy link</button>' +
      (isStream
        ? '<button class="btn btn-outlined" type="button" id="raw-btn"><svg class="ic"><use href="#ic-system_update_alt"/></svg> Save stream file</button>'
        : '<a class="btn btn-outlined" href="' + esc(s.previewUrl) + '" target="_blank" rel="noopener"><svg class="ic"><use href="#ic-open_in_new"/></svg> Play in new tab</a>');

    var copy = $('#copy-btn');
    if (copy) {
      copy.addEventListener('click', function () {
        var link = s.downloadUrl;
        copyText(link).then(function () {
          snack('Link copied.', 'Show', function () { promptText(link); });
        });
      });
    }
    var dl = $('#dl-link');
    if (dl) {
      dl.addEventListener('click', function (ev) {
        // The link is left in place for a browser without script, but a file this host
        // cannot carry in one answer has to arrive in pieces, so the click is taken over.
        ev.preventDefault();
        saveInPieces(s.downloadUrl, nameFromLink(s.downloadUrl) || 'video.' + (extLabel(s) || 'bin'));
      });
    }
    var raw = $('#raw-btn');
    if (raw) {
      raw.addEventListener('click', function () {
        saveInPieces(s.downloadUrl, 'stream.ts', 'Saving the stream file. Use Save as MP4 for a normal video.');
      });
    }
    var save = $('#save-btn');
    if (save) { save.onclick = function () { saveHere(s, save); }; }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok) { promptText(text); }
    return ok;
  }
  function promptText(text) { window.prompt('Copy this link:', text); }

  /* ---------- saving a file this host hands over in pieces ---------- */
  // One answer from this host carries about 18 MB and a video is often more, so a save
  // first asks for a single byte to learn the size. A file that still fits one answer is
  // handed to the browser's own download, exactly as the php site streamed it; only a
  // larger one is assembled here from ranged pieces, which are the same bytes, in the
  // same order, as that one stream. The probe is a byte, so it answers fast enough that
  // the click that started the save is still a fresh gesture for a download or a file.
  var PIECE = 8388608;            // 8 MB, comfortably inside one answer
  var ONE_ANSWER = 15728640;      // 15 MB: under the ceiling, so one request is enough
  var IN_PAGE_LIMIT = 268435456;  // 256 MB: past this the page asks for a file to write into

  function nameFromLink(link) {
    var m = /[?&]name=([^&]+)/.exec(String(link || ''));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function totalOf(contentRange) {
    var m = /\/(\d+)\s*$/.exec(String(contentRange || ''));
    return m ? Number(m[1]) : null;
  }

  function saveWhole(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // This host runs one file request at a time, so a preview that keeps buffering takes
  // the slot the save is standing in line for.
  function quietPlayer() {
    var p = document.getElementById('player');
    if (p) {
      try { p.pause(); } catch (e) { /* a player that will not pause is not worth a save */ }
    }
  }

  function saveInPieces(url, name, note) {
    quietPlayer();
    var start = 0;
    var total = null;
    var pieces = [];
    var sink = null;
    var dismiss = null;
    var beat = null;

    // The link this asks twice is a link to this same origin, and the origin is a
    // function the platform runs one at a time: a preview playing in this tab, or a
    // second visitor, makes the answered link return an error page for a few hundred
    // milliseconds. The piece is queued, not missing.
    function ask(range, tryNo) {
      return fetch(url, { headers: { Range: range }, credentials: 'same-origin' }).then(function (r) {
        if (r.status !== 200 && r.status !== 206) {
          if ((tryNo || 0) < 3) {
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(ask(range, (tryNo || 0) + 1)); }, 500 * ((tryNo || 0) + 1));
            });
          }
          return Promise.reject(new Error('The download stopped at ' + fmtBytes(start) + '. Run the save again to pick it up from there.'));
        }
        return r.arrayBuffer().then(function (buf) {
          return { ranged: r.status === 206, buf: buf, whole: totalOf(r.headers.get('Content-Range')) };
        });
      });
    }

    function pickSink() {
      if (total <= IN_PAGE_LIMIT || !window.showSaveFilePicker) { return Promise.resolve(); }
      // Holding several hundred megabytes in the page would end the tab, so a browser
      // that lets a page write a file is asked for one; the rest keep the pieces.
      return window.showSaveFilePicker({ suggestedName: name }).then(function (handle) {
        return handle.createWritable().then(function (w) { sink = w; });
      }, function (err) {
        if (err && err.name === 'AbortError') { return Promise.reject(new Error('Save cancelled.')); }
        return null;
      });
    }

    function say() {
      dismiss = snack(note || 'Saving ' + fmtBytes(total) + ' straight to your browser, '
        + fmtBytes(PIECE) + ' at a time.');
      beat = setInterval(function () {
        snack('Still saving ' + fmtBytes(start) + ' of ' + fmtBytes(total) + '.');
      }, 4500);
    }

    function quiet() {
      if (beat) { clearInterval(beat); beat = null; }
      if (dismiss) { dismiss(); dismiss = null; }
    }

    function finish() {
      quiet();
      if (sink) {
        return sink.close().then(function () { snack('Saved ' + fmtBytes(total) + ' to ' + name + '.'); });
      }
      var href = URL.createObjectURL(new Blob(pieces, { type: 'application/octet-stream' }));
      var a = document.createElement('a');
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
      snack('Saved ' + fmtBytes(total) + ' to your downloads.');
      return null;
    }

    function step() {
      return ask('bytes=' + start + '-' + Math.min(start + PIECE - 1, total - 1)).then(function (answer) {
        if (answer.buf.byteLength === 0) { return Promise.reject(new Error('The download stopped at ' + fmtBytes(start) + '.')); }
        start += answer.buf.byteLength;
        if (sink) { return sink.write(answer.buf); }
        pieces.push(answer.buf);
        return null;
      }).then(function () {
        if (start >= total) { return finish(); }
        return step();
      });
    }

    function begin() {
      return ask('bytes=0-0').then(function (answer) {
        if (!answer.ranged) {
          // The host answered the whole file, so the save is already done.
          pieces = [answer.buf];
          total = answer.buf.byteLength;
          start = total;
          if (total === 0) { return Promise.reject(new Error('The download arrived empty.')); }
          return finish();
        }
        if (answer.whole === null) { return Promise.reject(new Error('The download has no known size.')); }
        total = answer.whole;
        if (total === 0) { return Promise.reject(new Error('The download arrived empty.')); }
        if (total <= ONE_ANSWER) { saveWhole(url, name); return null; }
        return pickSink().then(function () { say(); return step(); });
      });
    }

    return begin()['catch'](function (err) {
      quiet();
      if (sink && sink.abort) { sink.abort().catch(function () { }); }
      snack(err && err.message ? err.message : 'The download failed. Try the save again.');
    });
  }

  /* ---------- saving here, on this device ---------- */
  // The relay already hands the page a playlist whose every line is a same-origin signed
  // url, so the browser can pull the parts one at a time and write the MP4 itself. That is
  // why there is no size limit any more: the file never has to fit inside one answer from
  // this host. The server builder below stays for the device that cannot do it.
  var LOCAL = (function () {
    var self = (document.currentScript && document.currentScript.src) || 'assets/js/app.js';
    try {
      var u = new URL('mux-worker.js', new URL(self, location.href));
      var v = /[?&]v=([^&]+)/.exec(self);
      return u.href + (v ? '?v=' + v[1] : '');
    } catch (e) {
      return null;
    }
  }());

  function pickSink(name) {
    if (window.showSaveFilePicker) {
      return window.showSaveFilePicker({ suggestedName: name }).then(function (handle) {
        return handle.createWritable().then(function (w) { return w; });
      });
    }
    var parts = [];
    return Promise.resolve(new WritableStream({
      write: function (chunk) { parts.push(new Blob([chunk])); },
      close: function () {
        var href = URL.createObjectURL(new Blob(parts));
        var a = document.createElement('a');
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
        snack('Saved ' + name + ' to your downloads.');
      }
    }));
  }

  function mountSave(btn) {
    var box = document.createElement('div');
    box.className = 'save';
    box.innerHTML = '<div class="save-line"><span id="save-head">Writing here</span>' +
      '<span id="save-pct">starting</span></div>' +
      '<div class="progress"><i id="save-fill" style="width:0%"></i></div>' +
      '<div class="save-line"><span>Keep this tab open</span>' +
      '<button class="btn btn-text btn-sm" type="button" id="save-cancel">Stop</button></div>';
    btn.parentNode.insertBefore(box, btn.nextSibling);
    btn.classList.add('hide');
    var cancel = function () { };
    box.querySelector('#save-cancel').addEventListener('click', function () { cancel(); });
    function setPct(pct, text) {
      box.querySelector('#save-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
      box.querySelector('#save-pct').textContent = text;
    }
    return {
      head: function (text) { box.querySelector('#save-head').textContent = text; },
      set: setPct,
      line: function (m) {
        setPct(m.total ? Math.floor((m.done / m.total) * 100) : 0,
          m.done + ' of ' + (m.total || '?') + ' parts · ' + fmtBytes(m.bytes || 0));
      },
      stop: function (fn) { cancel = fn; },
      remove: function () { box.remove(); btn.classList.remove('hide'); btn.disabled = false; },
      keep: function (label) {
        box.remove();
        btn.disabled = false;
        btn.classList.remove('hide');
        btn.innerHTML = '<svg class="ic"><use href="#ic-download"/></svg> ' + esc(label);
      }
    };
  }

  function runLocal(job, name, ctl) {
    return pickSink(name).then(function (stream) {
      return new Promise(function (resolve, reject) {
        var worker = new Worker(LOCAL);
        var settled = false;
        ctl.stop(function () {
          settled = true;
          worker.terminate();
          if (stream.abort) { stream.abort().catch(function () { }); }
          reject({ name: 'AbortError' });
        });
        worker.onmessage = function (e) {
          var m = e.data || {};
          if (m.ev === 'progress') { ctl.line(m); }
          else if (m.ev === 'done') { settled = true; worker.terminate(); resolve(); }
          else if (m.ev === 'error') { settled = true; worker.terminate(); reject(new Error(m.message || 'The local saver stopped.')); }
        };
        worker.onerror = function () {
          if (!settled) { settled = true; worker.terminate(); reject(new Error('The local saver did not start.')); }
        };
        worker.postMessage({
          cmd: 'mux',
          stream: stream,
          manifestUrl: job.manifestUrl,
          height: job.height || null
        }, [stream]);
      });
    });
  }

  function saveHere(s, btn) {
    quietPlayer();
    var name = mp4Name(s);
    var ctl = mountSave(btn);
    btn.disabled = true;
    runLocal({ manifestUrl: s.previewUrl, height: s.height }, name, ctl).then(function () {
      ctl.remove();
      snack('Your MP4 is saved on this device.');
    })['catch'](function (err) {
      ctl.remove();
      if (err && err.name === 'AbortError') { return; }
      snack((err && err.message ? err.message : 'This device could not write it.') + ' Finishing it here instead.');
      buildMp4(s, btn, true);
    });
  }

  function mp4Name(s) {
    var base = (s.name || state.title || nameFromLink(s.downloadUrl) || 'video').replace(/\.mp4$/i, '');
    return base.slice(0, 80) + '.mp4';
  }

  /* ---------- a stream address the visitor copied from their player ---------- */
  var directBtn = $('#direct-btn'), directInput = $('#direct-url');
  if (directInput) { bindField(directInput); }
  if (directBtn) {
    directBtn.addEventListener('click', function () {
      var url = (directInput.value || '').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) {
        directInput.closest('.field').classList.add('is-error');
        snack('Paste the .m3u8 or file address from your player.');
        return;
      }
      if (/\.m3u8(\?|$)/i.test(url)) {
        quietPlayer();
        var ctl = mountSave(directBtn);
        directBtn.disabled = true;
        runLocal({ manifestUrl: url, height: null }, mp4Name({ name: 'stream' }), ctl).then(function () {
          ctl.remove();
          snack('Saved on this device.');
        })['catch'](function (err) {
          ctl.remove();
          directBtn.disabled = false;
          snack(err && err.name === 'AbortError' ? 'Stopped.' : (err.message || 'That address did not answer. A site that checks its visitors will not answer this page either.'));
        });
      } else {
        saveInPieces(url, (decodeURIComponent(url.split('/').pop().split('?')[0]) || 'video').slice(0, 80));
      }
    });
  }

  /* ---------- the server builder, for a device that cannot write the file here ---------- */
  function buildMp4(s, btn) {
    btn.disabled = true;
    var ctl = mountSave(btn);
    ctl.head('Built on this site');
    fetch(API + '?r=build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'job=' + encodeURIComponent(state.job) + '&src=' + encodeURIComponent(s.id),
      credentials: 'same-origin'
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'The MP4 builder is not answering.' }; }); })
      .then(function (d) {
        if (!d.ok) {
          ctl.remove();
          snack(d.error || 'That stream cannot be turned into an MP4 here.');
          return;
        }
        poll(d.build);
      }).catch(function () {
        ctl.remove();
        snack('Could not reach this site. Try again.');
      });

    function poll(buildId) {
      var stop = false;
      function step() {
        if (stop) { return; }
        fetch(API + '?r=progress&build=' + encodeURIComponent(buildId), { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (p) {
            if (p.error) {
              stop = true;
              ctl.remove();
              snack(p.error);
              return;
            }
            ctl.set(Number(p.percent || 0), (p.segments || '?') + ' parts');
            if (p.done) {
              stop = true;
              ctl.keep('Download MP4');
              btn.onclick = function () { saveInPieces(p.fileUrl, p.filename || 'video.mp4', 'Saving your MP4.'); };
              snack('Your MP4 is ready.', 'Save it', function () { btn.onclick(); });
            } else { setTimeout(step, 1200); }
          }).catch(function () { stop = true; ctl.remove(); });
      }
      step();
    }
  }

  /* ---------- expiry countdown ---------- */
  var tickTimer = null;
  function tickExpiry() {
    if (tickTimer) { clearInterval(tickTimer); }
    tickTimer = setInterval(function () {
      var el = $('#exp');
      if (!el) { return; }
      el.textContent = fmtCountdown(state.expires);
      if (state.expires <= Math.floor(Date.now() / 1000)) {
        clearInterval(tickTimer);
        el.classList.remove('badge-warn');
        el.classList.add('badge-err');
        snack('That link expired. Run the same page again to get a fresh one.', 'Do it', runAnalyze);
      }
    }, 1000);
  }

  /* ---------- prefill from ?url= ---------- */
  var pre = new URLSearchParams(location.search).get('url');
  if (pre && urlInput) {
    urlInput.value = pre;
    urlInput.dispatchEvent(new Event('input'));
    setTimeout(runAnalyze, 350);
  }
})();
