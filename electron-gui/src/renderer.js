// ══════════════════════════════════════════════
//  Apple's Settlement Processor Suite — Renderer
// ══════════════════════════════════════════════

let monacoEditor = null;
let currentFilePath = null;
let originalContent = '';
let pipelineSteps = [];
let stepStatuses = {};
let currentModData = null; // { dataDir, campaigns, selectedCampaign, displayName }

// Valid resource and terrain names for dropdowns
const VALID_RESOURCES = [
  'amber', 'camels', 'coal', 'copper', 'cotton', 'dates', 'dyes', 'elephants',
  'fish', 'flax', 'fruits', 'gemstones', 'glass', 'gold', 'grain', 'hemp',
  'honey', 'horses', 'incense', 'iron', 'lead', 'livestock', 'marble',
  'olive_oil', 'papyrus', 'perfumes', 'pitch', 'pottery', 'purple_dye',
  'salt', 'sheep', 'silk', 'silver', 'slave_trade', 'slaves', 'spices',
  'stone', 'sulphur', 'timber', 'tin', 'wild_animals', 'wine',
];

const VALID_TERRAIN = [
  'alpine', 'arid', 'continental', 'desert', 'floodplains_delta', 'forest',
  'grassland', 'hills', 'karst_terrain', 'mediterranean', 'mountain_valley',
  'mountains', 'oceanic', 'plateau', 'river_valley', 'small_islands_and_rocky_coast',
  'steppe', 'sub_artic', 'temperate', 'tropical', 'wetlands',
  'irrigation_aquifer', 'irrigation_lake', 'irrigation_oasis', 'irrigation_river',
  'irrigation_springs', 'rivertrade',
  'base_port_level_0', 'base_port_level_1', 'base_port_level_2', 'base_port_level_3',
];

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  pipelineSteps = await window.api.getPipelineSteps();
  const projectRoot = await window.api.getProjectRoot();

  const parts = projectRoot.replace(/\\/g, '/').split('/');
  document.getElementById('project-path').textContent = parts[parts.length - 1] || projectRoot;

  initTabs();
  initModSource();
  initPipeline();
  initEditor();
  initCompare();
  initMaster();
  setupEventListeners();
});

// ══════════════════════════════════════
//  TAB NAVIGATION (Segmented Control)
// ══════════════════════════════════════

function initTabs() {
  // Main titlebar segments
  document.querySelectorAll('.titlebar-center .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('.titlebar-center .segment').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      seg.classList.add('active');
      document.getElementById(`tab-${seg.dataset.tab}`).classList.add('active');

      if (seg.dataset.tab === 'editor' && monacoEditor) {
        setTimeout(() => monacoEditor.layout(), 50);
      }
    });
  });
}

// ══════════════════════════════════════
//  MOD SOURCE / IMPORT
// ══════════════════════════════════════

async function initModSource() {
  document.getElementById('btn-choose-mod').addEventListener('click', chooseMod);
  document.getElementById('btn-load-files').addEventListener('click', loadModFiles);
  document.getElementById('campaign-select').addEventListener('change', (e) => {
    if (currentModData) currentModData.selectedCampaign = e.target.value;
  });

  // Restore last session
  const saved = await window.api.getModPrefs();
  if (saved) {
    applyModData(saved);
  }
}

async function chooseMod() {
  const result = await window.api.selectModFolder();
  if (!result) return;

  if (result.error) {
    setImportStatus(result.error, 'error');
    return;
  }

  applyModData(result);
  setImportStatus(`Found ${result.campaigns.length} campaign${result.campaigns.length > 1 ? 's' : ''}`, 'info');
}

function applyModData(data) {
  currentModData = data;

  // Update button label
  const btn = document.getElementById('btn-choose-mod');
  document.getElementById('mod-source-label').textContent = data.displayName;
  btn.classList.add('loaded');

  // Populate campaign dropdown
  const select = document.getElementById('campaign-select');
  select.innerHTML = '';
  data.campaigns.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === data.selectedCampaign) opt.selected = true;
    select.appendChild(opt);
  });

  // Show campaign row
  document.getElementById('campaign-row').style.display = 'flex';
}

async function loadModFiles() {
  if (!currentModData) return;

  const campaign = document.getElementById('campaign-select').value;
  setImportStatus('Importing...', 'info');

  try {
    const result = await window.api.loadModFiles(currentModData.dataDir, campaign);

    if (!result) {
      setImportStatus('Import failed — no result returned.', 'error');
      return;
    }

    if (result.error) {
      setImportStatus(`Import error: ${result.error}`, 'error');
      return;
    }

    if (result.criticalMissing && result.criticalMissing.length > 0) {
      const missingList = result.criticalMissing.join(', ');
      setImportStatus(`Imported ${result.copied.length} files. Missing: ${missingList}`, 'error');

      await showSubmodDialog(result.copied, result.criticalMissing, campaign);
    } else {
      setImportStatus(`Imported ${result.copied.length} files from ${campaign}`, 'success');
      document.getElementById('btn-save-to-mod').disabled = false;
    }

    // Refresh editor file list + building tree
    if (typeof loadConfigFiles === 'function') await loadConfigFiles();
    if (typeof loadBuildingTree === 'function') await loadBuildingTree();
  } catch (err) {
    setImportStatus(`Import error: ${err.message || err}`, 'error');
    console.error('Import error:', err);
  }
}

async function showSubmodDialog(alreadyCopied, missingFiles, submodCampaign) {
  const overlay = document.getElementById('submod-overlay');
  const missingListEl = document.getElementById('submod-missing-list');
  const statusEl = document.getElementById('submod-status');
  const parentInfoEl = document.getElementById('submod-parent-info');

  // Populate missing files list
  missingListEl.innerHTML = missingFiles.map(f =>
    `<div class="submod-file-item missing">${f}</div>`
  ).join('');

  statusEl.textContent = '';
  parentInfoEl.textContent = '';

  let parentData = null;

  overlay.classList.add('visible');

  return new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.remove('visible');
      resolve();
    };

    overlay.onclick = async (e) => {
      const target = e.target;

      // Close on Skip or clicking the backdrop itself
      if (target.id === 'btn-submod-skip') { cleanup(); return; }
      if (target === overlay) { cleanup(); return; }

      if (target.id === 'btn-submod-browse') {
        const result = await window.api.selectParentMod();
        if (!result) return;
        if (result.error) {
          statusEl.textContent = result.error;
          return;
        }

        parentData = result;
        parentInfoEl.textContent = result.displayName;
        document.getElementById('btn-submod-fill').disabled = false;
      }

      if (target.id === 'btn-submod-fill') {
        if (!parentData) return;
        statusEl.textContent = 'Importing missing files...';
        target.disabled = true;

        const fillResult = await window.api.loadParentModFiles(
          parentData.dataDir, missingFiles
        );

        if (fillResult.stillMissing.length > 0) {
          statusEl.textContent = `Filled ${fillResult.filled.length} files. Still missing: ${fillResult.stillMissing.join(', ')}`;
          missingListEl.innerHTML = missingFiles.map(f => {
            const wasFilled = fillResult.filled.includes(f);
            return `<div class="submod-file-item ${wasFilled ? 'filled' : 'missing'}">${f} ${wasFilled ? '(from parent)' : '(not found)'}</div>`;
          }).join('');
          target.disabled = false;
        } else {
          statusEl.textContent = `All ${fillResult.filled.length} missing files imported from parent mod.`;
          missingListEl.innerHTML = missingFiles.map(f =>
            `<div class="submod-file-item filled">${f} (from parent)</div>`
          ).join('');
          setImportStatus(`Imported ${alreadyCopied.length + fillResult.filled.length} files (${fillResult.filled.length} from parent)`, 'success');
          document.getElementById('btn-save-to-mod').disabled = false;
          setTimeout(cleanup, 1500);
        }

        if (typeof loadConfigFiles === 'function') await loadConfigFiles();
        if (typeof loadBuildingTree === 'function') await loadBuildingTree();
      }
    };
  });
}

async function saveBackToMod() {
  if (!currentModData) {
    appendConsole('No mod loaded. Import files first.\n', 'stderr');
    return;
  }

  const campaign = document.getElementById('campaign-select').value;
  const modName = currentModData.displayName || 'mod';

  const confirmed = confirm(
    `Save processed files back to the mod?\n\n` +
    `Mod: ${modName}\n` +
    `Campaign: ${campaign}\n\n` +
    `Files: descr_strat.txt (campaign) + descr_regions.txt (base, if updated)\n` +
    `Backups of originals will be created in _backups folders.\n\n` +
    `This will OVERWRITE the mod files. Continue?`
  );

  if (!confirmed) return;

  appendConsole(`\nSaving to mod: ${modName} / ${campaign}\n`, 'info');
  appendConsole(`  dataDir: ${currentModData.dataDir}\n`, 'stdout');

  try {
    const result = await window.api.saveBackToMod(currentModData.dataDir, campaign);

    if (result.success) {
      const files = result.saved ? result.saved.join(', ') : 'descr_strat.txt';
      appendConsole(`Saved: ${files}. Backups in _backups folders.\n`, 'success');
    } else {
      appendConsole(`Save failed: ${result.error}\n`, 'stderr');
    }
  } catch (err) {
    appendConsole(`Save error: ${err.message || err}\n`, 'stderr');
  }
}

function setImportStatus(msg, type = 'info') {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className = `import-status ${type}`;
}

// ══════════════════════════════════════
//  PIPELINE TAB
// ══════════════════════════════════════

function initPipeline() {
  const container = document.getElementById('pipeline-steps');

  // Keep the sidebar-header, add step cards after it
  const header = container.querySelector('.sidebar-header');

  pipelineSteps.forEach((step, i) => {
    stepStatuses[step.id] = 'idle';

    const card = document.createElement('div');
    card.className = 'step-card';
    card.id = `step-${step.id}`;
    card.innerHTML = `
      <input type="checkbox" class="step-checkbox" data-step="${step.id}" checked>
      <div class="step-dot" style="background: ${step.color}"></div>
      <div class="step-info">
        <div class="step-name">${step.name}</div>
        <div class="step-script">${step.script}</div>
      </div>
      <div class="step-status idle" id="status-${step.id}"></div>
    `;

    // Add import CSV button + status for hidden_resources step
    if (step.id === 'hidden_resources') {
      const importRow = document.createElement('div');
      importRow.className = 'step-import-col';

      const importBtn = document.createElement('button');
      importBtn.className = 'step-import-btn';
      importBtn.textContent = 'Import CSV';
      importBtn.title = 'Import hidden resources spreadsheet (CSV)';

      const importStatus = document.createElement('div');
      importStatus.className = 'step-import-status';
      importStatus.id = 'csv-import-status';

      function formatImportTime(ms) {
        const d = new Date(ms);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }

      function updateCsvStatus(mtime) {
        importStatus.textContent = `Imported ${formatImportTime(mtime)}`;
        importStatus.classList.add('imported');
      }

      // Check existing CSV on load
      window.api.checkHiddenResourcesCsv().then(info => {
        if (info.exists) {
          updateCsvStatus(info.importedAt);
        } else {
          importStatus.textContent = 'No CSV imported';
        }
      });

      importBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const result = await window.api.importHiddenResourcesCsv();
        if (result.success) {
          appendConsole(`Imported CSV: ${result.name}\n`, 'info');
          updateCsvStatus(result.importedAt);
        } else if (result.error) {
          appendConsole(`CSV import failed: ${result.error}\n`, 'stderr');
        }
      });

      importRow.appendChild(importBtn);
      importRow.appendChild(importStatus);
      card.querySelector('.step-info').appendChild(importRow);
    }

    // Add import-list button for the civic step
    if (step.id === 'civic') {
      const importRow = document.createElement('div');
      importRow.className = 'step-import-col';
      const importBtn = document.createElement('button');
      importBtn.className = 'step-import-btn';
      importBtn.textContent = 'Import List';
      importBtn.title = 'Import a civic buildings list (.txt) — replaces config/civic_buildings.txt';
      importBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const result = await window.api.importCivicList();
        if (result.success) {
          appendConsole(`Imported civic list: ${result.name}\n`, 'info');
        } else if (result.error) {
          appendConsole(`Civic list import failed: ${result.error}\n`, 'stderr');
        }
      });
      importRow.appendChild(importBtn);
      card.querySelector('.step-info').appendChild(importRow);
    }

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('step-checkbox')) return;
      if (e.target.classList.contains('step-import-btn')) return;
      document.querySelectorAll('.step-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });

    container.appendChild(card);
  });

  // Console sub-segments (Output / Changelog)
  document.querySelectorAll('.pipeline-main .segmented-control .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('.pipeline-main .segmented-control .segment').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.console-panel').forEach(p => p.classList.remove('active'));
      seg.classList.add('active');
      document.getElementById(`console-${seg.dataset.console}`).classList.add('active');
    });
  });

  // Buttons — both run checked steps with chaining
  document.getElementById('btn-run-all').addEventListener('click', () => {
    // Select all before running
    document.querySelectorAll('.step-checkbox').forEach(cb => { cb.checked = true; });
    runPipeline();
  });
  document.getElementById('btn-run-selected').addEventListener('click', () => runPipeline());
  document.getElementById('btn-clear-console').addEventListener('click', clearConsole);
  document.getElementById('btn-save-to-mod').addEventListener('click', saveBackToMod);

  // Select all / none
  document.getElementById('btn-select-all').addEventListener('click', () => {
    document.querySelectorAll('.step-checkbox').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('btn-select-none').addEventListener('click', () => {
    document.querySelectorAll('.step-checkbox').forEach(cb => { cb.checked = false; });
  });
}

async function runPipeline() {
  const stepIds = [];

  // Always respect checkboxes
  document.querySelectorAll('.step-checkbox:checked').forEach(cb => {
    stepIds.push(cb.dataset.step);
  });

  if (stepIds.length === 0) return;

  // Reset statuses and clear stale output files
  stepIds.forEach(id => setStepStatus(id, 'idle'));
  clearConsole();
  await window.api.clearStaleOutput();
  setRunning(true);

  const chaining = stepIds.length > 1;
  await window.api.backupConfig();
  appendConsole(`Running ${stepIds.length} step(s)${chaining ? ' (chained)' : ''}\n`, 'info');

  let failed = false;
  for (const stepId of stepIds) {
    const step = pipelineSteps.find(s => s.id === stepId);
    setStepStatus(stepId, 'running');
    appendConsole(`\n${step.name}\n`, 'info');

    const result = await window.api.runStep(stepId);

    if (result.success) {
      setStepStatus(stepId, 'done');
      appendConsole(`${step.name}: Done\n`, 'success');

      // Chain: feed this step's output into the next step's input
      if (stepId === 'hidden_resources') {
        await window.api.chainRegionsOutput();
      } else {
        await window.api.chainStratOutput();
      }
    } else {
      setStepStatus(stepId, 'error');
      appendConsole(`${step.name}: Failed (exit code ${result.code})\n`, 'stderr');
      if (result.error) appendConsole(`Error: ${result.error}\n`, 'stderr');
      failed = true;
      break;
    }
  }

  // Restore original config files (processed output is in processed_output/)
  await window.api.restoreConfig();

  setRunning(false);
  if (currentModData) {
    document.getElementById('btn-save-to-mod').disabled = false;
  }
  appendConsole('\nPipeline complete.\n', 'info');

  // Run validation
  appendConsole('\nValidating output...\n', 'info');
  const validation = await window.api.validateOutput();
  if (validation.errors.length > 0) {
    appendConsole(`\n${validation.errors.length} ERROR(S):\n`, 'stderr');
    validation.errors.forEach(e => appendConsole(`  ${e.message}\n`, 'stderr'));
  }
  if (validation.warnings.length > 0) {
    appendConsole(`\n${validation.warnings.length} WARNING(S):\n`, 'stderr');
    validation.warnings.forEach(w => appendConsole(`  ${w.message}\n`, 'stderr'));
  }
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    appendConsole('No issues found.\n', 'success');
  }

  await loadChangelogs();
}

function setStepStatus(stepId, status) {
  stepStatuses[stepId] = status;
  const el = document.getElementById(`status-${stepId}`);
  const card = document.getElementById(`step-${stepId}`);
  if (!el || !card) return;

  el.className = `step-status ${status}`;
  card.classList.remove('running', 'done', 'error');
  if (status !== 'idle') card.classList.add(status);

  const icons = { idle: '', running: '\u25CF', done: '\u2713', error: '\u2717' };
  el.textContent = icons[status] || '';
}

function setRunning(isRunning) {
  document.getElementById('btn-run-all').disabled = isRunning;
  document.getElementById('btn-run-selected').disabled = isRunning;
}

function clearConsole() {
  document.getElementById('console-text').innerHTML = '';
  document.getElementById('changelog-text').innerHTML = '';
}

function appendConsole(text, type = 'stdout') {
  const pre = document.getElementById('console-text');
  const span = document.createElement('span');
  span.className = `log-${type}`;
  span.textContent = text;
  pre.appendChild(span);
  pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
}

