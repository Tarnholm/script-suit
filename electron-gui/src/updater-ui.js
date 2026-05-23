// updater-ui.js — self-contained auto-update banner for the Settlement Processor
// Suite GUI. Listens to the `update-status` IPC bridge exposed by preload (api.*)
// and shows a small bottom-right banner. Framework-agnostic so it stays
// decoupled from renderer.js. Mirrors Provincia's update flow.
(function () {
  const api = window.api;
  if (!api || !api.onUpdateStatus) return;

  let banner;
  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'update-banner';
    Object.assign(banner.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '99999',
      maxWidth: '320px', padding: '12px 14px', borderRadius: '10px',
      background: '#26262d', color: '#e5e7eb', font: '13px/1.4 system-ui, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.45)', border: '1px solid #3a3a42',
      display: 'none',
    });
    document.body.appendChild(banner);
    return banner;
  }

  function render(html, { showInstall = false } = {}) {
    const b = ensureBanner();
    b.style.display = 'block';
    b.innerHTML =
      `<div style="display:flex;align-items:flex-start;gap:10px">
         <div style="flex:1">${html}</div>
         <button id="update-banner-x" title="Dismiss"
           style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1">×</button>
       </div>` +
      (showInstall
        ? `<button id="update-banner-install"
             style="margin-top:10px;width:100%;padding:7px 0;border:none;border-radius:7px;
                    background:#fbbf24;color:#1a1a1a;font-weight:600;cursor:pointer">
             Restart &amp; Install</button>`
        : '');
    b.querySelector('#update-banner-x').onclick = () => { b.style.display = 'none'; };
    const installBtn = b.querySelector('#update-banner-install');
    if (installBtn) installBtn.onclick = () => api.updaterQuitAndInstall && api.updaterQuitAndInstall();
  }

  function handle(s) {
    if (!s) return;
    switch (s.state) {
      case 'available':
        render(`Update <b>${s.version}</b> available — downloading…`);
        break;
      case 'downloading':
        render(`Downloading update… <b>${s.percent || 0}%</b>`);
        break;
      case 'downloaded':
        render(`Update <b>${s.version}</b> ready to install.`, { showInstall: true });
        break;
      case 'error':
        render(`Update check failed: ${s.message || 'unknown error'}`);
        break;
      case 'none':
      default:
        // Stay quiet on "you're on the latest" for the silent startup check.
        break;
    }
  }

  // Recover cached status (main may have fired events before this mounted).
  if (api.getUpdateStatus) api.getUpdateStatus().then((s) => { if (s) handle(s); });
  api.onUpdateStatus(handle);
})();
