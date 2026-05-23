// updater-ui.js — auto-update UX for the Settlement Processor Suite GUI.
// Framework-agnostic (vanilla) port of Provincia's update experience so the two
// behave identically:
//   • Toasts (top-right): dedupe identical messages with an ×N counter, auto-
//     dismiss after 6s, click to dismiss. Errors red, info grey.
//   • Version label (titlebar): single-click = check for updates; double-click =
//     toggle a background watch that re-checks every 5s until one appears; a
//     progress strip underlines it while downloading.
//   • Update banner (top-center): appears when a build finished downloading —
//     "Restart & install" / "Later".
// Talks to main via the preload `api.*` bridges (electron-updater).
(function () {
  const api = window.api;
  if (!api || !api.onUpdateStatus) return;

  const PRODUCT = 'Settlement Processor Suite';

  // ── state ────────────────────────────────────────────────────────────
  let appVersion = '';
  let manualCheck = false;     // true while a user-initiated check is pending
  let watching = false;        // background watch loop active
  let watchTimer = null;
  let clickTimer = null;       // single- vs double-click disambiguation
  let downloadPct = null;      // 0..100 while downloading, else null

  // ── error → short toast (mirror of Provincia's updateErrToast) ───────
  function updateErrToast(raw) {
    const s = String(raw || '(unknown)');
    if (/latest\.yml|HttpError|\b404\b/i.test(s)) {
      return { text: "Update imminent — a new release is still uploading. Keep watching; it'll install automatically.", kind: 'info' };
    }
    const first = s.split('\n')[0].trim();
    return { text: `Update check failed: ${first.length > 140 ? first.slice(0, 137) + '…' : first}`, kind: 'error' };
  }

  // ── toasts ───────────────────────────────────────────────────────────
  let toastWrap;
  const toasts = []; // { message, kind, count, el, badge, timer }

  function ensureToastWrap() {
    if (toastWrap) return toastWrap;
    toastWrap = document.createElement('div');
    Object.assign(toastWrap.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '9999',
      display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '380px',
    });
    document.body.appendChild(toastWrap);
    return toastWrap;
  }

  function dismissToast(entry) {
    clearTimeout(entry.timer);
    if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    const i = toasts.indexOf(entry);
    if (i >= 0) toasts.splice(i, 1);
  }

  function pushToast(message, kind = 'error') {
    const existing = toasts.find(t => t.message === message && t.kind === kind);
    if (existing) {
      existing.count += 1;
      existing.badge.textContent = '×' + existing.count;
      existing.badge.style.display = '';
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => dismissToast(existing), 6000);
      return;
    }
    ensureToastWrap();
    const el = document.createElement('div');
    Object.assign(el.style, {
      padding: '10px 14px', borderRadius: '6px',
      border: `1px solid ${kind === 'error' ? '#c44' : '#888'}`,
      background: 'rgba(30,20,20,0.95)', color: '#f2e6e6',
      fontSize: '0.85rem', cursor: 'pointer',
      boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'flex-start', gap: '8px',
      font: '13px/1.4 system-ui, sans-serif',
    });
    const body = document.createElement('div');
    Object.assign(body.style, { flex: '1', maxHeight: '140px', overflowY: 'auto', overflowWrap: 'anywhere' });
    body.innerHTML = `${message}<div style="font-size:.7rem;opacity:.6;margin-top:4px">click to dismiss</div>`;
    const badge = document.createElement('span');
    Object.assign(badge.style, {
      flexShrink: '0', padding: '2px 8px', borderRadius: '999px',
      background: 'rgba(220,166,74,0.25)', border: '1px solid rgba(220,166,74,0.55)',
      color: '#dca64a', fontWeight: '700', fontSize: '0.75rem', alignSelf: 'center',
      display: 'none',
    });
    badge.textContent = '×1';
    el.appendChild(body);
    el.appendChild(badge);
    const entry = { message, kind, count: 1, el, badge, timer: null };
    el.onclick = () => dismissToast(entry);
    entry.timer = setTimeout(() => dismissToast(entry), 6000);
    toasts.push(entry);
    toastWrap.appendChild(el);
  }

  // ── "ready to install" banner ────────────────────────────────────────
  let banner;
  function showBanner(version) {
    hideBanner();
    banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '10000', padding: '10px 16px', borderRadius: '8px',
      background: 'rgba(20,40,30,0.95)', border: '1px solid #4a8a5a',
      color: '#d6f2e0', fontSize: '0.85rem', boxShadow: '0 2px 14px rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', gap: '12px',
      font: '13px/1.4 system-ui, sans-serif',
    });
    const label = document.createElement('span');
    label.textContent = `${PRODUCT} ${version} is ready to install.`;
    const restart = document.createElement('button');
    restart.textContent = 'Restart & install';
    Object.assign(restart.style, {
      padding: '4px 12px', borderRadius: '4px', border: '1px solid #7acb90',
      background: '#4a8a5a', color: '#fff', fontWeight: '600', cursor: 'pointer',
    });
    restart.onclick = () => api.updaterQuitAndInstall && api.updaterQuitAndInstall();
    const later = document.createElement('button');
    later.textContent = 'Later';
    Object.assign(later.style, {
      padding: '4px 10px', borderRadius: '4px', border: '1px solid #555',
      background: 'transparent', color: '#aaa', cursor: 'pointer',
    });
    later.onclick = hideBanner;
    banner.appendChild(label);
    banner.appendChild(restart);
    banner.appendChild(later);
    document.body.appendChild(banner);
  }
  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  // ── version label (titlebar) ─────────────────────────────────────────
  let versionEl, progressEl, watchEl;
  function mountVersionLabel() {
    if (versionEl) return;
    versionEl = document.createElement('span');
    Object.assign(versionEl.style, {
      position: 'relative', fontSize: '0.65rem', fontWeight: '400', opacity: '0.55',
      fontFamily: 'Consolas, monospace', cursor: 'pointer', padding: '0 4px',
      borderRadius: '3px', transition: 'opacity .15s, background .12s', overflow: 'hidden',
      color: '#bbb', userSelect: 'none', WebkitAppRegion: 'no-drag',
    });
    progressEl = document.createElement('span');
    Object.assign(progressEl.style, {
      position: 'absolute', left: '0', bottom: '0', height: '2px', width: '0%',
      background: '#dca64a', transition: 'width .2s linear', display: 'none',
    });
    versionEl.appendChild(progressEl);

    // "👀 watching…" indicator (with a soft pulse) while the watch loop is active.
    if (!document.getElementById('sps-updater-style')) {
      const st = document.createElement('style');
      st.id = 'sps-updater-style';
      st.textContent = '@keyframes spsWatchPulse{0%,100%{opacity:1}50%{opacity:.45}}.sps-watch-pulse{animation:spsWatchPulse 1.2s ease-in-out infinite}';
      document.head.appendChild(st);
    }
    watchEl = document.createElement('span');
    watchEl.className = 'sps-watch-pulse';
    watchEl.textContent = ' 👀 watching…';
    Object.assign(watchEl.style, { marginLeft: '5px', color: '#dca64a', fontWeight: '600', display: 'none' });
    versionEl.appendChild(watchEl);

    versionEl.onmouseenter = () => { versionEl.style.opacity = '0.95'; versionEl.style.background = 'rgba(220,166,74,0.18)'; };
    versionEl.onmouseleave = () => { versionEl.style.opacity = watching ? '0.95' : '0.55'; versionEl.style.background = ''; };
    versionEl.onclick = onVersionClick;
    versionEl.ondblclick = onVersionDblClick;

    const host = document.querySelector('.titlebar-right') || document.body;
    if (host === document.body) {
      Object.assign(versionEl.style, { position: 'fixed', right: '12px', bottom: '8px', zIndex: '9998' });
      host.appendChild(versionEl);
    } else {
      host.insertBefore(versionEl, host.firstChild);
    }
    updateVersionLabel();
  }

  function updateVersionLabel() {
    if (!versionEl) return;
    const txt = appVersion ? `v${appVersion}` : '';
    // Keep the progress strip child; set text via a leading text node.
    versionEl.firstChild && versionEl.firstChild.nodeType === 3
      ? (versionEl.firstChild.textContent = txt)
      : versionEl.insertBefore(document.createTextNode(txt), versionEl.firstChild);
    versionEl.style.opacity = watching ? '0.95' : '0.55';
    versionEl.title = downloadPct != null
      ? `Downloading update… ${downloadPct}%`
      : watching
        ? 'Watching for updates every 5s — double-click to stop'
        : 'Click to check for updates · double-click to keep watching until one appears';
    if (watchEl) watchEl.style.display = (watching && downloadPct == null) ? '' : 'none';
    if (downloadPct != null) {
      progressEl.style.display = '';
      progressEl.style.width = `${downloadPct}%`;
    } else {
      progressEl.style.display = 'none';
    }
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function onCheckUpdates() {
    if (!api.updaterCheck) return;
    manualCheck = true;
    const r = await api.updaterCheck();
    if (r && !r.ok) {
      manualCheck = false;
      const t = updateErrToast(r.reason);
      pushToast(t.text, t.kind);
    }
  }

  function stopWatch(silent) {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    watching = false;
    updateVersionLabel();
    if (!silent) pushToast('Stopped watching for updates.', 'info');
  }

  function toggleWatch() {
    if (watchTimer) { stopWatch(false); return; }
    if (!api.updaterCheck) return;
    watching = true;
    updateVersionLabel();
    pushToast('Watching for updates in the background — checking every 5s until one is found.', 'info');
    const poll = () => { try { api.updaterCheck(); } catch (e) { console.warn('[updater] watch poll failed:', e); } };
    poll();
    watchTimer = setInterval(poll, 5000);
  }

  // Distinguish single click (one-off check) from double click (toggle watch).
  function onVersionClick() {
    if (clickTimer) return;
    clickTimer = setTimeout(() => { clickTimer = null; onCheckUpdates(); }, 250);
  }
  function onVersionDblClick() {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    toggleWatch();
  }

  // ── status handler ───────────────────────────────────────────────────
  function handle(s) {
    if (!s) return;
    if (s.state === 'available') {
      pushToast(`Update ${s.version} available — downloading in background.`, 'info');
      downloadPct = 0; updateVersionLabel();
      manualCheck = false;
      if (watchTimer) stopWatch(true);
    } else if (s.state === 'downloading') {
      downloadPct = typeof s.percent === 'number' ? s.percent : 0;
      updateVersionLabel();
    } else if (s.state === 'downloaded') {
      showBanner(s.version);
      downloadPct = null; updateVersionLabel();
      manualCheck = false;
      if (watchTimer) stopWatch(true);
    } else if (s.state === 'none') {
      if (manualCheck) {
        pushToast(`You're on the latest version${appVersion ? ` (v${appVersion})` : ''}.`, 'info');
        manualCheck = false;
      }
    } else if (s.state === 'error') {
      const t = updateErrToast(s.message);
      pushToast(t.text, t.kind);
      manualCheck = false;
    }
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init() {
    mountVersionLabel();
    if (api.getAppVersion) {
      api.getAppVersion().then(v => { if (v) { appVersion = v; updateVersionLabel(); } });
    }
    // Recover cached status (main may have fired before we subscribed).
    if (api.getUpdateStatus) api.getUpdateStatus().then(s => { if (s) handle(s); });
    api.onUpdateStatus(handle);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