async function loadChangelogs() {
  const output = await window.api.getLatestOutput();
  if (!output) return;

  const changelogPre = document.getElementById('changelog-text');
  changelogPre.innerHTML = '';

  // Collect all changelog files
  const changelogFiles = [];

  for (const [name, value] of Object.entries(output.contents)) {
    // Skip top-level changelog files (unified/combined) — only use step-specific ones
    if (Array.isArray(value)) {
      for (const file of value) {
        if (file.includes('changelog')) {
          changelogFiles.push({ path: `${output.path}/${name}/${file}` });
        }
      }
    }
  }

  if (changelogFiles.length === 0) {
    changelogPre.appendChild(Object.assign(document.createElement('span'), { className: 'log-info', textContent: 'No changelog files found.\n' }));
    return;
  }

  // Parse all changelogs and group by settlement
  const settlementChanges = {}; // settlement -> [{source, change}]
  const stepLabels = {
    'hidden_resources': 'Hidden Resources',
    'farms': 'Farms', 'heavy_industry': 'Heavy Industry', 'sanitation': 'Health',
    'mics': 'Military', 'homelands': 'Homelands', 'rural_exploits': 'Rural Exploits',
    'urban_exploits': 'Urban Exploits', 'port_authority': 'Ports',
    'settlement_processor': 'Core Buildings', 'slave_placer': 'Slaves',
    'port_mercenaries': 'Port Mercenaries',
  };

  // Separate mercenary changelog files from settlement changelog files
  const mercFiles = [];
  const settlementFiles = [];
  for (const cf of changelogFiles) {
    if (cf.path.toLowerCase().includes('port_mercenaries')) {
      mercFiles.push(cf);
    } else {
      settlementFiles.push(cf);
    }
  }

  // --- Parse settlement changelogs (existing logic) ---
  for (const cf of settlementFiles) {
    const content = await window.api.readOutputFile(cf.path);
    if (!content || !content.trim()) continue;

    let stepName = 'General';
    const pathLower = cf.path.toLowerCase();
    for (const [key, label] of Object.entries(stepLabels)) {
      if (key !== 'general' && pathLower.includes(key)) { stepName = label; break; }
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('===') || trimmed.startsWith('---')) continue;

      let settlement = null;
      let change = trimmed;

      let m = trimmed.match(/^Settlement\s+'([^']+)':\s*(.+)/);
      if (m) { settlement = m[1]; change = m[2]; }

      if (!settlement) {
        m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*\(([^)]+)\):\s*(.+)/);
        if (m) { settlement = m[1]; change = m[3]; }
      }

      if (!settlement) {
        m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*\|\s*(.+)/);
        if (m) { settlement = m[1].trim(); change = m[2]; }
      }

      if (!settlement) {
        m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(Assigned|Changed|Added|Removed|Unchanged)\s+(.+)/i);
        if (m) { settlement = m[1]; change = `${m[2]} ${m[3]}`; }
      }

      if (!settlement) {
        m = trimmed.match(/^Added\s+\w+\s+to\s+([A-Za-z_][A-Za-z0-9_-]*)\s+/);
        if (m) { settlement = m[1]; change = trimmed; }
      }

      if (change && /unchanged/i.test(change)) continue;

      if (settlement) {
        if (!settlementChanges[settlement]) settlementChanges[settlement] = [];
        settlementChanges[settlement].push({ step: stepName, change });
      }
    }
  }

  // --- Render settlement changes ---
  const settlements = Object.keys(settlementChanges).sort();

  if (settlements.length === 0 && mercFiles.length === 0) {
    changelogPre.appendChild(Object.assign(document.createElement('span'), { className: 'log-info', textContent: 'No changes found.\n' }));
    return;
  }

  if (settlements.length > 0) {
    const summary = document.createElement('span');
    summary.className = 'log-info';
    summary.textContent = `${settlements.length} settlements changed\n\n`;
    changelogPre.appendChild(summary);

    for (const settlement of settlements) {
      const changes = settlementChanges[settlement];

      const header = document.createElement('span');
      header.className = 'log-info';
      header.textContent = settlement;
      changelogPre.appendChild(header);

      for (const { step, change } of changes) {
        const prefix = document.createElement('span');
        prefix.className = 'log-stdout';
        prefix.textContent = `  [${step}] `;
        changelogPre.appendChild(prefix);

        renderColorizedChange(changelogPre, change);
      }
      changelogPre.appendChild(document.createTextNode('\n'));
    }
  }

  // --- Render mercenary changelogs with category headers ---
  if (mercFiles.length > 0) {
    // Sort files so they render in order (1_direct, 2_partial, 3_failed, 4_missing)
    mercFiles.sort((a, b) => a.path.localeCompare(b.path));

    for (const cf of mercFiles) {
      const content = await window.api.readOutputFile(cf.path);
      if (!content || !content.trim()) continue;

      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          changelogPre.appendChild(document.createTextNode('\n'));
          continue;
        }

        // Section headers (=== ... ===)
        if (trimmed.startsWith('===')) {
          const hdr = document.createElement('span');
          hdr.className = 'log-info';
          hdr.style.fontWeight = 'bold';
          hdr.textContent = '\n' + trimmed + '\n';
          changelogPre.appendChild(hdr);
          continue;
        }

        // Parse "Name: Action ..." lines
        const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)/);
        if (m) {
          const name = document.createElement('span');
          name.className = 'log-info';
          name.textContent = m[1];
          changelogPre.appendChild(name);

          const sep = document.createElement('span');
          sep.className = 'log-stdout';
          sep.textContent = '  ';
          changelogPre.appendChild(sep);

          renderColorizedChange(changelogPre, m[2]);
          changelogPre.appendChild(document.createTextNode('\n'));
        } else {
          // Plain text lines
          const span = document.createElement('span');
          span.className = 'log-stdout';
          span.textContent = trimmed + '\n';
          changelogPre.appendChild(span);
        }
      }
    }
  }
}

// Helper: render a change string with colorized segments
function renderColorizedChange(container, change) {
  const parts = change.split('; ');
  parts.forEach((part, pi) => {
    if (pi > 0) {
      const sep = document.createElement('span');
      sep.className = 'log-stdout';
      sep.textContent = '; ';
      container.appendChild(sep);
    }
    const seg = document.createElement('span');
    const pl = part.toLowerCase();
    if (pl.startsWith('unmatched')) {
      seg.className = 'log-warning';
    } else if (pl.startsWith('removed')) {
      seg.className = 'log-removed';
    } else if (pl.startsWith('added') || pl.startsWith('assigned')) {
      seg.className = 'log-added';
    } else if (pl.startsWith('changed from')) {
      const m = part.match(/^(Changed from\s+)(.+?)(\s+to\s+)(.+)$/i);
      if (m) {
        seg.className = 'log-stdout';
        seg.textContent = m[1];
        container.appendChild(seg);
        const oldPart = document.createElement('span');
        oldPart.className = 'log-removed';
        oldPart.textContent = m[2];
        container.appendChild(oldPart);
        const toPart = document.createElement('span');
        toPart.className = 'log-stdout';
        toPart.textContent = m[3];
        container.appendChild(toPart);
        const newPart = document.createElement('span');
        newPart.className = 'log-added';
        newPart.textContent = m[4];
        container.appendChild(newPart);
        return;
      }
      seg.className = 'log-stdout';
    } else {
      seg.className = 'log-stdout';
    }
    seg.textContent = part;
    container.appendChild(seg);
  });
}

// ══════════════════════════════════════
//  CONFIG EDITOR TAB
// ══════════════════════════════════════

let editorMode = 'simple'; // 'simple' or 'code'
let currentSimpleFields = []; // parsed fields for current script

// Script config definitions — what to extract and how to label it
const SCRIPT_CONFIGS = {
  'farms.py': [
    { section: 'How Farm Assignment Works', desc: '', variable: null, type: 'info',
      infoText: `Each settlement gets <b>one farm building</b> based on its terrain type and available resources.<br><br>
<b>Step 1:</b> Check if the settlement tier is high enough (minimum tier below)<br>
<b>Step 2:</b> Look at the region's terrain (forest, steppe, desert, etc.)<br>
<b>Step 3:</b> Check conditions within that terrain (climate, resources present)<br>
<b>Step 4:</b> Assign the matching farm building — first rule that matches wins<br><br>
The <b>bump rule</b> adds extra tier requirements to higher-level buildings.` },
    { section: 'Bump Rule', desc: 'How many extra tiers a settlement needs above the building\'s minimum. Example: bump of 1 means a building requiring "town" actually needs "large_town". Set to 0 to disable.',
      variable: 'BUMP_AMOUNT', type: 'number', label: 'Extra tiers required' },
    { section: 'Bump Exception — Fertility', desc: 'If a region\'s fertility is at least this value, the bump rule is skipped and normal settlement requirements apply. High-fertility regions get farm buildings more easily.',
      variable: 'FERTILITY_SKIP_BUMP', type: 'number', label: 'Skip bump when fertility >=' },
    { section: 'Farm Building Chains', desc: 'All building chains that this script manages.',
      variable: 'FARM_CHAINS', type: 'list', label: 'Farm chains' },
    { section: 'Terrain → Farm Rules', desc: 'Which farm building gets assigned for each terrain type. Rules are checked top to bottom — first match wins. Use the dropdowns to change assignments.',
      variable: null, type: 'terrain_rules' },
  ],
  'heavy_industry.py': [
    { section: 'How Heavy Industry Works', desc: '', variable: null, type: 'info',
      infoText: `Each settlement can get <b>one heavy industry building</b> (smith, mine, quarry, etc.) based on its resources.<br><br>
<b>Step 1:</b> For each building, check which of its required resources the region has<br>
<b>Step 2:</b> Calculate a score: <b>resource amount × resource score</b><br>
<b>Step 3:</b> The building with the highest score wins — if it meets the minimum score threshold<br>
<b>Step 4:</b> If multiple buildings tie, the tie-breaker priority list decides<br><br>
The <b>bump rule</b> means heavy industry buildings need a settlement one level bigger than normal.` },
    { section: 'Minimum Score Threshold', desc: 'A building must score at least this much to be assigned. Score = resource amount × resource score. Raise this to be stricter, lower it to assign buildings more easily.',
      variable: null, type: 'inline_num', label: 'Minimum score to qualify',
      pattern: /val\s*>=\s*(\d+)/,
      replacePattern: /(val\s*>=\s*)\d+/ },
    { section: 'Resource Scores', desc: 'How valuable each resource is. This is multiplied by the resource amount in the region to calculate the building score.',
      variable: 'RESOURCE_SCORES', type: 'dict_num', label: 'Resource scoring' },
    { section: 'Building Requirements', desc: 'Which resources each building needs. The building\'s score is the best (amount × score) from its resource list.',
      variable: 'BUILDING_TO_RESOURCES', type: 'building_reqs' },
    { section: 'Tie-Breaker Priority', desc: 'When two or more buildings have the exact same score, the one listed first here wins.',
      variable: 'EXPLICIT_HEAVY_IND_TIE_BREAKER_ORDER', type: 'list', label: 'Priority order (first = preferred)' },
    { section: 'Heavy Industry Set', desc: 'Only buildings in this set get the bump rule applied. Remove a building from this set to let it use normal settlement requirements.',
      variable: 'HEAVY_IND_BUILDINGS', type: 'set', label: 'Buildings affected by bump' },
    { section: 'Bump Rule', desc: 'Heavy industry buildings need a settlement this many levels higher than normal. Example: bump of 1 means a building requiring "town" actually needs "large_town". Set to 0 to disable.',
      variable: null, type: 'inline_num', label: 'Extra levels required',
      pattern: /SETTLEMENT_LEVEL_ORDER\[min\(idx\s*\+\s*(\d+)/,
      replacePattern: /(SETTLEMENT_LEVEL_ORDER\[min\(idx\s*\+\s*)\d+/ },
  ],
  'sanitation_healers.py': [
    { section: 'How Health Buildings Work', desc: '', variable: null, type: 'info',
      infoText: `Each settlement can get either a <b>health building</b> or a <b>hospital</b>.<br>
The rules below are checked in order — <b>first match wins</b>.<br><br>
<b>Additional rules:</b><br>
&nbsp;&nbsp;&nbsp;Villages never get health buildings (tier 0)<br>
&nbsp;&nbsp;&nbsp;Towns must have a <b>trader</b> building present to qualify<br>
&nbsp;&nbsp;&nbsp;Building level = settlement tier - 1 (Large Town gets tier 1 building)` },
    { section: 'Assignment Rules', desc: 'Checked in order — first match wins. Resources listed below each rule.',
      variable: null, type: 'health_rules' },
    { section: 'Buildings To Remove', desc: 'All building names that get stripped before reassignment. Prevents duplicates from old assignments.',
      variable: 'SCRUB', type: 'list', label: 'Buildings removed before processing' },
  ],
  'mics.py': [
    { section: 'How Military Buildings Work', desc: '', variable: null, type: 'info',
      infoText: `Each settlement gets either a <b>Military Industrial Complex (MIC)</b> or a <b>Garrison</b>, depending on two things:<br><br>
<b>1. Is it the faction's capital?</b><br>
&nbsp;&nbsp;&nbsp;Yes → always gets <b>MIC</b> (the strong military building)<br><br>
<b>2. Does the region have enough native culture?</b><br>
&nbsp;&nbsp;&nbsp;If the faction's own culture makes up enough of the region's population → <b>MIC</b><br>
&nbsp;&nbsp;&nbsp;If not enough native culture → <b>Garrison</b> (weaker military building)<br><br>
The threshold below controls what "enough" means.` },
    { section: 'Native Culture Threshold', desc: 'If the faction\'s culture is at least this % of the region\'s population, the settlement gets a MIC. Below this, it gets a Garrison instead.',
      variable: 'THRESHOLD', type: 'number', label: 'Minimum culture % for MIC' },
    { section: 'MIC Building Levels', desc: 'Which MIC building to place at each settlement tier. Higher tiers = bigger settlements = stronger buildings.',
      variable: 'BUILDINGS_HIGH', type: 'dict_select', label: 'Settlement tier → MIC building',
      keyLabels: { '1': 'Town (tier 1)', '2': 'Large Town (tier 2)', '3': 'City (tier 3)', '4': 'Large City (tier 4)' },
      options: ['mic_1', 'mic_2', 'mic_3', 'mic_4'] },
    { section: 'Garrison Building Levels', desc: 'Which Garrison building to place at each settlement tier. Used when native culture is below the threshold.',
      variable: 'BUILDINGS_LOW', type: 'dict_select', label: 'Settlement tier → Garrison building',
      keyLabels: { '1': 'Town (tier 1)', '2': 'Large Town (tier 2)', '3': 'City (tier 3)' },
      options: ['garrison', 'garrison+1', 'garrison+2'] },
    { section: 'Factions Without Military', desc: 'These factions get ALL military buildings removed. Typically only the slave faction.',
      variable: 'NO_MILITARY_FACTIONS', type: 'set', label: 'Excluded factions' },
  ],
  'rural_exploits.py': [
    { section: 'How Rural Exploits Work', desc: '', variable: null, type: 'info',
      infoText: `Each settlement can get <b>one rural exploit building</b> (wine, olive, timber, horses, etc.) based on what resources the region has.<br><br>
<b>Step 1:</b> Check which resources the region has (e.g. wine, horses, timber)<br>
<b>Step 2:</b> Map each resource to its building (wine → wine_industry, horses → horse_trainer)<br>
<b>Step 3:</b> If multiple qualify, the priority ranking below decides which one wins<br><br>
The <b>bump rule</b> adds extra tier requirements unless the region has a large amount of the resource.` },
    { section: 'Resource → Building Mapping', desc: 'Which building gets assigned for each resource. If a region has this resource, it can get this building.',
      variable: 'RESOURCE_TO_BUILDING', type: 'dict_select', label: 'Resource → Building',
      options: ['wine_industry', 'olive_cultivation', 'dates_cultivation', 'agroforestry',
        'papyrus_maker', 'honey_industry', 'hunters', 'horse_trainer',
        'timber_industry', 'camels_trade', 'hemp_cultivation'] },
    { section: 'Priority Ranking', desc: 'When a region qualifies for multiple rural buildings, the one listed first here wins.',
      variable: 'RANKED_EXPLOIT', type: 'list', label: 'Priority order (first = preferred)' },
    { section: 'Bump Rule — Skip Threshold', desc: 'If a region has at least this much of the resource, the bump rule is skipped and normal settlement requirements apply. Lower = more buildings skip bump.',
      variable: null, type: 'inline_num', label: 'Skip bump when resource amount >=',
      pattern: /resource_amt\s*>=\s*(\d+)/,
      replacePattern: /(resource_amt\s*>=\s*)\d+/ },
    { section: 'Bump Rule — Extra Tiers', desc: 'When bump is active, the settlement must be this many tiers higher than the building minimum. Set to 0 to disable bump entirely.',
      variable: null, type: 'inline_num', label: 'Extra tiers required',
      pattern: /bumped_tier\s*=\s*min_tier\s*\+\s*(\d+)/,
      replacePattern: /(bumped_tier\s*=\s*min_tier\s*\+\s*)\d+/ },
  ],
  'urban_exploits.py': [
    { section: 'How Urban Exploits Work', desc: '', variable: null, type: 'info',
      infoText: `Each settlement can get <b>one urban exploit building</b> (silk trader, glass production, dyes, etc.) based on what trade resources the region has.<br><br>
<b>Step 1:</b> Check if the settlement meets the minimum tier<br>
<b>Step 2:</b> Check which trade resources the region has<br>
<b>Step 3:</b> If multiple qualify, the priority ranking decides which one wins<br><br>
The <b>bump rule</b> adds extra tier requirements when the resource amount is low. Regions with plenty of a resource get the building more easily.` },
    { section: 'Minimum Settlement Tier', desc: 'Settlements below this tier get no urban exploit building at all.',
      variable: 'URBAN_EXPLOIT_MIN_TIER', type: 'number', label: 'Minimum tier required' },
    { section: 'Priority Ranking', desc: 'When a region qualifies for multiple urban buildings, the one listed first here wins.',
      variable: 'URBAN_EXPLOIT_PRIORITY_ORDER', type: 'list', label: 'Priority order (first = preferred)' },
    { section: 'Bump Rule', desc: 'When a region has less than this amount of the resource, the bump rule kicks in and the settlement needs to be one level bigger than normal. Above this amount, normal requirements apply.',
      variable: null, type: 'inline_num', label: 'Apply bump when resource amount is below',
      pattern: /resource_amount\s*<\s*([\d.]+)/,
      replacePattern: /(resource_amount\s*<\s*)[\d.]+/ },
  ],
  'port_authority.py': [
    { section: 'How Port Assignment Works', desc: '', variable: null, type: 'info',
      infoText: `Each settlement can get a <b>port building</b> if the region has the right resources.<br><br>
<b>How it decides:</b><br>
&nbsp;&nbsp;&nbsp;1. Check if the region has a <b>base_port_level</b> resource (coastal) or <b>rivertrade</b> resource (river)<br>
&nbsp;&nbsp;&nbsp;2. The base_port_level number determines the maximum port tier allowed<br>
&nbsp;&nbsp;&nbsp;3. The settlement tier determines which port level gets built<br><br>
<b>Port upgrade path:</b><br>
&nbsp;&nbsp;&nbsp;Coastal: <b>port</b> → <b>shipwright</b> → <b>dockyard</b><br>
&nbsp;&nbsp;&nbsp;River: <b>river_port1</b> → <b>river_port2</b><br><br>
The <b>bump rule</b> only applies to river ports — coastal ports use normal settlement requirements.` },
    { section: 'Port Building Names', desc: 'All building names this script recognizes as port buildings. It will only touch these chains.',
      variable: 'PORT_BUILDING_NAMES', type: 'list', label: 'Managed port buildings' },
    { section: 'Settlement Tier Order', desc: 'The progression of settlement levels. Used to calculate the bump (shifting one level up).',
      variable: 'SETTLEMENT_LEVEL_ORDER', type: 'list', label: 'Settlement level order' },
    { section: 'Bump Rule (River Ports Only)', desc: 'River ports need a settlement this many levels higher than normal. Coastal ports are NOT affected. Set to 0 to disable bump for river ports.',
      variable: null, type: 'inline_num', label: 'Extra levels required for river ports',
      pattern: /SETTLEMENT_LEVEL_ORDER\[min\(idx\s*\+\s*(\d+)/,
      replacePattern: /(SETTLEMENT_LEVEL_ORDER\[min\(idx\s*\+\s*)\d+/ },
  ],
  'settlement_processor.py': [
    { section: 'How Core Buildings Work', desc: '', variable: null, type: 'info',
      infoText: `This script assigns the <b>core infrastructure buildings</b> that every settlement needs — walls, roads, markets, and treasury.<br><br>
For each building chain, it finds the <b>highest level</b> the settlement qualifies for based on its tier, then applies the bump rule.` },
    { section: 'Assignment Rules', desc: 'How each building chain is assigned.',
      variable: null, type: 'settlement_rules' },
    { section: 'No Defenses Regions', desc: 'These regions get no defenses building assigned. Add regions that should be unfortified.',
      variable: 'NO_DEFENSES_REGIONS', type: 'set', label: 'Regions without defenses' },
    { section: 'Managed Building Chains', desc: 'The building chains this script manages. It assigns the highest allowed level of each chain to every settlement.',
      variable: 'MANAGED_CHAINS', type: 'set', label: 'Building chains managed', readonly: true },
    { section: 'Bump Rule', desc: 'Settlements must be this many tiers above the building\'s minimum to qualify. Example: bump of 1 means a building requiring "town" actually needs "large_town". Set to 0 to disable.',
      variable: null, type: 'inline_num', label: 'Extra tiers required',
      pattern: /settlement_tier\s*>=\s*\(min_tier\s*\+\s*(\d+)\)/,
      replacePattern: /(settlement_tier\s*>=\s*\(min_tier\s*\+\s*)\d+/ },
    { section: 'Town Trader Override', desc: 'Towns that have a resource with high enough quantity automatically get the market forced to "trader" level.',
      variable: 'TRADER_OVERRIDE_QTY', type: 'number', label: 'Minimum resource quantity needed' },
    { section: 'Trader Override — Allowed Resources', desc: 'Only these resources count for the trader override. Leave empty = ALL resources count.',
      variable: 'TRADER_OVERRIDE_RESOURCES', type: 'set', label: 'Resources that trigger trader (empty = all)' },
  ],
  'slave_placer.py': [
    { section: 'How Slave Placement Works', desc: '', variable: null, type: 'info',
      infoText: `This script adds a <b>slaves resource</b> to every region that doesn't already have one.<br><br>
<b>What it does:</b><br>
&nbsp;&nbsp;&nbsp;1. Reads the map_regions.tga to find valid pixel coordinates for each region<br>
&nbsp;&nbsp;&nbsp;2. Checks which regions already have a slaves resource in descr_strat.txt<br>
&nbsp;&nbsp;&nbsp;3. For regions without slaves, picks an unused coordinate and adds a slave resource line<br><br>
This ensures every region has access to slave labor as a baseline resource. The script runs last in the pipeline since it only adds resources, not buildings.` },
  ],
  'homelands.py': [
    { section: 'How Homeland Assignment Works', desc: '', variable: null, type: 'info',
      infoText: `This script decides whether each settlement is in its faction's <b>homeland</b>, and assigns government buildings accordingly.<br><br>
<b>How homeland is determined:</b><br>
&nbsp;&nbsp;&nbsp;1. Each faction has <b>homeland hidden resources</b> defined in the EDB (export_descr_buildings.txt) via alias entries<br>
&nbsp;&nbsp;&nbsp;2. Each region has <b>hidden resources</b> defined in descr_regions.txt<br>
&nbsp;&nbsp;&nbsp;3. If the region's hidden resources <b>overlap</b> with the faction's homeland resources → it's a homeland region` },
    { section: 'Homeland Rules', desc: 'What happens based on homeland status.',
      variable: null, type: 'homeland_rules' },
    { section: 'Ignored Factions', desc: 'These factions are skipped entirely — no government building changes.',
      variable: 'IGNORED_OWNERS', type: 'set', label: 'Factions to skip' },
    { section: 'Colony Building Levels', desc: 'Colony building tiers recognized by this script. Order matters — later = higher tier.',
      variable: 'COLONY_LEVELS', type: 'list', label: 'Colony levels (lowest to highest)' },
  ],
};

async function initEditor() {
  await loadMonaco();
  await loadScriptFiles();
  await loadConfigFiles();
  await loadBuildingTree();
  await loadProfiles();
  initEditorModeToggle();

  document.getElementById('btn-save-file').addEventListener('click', saveCurrentFile);
  document.getElementById('btn-save-as').addEventListener('click', saveFileAs);
  document.getElementById('btn-revert').addEventListener('click', revertFile);
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
  document.getElementById('building-search').addEventListener('input', filterBuildings);
}

function initEditorModeToggle() {
  document.querySelectorAll('#editor-mode-toggle .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#editor-mode-toggle .segment').forEach(s => s.classList.remove('active'));
      seg.classList.add('active');
      setEditorMode(seg.dataset.mode);
    });
  });
}

function setEditorMode(mode) {
  editorMode = mode;
  const monacoEl = document.getElementById('monaco-container');
  const simpleEl = document.getElementById('simple-editor');

  if (mode === 'code') {
    monacoEl.style.display = '';
    simpleEl.classList.remove('active');
    if (monacoEditor) {
      // Sync any simple editor changes back to Monaco before showing
      if (currentSimpleFields.length > 0) {
        const updatedContent = applySimpleEdits(monacoEditor.getValue());
        if (updatedContent !== monacoEditor.getValue()) {
          monacoEditor.setValue(updatedContent);
        }
      }
      monacoEditor.layout();
    }
  } else {
    monacoEl.style.display = 'none';
    simpleEl.classList.add('active');
    if (monacoEditor && currentFilePath && currentFilePath.endsWith('.py')) {
      renderSimpleEditor(monacoEditor.getValue());
    }
  }
}

function renderSimpleEditor(content) {
  const simpleEl = document.getElementById('simple-editor');
  const fileName = currentFilePath ? currentFilePath.replace(/\\/g, '/').split('/').pop() : '';
  const config = SCRIPT_CONFIGS[fileName];

  if (!config) {
    simpleEl.innerHTML = '<div class="simple-editor-empty">No simple editor available for this file. Use Code mode.</div>';
    currentSimpleFields = [];
    return;
  }

  currentSimpleFields = [];
  let html = '';

  for (const field of config) {
    const parsed = parseField(content, field);
    if (!parsed) continue;

    currentSimpleFields.push({ ...field, ...parsed });

    html += `<div class="se-section">`;
    html += `<div class="se-section-header">
      <span class="se-section-title">${field.section}</span>
      <span class="se-section-desc">${field.desc}</span>
    </div>`;

    if (field.type === 'number' || field.type === 'inline_num') {
      html += `<table class="se-dict-table">
        <thead><tr><th>${field.label}</th><th>Value</th></tr></thead>
        <tbody>
          <tr>
            <td class="se-dict-key">${field.variable || field.label}</td>
            <td><input type="number" class="se-dict-input" data-var="${field.variable || field.label}" data-type="${field.type}" value="${parsed.value}" step="1"></td>
          </tr>
        </tbody>
      </table>`;
    } else if (field.type === 'terrain_rules') {
      html += renderTerrainRulesTable(parsed.value);
    } else if (field.type === 'health_rules') {
      html += renderHealthRules(parsed.value);
    } else if (field.type === 'settlement_rules') {
      html += renderSettlementRules();
    } else if (field.type === 'homeland_rules') {
      html += renderHomelandRules();
    } else if (field.type === 'info') {
      html += `<div class="se-info-box">${field.infoText}</div>`;
    } else if (field.type === 'building_reqs') {
      html += renderBuildingReqsTable(parsed.value, parsed.scores);
    } else if (field.type === 'dict_num') {
      html += `<table class="se-dict-table">
        <thead><tr><th>Resource</th><th>Score</th></tr></thead>
        <tbody>`;
      for (const [key, val] of Object.entries(parsed.value)) {
        html += `<tr>
          <td class="se-dict-key">${key}</td>
          <td><input type="number" class="se-dict-input" data-var="${field.variable}" data-key="${key}" value="${val}" step="any"></td>
        </tr>`;
      }
      html += `</tbody></table>`;
    } else if (field.type === 'dict_select') {
      const keyLabels = field.keyLabels || {};
      const options = field.options || [];
      const headerParts = (field.label || 'Key → Value').split('→').map(s => s.trim());
      const headerLeft = headerParts[0] || 'Key';
      const headerRight = headerParts[1] || 'Value';
      html += `<table class="se-dict-table se-dict-table-left">
        <thead><tr><th>${headerLeft}</th><th>${headerRight}</th></tr></thead>
        <tbody>`;
      for (const [key, val] of Object.entries(parsed.value)) {
        const displayKey = keyLabels[key] || key;
        const optionsHtml = options.map(o =>
          `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`
        ).join('');
        html += `<tr>
          <td class="se-dict-key">${displayKey}</td>
          <td><select class="se-dict-select" data-var="${field.variable}" data-key="${key}">${optionsHtml}</select></td>
        </tr>`;
      }
      html += `</tbody></table>`;
    } else if (field.type === 'dict_str') {
      const keyLabels = field.keyLabels || {};
      html += `<table class="se-dict-table se-dict-table-left">
        <thead><tr><th>Settlement</th><th>Building</th></tr></thead>
        <tbody>`;
      for (const [key, val] of Object.entries(parsed.value)) {
        const displayKey = keyLabels[key] || key;
        html += `<tr>
          <td class="se-dict-key">${displayKey}</td>
          <td><input type="text" class="se-dict-input" style="width:140px;text-align:left" data-var="${field.variable}" data-key="${key}" value="${val}"></td>
        </tr>`;
      }
      html += `</tbody></table>`;
    } else if (field.type === 'list') {
      html += `<div class="se-list">`;
      parsed.value.forEach((item, i) => {
        html += `<span class="se-list-item">${item}</span>`;
      });
      html += `</div>`;
    } else if (field.type === 'set') {
      const readonly = field.readonly;
      const tagsHtml = parsed.value.map(v => {
        if (readonly) {
          return `<span class="se-tag" style="cursor:default">${v}</span>`;
        }
        return `<span class="se-tag" draggable="true" data-val="${v}">${v}<span class="se-tag-remove" data-val="${v}">&times;</span></span>`;
      }).join('');
      if (readonly) {
        html += `<div class="se-list">${tagsHtml}</div>`;
      } else {
        html += `<div class="se-tag-selector" data-var="${field.variable}" data-field-type="set">
          <div class="se-tag-list">${tagsHtml}</div>
          <input type="text" class="se-tag-input" placeholder="Type and press Enter to add" data-var="${field.variable}">
        </div>`;
      }
    }

    html += `</div>`;
  }

  simpleEl.innerHTML = html;

  // Listen for changes on inputs and selects
  simpleEl.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', () => {
      markSimpleModified();
    });
  });

  // Set tag inputs — Enter to add
  simpleEl.querySelectorAll('.se-tag-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const val = input.value.trim().toLowerCase();
      if (!val) return;
      const tagList = input.closest('.se-tag-selector').querySelector('.se-tag-list');
      const existing = Array.from(tagList.querySelectorAll('.se-tag')).map(t => t.dataset.val);
      if (existing.includes(val)) { input.value = ''; return; }
      const tag = document.createElement('span');
      tag.className = 'se-tag';
      tag.draggable = true;
      tag.dataset.val = val;
      tag.innerHTML = `${val}<span class="se-tag-remove" data-val="${val}">&times;</span>`;
      tag.querySelector('.se-tag-remove').onclick = (ev) => { ev.stopPropagation(); tag.remove(); markSimpleModified(); };
      tagList.appendChild(tag);
      input.value = '';
      markSimpleModified();
    });
  });

  // Set tag remove buttons
  simpleEl.querySelectorAll('.se-tag-selector[data-field-type="set"] .se-tag-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.parentElement.remove();
      markSimpleModified();
    });
  });
}

function parseField(content, field) {
  const lines = content.split('\n');

  if (field.type === 'info') {
    return { value: true };
  }

  if (field.type === 'health_rules') {
    return parseHealthRules(content);
  }

  if (field.type === 'homeland_rules') {
    return parseHomelandRules(content);
  }

  if (field.type === 'settlement_rules') {
    return { value: true };
  }

  if (field.type === 'terrain_rules') {
    return parseTerrainRules(content);
  }

  if (field.type === 'building_reqs') {
    return parseBuildingReqs(content);
  }

  if (field.type === 'inline_num') {
    const match = content.match(field.pattern);
    if (!match) return null;
    return { value: parseFloat(match[1]), raw: match[0] };
  }

  if (field.pattern && (field.type === 'set' || field.type === 'list')) {
    const match = content.match(field.pattern);
    if (!match) return null;
    const items = match[1].split(',').map(s => s.trim().replace(/["']/g, '').replace(/#.*/, '').trim()).filter(Boolean);
    return { value: items, raw: match[0] };
  }

  if (field.type === 'number') {
    const re = new RegExp(`${field.variable}\\s*=\\s*([\\d.]+)`);
    const match = content.match(re);
    if (!match) return null;
    return { value: parseFloat(match[1]), raw: match[0] };
  }

  if (field.type === 'dict_num' || field.type === 'dict_str' || field.type === 'dict_select') {
    // Find the variable assignment and extract the dict
    const re = new RegExp(`${field.variable}\\s*=\\s*\\{`);
    const match = content.match(re);
    if (!match) return null;

    const startIdx = content.indexOf(match[0]);
    let braceCount = 0;
    let dictStr = '';
    for (let i = startIdx + match[0].length - 1; i < content.length; i++) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') braceCount--;
      dictStr += content[i];
      if (braceCount === 0) break;
    }

    // Parse key-value pairs
    const dict = {};
    const pairRe = /["']([^"']+)["']\s*:\s*([^,}\n]+)/g;
    let pairMatch;
    while ((pairMatch = pairRe.exec(dictStr)) !== null) {
      const val = pairMatch[2].trim().replace(/["']/g, '');
      dict[pairMatch[1]] = field.type === 'dict_num' ? parseFloat(val) : val;
    }

    // Also handle int keys like {1: "garrison", ...}
    const intPairRe = /(\d+)\s*:\s*["']([^"']+)["']/g;
    while ((pairMatch = intPairRe.exec(dictStr)) !== null) {
      dict[pairMatch[1]] = pairMatch[2];
    }

    return { value: dict, raw: dictStr, startIdx };
  }

  if (field.type === 'list') {
    const re = new RegExp(`${field.variable}\\s*=\\s*\\[`);
    const match = content.match(re);
    if (!match) return null;

    const startIdx = content.indexOf(match[0]);
    let bracketCount = 0;
    let listStr = '';
    for (let i = startIdx + match[0].length - 1; i < content.length; i++) {
      if (content[i] === '[') bracketCount++;
      if (content[i] === ']') bracketCount--;
      listStr += content[i];
      if (bracketCount === 0) break;
    }

    const items = [];
    const itemRe = /["']([^"']+)["']/g;
    let itemMatch;
    while ((itemMatch = itemRe.exec(listStr)) !== null) {
      items.push(itemMatch[1]);
    }

    return { value: items, raw: listStr, startIdx };
  }

  if (field.type === 'set') {
    // Try {value} syntax first
    const re = new RegExp(`${field.variable}\\s*=\\s*\\{`);
    const match = content.match(re);

    if (match) {
      const startIdx = content.indexOf(match[0]);
      let braceCount = 0;
      let setStr = '';
      for (let i = startIdx + match[0].length - 1; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        if (content[i] === '}') braceCount--;
        setStr += content[i];
        if (braceCount === 0) break;
      }

      const items = [];
      const itemRe = /["']([^"']+)["']/g;
      let itemMatch;
      while ((itemMatch = itemRe.exec(setStr)) !== null) {
        items.push(itemMatch[1]);
      }

      return { value: items, raw: setStr, startIdx };
    }

    // Try set() syntax (empty set)
    const reEmpty = new RegExp(`${field.variable}\\s*=\\s*set\\(\\)`);
    const matchEmpty = content.match(reEmpty);
    if (matchEmpty) {
      return { value: [], raw: matchEmpty[0], startIdx: content.indexOf(matchEmpty[0]) };
    }

    return null;
  }

  return null;
}

// ── Health Rules parser/renderer (sanitation_healers) ──

function parseHealthRules(content) {
  // Parse med_boosters and water_res sets
  const medMatch = content.match(/med_boosters\s*=\s*\{([^}]+)\}/);
  const waterMatch = content.match(/water_res\s*=\s*\{([^}]+)\}/);
  const med = medMatch ? medMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean) : [];
  const water = waterMatch ? waterMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean) : [];

  // Parse NAME_MAP
  const nameMapMatch = content.match(/NAME_MAP\s*=\s*\{([\s\S]*?)\n\}/);
  const healthLevels = {};
  const hospitalLevels = {};

  if (nameMapMatch) {
    const healthMatch = nameMapMatch[1].match(/"health"\s*:\s*\{([^}]+)\}/);
    const hospMatch = nameMapMatch[1].match(/"hospitals"\s*:\s*\{([^}]+)\}/);
    if (healthMatch) {
      const re = /(\d+)\s*:\s*"(\w+)"/g;
      let m;
      while ((m = re.exec(healthMatch[1])) !== null) healthLevels[m[1]] = m[2];
    }
    if (hospMatch) {
      const re = /(\d+)\s*:\s*"(\w+)"/g;
      let m;
      while ((m = re.exec(hospMatch[1])) !== null) hospitalLevels[m[1]] = m[2];
    }
  }

  return {
    value: {
      rules: [
        { num: 1, condition: 'Has perfumes AND any medicinal booster', chain: 'hospitals',
          condChecks: [
            { label: 'Requires', value: 'perfumes', fixed: true },
            { label: 'Plus any of', values: med, editable: true, varName: 'med_boosters' },
          ]},
        { num: 2, condition: 'Has any water resource', chain: 'health',
          condChecks: [
            { label: 'Any of', values: water, editable: true, varName: 'water_res' },
          ]},
        { num: 3, condition: 'Has perfumes (no medicinal or water)', chain: 'hospitals',
          condChecks: [
            { label: 'Requires', value: 'perfumes', fixed: true },
          ]},
      ],
      healthLevels,
      hospitalLevels,
    }
  };
}

function renderHealthRules(data) {
  const { rules, healthLevels, hospitalLevels } = data;

  const tierLabels = { '1': 'Town / Large Town', '2': 'City', '3': 'Large City', '4': 'Huge City', '5': '—' };

  let html = '<div class="se-terrain-rules">';

  // Rules
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Decision Rules</span>
      <span class="se-terrain-count">${rules.length} rules</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">
      <div class="se-terrain-priority-note">Rules checked top to bottom — first match wins</div>`;

  for (const rule of rules) {
    html += `<div class="se-terrain-chain">
      <div class="se-terrain-chain-num">${rule.num}</div>
      <div class="se-terrain-chain-body">
        <div class="se-terrain-chain-top">`;

    for (const check of rule.condChecks) {
      if (check.fixed) {
        html += `<div class="se-cond-row">
          <span class="se-cond-type" style="min-width:auto;border:none;background:none;color:var(--accent);padding-left:0">${check.label}</span>
          <span class="se-tag" style="cursor:default">${check.value}</span>
        </div>`;
      } else if (check.values) {
        const tagsHtml = check.values.map(v =>
          `<span class="se-tag" draggable="true" data-val="${v}">${v}<span class="se-tag-remove" data-val="${v}">&times;</span></span>`
        ).join('');
        const optionsHtml = VALID_RESOURCES.map(o => `<option value="${o}">${o}</option>`).join('');
        html += `<div class="se-cond-row" style="flex-wrap:wrap">
          <span class="se-cond-type" style="min-width:auto;border:none;background:none;color:var(--accent);padding-left:0">${check.label}</span>
          <div class="se-tag-selector">
            <div class="se-tag-list">${tagsHtml}</div>
            <select class="se-tag-add"><option value="">+ add...</option>${optionsHtml}</select>
          </div>
        </div>`;
      }
    }

    html += `</div>
        <div class="se-terrain-chain-assign">
          <span class="se-terrain-assign-label">assign</span>
          <select class="se-terrain-select" style="color:var(--text-primary)" disabled>
            <option selected>${rule.chain === 'health' ? 'Health chain' : 'Hospital chain'}</option>
          </select>
        </div>
      </div>
    </div>`;
  }

  html += `</div></div>`;

  // Health levels table
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Health Chain Levels</span>
      <span class="se-terrain-count">cisterns → city_plumbing</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">`;
  for (const [tier, building] of Object.entries(healthLevels)) {
    html += `<div class="se-terrain-chain">
      <div class="se-terrain-chain-num">${tier}</div>
      <div class="se-terrain-chain-body">
        <div class="se-terrain-chain-assign">
          <span class="se-terrain-assign-label" style="min-width:130px">${tierLabels[tier] || 'Tier ' + tier}</span>
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:500">${building}</span>
        </div>
      </div>
    </div>`;
  }
  html += `</div></div>`;

  // Hospital levels table
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Hospital Chain Levels</span>
      <span class="se-terrain-count">hospital_1 → hospital_3</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">`;
  for (const [tier, building] of Object.entries(hospitalLevels)) {
    html += `<div class="se-terrain-chain">
      <div class="se-terrain-chain-num">${tier}</div>
      <div class="se-terrain-chain-body">
        <div class="se-terrain-chain-assign">
          <span class="se-terrain-assign-label" style="min-width:130px">${tierLabels[tier] || 'Tier ' + tier}</span>
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:500">${building}</span>
        </div>
      </div>
    </div>`;
  }
  html += `</div></div>`;

  html += '</div>';

  // Init tag events after render
  setTimeout(() => {
    document.querySelectorAll('.se-tag-add').forEach(sel => {
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        const tagList = sel.closest('.se-tag-selector').querySelector('.se-tag-list');
        const existing = Array.from(tagList.querySelectorAll('.se-tag')).map(t => t.dataset.val);
        if (existing.includes(sel.value)) { sel.value = ''; return; }
        const tag = document.createElement('span');
        tag.className = 'se-tag';
        tag.draggable = true;
        tag.dataset.val = sel.value;
        tag.innerHTML = `${sel.value}<span class="se-tag-remove" data-val="${sel.value}">&times;</span>`;
        tag.querySelector('.se-tag-remove').onclick = (e) => { e.stopPropagation(); tag.remove(); markSimpleModified(); };
        tagList.appendChild(tag);
        sel.value = '';
        markSimpleModified();
      });
    });
    document.querySelectorAll('.se-tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); btn.parentElement.remove(); markSimpleModified(); });
    });
  }, 0);

  return html;
}

// ── Core Buildings (Settlement Processor) Rules renderer ──

function renderSettlementRules() {
  let html = '<div class="se-terrain-rules">';

  // Chain assignment rules
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Building Assignment</span>
      <span class="se-terrain-count">4 chains</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">
      <div class="se-terrain-priority-note">Each chain assigns the highest level the settlement qualifies for (with bump rule)</div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">1</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label" style="min-width:130px">Defenses</span>
            <span style="font-size:12px;color:var(--text-secondary)">Walls and fortifications — scaled to settlement tier</span>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">2</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label" style="min-width:130px">Hinterland Roads</span>
            <span style="font-size:12px;color:var(--text-secondary)">Road networks — scaled to settlement tier</span>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">3</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label" style="min-width:130px">Market</span>
            <span style="font-size:12px;color:var(--text-secondary)">Trade buildings — scaled to settlement tier</span>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">4</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label" style="min-width:130px">Capital Treasury</span>
            <span style="font-size:12px;color:var(--text-secondary)">Economic buildings — scaled to settlement tier</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  // Special rules
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Special Rules</span>
      <span class="se-terrain-count">3 rules</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">1</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">EXCEPTION</span>
              <span style="font-size:12px;color:var(--text-secondary)">Some regions get <b>no defenses</b> — edit the list in "No Defenses Regions" below</span>
            </div>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">2</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">OVERRIDE</span>
              <span style="font-size:12px;color:var(--text-secondary)">Towns with a high-quantity resource get market forced to <b>trader</b> level</span>
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">threshold</span>
            <span style="font-size:12px;color:var(--text-tertiary)">Controlled by "Town Trader Override" setting below</span>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">3</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">PRESERVE</span>
              <span style="font-size:12px;color:var(--text-secondary)">Existing <b>temple</b> buildings are always kept — never removed or replaced</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  html += '</div>';
  return html;
}

// ── Homeland Rules parser/renderer ──

function parseHomelandRules(content) {
  // Extract the gov building chain and level
  const govMatch = content.match(/type\s+(\w+)\s+(gov\d+)/);
  const govChain = govMatch ? govMatch[1] : 'governmentD';
  const govLevel = govMatch ? govMatch[2] : 'gov4';

  // Extract colony downgrade: from and to
  const downFromMatch = content.match(/colony_tier\s*==\s*"(colony_\d+)"/);
  const downToMatch = content.match(/r'\\1(colony_\d+)'/);
  const downgradeFrom = downFromMatch ? downFromMatch[1] : 'colony_2';
  const downgradeTo = downToMatch ? downToMatch[1] : 'colony_1';

  // Extract village rule level
  const villageMatch = content.match(/settlement_level\s*==\s*"(\w+)"[\s\S]*?can't have colony/);
  const villageLevel = villageMatch ? villageMatch[1] : 'village';

  // Extract town rule level
  const townMatch = content.match(/settlement_level\s*==\s*"(\w+)"[\s\S]*?colony_2/);
  const townLevel = townMatch ? townMatch[1] : 'town';

  return {
    value: { govChain, govLevel, downgradeFrom, downgradeTo, villageLevel, townLevel }
  };
}

function renderHomelandRules() {
  // We need the parsed data - get it from currentSimpleFields
  const field = currentSimpleFields.find(f => f.type === 'homeland_rules');
  const data = field ? field.value : {};
  const { govChain, govLevel, downgradeFrom, downgradeTo } = data;

  const govOptions = ['governmentA', 'governmentB', 'governmentC', 'governmentD'].map(g =>
    `<option value="${g}" ${g === govChain ? 'selected' : ''}>${g}</option>`
  ).join('');

  const govLevelOptions = ['gov1', 'gov2', 'gov3', 'gov4', 'gov5'].map(g =>
    `<option value="${g}" ${g === govLevel ? 'selected' : ''}>${g}</option>`
  ).join('');

  const colonyOptions = ['colony_1', 'colony_2', 'colony_3'].map(c =>
    `<option value="${c}" ${c === downgradeFrom ? 'selected' : ''}>${c}</option>`
  ).join('');

  const colonyToOptions = ['colony_1', 'colony_2', 'colony_3'].map(c =>
    `<option value="${c}" ${c === downgradeTo ? 'selected' : ''}>${c}</option>`
  ).join('');

  const settlementOptions = ['village', 'town', 'large_town', 'city', 'large_city', 'huge_city'].map(s =>
    `<option value="${s}">${s}</option>`
  ).join('');

  let html = '<div class="se-terrain-rules">';

  // Homeland rules
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Homeland Regions</span>
      <span class="se-terrain-count">2 rules</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">
      <div class="se-terrain-priority-note">Region's hidden resources overlap with faction's homeland resources</div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">1</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">WHEN</span>
              <span style="font-size:12px;color:var(--text-secondary)">Region IS a homeland</span>
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">add building</span>
            <select class="se-dict-select" id="homeland-gov-chain">${govOptions}</select>
            <select class="se-dict-select" id="homeland-gov-level">${govLevelOptions}</select>
            <span style="font-size:11px;color:var(--text-tertiary);margin-left:4px">+ remove colonies</span>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">2</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">WHEN</span>
              <span style="font-size:12px;color:var(--text-secondary)">Region is NOT a homeland</span>
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">action</span>
            <span style="font-size:12px;color:var(--text-primary)">Remove the government building above if present</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  // Colony rules
  html += `<div class="se-terrain-group">
    <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="se-terrain-name">Colony Rules</span>
      <span class="se-terrain-count">3 rules</span>
      <span class="se-terrain-chevron">&#9662;</span>
    </div>
    <div class="se-terrain-chains">
      <div class="se-terrain-priority-note">Applied to all settlements regardless of homeland status</div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">1</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">WHEN</span>
              <span style="font-size:12px;color:var(--text-secondary)">Settlement is a <b>village</b></span>
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">action</span>
            <span style="font-size:12px;color:var(--text-primary)">Remove ALL colony buildings</span>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">2</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">WHEN</span>
              <span style="font-size:12px;color:var(--text-secondary)">Settlement is a <b>town</b> with</span>
              <select class="se-dict-select" id="homeland-downgrade-from">${colonyOptions}</select>
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">downgrade to</span>
            <select class="se-dict-select" id="homeland-downgrade-to">${colonyToOptions}</select>
          </div>
        </div>
      </div>

      <div class="se-terrain-chain">
        <div class="se-terrain-chain-num">3</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-cond-row">
              <span style="font-size:11px;color:var(--accent);font-weight:600">WHEN</span>
              <span style="font-size:12px;color:var(--text-secondary)">Settlement is a homeland (has gov building above)</span>
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">action</span>
            <span style="font-size:12px;color:var(--text-primary)">Remove all colony buildings</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  html += '</div>';

  // Add change listeners after render
  setTimeout(() => {
    ['homeland-gov-chain', 'homeland-gov-level', 'homeland-downgrade-from', 'homeland-downgrade-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => markSimpleModified());
    });
  }, 0);

  return html;
}

// ── Building Requirements parser/renderer (heavy_industry) ──

function parseBuildingReqs(content) {
  // Parse BUILDING_TO_RESOURCES dict
  const match = content.match(/BUILDING_TO_RESOURCES\s*=\s*\{/);
  if (!match) return null;

  const startIdx = content.indexOf(match[0]);
  let braceCount = 0;
  let dictStr = '';
  for (let i = startIdx + match[0].length - 1; i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') braceCount--;
    dictStr += content[i];
    if (braceCount === 0) break;
  }

  // Parse each building: resources mapping
  const buildings = {};
  // Match "building_name": ["res1", "res2", ...]
  const entryRe = /"(\w+)"\s*:\s*\[([^\]]+)\]/g;
  let entryMatch;
  while ((entryMatch = entryRe.exec(dictStr)) !== null) {
    const resources = entryMatch[2].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean);
    buildings[entryMatch[1]] = resources;
  }

  // Also parse RESOURCE_SCORES for cross-reference
  const scores = {};
  const scoresMatch = content.match(/RESOURCE_SCORES\s*=\s*\{/);
  if (scoresMatch) {
    const sStart = content.indexOf(scoresMatch[0]);
    let bc = 0;
    let sStr = '';
    for (let i = sStart + scoresMatch[0].length - 1; i < content.length; i++) {
      if (content[i] === '{') bc++;
      if (content[i] === '}') bc--;
      sStr += content[i];
      if (bc === 0) break;
    }
    const pairRe = /"(\w+)"\s*:\s*([\d.]+)/g;
    let pm;
    while ((pm = pairRe.exec(sStr)) !== null) {
      scores[pm[1]] = parseFloat(pm[2]);
    }
  }

  return { value: buildings, scores };
}

function renderBuildingReqsTable(buildings, scores) {
  if (!buildings) return '';

  let html = '<div class="se-building-reqs">';

  for (const [building, resources] of Object.entries(buildings)) {
    const resDisplay = resources.map(r => {
      const score = scores && scores[r] ? scores[r] : '?';
      return `<span class="se-req-resource">
        <span class="se-req-res-name">${r}</span>
        <span class="se-req-res-score">score: ${score}</span>
      </span>`;
    }).join('');

    html += `<div class="se-req-row">
      <div class="se-req-building">${building.replace(/_/g, ' ')}</div>
      <div class="se-req-resources">${resDisplay}</div>
    </div>`;
  }

  html += '</div>';
  html += '<div class="se-req-formula">Score = resource amount &times; resource score. Highest scoring building wins.</div>';
  return html;
}

// Human-readable condition simplifier
function humanizeCondition(raw) {
  return raw
    .replace(/^(?:if|elif)\s+/, '')
    .replace(/:$/, '')
    // has_any_hr → terrain checks
    .replace(/self\.has_any_hr\(hidden,\s*\[([^\]]+)\]\)/g, (_, items) =>
      'terrain: ' + items.replace(/["']/g, '').trim())
    .replace(/self\.has_any_hr\(hidden,\s*(\w+)\)/g, 'terrain in $1')
    // has_any → resource checks
    .replace(/self\.has_any\(resources,\s*\[([^\]]+)\]\)/g, (_, items) =>
      'resources: ' + items.replace(/["']/g, '').trim())
    // in hidden / in resources
    .replace(/"(\w+)"\s+in\s+hidden/g, 'terrain has $1')
    .replace(/"(\w+)"\s+in\s+resources/g, 'has $1')
    // any(r in resources ...)
    .replace(/any\(r in resources for r in \[([^\]]+)\]\)/g, (_, items) =>
      'has any of: ' + items.replace(/["']/g, '').trim())
    .replace(/any\(hr in hidden for hr in \[([^\]]+)\]\)/g, (_, items) =>
      'terrain has any of: ' + items.replace(/["']/g, '').trim())
    // not
    .replace(/not\s+terrain/g, 'NOT terrain')
    .replace(/not\s+has/g, 'NOT has')
    .replace(/not\s+self/g, 'NOT')
    // cleanup
    .replace(/["']/g, '')
    .replace(/\s+and\s+/g, ' AND ')
    .replace(/\s+or\s+/g, ' OR ')
    .replace(/faction_lower in allowed/, 'faction is in allowed list')
    .replace(/^else\s*$/, 'Fallback (no other rule matched)')
    .trim();
}

function parseTerrainRules(content) {
  const rules = [];

  const funcStart = content.indexOf('def select_farm_chain(self');
  if (funcStart === -1) return { value: rules };

  // Lines of the whole file (for absolute line number tracking)
  const allLines = content.split('\n');
  const funcLineNum = content.slice(0, funcStart).split('\n').length - 1;

  const afterFunc = content.slice(funcStart);
  const nextDef = afterFunc.match(/\n    def \w+\(self/);
  const funcBody = nextDef ? afterFunc.slice(0, nextDef.index) : afterFunc;
  const lines = funcBody.split('\n');

  let currentTerrain = null;
  let currentChains = [];
  let localVars = {}; // local variable definitions within terrain block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const absLine = funcLineNum + i + 1; // 1-based absolute line number

    // Top-level terrain check
    const terrainMatch = line.match(/^        if "(\w+)" in hidden\s*:/);
    if (terrainMatch) {
      if (currentTerrain && currentChains.length > 0) {
        rules.push({ terrain: currentTerrain, chains: [...currentChains], localVars: { ...localVars } });
      }
      currentTerrain = terrainMatch[1];
      currentChains = [];
      localVars = {};
      continue;
    }

    if (!currentTerrain) continue;

    // Collect local variable definitions (e.g., plateau_irrigation = [...])
    const varMatch = trimmed.match(/^(\w+)\s*=\s*\[([^\]]*)\]/);
    if (varMatch) {
      const vals = varMatch[2].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean);
      localVars[varMatch[1]] = vals;
      continue;
    }

    // Also catch set definitions: irrigation = {"x", "y"}
    const setVarMatch = trimmed.match(/^(\w+)\s*=\s*\{([^}]*)\}/);
    if (setVarMatch && !trimmed.includes('return') && !trimmed.includes('pick_chain')) {
      const vals = setVarMatch[2].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean);
      localVars[setVarMatch[1]] = vals;
      continue;
    }

    // Find pick_chain or direct returns
    const pickMatch = trimmed.match(/return\s+pick_chain\("(\w+)"\)/);
    const directMatch = trimmed.match(/return\s+"(\w+)",\s+farm_level/);

    if (pickMatch || directMatch) {
      const chain = pickMatch ? pickMatch[1] : directMatch[1];
      const returnIndent = line.search(/\S/);

      let conditionLines = [];
      let condType = 'fallback';
      let foundCondition = false;

      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const prevLine = lines[j];
        const prev = prevLine.trim();
        const prevIndent = prevLine.search(/\S/);

        if (prev.startsWith('logmsg') || prev === '' || prev.startsWith('#') || prev.startsWith('return')) continue;

        if (prev.startsWith('if ') || prev.startsWith('elif ') || prev.startsWith('else')) {
          if (prevIndent < returnIndent) {
            conditionLines.unshift(prev);
            condType = prev.startsWith('else') ? 'fallback' : (prev.startsWith('elif') ? 'elif' : 'if');
            foundCondition = true;
            break;
          } else {
            break;
          }
        }
        if (prev.endsWith(')') || prev.endsWith('and') || prev.endsWith('or') || prev.startsWith('and ') || prev.startsWith('or ') || prev.startsWith('(')) {
          conditionLines.unshift(prev);
        }
      }

      const rawCondition = conditionLines.join(' ');

      currentChains.push({
        chain,
        condType,
        lineNum: absLine,
        rawCondition,
        localVars: { ...localVars },
      });
    }
  }

  if (currentTerrain && currentChains.length > 0) {
    rules.push({ terrain: currentTerrain, chains: [...currentChains], localVars: { ...localVars } });
  }

  return { value: rules };
}

// All farm chains for the dropdown
const FARM_CHAIN_OPTIONS = [
  'irrigated_farming', 'rainfed_farming', 'qanat_farming', 'highland_pastoralism',
  'sedentary_animal_husbandry', 'marsh_reclamation', 'wetland_pastoralism',
  'nomadic_pastoralism', 'forest_pastoralism', 'shifting_cultivation'
];

// Resolve local variables in a condition string
// e.g., plateau_irrigation → ["irrigation_river", "irrigation_springs", ...]
function resolveLocalVars(condStr, localVars) {
  let resolved = condStr;
  for (const [varName, varValue] of Object.entries(localVars)) {
    // Handle var[:3] slicing
    const sliceRe = new RegExp(varName + '\\[:(\\d+)\\]', 'g');
    resolved = resolved.replace(sliceRe, (_, n) => {
      const sliced = varValue.slice(0, parseInt(n));
      return JSON.stringify(sliced);
    });
    // Handle ["x"] + var  (list concatenation)
    const concatRe = new RegExp('\\[([^\\]]+)\\]\\s*\\+\\s*' + varName, 'g');
    resolved = resolved.replace(concatRe, (_, items) => {
      const prefix = items.split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean);
      return JSON.stringify([...prefix, ...varValue]);
    });
    // Handle plain var reference
    const plainRe = new RegExp('(?<![\\w.])' + varName + '(?!\\w)', 'g');
    resolved = resolved.replace(plainRe, JSON.stringify(varValue));
  }
  return resolved;
}

// Legacy alias
function extractListValues(str) {
  return extractAnyListValues(str);
}

// Extract values from a list string — handles both "quoted" and unquoted
function extractAnyListValues(str) {
  // Try quoted first
  const quoted = [];
  const qre = /["']([^"']+)["']/g;
  let qm;
  while ((qm = qre.exec(str)) !== null) quoted.push(qm[1]);
  if (quoted.length > 0) return quoted;

  // Fall back to unquoted comma-separated
  return str.replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean);
}

// Parse a single atomic condition (no or/and splitting needed)
function parseAtomicCondition(expr) {
  let trimmed = expr.trim();
  // Strip wrapping parens
  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1).trim();
    // Make sure we're not stripping meaningful parens
    let depth = 0, safe = true;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '(') depth++;
      if (inner[i] === ')') depth--;
      if (depth < 0) { safe = false; break; }
    }
    if (safe && depth === 0) trimmed = inner; else break;
  }

  // Detect 'not' prefix — handle both "not X" and "not any(...)"
  const isNot = /^not\s+/.test(trimmed);
  let clean = trimmed.replace(/^not\s+/, '').trim();
  // Also strip a leading paren after not: "not (any(...))" → "any(...)"
  if (clean.startsWith('(') && clean.endsWith(')')) {
    let d = 0, ok = true;
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '(') d++;
      if (clean[i] === ')') d--;
      if (d === 0 && i < clean.length - 1) { ok = false; break; }
    }
    if (ok) clean = clean.slice(1, -1).trim();
  }

  // "X" in resources
  let m = clean.match(/^["']?(\w+)["']?\s+in\s+resources$/);
  if (m) return { type: isNot ? 'not_resource_any' : 'resource', values: [m[1]] };

  // "X" in hidden
  m = clean.match(/^["']?(\w+)["']?\s+in\s+hidden$/);
  if (m) return { type: isNot ? 'not_terrain_any' : 'terrain', values: [m[1]] };

  // self.has_any(resources, [...]) — with or without self.
  m = clean.match(/(?:self\.)?has_any\(resources,\s*(\[.+?\])\)/);
  if (m) return { type: isNot ? 'not_resource_any' : 'resource_any', values: extractAnyListValues(m[1]) };

  // self.has_any_hr(hidden, [...]) — with or without self.
  m = clean.match(/(?:self\.)?has_any_hr\(hidden,\s*(\[.+?\])\)/);
  if (m) return { type: isNot ? 'not_terrain_any' : 'terrain_any', values: extractAnyListValues(m[1]) };

  // any(r in resources for r in [...]) — also matches not any(...)
  m = clean.match(/any\(\w+ in resources for \w+ in (\[.+?\])\)/);
  if (m) return { type: isNot ? 'not_resource_any' : 'resource_any', values: extractAnyListValues(m[1]) };

  // any(hr in hidden for hr in [...]) — also matches not any(...)
  m = clean.match(/any\(\w+ in hidden for \w+ in (\[.+?\])\)/);
  if (m) return { type: isNot ? 'not_terrain_any' : 'terrain_any', values: extractAnyListValues(m[1]) };

  // "X" in hidden or "Y" in hidden (simple OR of terrain checks, any number)
  m = clean.match(/^(["']?\w+["']?\s+in\s+hidden)(\s+or\s+["']?\w+["']?\s+in\s+hidden)+$/);
  if (m) {
    const vals = [];
    const re2 = /["']?(\w+)["']?\s+in\s+hidden/g;
    let m2;
    while ((m2 = re2.exec(clean)) !== null) vals.push(m2[1]);
    return { type: isNot ? 'not_terrain_any' : 'terrain_any', values: vals };
  }

  // "X" in resources or "Y" in resources (any number)
  m = clean.match(/^(["']?\w+["']?\s+in\s+resources)(\s+or\s+["']?\w+["']?\s+in\s+resources)+$/);
  if (m) {
    const vals = [];
    const re2 = /["']?(\w+)["']?\s+in\s+resources/g;
    let m2;
    while ((m2 = re2.exec(clean)) !== null) vals.push(m2[1]);
    return { type: isNot ? 'not_resource_any' : 'resource_any', values: vals };
  }

  // faction_lower in allowed (special faction membership check)
  if (clean.match(/faction_lower\s+in\s+allowed/)) {
    return { type: 'faction_allowed', values: ['in allowed factions list'] };
  }
  if (clean.match(/faction_lower\s+not\s+in\s+allowed/) || (isNot && clean.match(/faction_lower\s+in\s+allowed/))) {
    return { type: 'faction_not_allowed', values: ['not in allowed factions list'] };
  }

  return null; // couldn't parse
}

// Structured condition: array of checks combined with AND
function parseConditionToChecks(rawCondition, localVars) {
  if (!rawCondition || rawCondition === 'else' || rawCondition === 'else:') {
    return [{ type: 'fallback', values: [] }];
  }

  // Clean up
  let cond = rawCondition
    .replace(/^(?:if|elif)\s+/, '')
    .replace(/:$/, '')
    .trim();

  // Resolve local variables
  if (localVars) {
    cond = resolveLocalVars(cond, localVars);
  }

  // Strip outermost parens if they wrap the whole thing
  if (cond.startsWith('(') && cond.endsWith(')')) {
    let depth = 0, allWrapped = true;
    for (let i = 0; i < cond.length; i++) {
      if (cond[i] === '(') depth++;
      if (cond[i] === ')') depth--;
      if (depth === 0 && i < cond.length - 1) { allWrapped = false; break; }
    }
    if (allWrapped) cond = cond.slice(1, -1).trim();
  }

  // For `or` conditions at top level, we'll flatten them into a single "any of" style
  // First try splitting on top-level ' and '
  const andParts = splitTopLevel(cond, ' and ');

  const checks = [];
  let allParsed = true;

  for (let part of andParts) {
    // Strip wrapping parens from this part
    part = stripOuterParens(part);
    // Check if this part has ' or ' (making it an OR group)
    const orParts = splitTopLevel(part, ' or ');

    if (orParts.length > 1) {
      // Try to parse each OR branch
      const parsed = orParts.map(p => parseAtomicCondition(p)).filter(Boolean);
      if (parsed.length === orParts.length) {
        // Group by base type (resource vs terrain) and merge values
        const groups = {};
        for (const p of parsed) {
          // Normalize type: resource/resource_any → resource_any, terrain/terrain_any → terrain_any
          let baseType = p.type;
          if (baseType === 'resource') baseType = 'resource_any';
          if (baseType === 'terrain') baseType = 'terrain_any';
          if (!groups[baseType]) groups[baseType] = [];
          groups[baseType].push(...p.values);
        }
        // Push each group as a separate check, joined by OR between groups
        const groupEntries = Object.entries(groups);
        for (let gi = 0; gi < groupEntries.length; gi++) {
          const [type, vals] = groupEntries[gi];
          if (gi > 0) {
            checks.push({ type: 'or_join', values: [] });
          }
          checks.push({ type, values: [...new Set(vals)] });
        }
        continue;
      }
      // Couldn't parse all branches — fall through to raw
      const readable = orParts.map(p => {
        const atom = parseAtomicCondition(p);
        if (atom) return `${atom.type.replace(/_/g, ' ')}: ${atom.values.join(', ')}`;
        return p.replace(/self\./g, '').replace(/["']/g, '');
      }).join(' OR ');
      checks.push({ type: 'raw', values: [readable] });
      allParsed = false;
      continue;
    }

    const atom = parseAtomicCondition(part);
    if (atom) {
      checks.push(atom);
    } else {
      // Unparseable — clean up for display
      const cleaned = part
        .replace(/self\.\w+\([^)]*\)/g, (match) => match.replace(/self\./g, '').replace(/["']/g, ''))
        .replace(/["']/g, '');
      checks.push({ type: 'raw', values: [cleaned] });
      allParsed = false;
    }
  }

  return checks.length > 0 ? checks : [{ type: 'fallback', values: [] }];
}

// Strip wrapping parens if they enclose the entire string
function stripOuterParens(str) {
  let s = str.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0, allWrapped = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      if (s[i] === ')') depth--;
      if (depth === 0 && i < s.length - 1) { allWrapped = false; break; }
    }
    if (allWrapped) s = s.slice(1, -1).trim(); else break;
  }
  return s;
}

// Split a string on a delimiter, but only at the top level (not inside parens/brackets)
function splitTopLevel(str, delim) {
  const parts = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(' || str[i] === '[') depth++;
    if (str[i] === ')' || str[i] === ']') depth--;

    if (depth === 0 && str.substring(i, i + delim.length) === delim) {
      parts.push(current.trim());
      current = '';
      i += delim.length - 1;
    } else {
      current += str[i];
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function getOptionsForCondType(type) {
  if (type.includes('resource')) return VALID_RESOURCES;
  if (type.includes('terrain')) return VALID_TERRAIN;
  return [];
}

function renderTagSelector(values, allOptions, prefix, cidx) {
  const selected = new Set(values);
  const optionsHtml = allOptions.map(o =>
    `<option value="${o}">${o}</option>`
  ).join('');

  const tagsHtml = values.map((v, i) =>
    `<span class="se-tag" draggable="true" data-val="${v}" data-idx="${i}" ${prefix} data-cidx="${cidx}">
      ${v}
      <span class="se-tag-remove" data-val="${v}">&times;</span>
    </span>`
  ).join('');

  return `<div class="se-tag-selector" ${prefix} data-cidx="${cidx}">
    <div class="se-tag-list" ${prefix} data-cidx="${cidx}">${tagsHtml}</div>
    <select class="se-tag-add" ${prefix} data-cidx="${cidx}">
      <option value="">+ add...</option>
      ${optionsHtml}
    </select>
  </div>`;
}

function checksToConditionHtml(checks, ruleIdx, terrainIdx) {
  const prefix = `data-tidx="${terrainIdx}" data-ridx="${ruleIdx}"`;

  if (checks.length === 1 && checks[0].type === 'fallback') {
    return `<div class="se-cond-row">
      <select class="se-cond-type" ${prefix} data-cidx="0">
        ${condTypeOptions('fallback')}
      </select>
    </div>`;
  }

  let html = '';
  checks.forEach((check, cidx) => {
    if (check.type === 'or_join') {
      html += `<div class="se-cond-joiner or">OR</div>`;
      return;
    }
    if (cidx > 0 && checks[cidx - 1]?.type !== 'or_join') {
      html += `<div class="se-cond-joiner">AND</div>`;
    }
    const options = getOptionsForCondType(check.type);
    const useDropdown = check.type !== 'fallback' && check.type !== 'raw';
    const isSingle = check.type === 'resource' || check.type === 'terrain';

    html += `<div class="se-cond-row">
      <select class="se-cond-type" ${prefix} data-cidx="${cidx}">
        ${condTypeOptions(check.type)}
      </select>`;

    const isFaction = check.type === 'faction_allowed' || check.type === 'faction_not_allowed';
    if (isFaction) {
      html += `<span class="se-cond-faction-label">(see Marsh Reclamation Factions below)</span>`;
    } else if (useDropdown) {
      if (isSingle) {
        // Single value dropdown
        const optionsHtml = options.map(o =>
          `<option value="${o}" ${o === check.values[0] ? 'selected' : ''}>${o}</option>`
        ).join('');
        html += `<select class="se-cond-single-value" ${prefix} data-cidx="${cidx}">
          ${optionsHtml}
        </select>`;
      } else {
        // Multi-value tag selector with drag-and-drop
        html += renderTagSelector(check.values, options, prefix, cidx);
      }
    } else if (check.type === 'raw') {
      html += `<input type="text" class="se-cond-values" ${prefix} data-cidx="${cidx}" value="${check.values.join(', ')}">`;
    }

    html += `</div>`;
  });

  html += `<button class="se-cond-add-check" ${prefix} title="Add another condition">+ AND</button>`;
  return html;
}

function condTypeOptions(selected) {
  const types = [
    ['resource', 'Has resource'],
    ['resource_any', 'Has any resource from'],
    ['terrain', 'Terrain has'],
    ['terrain_any', 'Terrain has any of'],
    ['not_resource_any', 'Does NOT have resources'],
    ['not_terrain_any', 'Terrain does NOT have'],
    ['faction_allowed', 'Faction is in allowed list'],
    ['faction_not_allowed', 'Faction is NOT in allowed list'],
    ['fallback', 'Fallback (always)'],
  ];
  return types.map(([val, label]) =>
    `<option value="${val}" ${val === selected ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function checksToython(checks) {
  if (checks.length === 1 && checks[0].type === 'fallback') return null; // bare return, no if

  // Build with proper and/or joining
  const segments = [];
  let currentGroup = [];

  for (const check of checks) {
    if (check.type === 'or_join') {
      if (currentGroup.length > 0) {
        segments.push(currentGroup.join(' and '));
        currentGroup = [];
      }
      continue;
    }
    const py = checkToPython(check);
    if (py) currentGroup.push(py);
  }
  if (currentGroup.length > 0) segments.push(currentGroup.join(' and '));

  return segments.join(' or ');
}

function checkToPython(check) {
  const vals = check.values || [];
  switch (check.type) {
    case 'resource':
      return `"${vals[0]}" in resources`;
    case 'terrain':
      return `"${vals[0]}" in hidden`;
    case 'resource_any':
      return `self.has_any(resources, [${vals.map(v => `"${v}"`).join(', ')}])`;
    case 'terrain_any':
      return `self.has_any_hr(hidden, [${vals.map(v => `"${v}"`).join(', ')}])`;
    case 'not_resource_any':
      return `not self.has_any(resources, [${vals.map(v => `"${v}"`).join(', ')}])`;
    case 'not_terrain_any':
      return `not self.has_any_hr(hidden, [${vals.map(v => `"${v}"`).join(', ')}])`;
    case 'faction_allowed':
      return 'faction_lower in allowed';
    case 'faction_not_allowed':
      return 'faction_lower not in allowed';
    default:
      return vals.join(' ');
  }
}

// Store parsed terrain rules for save-back
let parsedTerrainRules = [];

function renderTerrainRulesTable(rules) {
  if (!rules || rules.length === 0) {
    return '<div class="simple-editor-empty">Could not parse terrain rules.</div>';
  }

  parsedTerrainRules = rules;

  const chainOptionsHtml = FARM_CHAIN_OPTIONS.map(c =>
    `<option value="${c}">${c.replace(/_/g, ' ')}</option>`
  ).join('');

  let html = '<div class="se-terrain-rules" id="terrain-rules-container">';

  rules.forEach((rule, tidx) => {
    html += `<div class="se-terrain-group" data-tidx="${tidx}">
      <div class="se-terrain-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="se-terrain-name">${rule.terrain.replace(/_/g, ' ')}</span>
        <span class="se-terrain-count">${rule.chains.length} rule${rule.chains.length > 1 ? 's' : ''}</span>
        <span class="se-terrain-chevron">&#9662;</span>
      </div>
      <div class="se-terrain-chains">
        <div class="se-terrain-priority-note">Rules checked top to bottom — first match wins</div>`;

    rule.chains.forEach((chain, ridx) => {
      const checks = parseConditionToChecks(chain.rawCondition, chain.localVars || rule.localVars);
      const isFallback = checks.length === 1 && checks[0].type === 'fallback';

      html += `<div class="se-terrain-chain ${isFallback ? 'fallback' : ''}" data-tidx="${tidx}" data-ridx="${ridx}">
        <div class="se-terrain-chain-num">${ridx + 1}</div>
        <div class="se-terrain-chain-body">
          <div class="se-terrain-chain-top">
            <div class="se-terrain-condition-editor">
              ${checksToConditionHtml(checks, ridx, tidx)}
            </div>
          </div>
          <div class="se-terrain-chain-assign">
            <span class="se-terrain-assign-label">assign</span>
            <select class="se-terrain-select" data-line="${chain.lineNum}" data-old="${chain.chain}" data-tidx="${tidx}" data-ridx="${ridx}">
              ${chainOptionsHtml.replace(`value="${chain.chain}"`, `value="${chain.chain}" selected`)}
            </select>
            <button class="se-terrain-delete-rule" data-tidx="${tidx}" data-ridx="${ridx}" title="Remove this rule">&times;</button>
          </div>
        </div>
      </div>`;
    });

    // For wetlands terrain, show the marsh reclamation factions list
    if (rule.terrain === 'wetlands') {
      const factionVars = rule.localVars || {};
      const allowedFactions = factionVars['allowed'] || [];
      if (allowedFactions.length > 0) {
        html += `<div class="se-terrain-factions">
          <div class="se-terrain-factions-label">Marsh reclamation allowed factions:</div>
          <div class="se-list">
            ${allowedFactions.map(f => `<span class="se-list-item">${f}</span>`).join('')}
          </div>
        </div>`;
      }
    }

    html += `<div class="se-terrain-add-rule">
        <button class="se-terrain-add-btn" data-tidx="${tidx}">+ Add Rule</button>
      </div>`;

    html += `</div></div>`;
  });

  html += '</div>';

  // Attach event listeners after render (via setTimeout since innerHTML hasn't been set yet)
  setTimeout(() => initTerrainRuleEvents(), 0);

  return html;
}

function initTerrainRuleEvents() {
  const container = document.getElementById('terrain-rules-container');
  if (!container) return;

  // Add rule buttons
  container.querySelectorAll('.se-terrain-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      addTerrainRule(parseInt(btn.dataset.tidx));
    });
  });

  // Delete rule buttons
  container.querySelectorAll('.se-terrain-delete-rule').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTerrainRule(parseInt(btn.dataset.tidx), parseInt(btn.dataset.ridx));
    });
  });

  // Add AND check buttons
  container.querySelectorAll('.se-cond-add-check').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      addConditionCheck(parseInt(btn.dataset.tidx), parseInt(btn.dataset.ridx));
    });
  });

  // Change listeners
  container.querySelectorAll('.se-cond-type, .se-cond-single-value, .se-terrain-select').forEach(el => {
    el.addEventListener('change', () => markSimpleModified());
  });

  // Tag add (from dropdown)
  container.querySelectorAll('.se-tag-add').forEach(sel => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const tagList = sel.closest('.se-tag-selector').querySelector('.se-tag-list');
      // Check if already added
      const existing = Array.from(tagList.querySelectorAll('.se-tag')).map(t => t.dataset.val);
      if (existing.includes(sel.value)) { sel.value = ''; return; }
      const tag = document.createElement('span');
      tag.className = 'se-tag';
      tag.draggable = true;
      tag.dataset.val = sel.value;
      tag.innerHTML = `${sel.value}<span class="se-tag-remove" data-val="${sel.value}">&times;</span>`;
      tagList.appendChild(tag);
      sel.value = '';
      initTagDragDrop(tagList);
      markSimpleModified();
    });
  });

  // Tag remove (click ×)
  container.querySelectorAll('.se-tag-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.parentElement.remove();
      markSimpleModified();
    });
  });

  // Init drag-drop on all tag lists
  container.querySelectorAll('.se-tag-list').forEach(list => {
    initTagDragDrop(list);
  });
}

function initTagDragDrop(tagList) {
  const tags = tagList.querySelectorAll('.se-tag');
  let draggedEl = null;

  tags.forEach(tag => {
    tag.addEventListener('dragstart', (e) => {
      draggedEl = tag;
      tag.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    tag.addEventListener('dragend', () => {
      tag.classList.remove('dragging');
      draggedEl = null;
      markSimpleModified();
    });

    tag.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!draggedEl || draggedEl === tag) return;
      const rect = tag.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        tagList.insertBefore(draggedEl, tag);
      } else {
        tagList.insertBefore(draggedEl, tag.nextSibling);
      }
    });
  });

  // Also handle remove buttons for newly added tags
  tagList.querySelectorAll('.se-tag-remove').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      btn.parentElement.remove();
      markSimpleModified();
    };
  });
}

function addTerrainRule(tidx) {
  const rule = parsedTerrainRules[tidx];
  if (!rule) return;

  // Add a new fallback rule at the end
  rule.chains.push({
    chain: 'rainfed_farming',
    condition: 'Fallback',
    condType: 'fallback',
    lineNum: -1, // new rule, no line yet
    rawCondition: 'else:',
    isNew: true,
  });

  // Re-render
  const content = monacoEditor.getValue();
  renderSimpleEditor(content);
  markSimpleModified();
}

function deleteTerrainRule(tidx, ridx) {
  const rule = parsedTerrainRules[tidx];
  if (!rule || rule.chains.length <= 1) return; // don't delete the last rule

  rule.chains[ridx].deleted = true;

  const content = monacoEditor.getValue();
  renderSimpleEditor(content);
  markSimpleModified();
}

function addConditionCheck(tidx, ridx) {
  const container = document.getElementById('terrain-rules-container');
  const condEditor = container.querySelector(`.se-terrain-chain[data-tidx="${tidx}"][data-ridx="${ridx}"] .se-terrain-condition-editor`);
  if (!condEditor) return;

  const addBtn = condEditor.querySelector('.se-cond-add-check');
  const prefix = `data-tidx="${tidx}" data-ridx="${ridx}"`;
  const optionsHtml = VALID_RESOURCES.map(o => `<option value="${o}">${o}</option>`).join('');

  const joiner = document.createElement('div');
  joiner.className = 'se-cond-joiner';
  joiner.textContent = 'AND';

  const row = document.createElement('div');
  row.className = 'se-cond-row';
  row.innerHTML = `
    <select class="se-cond-type" ${prefix} data-cidx="new">
      ${condTypeOptions('resource')}
    </select>
    <select class="se-cond-single-value" ${prefix} data-cidx="new">
      ${optionsHtml}
    </select>`;

  addBtn.before(joiner);
  addBtn.before(row);

  // Add change listeners
  row.querySelectorAll('select').forEach(el => {
    el.addEventListener('change', () => {
      // If type changed to multi, swap to tag selector
      markSimpleModified();
    });
  });

  markSimpleModified();
}

function applySimpleEdits(content) {
  const simpleEl = document.getElementById('simple-editor');

  for (const field of currentSimpleFields) {
    if (field.type === 'inline_num' && field.replacePattern) {
      const input = simpleEl.querySelector(`input[data-type="inline_num"][data-var="${field.label}"]`);
      if (!input) continue;
      content = content.replace(field.replacePattern, `$1${input.value}`);
    } else if (field.type === 'number') {
      const input = simpleEl.querySelector(`input[data-var="${field.variable}"]`);
      if (!input) continue;
      const newVal = input.value;
      const re = new RegExp(`(${field.variable}\\s*=\\s*)[\\d.]+`);
      content = content.replace(re, `$1${newVal}`);
    } else if (field.type === 'dict_num') {
      const inputs = simpleEl.querySelectorAll(`input[data-var="${field.variable}"]`);
      inputs.forEach(input => {
        const key = input.dataset.key;
        const newVal = input.value;
        // Replace "key": oldVal with "key": newVal
        const re = new RegExp(`(["']${escapeRegex(key)}["']\\s*:\\s*)[\\d.]+`);
        content = content.replace(re, `$1${newVal}`);
      });
    } else if (field.type === 'dict_str') {
      const inputs = simpleEl.querySelectorAll(`input[data-var="${field.variable}"]`);
      inputs.forEach(input => {
        const key = input.dataset.key;
        const newVal = input.value;
        const re = new RegExp(`(${escapeRegex(key)}["']\\s*:\\s*["'])[^"']+`);
        content = content.replace(re, `$1${newVal}`);
      });
    } else if (field.type === 'dict_select') {
      const selects = simpleEl.querySelectorAll(`select[data-var="${field.variable}"]`);
      selects.forEach(select => {
        const key = select.dataset.key;
        const newVal = select.value;
        const re = new RegExp(`(${escapeRegex(key)}["']\\s*:\\s*["'])[^"']+`);
        content = content.replace(re, `$1${newVal}`);
      });
    } else if (field.type === 'set' && field.variable && !field.readonly) {
      const selector = simpleEl.querySelector(`.se-tag-selector[data-var="${field.variable}"]`);
      if (selector) {
        const tags = Array.from(selector.querySelectorAll('.se-tag')).map(t => t.dataset.val);
        const newSet = tags.length > 0
          ? `{${tags.map(v => `"${v}"`).join(', ')}}`
          : 'set()';
        // Replace both {..} and set() formats
        const re1 = new RegExp(`(${escapeRegex(field.variable)}\\s*=\\s*)\\{[^}]*\\}`);
        const re2 = new RegExp(`(${escapeRegex(field.variable)}\\s*=\\s*)set\\(\\)`);
        if (re1.test(content)) {
          content = content.replace(re1, `$1${newSet}`);
        } else if (re2.test(content)) {
          content = content.replace(re2, `$1${newSet}`);
        }
      }
    }
  }

  // Apply terrain rule changes (conditions, chains, new rules, deleted rules)
  content = applyTerrainRuleEdits(content, simpleEl);

  // Apply homeland rule changes
  const govChainEl = document.getElementById('homeland-gov-chain');
  const govLevelEl = document.getElementById('homeland-gov-level');
  const downFromEl = document.getElementById('homeland-downgrade-from');
  const downToEl = document.getElementById('homeland-downgrade-to');

  if (govChainEl && govLevelEl) {
    const newChain = govChainEl.value;
    const newLevel = govLevelEl.value;
    // Replace all governmentX govY references
    content = content.replace(/government[A-D]\s+gov\d+/g, `${newChain} ${newLevel}`);
  }

  if (downFromEl && downToEl) {
    const from = downFromEl.value;
    const to = downToEl.value;
    content = content.replace(/(colony_tier\s*==\s*")colony_\d+/, `$1${from}`);
    content = content.replace(/(r'\\1)colony_\d+/, `$1${to}`);
  }

  return content;
}

function applyTerrainRuleEdits(content, simpleEl) {
  const container = simpleEl.querySelector('#terrain-rules-container');
  if (!container || parsedTerrainRules.length === 0) return content;

  const contentLines = content.split('\n');

  // First pass: update existing rules (chain changes + condition changes)
  container.querySelectorAll('.se-terrain-select').forEach(select => {
    const lineNum = parseInt(select.dataset.line);
    const oldChain = select.dataset.old;
    const newChain = select.value;

    if (lineNum > 0 && oldChain !== newChain) {
      const lineIdx = lineNum - 1;
      if (lineIdx >= 0 && lineIdx < contentLines.length) {
        contentLines[lineIdx] = contentLines[lineIdx]
          .replace(`pick_chain("${oldChain}")`, `pick_chain("${newChain}")`)
          .replace(`"${oldChain}", farm_level`, `"${newChain}", farm_level`);
        select.dataset.old = newChain;
      }
    }
  });

  // Update conditions on existing rules
  container.querySelectorAll('.se-terrain-chain').forEach(chainEl => {
    const tidx = parseInt(chainEl.dataset.tidx);
    const ridx = parseInt(chainEl.dataset.ridx);
    const rule = parsedTerrainRules[tidx];
    if (!rule) return;
    const chain = rule.chains[ridx];
    if (!chain || chain.lineNum <= 0) return;

    // Read condition checks from the form
    const checks = readChecksFromForm(chainEl);
    const newPythonCond = checksToython(checks);

    if (newPythonCond === null) return; // fallback, no condition line to edit

    // Find the condition line (look backward from the return line)
    const returnLineIdx = chain.lineNum - 1;
    for (let j = returnLineIdx - 1; j >= Math.max(0, returnLineIdx - 5); j--) {
      const line = contentLines[j].trim();
      if (line.startsWith('if ') || line.startsWith('elif ')) {
        const indent = contentLines[j].match(/^(\s*)/)[1];
        contentLines[j] = `${indent}if ${newPythonCond}:`;
        break;
      }
    }
  });

  content = contentLines.join('\n');

  // Handle new rules and deleted rules
  for (let tidx = parsedTerrainRules.length - 1; tidx >= 0; tidx--) {
    const rule = parsedTerrainRules[tidx];

    // Delete marked rules (reverse order to preserve line numbers)
    for (let ridx = rule.chains.length - 1; ridx >= 0; ridx--) {
      const chain = rule.chains[ridx];
      if (chain.deleted && chain.lineNum > 0) {
        const lines = content.split('\n');
        const returnLineIdx = chain.lineNum - 1;

        // Find the start of this rule block (the if/elif line)
        let startLine = returnLineIdx;
        for (let j = returnLineIdx - 1; j >= Math.max(0, returnLineIdx - 5); j--) {
          const trimmed = lines[j].trim();
          if (trimmed.startsWith('if ') || trimmed.startsWith('elif ') || trimmed.startsWith('else') || trimmed.startsWith('#') || trimmed.startsWith('logmsg')) {
            startLine = j;
          } else if (trimmed !== '') {
            break;
          }
        }

        // Remove lines from startLine to returnLineIdx
        lines.splice(startLine, returnLineIdx - startLine + 1);
        content = lines.join('\n');

        rule.chains.splice(ridx, 1);
      }
    }

    // Add new rules
    for (let ridx = rule.chains.length - 1; ridx >= 0; ridx--) {
      const chain = rule.chains[ridx];
      if (!chain.isNew) continue;

      // Read the chain and condition from form
      const chainEl = container.querySelector(`.se-terrain-chain[data-tidx="${tidx}"][data-ridx="${ridx}"]`);
      if (!chainEl) continue;

      const checks = readChecksFromForm(chainEl);
      const pythonCond = checksToython(checks);
      const selectedChain = chainEl.querySelector('.se-terrain-select')?.value || 'rainfed_farming';

      // Find the terrain block to insert into
      // Look for the last pick_chain in this terrain's block
      const existingChains = rule.chains.filter(c => !c.isNew && !c.deleted && c.lineNum > 0);
      if (existingChains.length === 0) continue;

      const lastExisting = existingChains[existingChains.length - 1];
      const insertAfterLine = lastExisting.lineNum; // 1-based

      const lines = content.split('\n');
      const indent = '            '; // 12 spaces (3 levels deep in class method)

      let newLines;
      if (pythonCond) {
        newLines = [
          `${indent}if ${pythonCond}:`,
          `${indent}    return pick_chain("${selectedChain}")`,
        ];
      } else {
        newLines = [
          `${indent}return pick_chain("${selectedChain}")`,
        ];
      }

      lines.splice(insertAfterLine, 0, ...newLines);
      content = lines.join('\n');

      chain.isNew = false;
    }
  }

  return content;
}

function readChecksFromForm(chainEl) {
  const checks = [];
  chainEl.querySelectorAll('.se-cond-row').forEach(row => {
    const typeSelect = row.querySelector('.se-cond-type');
    if (!typeSelect) return;
    const type = typeSelect.value;

    let values = [];

    // Single dropdown
    const singleSelect = row.querySelector('.se-cond-single-value');
    if (singleSelect) {
      values = [singleSelect.value];
    }

    // Tag selector (multi)
    const tagList = row.querySelector('.se-tag-list');
    if (tagList) {
      values = Array.from(tagList.querySelectorAll('.se-tag')).map(t => t.dataset.val);
    }

    // Raw text input fallback
    const textInput = row.querySelector('.se-cond-values');
    if (textInput && !singleSelect && !tagList) {
      values = textInput.value.split(',').map(s => s.trim()).filter(Boolean);
    }

    checks.push({ type, values });
  });
  return checks.length > 0 ? checks : [{ type: 'fallback', values: [] }];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markSimpleModified() {
  const filenameEl = document.getElementById('editor-filename');
  filenameEl.classList.add('modified');
  document.getElementById('btn-save-file').disabled = false;
  document.getElementById('btn-revert').disabled = false;
}

async function loadMonaco() {
  // Lazy-load monaco from a CDN so we don't ship 90 MB of editor in the
  // installer. ~5 MB fetch on first Editor-tab open; cached by the browser
  // for subsequent runs. Fallback to the simple textarea if offline.
  const MONACO_VERSION = '0.52.2';
  const monacoPath = `https://unpkg.com/monaco-editor@${MONACO_VERSION}/min/vs`;

  return new Promise((resolve, reject) => {
    const container = document.getElementById('monaco-container');
    container.innerHTML = `
      <div style="padding:20px;display:flex;align-items:center;gap:10px;color:var(--text-tertiary,#8e8e93);font-size:11.5px">
        <div style="width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:master-spin 0.8s linear infinite"></div>
        Loading editor from CDN...
      </div>`;

    const loaderScript = document.createElement('script');
    loaderScript.src = `${monacoPath}/loader.js`;
    loaderScript.onerror = () => {
      container.innerHTML = `
        <div style="padding:20px;color:var(--red,#ff453a);font-size:11.5px">
          Could not load editor (no internet?). Toggle to <strong>Simple</strong> mode above to edit.
        </div>`;
      reject(new Error('monaco loader failed'));
    };
    loaderScript.onload = () => {
      require.config({ paths: { vs: monacoPath } });
      require(['vs/editor/editor.main'], () => {
        // Clear the "loading from CDN" placeholder so monaco can mount cleanly.
        container.innerHTML = '';
        // macOS-native dark theme
        monaco.editor.defineTheme('macos-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
            { token: 'keyword', foreground: 'ff7b72' },
            { token: 'string', foreground: 'a5d6ff' },
            { token: 'number', foreground: '79c0ff' },
            { token: 'type', foreground: 'ffa657' },
          ],
          colors: {
            'editor.background': '#1e1e1e',
            'editor.foreground': '#e6e6e6',
            'editor.lineHighlightBackground': '#2a2a2a',
            'editor.selectionBackground': '#264f78',
            'editorLineNumber.foreground': '#555555',
            'editorLineNumber.activeForeground': '#999999',
            'editorCursor.foreground': '#0a84ff',
            'editor.inactiveSelectionBackground': '#3a3d41',
            'editorIndentGuide.background': '#333333',
            'editorWidget.background': '#252526',
            'editorWidget.border': '#454545',
            'scrollbar.shadow': '#00000000',
            'scrollbarSlider.background': '#ffffff15',
            'scrollbarSlider.hoverBackground': '#ffffff25',
            'scrollbarSlider.activeBackground': '#ffffff35',
          }
        });

        monacoEditor = monaco.editor.create(document.getElementById('monaco-container'), {
          value: '; Select a config file from the sidebar to begin editing.',
          language: 'plaintext',
          theme: 'macos-dark',
          fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Menlo', 'Consolas', monospace",
          fontSize: 12,
          lineHeight: 19,
          minimap: { enabled: true, scale: 1, renderCharacters: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: true },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          padding: { top: 8, bottom: 8 },
          roundedSelection: true,
          renderLineHighlight: 'gutter',
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
          },
        });

        // Track modifications
        monacoEditor.onDidChangeModelContent(() => {
          const modified = monacoEditor.getValue() !== originalContent;
          const filenameEl = document.getElementById('editor-filename');
          filenameEl.classList.toggle('modified', modified);
          document.getElementById('btn-save-file').disabled = !modified;
          document.getElementById('btn-revert').disabled = !modified;
        });

        window.addEventListener('resize', () => monacoEditor.layout());
        resolve();
      });
    };
    document.head.appendChild(loaderScript);
  });
}

async function loadScriptFiles() {
  const files = await window.api.listScripts();
  const list = document.getElementById('script-file-list');
  list.innerHTML = '';

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'source-list-item';
    item.innerHTML = `
      <span class="item-icon">\uD83D\uDC0D</span>
      <span class="item-label">${file.name}</span>
      <span class="item-badge">${formatSize(file.size)}</span>
    `;
    item.addEventListener('click', () => openFile(file.path, file.name));
    list.appendChild(item);
  });
}

async function loadConfigFiles() {
  const files = await window.api.listConfigFiles();
  const list = document.getElementById('config-file-list');
  list.innerHTML = '';

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'source-list-item';
    item.innerHTML = `
      <span class="item-icon">\uD83D\uDCC4</span>
      <span class="item-label">${file.name}</span>
      <span class="item-badge">${formatSize(file.size)}</span>
    `;
    item.addEventListener('click', () => openFile(file.path, file.name));
    list.appendChild(item);
  });
}

async function openFile(filePath, fileName) {
  const content = await window.api.readFile(filePath);
  currentFilePath = filePath;
  originalContent = content;

  monacoEditor.setValue(content);
  document.getElementById('editor-filename').textContent = fileName;
  document.getElementById('editor-filename').classList.remove('modified');
  document.getElementById('btn-save-file').disabled = true;
  document.getElementById('btn-save-as').disabled = false;
  document.getElementById('btn-revert').disabled = true;

  // Highlight active file across both lists
  document.querySelectorAll('#script-file-list .source-list-item, #config-file-list .source-list-item').forEach(item => {
    item.classList.toggle('active', item.querySelector('.item-label').textContent === fileName);
  });

  // Auto-detect language
  if (fileName.endsWith('.py')) {
    monaco.editor.setModelLanguage(monacoEditor.getModel(), 'python');
  } else if (fileName.endsWith('.json')) {
    monaco.editor.setModelLanguage(monacoEditor.getModel(), 'json');
  } else {
    monaco.editor.setModelLanguage(monacoEditor.getModel(), 'plaintext');
  }

  // Show/hide Simple/Code toggle for .py script files
  const modeToggle = document.getElementById('editor-mode-toggle');
  const isScript = fileName.endsWith('.py') && SCRIPT_CONFIGS[fileName];
  modeToggle.style.display = isScript ? '' : 'none';

  if (isScript) {
    // Default to simple mode for scripts
    setEditorMode('simple');
    document.querySelectorAll('#editor-mode-toggle .segment').forEach(s => {
      s.classList.toggle('active', s.dataset.mode === 'simple');
    });
  } else {
    // Non-script files always use code mode
    setEditorMode('code');
  }
}

async function saveCurrentFile() {
  if (!currentFilePath) return;

  let content = monacoEditor.getValue();

  // If in simple mode, apply form changes to the source
  if (editorMode === 'simple' && currentSimpleFields.length > 0) {
    content = applySimpleEdits(content);
    monacoEditor.setValue(content);
  }

  const result = await window.api.writeFile(currentFilePath, content);
  if (result.success) {
    originalContent = content;
    document.getElementById('editor-filename').classList.remove('modified');
    document.getElementById('btn-save-file').disabled = true;
    document.getElementById('btn-revert').disabled = true;
  }
}

async function saveFileAs() {
  const content = monacoEditor.getValue();
  const defaultName = document.getElementById('editor-filename').textContent || 'config.txt';
  await window.api.saveFileAs(defaultName, content);
}

function revertFile() {
  if (!currentFilePath) return;
  monacoEditor.setValue(originalContent);
  if (editorMode === 'simple') {
    renderSimpleEditor(originalContent);
  }
  document.getElementById('editor-filename').classList.remove('modified');
  document.getElementById('btn-save-file').disabled = true;
  document.getElementById('btn-revert').disabled = true;
}

const CATEGORY_COLORS = {
  'Farms': '#4ade80',
  'Food Storage & Grain': '#86efac',
  'Heavy Industry': '#9ca3af',
  'Metal Exports': '#d1d5db',
  'Health & Sanitation': '#60a5fa',
  'Military': '#f87171',
  'Government': '#c084fc',
  'Law & Culture': '#e9d5ff',
  'Rural Exploits': '#fb923c',
  'Urban Exploits': '#facc15',
  'Ports': '#38bdf8',
  'Settlement': '#a78bfa',
  'Temples': '#f472b6',
  'Other': '#6b7280',
};

async function loadBuildingTree() {
  const buildings = await window.api.parseEdbBuildings();
  if (buildings.error) return;

  const tree = document.getElementById('building-tree');
  tree.innerHTML = '';

  // Group by category
  const groups = {};
  buildings.forEach(b => {
    const cat = b.category || 'Other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(b);
  });

  // Render groups in a defined order
  const order = ['Farms', 'Food Storage & Grain', 'Heavy Industry', 'Metal Exports',
    'Health & Sanitation', 'Military', 'Government', 'Law & Culture',
    'Rural Exploits', 'Urban Exploits', 'Ports', 'Settlement', 'Temples', 'Other'];

  for (const cat of order) {
    const items = groups[cat];
    if (!items || items.length === 0) continue;

    const color = CATEGORY_COLORS[cat] || '#6b7280';

    const group = document.createElement('div');
    group.className = 'building-group collapsed';
    group.dataset.category = cat.toLowerCase();

    const header = document.createElement('div');
    header.className = 'building-group-header';
    header.innerHTML = `
      <span class="building-group-dot" style="background:${color}"></span>
      <span class="building-group-name">${cat}</span>
      <span class="building-group-count">${items.length}</span>
      <span class="building-group-chevron">&#9662;</span>
    `;

    const list = document.createElement('div');
    list.className = 'building-group-list';

    items.forEach(b => {
      const item = document.createElement('div');
      item.className = 'building-item';
      item.dataset.name = b.name.toLowerCase();
      item.innerHTML = `
        <span class="building-dot" style="background:${color}"></span>
        <span>${b.name}</span>
        <span class="building-levels">${b.levels.length}L</span>
      `;
      item.addEventListener('click', () => jumpToBuilding(b));
      list.appendChild(item);
    });

    header.addEventListener('click', () => {
      group.classList.toggle('collapsed');
    });

    group.appendChild(header);
    group.appendChild(list);
    tree.appendChild(group);
  }
}

function jumpToBuilding(building) {
  const edbItems = document.querySelectorAll('#config-file-list .source-list-item');
  for (const item of edbItems) {
    if (item.querySelector('.item-label').textContent === 'export_descr_buildings.txt') {
      item.click();
      setTimeout(() => {
        if (monacoEditor && building.line) {
          monacoEditor.revealLineInCenter(building.line);
          monacoEditor.setPosition({ lineNumber: building.line, column: 1 });
          monacoEditor.focus();
        }
      }, 200);
      break;
    }
  }
}

function filterBuildings() {
  const query = document.getElementById('building-search').value.toLowerCase();

  document.querySelectorAll('.building-group').forEach(group => {
    let anyVisible = false;

    // Check if category name matches
    const catMatch = group.dataset.category.includes(query);

    group.querySelectorAll('.building-item').forEach(item => {
      const show = catMatch || item.dataset.name.includes(query);
      item.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
    });

    group.style.display = anyVisible ? '' : 'none';
    // Auto-expand groups when filtering
    if (query && anyVisible) group.classList.remove('collapsed');
  });
}

async function loadProfiles() {
  const profiles = await window.api.listProfiles();
  const list = document.getElementById('profile-list');
  list.innerHTML = '';

  if (profiles.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);padding:6px 8px;">No rule profiles yet. Edit scripts and save a snapshot.</div>';
    populateCompareProfiles([]);
    return;
  }

  profiles.forEach(profile => {
    const item = document.createElement('div');
    item.className = 'source-list-item profile-item';
    item.innerHTML = `
      <span class="item-label" title="${profile.description || ''}">${profile.name}</span>
      <button class="btn-load-profile">Load</button>
    `;
    item.querySelector('.btn-load-profile').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Load rule profile "${profile.name}"? This will overwrite your current scripts.`)) return;
      const result = await window.api.loadProfile(profile.name);
      if (result.success) {
        await loadScriptFiles();
        // Re-open current file if it's a script
        if (currentFilePath && currentFilePath.endsWith('.py')) {
          const fileName = currentFilePath.replace(/\\/g, '/').split('/').pop();
          await openFile(currentFilePath, fileName);
        }
      }
    });
    list.appendChild(item);
  });

  populateCompareProfiles(profiles);
}

async function saveProfile() {
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) return;

  const result = await window.api.saveProfile(name);
  if (result.success) {
    document.getElementById('profile-name-input').value = '';
    await loadProfiles();
  }
}

// ══════════════════════════════════════
//  COMPARE TAB
// ══════════════════════════════════════

function initCompare() {
  const container = document.getElementById('compare-step-checks');
  pipelineSteps.forEach(step => {
    const chip = document.createElement('label');
    chip.className = 'chip checked';
    chip.innerHTML = `
      <input type="checkbox" value="${step.id}" checked>
      <span class="chip-dot" style="background:${step.color}"></span>
      ${step.name}
    `;
    // Toggle chip visual
    chip.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') {
        // Let checkbox toggle naturally, then sync class
        setTimeout(() => {
          chip.classList.toggle('checked', e.target.checked);
        }, 0);
      } else {
        // Click on label toggles checkbox
        const cb = chip.querySelector('input');
        cb.checked = !cb.checked;
        chip.classList.toggle('checked', cb.checked);
        e.preventDefault();
      }
    });
    container.appendChild(chip);
  });

  document.getElementById('btn-run-compare').addEventListener('click', runComparison);
}

function populateCompareProfiles(profiles) {
  ['compare-profile-a', 'compare-profile-b'].forEach(id => {
    const select = document.getElementById(id);
    while (select.options.length > 1) select.remove(1);
    profiles.forEach(profile => {
      const name = typeof profile === 'string' ? profile : profile.name;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  });
}

async function runComparison() {
  const profileA = document.getElementById('compare-profile-a').value;
  const profileB = document.getElementById('compare-profile-b').value;

  const stepIds = [];
  document.querySelectorAll('#compare-step-checks input:checked').forEach(cb => {
    stepIds.push(cb.value);
  });

  if (stepIds.length === 0) {
    setCompareStatus('Select at least one step.');
    return;
  }

  if (profileA === profileB) {
    setCompareStatus('Select two different profiles to compare.');
    return;
  }

  document.getElementById('btn-run-compare').disabled = true;
  setCompareStatus('Running comparison...');

  const result = await window.api.runComparison(profileA, profileB, stepIds);

  document.getElementById('btn-run-compare').disabled = false;

  if (result.error) {
    setCompareStatus(`Error: ${result.error}`);
    return;
  }

  setCompareStatus('Comparison complete.');
  renderComparisonResults(result, profileA, profileB, stepIds);
}

function renderComparisonResults(result, profileA, profileB, stepIds) {
  const container = document.getElementById('compare-results');
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'diff-container';

  const aLines = (result.profileA.finalStrat || '').split('\n');
  const bLines = (result.profileB.finalStrat || '').split('\n');

  const aBuildingsMap = extractBuildings(aLines);
  const bBuildingsMap = extractBuildings(bLines);

  let added = 0, removed = 0, changed = 0, same = 0;
  const allRegions = new Set([...Object.keys(aBuildingsMap), ...Object.keys(bBuildingsMap)]);

  const diffRows = [];
  allRegions.forEach(region => {
    const aSet = aBuildingsMap[region] || [];
    const bSet = bBuildingsMap[region] || [];
    const aStr = aSet.sort().join(', ');
    const bStr = bSet.sort().join(', ');

    if (aStr === bStr) {
      same++;
    } else {
      const aOnly = aSet.filter(b => !bSet.includes(b));
      const bOnly = bSet.filter(b => !aSet.includes(b));
      if (aOnly.length > 0 && bOnly.length === 0) removed += aOnly.length;
      else if (bOnly.length > 0 && aOnly.length === 0) added += bOnly.length;
      else changed++;
      diffRows.push({ region, aSet, bSet, aOnly, bOnly });
    }
  });

  // Summary cards
  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  summary.innerHTML = `
    <div class="diff-stat added">
      <div class="stat-value">${added}</div>
      <div class="stat-label">Added in B</div>
    </div>
    <div class="diff-stat removed">
      <div class="stat-value">${removed}</div>
      <div class="stat-label">Removed in B</div>
    </div>
    <div class="diff-stat changed">
      <div class="stat-value">${changed}</div>
      <div class="stat-label">Changed</div>
    </div>
    <div class="diff-stat same">
      <div class="stat-value">${same}</div>
      <div class="stat-label">Unchanged</div>
    </div>
  `;
  wrapper.appendChild(summary);

  // Diff details
  if (diffRows.length > 0) {
    const diffSection = document.createElement('div');
    diffSection.className = 'diff-step-section';

    const header = document.createElement('div');
    header.className = 'diff-step-header';
    header.innerHTML = `
      <div class="diff-step-name">Building Differences (${diffRows.length} regions)</div>
      <span class="diff-step-badge different">${diffRows.length} changed</span>
    `;
    diffSection.appendChild(header);

    const body = document.createElement('div');
    body.className = 'diff-step-body open';

    const sideBySide = document.createElement('div');
    sideBySide.className = 'diff-side-by-side';

    const paneA = document.createElement('div');
    paneA.className = 'diff-pane';
    paneA.innerHTML = `<div class="diff-pane-header">Profile A: ${profileA}</div>`;
    const preA = document.createElement('pre');

    const paneB = document.createElement('div');
    paneB.className = 'diff-pane';
    paneB.innerHTML = `<div class="diff-pane-header">Profile B: ${profileB}</div>`;
    const preB = document.createElement('pre');

    diffRows.sort((a, b) => a.region.localeCompare(b.region));
    diffRows.forEach(row => {
      const lineA = `${row.region}:\n  ${row.aSet.join(', ') || '(none)'}\n\n`;
      const lineB = `${row.region}:\n  ${row.bSet.join(', ') || '(none)'}\n\n`;

      const spanA = document.createElement('span');
      spanA.className = row.aOnly.length > 0 ? 'diff-line-removed' : '';
      spanA.textContent = lineA;
      preA.appendChild(spanA);

      const spanB = document.createElement('span');
      spanB.className = row.bOnly.length > 0 ? 'diff-line-added' : '';
      spanB.textContent = lineB;
      preB.appendChild(spanB);
    });

    paneA.appendChild(preA);
    paneB.appendChild(preB);
    sideBySide.appendChild(paneA);
    sideBySide.appendChild(paneB);
    body.appendChild(sideBySide);
    diffSection.appendChild(body);

    header.addEventListener('click', () => body.classList.toggle('open'));
    wrapper.appendChild(diffSection);
  } else {
    const noChanges = document.createElement('div');
    noChanges.className = 'compare-empty';
    noChanges.innerHTML = '<p>No building differences found between the two profiles.</p>';
    wrapper.appendChild(noChanges);
  }

  container.appendChild(wrapper);
}

function extractBuildings(lines) {
  const buildings = {};
  let currentRegion = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const regionMatch = trimmed.match(/^\s*region\s+(\S+)/);
    if (regionMatch) {
      currentRegion = regionMatch[1];
      if (!buildings[currentRegion]) buildings[currentRegion] = [];
    }
    const typeMatch = trimmed.match(/^\s*type\s+(\S+)\s+(\S+)/);
    if (typeMatch && currentRegion) {
      buildings[currentRegion].push(`${typeMatch[1]}:${typeMatch[2]}`);
    }
  }

  return buildings;
}

function setCompareStatus(msg) {
  document.getElementById('compare-status').textContent = msg;
}

// ══════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════

function setupEventListeners() {
  window.api.onStepOutput((data) => {
    appendConsole(data.text, data.stream);
  });

  window.api.onComparisonStatus((msg) => {
    setCompareStatus(msg);
  });
}

// ── Helpers ──

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ══════════════════════════════════════
//  MASTER TAB — building allowlist + run
// ══════════════════════════════════════

const MASTER_CATEGORY_ORDER = [
  'Farms', 'Food Storage & Grain', 'Heavy Industry', 'Metal Exports',
  'Health & Sanitation', 'Military', 'Government', 'Law & Culture',
  'Rural Exploits', 'Urban Exploits', 'Ports', 'Settlement', 'Temples', 'Other',
];

const MASTER_PIPELINE_STEPS = [
  { id: '00_hidden_resources',    name: 'Hidden Resources' },
  { id: '01_farms',               name: 'Farms' },
  { id: '02_heavy_industry',      name: 'Heavy Industry' },
  { id: '03_sanitation_healers',  name: 'Sanitation' },
  { id: '04_mics',                name: 'Military' },
  { id: '05_homelands',           name: 'Homelands' },
  { id: '06_rural_exploits',      name: 'Rural Exploits' },
  { id: '07_urban_exploits',      name: 'Urban Exploits' },
  { id: '08_port_authority',      name: 'Port Authority' },
  { id: '09_settlement_processor',name: 'Settlement Processor' },
  { id: '10_slave_placer',        name: 'Slave Placer' },
  { id: 'allowlist',               name: 'Apply Allowlist' },
];

// Mutable in-memory state
let masterBuildings = [];   // raw EDB chains [{ name, levels, category, ... }]
let masterAllow = {};       // { chainName: { allowed: bool, levels: { levelName: bool } } }
let masterStats = null;     // { chains: {name: count}, levels: {chain:{lvl:count}}, totalBuildings, settlementCount }
let masterRunning = false;
let masterViewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('master.view')) || 'grid';

const MASTER_EXPAND_KEY = 'master.expanded.v1';
function loadExpandState() {
  try { return JSON.parse(localStorage.getItem(MASTER_EXPAND_KEY) || '{}'); }
  catch { return {}; }
}
function saveExpandState(state) {
  try { localStorage.setItem(MASTER_EXPAND_KEY, JSON.stringify(state)); }
  catch {}
}

function initMaster() {
  document.getElementById('btn-run-master').addEventListener('click', runMaster);
  document.getElementById('btn-master-clear').addEventListener('click', () => {
    document.getElementById('master-console').textContent = '';
    document.getElementById('master-step-list').innerHTML = '';
    document.getElementById('master-result-row').style.display = 'none';
    document.getElementById('master-drop-detail').innerHTML = '';
    document.getElementById('master-progress-fill').style.width = '0%';
    setMasterStatus('Ready');
  });
  document.getElementById('btn-master-all').addEventListener('click', () => masterToggleAll(true));
  document.getElementById('btn-master-none').addEventListener('click', () => masterToggleAll(false));
  document.getElementById('master-search').addEventListener('input', filterMasterTree);
  document.getElementById('btn-master-save-mod').addEventListener('click', () => saveBackToMod());

  // Pane toggle (Steps vs Output)
  document.querySelectorAll('#master-pane-toggle .segment').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#master-pane-toggle .segment').forEach(s => s.classList.remove('active'));
      seg.classList.add('active');
      document.querySelectorAll('.master-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(`master-pane-${seg.dataset.pane}`).classList.add('active');
    });
  });

  // Presets
  document.getElementById('master-preset').addEventListener('change', (ev) => {
    const v = ev.target.value;
    if (v) {
      applyPreset(v);
      ev.target.value = '';
    }
  });

  // Grid / list view toggle
  const viewToggle = document.getElementById('master-view-toggle');
  if (viewToggle) {
    // Sync initial active state with persisted mode
    viewToggle.querySelectorAll('.segment').forEach(seg => {
      seg.classList.toggle('active', seg.dataset.view === masterViewMode);
      seg.addEventListener('click', () => {
        if (masterRunning) return;
        const view = seg.dataset.view;
        if (view === masterViewMode) return;
        masterViewMode = view;
        try { localStorage.setItem('master.view', view); } catch {}
        viewToggle.querySelectorAll('.segment').forEach(s => s.classList.toggle('active', s === seg));
        renderMasterTree();
      });
    });
  }

  window.api.onMasterOutput(({ text, stream }) => {
    appendMasterConsole(text, stream === 'stderr' ? 'log-stderr' : 'log-stdout');

    // Per-step status events from master_processor.py:
    //   [NN_step] running...
    //   [NN_step] ok
    //   [allowlist] applying filter...
    //   [allowlist] kept X buildings, dropped Y
    const stepM = text.match(/\[(\d{2}_[a-z_]+|allowlist)\]\s+(running|ok|applying)/);
    if (stepM) {
      const id = stepM[1];
      const state = stepM[2];
      if (state === 'running' || state === 'applying') {
        markStepRunning(id);
      } else if (state === 'ok') {
        markStepDone(id);
      }
    }

    if (text.includes('[allowlist] applying filter')) {
      setMasterStatus('Applying allowlist...');
    }
    const drop = text.match(/\[allowlist\] kept (\d+) buildings, dropped (\d+)/);
    if (drop) {
      const kept = +drop[1], dropped = +drop[2];
      setMasterStatus(`Allowlist: ${dropped} dropped, ${kept} kept`);
      showRunResult(kept, dropped);
      markStepDone('allowlist');
    }

    // Per-chain drop count detail (printed by master_processor as "  - chain: N")
    const dropChain = text.match(/^\s*-\s+([\w_]+):\s+(\d+)\s*$/m);
    if (dropChain) addDropDetailRow(dropChain[1], +dropChain[2]);
  });
  window.api.onMasterDone((result) => {
    masterRunning = false;
    setMasterStatus(result.success ? 'Done' : 'Error');
    document.getElementById('btn-run-master').disabled = false;
    document.getElementById('btn-master-save-mod').disabled = !result.success;
    document.getElementById('master-progress-fill').style.width = '100%';
    // Refresh stats after a successful run
    if (result.success) refreshStratStats();
  });

  // Load tree the first time the Master tab is shown.
  document.querySelector('.titlebar-center .segment[data-tab="master"]')
    .addEventListener('click', () => {
      if (masterBuildings.length === 0) loadMasterTree();
    });
}

function applyPreset(preset) {
  if (preset === 'all') {
    masterToggleAll(true); return;
  }
  if (preset === 'none') {
    masterToggleAll(false); return;
  }
  const blockedCategories = {
    no_military: ['Military'],
    no_health: ['Health & Sanitation'],
    economy_only: ['Military', 'Temples'],
    essentials_only: ['Military', 'Heavy Industry', 'Metal Exports',
                      'Rural Exploits', 'Urban Exploits', 'Temples',
                      'Health & Sanitation', 'Law & Culture', 'Ports'],
  };
  const blocked = new Set(blockedCategories[preset] || []);
  for (const b of masterBuildings) {
    const allowChain = !blocked.has(b.category || 'Other');
    masterAllow[b.name].allowed = allowChain;
    for (const k of Object.keys(masterAllow[b.name].levels)) {
      masterAllow[b.name].levels[k] = allowChain;
    }
  }
  renderMasterTree();
  saveAllowlistDebounced();
  updateMasterSummary();
}

async function loadMasterTree() {
  setMasterStatus('Loading EDB...');
  const tree = document.getElementById('master-tree');

  // Bail with a clear message if no mod is imported yet
  if (!currentModData || !currentModData.dataDir) {
    tree.innerHTML = `
      <div class="master-empty">
        <div class="master-empty-icon">⌬</div>
        <div class="master-empty-text">No mod imported yet</div>
        <div class="master-empty-sub">Go to the Pipeline tab → Source → Browse to load a mod first.</div>
      </div>`;
    setMasterStatus('No mod loaded');
    return;
  }

  tree.innerHTML = `
    <div class="master-empty">
      <div class="master-empty-icon">⌬</div>
      <div class="master-empty-text">Parsing export_descr_buildings.txt...</div>
      <div class="master-empty-sub">This takes a moment for large mods.</div>
    </div>`;
  console.log('[master] loading tree, mod dataDir =', currentModData.dataDir);
  const [buildings, stats] = await Promise.all([
    window.api.parseEdbBuildings(),
    window.api.getStratStats().catch(() => null),
  ]);
  if (!Array.isArray(buildings)) {
    setMasterStatus('Failed: ' + (buildings && buildings.error || 'EDB parse error'));
    tree.innerHTML = `
      <div class="master-empty">
        <div class="master-empty-icon">!</div>
        <div class="master-empty-text">Couldn't parse EDB</div>
        <div class="master-empty-sub">Make sure a mod is imported (Pipeline tab → Source).</div>
      </div>`;
    return;
  }
  console.log('[master] EDB parsed, chains =', buildings.length, 'TGA decoder =', typeof TGA);
  masterStats = stats;
  masterBuildings = buildings;

  // Load persisted allowlist; default everything to allowed.
  const saved = await window.api.loadAllowlist();
  masterAllow = {};
  for (const b of buildings) {
    const savedChain = saved && saved.chains && saved.chains[b.name];
    const chainAllowed = savedChain ? !!savedChain.allowed : true;
    const levels = {};
    for (const lvl of b.levels) {
      const lname = lvl.name;
      const savedLevel = savedChain && savedChain.levels && (lname in savedChain.levels)
        ? !!savedChain.levels[lname]
        : true;
      levels[lname] = savedLevel;
    }
    masterAllow[b.name] = { allowed: chainAllowed, levels };
  }

  renderMasterTree();
  updateMasterSummary();
  setMasterStatus('Ready');
}

function renderMasterTree() {
  if (masterViewMode === 'list') renderMasterList();
  else renderMasterGrid();
}

function renderMasterList() {
  const tree = document.getElementById('master-tree');
  tree.classList.remove('grid-mode');
  tree.innerHTML = '';
  const expand = loadExpandState();

  const groups = {};
  for (const b of masterBuildings) {
    const cat = b.category || 'Other';
    (groups[cat] = groups[cat] || []).push(b);
  }

  for (const cat of MASTER_CATEGORY_ORDER) {
    const items = groups[cat];
    if (!items || !items.length) continue;
    const color = (typeof CATEGORY_COLORS !== 'undefined' && CATEGORY_COLORS[cat]) || '#6b7280';

    const section = document.createElement('div');
    section.className = 'mg-section';
    section.dataset.category = cat;
    // Default = expanded; respect the persisted state.
    if (expand[cat] === false) section.classList.add('collapsed');

    const allOn = items.every(b => masterAllow[b.name].allowed);

    const header = document.createElement('div');
    header.className = 'mg-section-header';

    const chevron = document.createElement('span');
    chevron.className = 'mg-section-chevron';
    chevron.textContent = '›';

    const dot = document.createElement('span');
    dot.className = 'mg-section-dot';
    dot.style.background = color;
    const name = document.createElement('span');
    name.className = 'mg-section-name';
    name.textContent = cat;
    const count = document.createElement('span');
    count.className = 'mg-section-count';
    const onCount = items.filter(b => masterAllow[b.name].allowed).length;
    count.textContent = `${onCount}/${items.length}`;
    const toggle = document.createElement('button');
    toggle.className = 'mg-section-toggle';
    toggle.textContent = allOn ? 'NONE' : 'ALL';
    header.append(chevron, dot, name, count, toggle);

    // Click anywhere on the header toggles collapse, except on the All/None button.
    header.addEventListener('click', (ev) => {
      if (ev.target === toggle) return;
      section.classList.toggle('collapsed');
      const state = loadExpandState();
      state[cat] = !section.classList.contains('collapsed');
      saveExpandState(state);
    });

    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const target = !allOn;
      for (const b of items) {
        masterAllow[b.name].allowed = target;
        for (const k of Object.keys(masterAllow[b.name].levels)) {
          masterAllow[b.name].levels[k] = target;
        }
      }
      renderMasterTree();
      saveAllowlistDebounced();
      updateMasterSummary();
    });

    const list = document.createElement('div');
    list.className = 'ml-section-body';
    list.style.padding = '0 8px 6px';

    for (const b of items) {
      const row = document.createElement('div');
      row.className = 'ml-row' + (masterAllow[b.name].allowed ? '' : ' blocked');
      row.dataset.chain = b.name;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ml-check';
      cb.checked = !!masterAllow[b.name].allowed;
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', () => {
        const target = !!cb.checked;
        masterAllow[b.name].allowed = target;
        for (const k of Object.keys(masterAllow[b.name].levels)) {
          masterAllow[b.name].levels[k] = target;
        }
        renderMasterTree();
        saveAllowlistDebounced();
        updateMasterSummary();
      });

      const rDot = document.createElement('span');
      rDot.className = 'ml-dot';
      rDot.style.background = color;

      const rName = document.createElement('span');
      rName.className = 'ml-name';
      rName.textContent = b.name;

      const usage = (masterStats && masterStats.chains[b.name]) || 0;
      const drop = computeChainDrop(b.name);

      const usageBadge = document.createElement('span');
      usageBadge.className = 'ml-stat';
      usageBadge.textContent = usage > 0 ? `${usage}` : '·';

      const dropBadge = document.createElement('span');
      dropBadge.className = 'ml-drop' + (drop === 0 ? ' zero' : '');
      dropBadge.textContent = drop > 0 ? `−${drop}` : '';

      const lvlCount = document.createElement('span');
      lvlCount.className = 'ml-stat';
      lvlCount.textContent = `${b.levels.length}L`;

      row.append(cb, rDot, rName, usageBadge, dropBadge, lvlCount);

      // Click anywhere on the row toggles the checkbox.
      row.addEventListener('click', (ev) => {
        if (ev.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      list.appendChild(row);
    }

    section.appendChild(header);
    section.appendChild(list);
    tree.appendChild(section);
  }
}

// Building-icon cache (renderer-side) — same shape as Provincia's:
//   `${culture}|${level}` → blob URL | "none"
const _iconCache = new Map();
const _iconInflight = new Map();

function _pixelsToBlobUrl(width, height, pixels) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  img.data.set(new Uint8ClampedArray(pixels));
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), 'image/png');
  });
}

function loadBuildingIcon(modDataDir, culture, levelName, chainName) {
  if (!culture || !levelName) return Promise.resolve(null);
  const key = `${culture}|${levelName}`;
  if (_iconCache.has(key)) {
    const v = _iconCache.get(key);
    return Promise.resolve(v === 'none' ? null : v);
  }
  if (_iconInflight.has(key)) return _iconInflight.get(key);

  const p = (async () => {
    try {
      const res = await window.api.resolveBuildingIcon(modDataDir, culture, levelName, chainName || null);
      if (!res || !res.buffer) {
        if ((globalThis.__iconMissCount = (globalThis.__iconMissCount || 0) + 1) <= 5) {
          console.warn('[icon] miss:', culture, '/', chainName || '?', '/', levelName);
        }
        _iconCache.set(key, 'none');
        return null;
      }
      if (typeof TGA !== 'function') {
        console.error('[icon] TGA decoder not loaded!');
        _iconCache.set(key, 'none');
        return null;
      }
      const tga = new TGA(new Uint8Array(res.buffer));
      if (!tga.width || !tga.height || !tga.pixels) {
        console.warn('[icon] decode failed for', levelName, 'path:', res.path);
        _iconCache.set(key, 'none');
        return null;
      }
      const url = await _pixelsToBlobUrl(tga.width, tga.height, tga.pixels);
      _iconCache.set(key, url || 'none');
      return url || null;
    } catch (e) {
      console.error('[icon] error for', levelName, e);
      _iconCache.set(key, 'none');
      return null;
    } finally {
      _iconInflight.delete(key);
    }
  })();
  _iconInflight.set(key, p);
  return p;
}

let _iconObserver = null;
function ensureIconObserver() {
  if (_iconObserver) return _iconObserver;
  // Use the scrollable section as the observation root so tiles below the
  // fold of an internal scroll container fire correctly. Falls back to the
  // viewport if the section isn't there yet.
  const scrollRoot = document.querySelector('.master-tree-section') || null;
  _iconObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      _iconObserver.unobserve(el);
      const lvlName = el.dataset.iconLevel;
      const chainName = el.dataset.iconChain;
      if (!lvlName) continue;
      const modDataDir = (typeof currentModData !== 'undefined' && currentModData) ? currentModData.dataDir : null;
      const culture = el.dataset.iconCulture || 'roman';
      try {
        const url = await loadBuildingIcon(modDataDir, culture, lvlName, chainName);
        if (url && el.isConnected) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = lvlName;
          el.classList.remove('placeholder');
          el.replaceChildren(img);
        }
      } catch (e) {
        console.error('[icon] observer error:', e);
      }
    }
  }, { root: scrollRoot, rootMargin: '300px 0px' });
  return _iconObserver;
}

function renderMasterGrid() {
  const tree = document.getElementById('master-tree');
  tree.classList.add('grid-mode');
  tree.innerHTML = '';
  const expand = loadExpandState();
  const obs = ensureIconObserver();

  // Group by category
  const groups = {};
  for (const b of masterBuildings) {
    const cat = b.category || 'Other';
    (groups[cat] = groups[cat] || []).push(b);
  }

  for (const cat of MASTER_CATEGORY_ORDER) {
    const items = groups[cat];
    if (!items || !items.length) continue;
    const color = (typeof CATEGORY_COLORS !== 'undefined' && CATEGORY_COLORS[cat]) || '#6b7280';

    const section = document.createElement('div');
    section.className = 'mg-section';
    section.dataset.category = cat;

    const allOn = items.every(b => masterAllow[b.name].allowed);
    const noneOn = items.every(b => !masterAllow[b.name].allowed);

    const header = document.createElement('div');
    header.className = 'mg-section-header';
    const dot = document.createElement('span');
    dot.className = 'mg-section-dot';
    dot.style.background = color;
    const name = document.createElement('span');
    name.className = 'mg-section-name';
    name.textContent = cat;
    const count = document.createElement('span');
    count.className = 'mg-section-count';
    const onCount = items.filter(b => masterAllow[b.name].allowed).length;
    count.textContent = `${onCount}/${items.length}`;
    const toggle = document.createElement('button');
    toggle.className = 'mg-section-toggle';
    toggle.textContent = allOn ? 'NONE' : 'ALL';
    toggle.title = allOn ? 'Block every building in this category' : 'Allow every building in this category';

    header.appendChild(dot);
    header.appendChild(name);
    header.appendChild(count);
    header.appendChild(toggle);

    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const target = !allOn;
      for (const b of items) {
        masterAllow[b.name].allowed = target;
        for (const k of Object.keys(masterAllow[b.name].levels)) {
          masterAllow[b.name].levels[k] = target;
        }
      }
      renderMasterGrid();
      saveAllowlistDebounced();
      updateMasterSummary();
    });

    const grid = document.createElement('div');
    grid.className = 'mg-grid';

    for (const b of items) {
      const tile = document.createElement('div');
      tile.className = 'mg-tile' + (masterAllow[b.name].allowed ? ' allowed' : ' blocked');
      tile.dataset.chain = b.name;

      const usage = (masterStats && masterStats.chains[b.name]) || 0;
      const drop = computeChainDrop(b.name);
      tile.title = b.name
        + (usage > 0 ? `\n${usage} settlements use this` : '\n(unused in current strat)')
        + (drop > 0 ? `\n${drop} would be stripped on next run` : '');

      // Icon — placeholder until lazy-load resolves it
      const iconWrap = document.createElement('div');
      iconWrap.className = 'mg-tile-icon placeholder';
      iconWrap.textContent = b.name.charAt(0).toUpperCase();
      const repLevel = (b.levels[0] && b.levels[0].name) || b.name;
      iconWrap.dataset.iconLevel = repLevel;
      iconWrap.dataset.iconChain = b.name;
      iconWrap.dataset.iconCulture = 'roman';  // RIS keeps art under roman/
      obs.observe(iconWrap);

      const lbl = document.createElement('div');
      lbl.className = 'mg-tile-name';
      lbl.textContent = b.name;

      const usageBadge = document.createElement('span');
      usageBadge.className = 'mg-tile-usage' + (usage === 0 ? ' zero' : '');
      usageBadge.textContent = String(usage);

      const dropBadge = document.createElement('span');
      dropBadge.className = 'mg-tile-drop' + (drop === 0 ? ' zero' : '');
      dropBadge.textContent = `−${drop}`;

      tile.appendChild(iconWrap);
      tile.appendChild(lbl);
      tile.appendChild(usageBadge);
      tile.appendChild(dropBadge);

      tile.addEventListener('click', () => {
        const wasAllowed = masterAllow[b.name].allowed;
        const target = !wasAllowed;
        masterAllow[b.name].allowed = target;
        for (const k of Object.keys(masterAllow[b.name].levels)) {
          masterAllow[b.name].levels[k] = target;
        }
        renderMasterGrid();
        saveAllowlistDebounced();
        updateMasterSummary();
      });

      grid.appendChild(tile);
    }

    section.appendChild(header);
    section.appendChild(grid);
    tree.appendChild(section);
  }
}

function masterToggleAll(target) {
  for (const b of masterBuildings) {
    masterAllow[b.name].allowed = target;
    for (const k of Object.keys(masterAllow[b.name].levels)) {
      masterAllow[b.name].levels[k] = target;
    }
  }
  renderMasterTree();
  saveAllowlistDebounced();
  updateMasterSummary();
}

function filterMasterTree() {
  const q = (document.getElementById('master-search').value || '').toLowerCase();
  document.querySelectorAll('#master-tree .mg-section').forEach(section => {
    const cat = (section.dataset.category || '').toLowerCase();
    const catMatch = cat.includes(q);
    let anyVisible = false;
    section.querySelectorAll('.mg-tile, .ml-row').forEach(item => {
      const cn = (item.dataset.chain || '').toLowerCase();
      const show = !q || catMatch || cn.includes(q);
      item.hidden = !show;
      if (show) anyVisible = true;
    });
    section.style.display = anyVisible ? '' : 'none';
  });
}

let _saveAllowlistTimer = null;
function saveAllowlistDebounced() {
  if (_saveAllowlistTimer) clearTimeout(_saveAllowlistTimer);
  _saveAllowlistTimer = setTimeout(async () => {
    const data = { chains: masterAllow };
    await window.api.saveAllowlist(data);
  }, 200);
}

function updateMasterSummary() {
  let chainsOn = 0, chainsTotal = 0, levelsOn = 0, levelsTotal = 0;
  for (const name of Object.keys(masterAllow)) {
    chainsTotal++;
    if (masterAllow[name].allowed) chainsOn++;
    for (const lvl of Object.keys(masterAllow[name].levels)) {
      levelsTotal++;
      if (masterAllow[name].levels[lvl]) levelsOn++;
    }
  }
  document.getElementById('master-summary-allowed').textContent =
    `${chainsOn}/${chainsTotal} chains · ${levelsOn}/${levelsTotal} levels`;

  // Live drop preview against current strat
  const totalDrop = computeTotalDrop();
  const row = document.getElementById('master-summary-drop-row');
  if (totalDrop > 0 && masterStats) {
    row.style.display = '';
    document.getElementById('master-summary-drop').textContent = `${totalDrop} buildings`;
  } else if (masterStats) {
    row.style.display = '';
    const el = document.getElementById('master-summary-drop');
    el.textContent = '0';
    el.classList.remove('drop');
    setTimeout(() => el.classList.add('drop'), 0);
  } else {
    row.style.display = 'none';
  }
}

// How many `type chain X` lines would be stripped if we ran the master right now,
// based on the current allowlist and the live stats from descr_strat.txt.
function computeChainDrop(chainName) {
  if (!masterStats || !masterStats.levels[chainName]) return 0;
  const ce = masterAllow[chainName];
  if (!ce) return 0;
  if (!ce.allowed) {
    // entire chain disabled → all usage counts as dropped
    return masterStats.chains[chainName] || 0;
  }
  // chain allowed but specific levels may be off
  let dropped = 0;
  for (const [lvl, count] of Object.entries(masterStats.levels[chainName])) {
    if (ce.levels[lvl] === false) dropped += count;
  }
  return dropped;
}
function computeTotalDrop() {
  if (!masterStats) return 0;
  let total = 0;
  for (const chain of Object.keys(masterStats.chains)) {
    total += computeChainDrop(chain);
  }
  return total;
}

async function refreshStratStats() {
  try {
    masterStats = await window.api.getStratStats();
  } catch {
    masterStats = null;
  }
  if (masterBuildings.length) {
    renderMasterTree();
    updateMasterSummary();
  }
}

// ── Run progress visualisation ──

function buildStepCards() {
  const list = document.getElementById('master-step-list');
  list.innerHTML = '';
  for (const step of MASTER_PIPELINE_STEPS) {
    const card = document.createElement('div');
    card.className = 'master-step-card';
    card.dataset.id = step.id;

    const icon = document.createElement('div');
    icon.className = 'master-step-icon';
    icon.textContent = '○';

    const name = document.createElement('div');
    name.className = 'master-step-name';
    name.textContent = step.name;

    const detail = document.createElement('div');
    detail.className = 'master-step-detail';
    detail.textContent = '';

    card.appendChild(icon);
    card.appendChild(name);
    card.appendChild(detail);
    list.appendChild(card);
  }
}

function findStepCard(id) {
  return document.querySelector(`.master-step-card[data-id="${id}"]`);
}

function markStepRunning(id) {
  const card = findStepCard(id);
  if (!card) return;
  card.classList.remove('done', 'error');
  card.classList.add('running');
  card.querySelector('.master-step-icon').textContent = '◐';
}

function markStepDone(id) {
  const card = findStepCard(id);
  if (!card) return;
  card.classList.remove('running', 'error');
  card.classList.add('done');
  card.querySelector('.master-step-icon').textContent = '✓';
  // Update progress bar
  const cards = document.querySelectorAll('.master-step-card');
  const done = document.querySelectorAll('.master-step-card.done').length;
  const pct = Math.round((done / cards.length) * 100);
  document.getElementById('master-progress-fill').style.width = `${pct}%`;
}

function showRunResult(kept, dropped) {
  document.getElementById('master-result-row').style.display = '';
  document.getElementById('master-result-kept').textContent = kept.toLocaleString();
  document.getElementById('master-result-dropped').textContent = dropped.toLocaleString();
}

function addDropDetailRow(chain, count) {
  const cont = document.getElementById('master-drop-detail');
  if (!cont.dataset.hasHeader) {
    const h = document.createElement('div');
    h.className = 'master-summary-label';
    h.style.padding = '8px 12px 4px';
    h.textContent = 'Top dropped chains';
    cont.appendChild(h);
    cont.dataset.hasHeader = '1';
  }
  const row = document.createElement('div');
  row.className = 'master-drop-detail-row';
  const name = document.createElement('span');
  name.className = 'master-drop-detail-name';
  name.textContent = chain;
  const cnt = document.createElement('span');
  cnt.className = 'master-drop-detail-count';
  cnt.textContent = `−${count}`;
  row.appendChild(name);
  row.appendChild(cnt);
  cont.appendChild(row);
}

function setMasterStatus(text) {
  document.getElementById('master-status').textContent = text;
}

function appendMasterConsole(text, cls) {
  const el = document.getElementById('master-console');
  if (cls && cls !== 'log-stdout') {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    el.appendChild(span);
  } else {
    el.appendChild(document.createTextNode(text));
  }
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

async function runMaster() {
  if (masterRunning) return;
  masterRunning = true;
  setMasterStatus('Starting...');
  document.getElementById('btn-run-master').disabled = true;
  document.getElementById('btn-master-save-mod').disabled = true;
  document.getElementById('master-console').textContent = '';
  document.getElementById('master-result-row').style.display = 'none';
  const drop = document.getElementById('master-drop-detail');
  drop.innerHTML = '';
  delete drop.dataset.hasHeader;
  document.getElementById('master-progress-fill').style.width = '0%';
  buildStepCards();
  await window.api.saveAllowlist({ chains: masterAllow });
  await window.api.runMaster();
}
