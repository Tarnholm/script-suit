const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// Pin the AppUserModelID so taskbar / Start-Menu pins survive auto-updates.
// NSIS sets the installed shortcut's AppUserModelID from package.json's appId;
// setting the same value here on every launch keeps the pin anchored to the new
// exe after an electron-updater reinstall. (Mirrors Provincia.)
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.apple.settlement-processor'); } catch {}
}

let mainWindow;

// In dev: electron-gui/../ = project root
// In packaged: scripts live in resources/app_data/, but user data (config, output, profiles)
// goes to a writable location in AppData
const SCRIPTS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app_data')
  : path.resolve(__dirname, '..');

const PROJECT_ROOT = app.isPackaged
  ? path.join(app.getPath('userData'), 'project')
  : path.resolve(__dirname, '..');

// On first run in packaged mode, copy bundled scripts + config to writable location
if (app.isPackaged) {
  const projDir = PROJECT_ROOT;
  if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

  // Always update scripts from bundle so they match the installed version
  const srcScripts = SCRIPTS_DIR;
  for (const file of fs.readdirSync(srcScripts)) {
    if (file.endsWith('.py')) {
      fs.copyFileSync(path.join(srcScripts, file), path.join(projDir, file));
    }
  }

  // Copy default config — create folder if missing, and add any new files from bundle
  const srcConfig = path.join(srcScripts, 'config');
  const destConfig = path.join(projDir, 'config');
  if (fs.existsSync(srcConfig)) {
    if (!fs.existsSync(destConfig)) fs.mkdirSync(destConfig, { recursive: true });
    for (const file of fs.readdirSync(srcConfig)) {
      const dest = path.join(destConfig, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(srcConfig, file), dest);
      }
    }
  }
}

// Pipeline step definitions
const PIPELINE_STEPS = [
  { id: 'hidden_resources', name: 'Hidden Resources', script: 'hidden_resources.py', color: '#e879f9' },
  { id: 'farms', name: 'Farms', script: 'farms.py', color: '#4ade80' },
  { id: 'heavy_industry', name: 'Heavy Industry', script: 'heavy_industry.py', color: '#9ca3af' },
  { id: 'sanitation', name: 'Sanitation', script: 'sanitation_healers.py', color: '#60a5fa' },
  { id: 'military', name: 'Military', script: 'mics.py', color: '#f87171' },
  { id: 'homelands', name: 'Homelands', script: 'homelands.py', color: '#c084fc' },
  { id: 'rural_exploits', name: 'Rural Exploits', script: 'rural_exploits.py', color: '#fb923c' },
  { id: 'urban_exploits', name: 'Urban Exploits', script: 'urban_exploits.py', color: '#facc15' },
  { id: 'port_authority', name: 'Port Authority', script: 'port_authority.py', color: '#38bdf8' },
  { id: 'settlement_processor', name: 'Core Buildings', script: 'settlement_processor.py', color: '#a78bfa' },
  { id: 'temples', name: 'Temples', script: 'temples.py', color: '#fbbf24' },
  { id: 'civic', name: 'Civic Buildings', script: 'civic.py', color: '#34d399' },
  { id: 'slave_placer', name: 'Slave Placer', script: 'slave_placer.py', color: '#f472b6' },
  { id: 'port_mercenaries', name: 'Port Mercenaries', script: 'port_mercenaries.py', color: '#2dd4bf' },
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: "Apple's Settlement Processor Suite",
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#26262800',
      symbolColor: '#999999',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
  // Auto-update: one check on startup (packaged builds only — dev would 404).
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(err =>
      console.warn('[updater] startup check failed:', err.message));
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Auto-update (electron-updater) ──────────────────────────────────────
// Ported from Provincia. Reads the GitHub Releases feed configured under
// build.publish in package.json. Fails silently (with a log line) if there's
// no network, no feed, or it's a dev run. Emits an `update-status` IPC event
// to the renderer so the GUI can show a toast / "Restart & install" banner.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

// Cache the most recent status so the renderer can query it on mount and
// recover from the race where main fires events before the renderer subscribes.
let lastUpdateStatus = null;
function sendUpdateEvent(channel, payload) {
  if (channel === 'update-status') lastUpdateStatus = payload;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

autoUpdater.on('update-available', (info) => {
  console.log('[updater] update available:', info.version);
  sendUpdateEvent('update-status', { state: 'available', version: info.version });
});
autoUpdater.on('update-not-available', () => {
  sendUpdateEvent('update-status', { state: 'none' });
});
autoUpdater.on('download-progress', (p) => {
  sendUpdateEvent('update-status', { state: 'downloading', percent: Math.round(p.percent || 0) });
});
autoUpdater.on('update-downloaded', (info) => {
  console.log('[updater] downloaded:', info.version);
  sendUpdateEvent('update-status', { state: 'downloaded', version: info.version });
});
autoUpdater.on('error', (err) => {
  console.warn('[updater] error:', err.message);
  sendUpdateEvent('update-status', { state: 'error', message: err.message });
});

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-update-status', async () => lastUpdateStatus);
ipcMain.handle('updater-check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev build' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
});
ipcMain.handle('updater-quit-and-install', () => {
  // (isSilent, isForceRunAfter): skip the NSIS wizard and relaunch after install.
  autoUpdater.quitAndInstall(true, true);
  return true;
});

// ── IPC Handlers ──

ipcMain.handle('get-pipeline-steps', () => PIPELINE_STEPS);
ipcMain.handle('get-project-root', () => PROJECT_ROOT);

// ── Mod / Game Import ──

const MOD_FILE_MAP = [
  { name: 'descr_strat.txt', dirs: ['campaign'] },
  { name: 'descr_regions.txt', dirs: ['campaign', 'world/maps/base'] },
  { name: 'map_regions.tga', dirs: ['campaign', 'world/maps/base'] },
  { name: 'export_descr_buildings.txt', dirs: ['.'] },
  { name: 'descr_sm_factions.txt', dirs: ['.'] },
  { name: 'descr_win_conditions.txt', dirs: ['campaign'] },
];

const PREFS_FILE = path.join(PROJECT_ROOT, '.gui_prefs.json');

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch (e) {}
  return {};
}

function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch (e) {}
}

function findDataDir(root) {
  const candidates = [
    // root IS the data dir (e.g. selected "data/" directly)
    [root, path.dirname(root)],
    // root contains data/
    [path.join(root, 'data'), root],
  ];
  // Additional sub-paths (macOS app bundles, etc.)
  for (const sub of ['Contents/Resources/Data/data', 'Contents/Resources/Data', 'Data/data', 'Data']) {
    candidates.push([path.join(root, sub), root]);
  }

  for (const [dataDir, displayRoot] of candidates) {
    const campaignPath = path.join(dataDir, 'world', 'maps', 'campaign');
    if (fs.existsSync(campaignPath) && fs.statSync(campaignPath).isDirectory()) {
      return { dataDir, displayRoot };
    }
  }
  return null;
}

function findCampaigns(dataDir) {
  const found = new Set();

  // Standard location: data/world/maps/campaign/<name>/descr_strat.txt
  const campaignBase = path.join(dataDir, 'world', 'maps', 'campaign');
  if (fs.existsSync(campaignBase)) {
    for (const d of fs.readdirSync(campaignBase, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(campaignBase, d.name, 'descr_strat.txt'))) {
        found.add(d.name);
      }
    }
  }

  // Also check original_overrides (Rome Remastered override system)
  const overrideBase = path.join(dataDir, 'original_overrides', 'resource_quantity', 'world', 'maps', 'campaign');
  if (fs.existsSync(overrideBase)) {
    for (const d of fs.readdirSync(overrideBase, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(overrideBase, d.name, 'descr_strat.txt'))) {
        found.add(d.name);
      }
    }
  }

  return [...found].sort();
}

// Select mod folder — returns folder info + campaigns
ipcMain.handle('select-mod-folder', async () => {
  const prefs = loadPrefs();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Mod or Game Folder',
    defaultPath: prefs.lastModFolder || undefined,
  });
  if (result.canceled) return null;

  const selectedPath = result.filePaths[0];
  const found = findDataDir(selectedPath);
  if (!found) {
    return { error: 'No campaign data found. Select the mod/game root folder (the one containing "data/").' };
  }

  const campaigns = findCampaigns(found.dataDir);
  if (campaigns.length === 0) {
    return { error: 'No campaigns found in this folder.' };
  }

  // Save prefs
  prefs.lastModFolder = selectedPath;
  prefs.lastDataDir = found.dataDir;
  prefs.lastDisplayRoot = found.displayRoot;
  savePrefs(prefs);

  return {
    modFolder: selectedPath,
    dataDir: found.dataDir,
    displayName: path.basename(found.displayRoot),
    campaigns,
    selectedCampaign: prefs.lastCampaign && campaigns.includes(prefs.lastCampaign)
      ? prefs.lastCampaign : campaigns[0],
  };
});

// Load saved mod prefs on startup
ipcMain.handle('get-mod-prefs', async () => {
  const prefs = loadPrefs();
  console.log('[get-mod-prefs] prefs:', JSON.stringify(prefs));
  console.log('[get-mod-prefs] PREFS_FILE:', PREFS_FILE);
  console.log('[get-mod-prefs] lastDataDir exists:', prefs.lastDataDir ? fs.existsSync(prefs.lastDataDir) : 'no path');
  if (!prefs.lastDataDir || !fs.existsSync(prefs.lastDataDir)) return null;

  const campaigns = findCampaigns(prefs.lastDataDir);
  if (campaigns.length === 0) return null;

  return {
    modFolder: prefs.lastModFolder,
    dataDir: prefs.lastDataDir,
    displayName: path.basename(prefs.lastDisplayRoot || prefs.lastModFolder),
    campaigns,
    selectedCampaign: prefs.lastCampaign && campaigns.includes(prefs.lastCampaign)
      ? prefs.lastCampaign : campaigns[0],
  };
});

// Load mod files into config dir
ipcMain.handle('load-mod-files', async (_, dataDir, campaignName) => {
  try {
    const configDir = path.join(PROJECT_ROOT, 'config');
    const campaignDir = path.join(dataDir, 'world', 'maps', 'campaign', campaignName);

    console.log(`[load-mod-files] PROJECT_ROOT: ${PROJECT_ROOT}`);
    console.log(`[load-mod-files] configDir: ${configDir}`);
    console.log(`[load-mod-files] dataDir: ${dataDir}`);
    console.log(`[load-mod-files] campaignDir: ${campaignDir}`);

    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const copied = [];
    const missing = [];

    const overrideCampaignDir = path.join(dataDir, 'original_overrides', 'resource_quantity', 'world', 'maps', 'campaign', campaignName);

    for (const entry of MOD_FILE_MAP) {
      const { name, dirs } = entry;
      const lookupName = entry.srcName || name;  // file to find on disk
      let found = false;
      for (const searchDir of dirs) {
        // Build candidate paths: standard location + original_overrides
        const candidates = [];
        if (searchDir === 'campaign') {
          candidates.push(path.join(campaignDir, lookupName));
          candidates.push(path.join(overrideCampaignDir, lookupName));
        } else {
          candidates.push(path.join(dataDir, searchDir, lookupName));
        }

        for (const src of candidates) {
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(configDir, name));
            copied.push(name);
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) missing.push(name);
    }

    // --- Cross-campaign mercenary import ---
    // Grab descr_mercenaries.txt from ANY other campaign, plus that campaign's
    // descr_regions.txt as the source regions for the porting tool.
    // Target regions always come from world/maps/base/.
    const campaignBase = path.join(dataDir, 'world', 'maps', 'campaign');
    const baseRegions = path.join(dataDir, 'world', 'maps', 'base', 'descr_regions.txt');

    // Target regions = base map regions (what the selected campaign uses)
    if (fs.existsSync(baseRegions)) {
      fs.copyFileSync(baseRegions, path.join(configDir, 'descr_regions_target.txt'));
      copied.push('descr_regions_target.txt');
    }

    // Source mercs + source regions = from whichever OTHER campaign has descr_mercenaries.txt
    let mercFound = false;
    if (fs.existsSync(campaignBase)) {
      for (const d of fs.readdirSync(campaignBase, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === campaignName) continue;
        const mercSrc = path.join(campaignBase, d.name, 'descr_mercenaries.txt');
        if (fs.existsSync(mercSrc)) {
          fs.copyFileSync(mercSrc, path.join(configDir, 'descr_mercenaries.txt'));
          copied.push('descr_mercenaries.txt');
          // Also grab that campaign's descr_regions.txt as source regions
          const srcRegions = path.join(campaignBase, d.name, 'descr_regions.txt');
          if (fs.existsSync(srcRegions)) {
            fs.copyFileSync(srcRegions, path.join(configDir, 'descr_regions_source.txt'));
            copied.push('descr_regions_source.txt');
          }
          console.log(`[load-mod-files] Found mercenaries in campaign: ${d.name}`);
          mercFound = true;
          break;
        }
      }
    }
    // Also check if the selected campaign itself has mercs (fallback)
    if (!mercFound) {
      const ownMercs = path.join(campaignDir, 'descr_mercenaries.txt');
      if (fs.existsSync(ownMercs)) {
        fs.copyFileSync(ownMercs, path.join(configDir, 'descr_mercenaries.txt'));
        copied.push('descr_mercenaries.txt');
      }
    }

    const prefs = loadPrefs();
    prefs.lastCampaign = campaignName;
    savePrefs(prefs);

    // New mod loaded → invalidate icon index so it rescans on next request
    _resetIconIndex();

    const criticalMissing = missing.filter(f => !['descr_win_conditions.txt', 'map_regions.tga'].includes(f));

    console.log(`[load-mod-files] copied: ${copied.length}, missing: ${missing.length}, critical: ${criticalMissing.length}`);

    return { copied, missing, criticalMissing };
  } catch (err) {
    console.error('[load-mod-files] Error:', err);
    return { copied: [], missing: [], criticalMissing: [], error: err.message };
  }
});

// Select parent mod folder (for submod fallback)
ipcMain.handle('select-parent-mod', async () => {
  const prefs = loadPrefs();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Parent Mod / Base Game Folder',
    defaultPath: prefs.lastParentMod || undefined,
  });
  if (result.canceled) return null;

  const selectedPath = result.filePaths[0];
  const found = findDataDir(selectedPath);
  if (!found) {
    return { error: 'No game data found in this folder.' };
  }

  prefs.lastParentMod = selectedPath;
  prefs.lastParentDataDir = found.dataDir;
  savePrefs(prefs);

  return {
    dataDir: found.dataDir,
    displayName: path.basename(found.displayRoot),
  };
});

// Load missing files from parent mod — searches all campaigns, only fills gaps
ipcMain.handle('load-parent-mod-files', async (_, parentDataDir, missingFiles) => {
  const configDir = path.join(PROJECT_ROOT, 'config');
  const allCampaigns = findCampaigns(parentDataDir);

  const filled = [];
  const stillMissing = [];

  for (const fileName of missingFiles) {
    const entry = MOD_FILE_MAP.find(e => e.name === fileName);
    if (!entry) { stillMissing.push(fileName); continue; }

    let found = false;
    for (const searchDir of entry.dirs) {
      if (searchDir === 'campaign') {
        // Try every campaign in the parent
        for (const camp of allCampaigns) {
          const src = path.join(parentDataDir, 'world', 'maps', 'campaign', camp, fileName);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(configDir, fileName));
            filled.push(fileName);
            found = true;
            break;
          }
        }
      } else {
        const src = path.join(parentDataDir, searchDir, fileName);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(configDir, fileName));
          filled.push(fileName);
          found = true;
        }
      }
      if (found) break;
    }
    if (!found) stillMissing.push(fileName);
  }

  return { filled, stillMissing };
});

// Find the actual location of a game file in the mod structure
// Searches: campaign dir, original_overrides campaign dir, base dir
function findModFile(dataDir, campaignName, fileName) {
  const candidates = [
    // Standard campaign dir
    path.join(dataDir, 'world', 'maps', 'campaign', campaignName, fileName),
    // original_overrides (Rome Remastered override system)
    path.join(dataDir, 'original_overrides', 'resource_quantity', 'world', 'maps', 'campaign', campaignName, fileName),
    // base dir (shared across campaigns)
    path.join(dataDir, 'world', 'maps', 'base', fileName),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Save processed files back to the mod folder
ipcMain.handle('save-back-to-mod', async (_, dataDir, campaignName) => {
  try {
    const configDir = path.join(PROJECT_ROOT, 'config');
    const outputDir = path.join(PROJECT_ROOT, 'processed_output');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const saved = [];

    // --- Save descr_strat.txt ---
    // Prefer processed output (from pipeline run), fall back to config
    const stratFromOutput = findLatestOutputFile('descr_strat.txt');
    const stratFromConfig = path.join(configDir, 'descr_strat.txt');
    const stratSrc = stratFromOutput || stratFromConfig;
    if (!fs.existsSync(stratSrc)) {
      return { success: false, error: 'No descr_strat.txt found. Run the pipeline first.' };
    }

    const stratDest = findModFile(dataDir, campaignName, 'descr_strat.txt');
    if (!stratDest) {
      // No existing file found — create in standard campaign dir
      const fallback = path.join(dataDir, 'world', 'maps', 'campaign', campaignName, 'descr_strat.txt');
      if (!fs.existsSync(path.dirname(fallback))) {
        return { success: false, error: `Campaign directory not found for: ${campaignName}` };
      }
      fs.copyFileSync(stratSrc, fallback);
      saved.push(`descr_strat.txt → ${path.dirname(fallback)}`);
    } else {
      // Backup and overwrite at the found location
      const stratBackupDir = path.join(path.dirname(stratDest), '_backups');
      fs.mkdirSync(stratBackupDir, { recursive: true });
      fs.copyFileSync(stratDest, path.join(stratBackupDir, `descr_strat_${timestamp}.txt`));
      fs.copyFileSync(stratSrc, stratDest);
      saved.push(`descr_strat.txt → ${path.dirname(stratDest)}`);
      console.log(`[save-back] Saved descr_strat.txt to: ${stratDest}`);
    }

    // --- Save descr_regions.txt (from hidden_resources step) ---
    const regionsSrc = findLatestOutputFile('descr_regions.txt');
    if (regionsSrc) {
      const regionsDest = findModFile(dataDir, campaignName, 'descr_regions.txt');
      if (regionsDest) {
        const regionsBackupDir = path.join(path.dirname(regionsDest), '_backups');
        fs.mkdirSync(regionsBackupDir, { recursive: true });
        fs.copyFileSync(regionsDest, path.join(regionsBackupDir, `descr_regions_${timestamp}.txt`));
        fs.copyFileSync(regionsSrc, regionsDest);
        saved.push(`descr_regions.txt → ${path.dirname(regionsDest)}`);
        console.log(`[save-back] Saved descr_regions.txt to: ${regionsDest}`);
      }
    }

    return { success: true, saved };
  } catch (err) {
    console.error('[save-back] Error:', err);
    return { success: false, error: err.message };
  }
});

// List config files
ipcMain.handle('list-config-files', async () => {
  const configDir = path.join(PROJECT_ROOT, 'config');
  try {
    const files = fs.readdirSync(configDir).filter(f => f.endsWith('.txt'));
    return files.map(f => ({
      name: f,
      path: path.join(configDir, f),
      size: fs.statSync(path.join(configDir, f)).size,
    }));
  } catch (e) {
    return [];
  }
});

// Read file
ipcMain.handle('read-file', async (_, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    // Try other encodings
    try {
      return fs.readFileSync(filePath, 'utf-16le');
    } catch (e2) {
      return `Error reading file: ${e.message}`;
    }
  }
});

// Write file
ipcMain.handle('write-file', async (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Save file as (for config profiles)
ipcMain.handle('save-file-as', async (_, defaultName, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(PROJECT_ROOT, 'config', defaultName),
    filters: [{ name: 'Text Files', extensions: ['txt'] }],
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return result.filePath;
});

// Import CSV for hidden resources
ipcMain.handle('import-hidden-resources-csv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Hidden Resources CSV',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled) return { success: false };

  const src = result.filePaths[0];
  const dest = path.join(PROJECT_ROOT, 'config', 'hidden_resources.csv');
  const metaFile = path.join(PROJECT_ROOT, 'config', '.csv_import_meta.json');
  try {
    fs.copyFileSync(src, dest);
    const now = Date.now();
    fs.writeFileSync(metaFile, JSON.stringify({ importedAt: now, name: path.basename(src) }));
    return { success: true, path: src, name: path.basename(src), importedAt: now };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Import civic-buildings list (.txt) -> config/civic_buildings.txt
ipcMain.handle('import-civic-list', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Civic Buildings List',
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled) return { success: false };
  const src = result.filePaths[0];
  const dest = path.join(PROJECT_ROOT, 'config', 'civic_buildings.txt');
  try {
    fs.copyFileSync(src, dest);
    return { success: true, path: src, name: path.basename(src) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Check if hidden resources CSV exists and when it was imported
ipcMain.handle('check-hidden-resources-csv', async () => {
  const csvPath = path.join(PROJECT_ROOT, 'config', 'hidden_resources.csv');
  const metaFile = path.join(PROJECT_ROOT, 'config', '.csv_import_meta.json');
  if (!fs.existsSync(csvPath)) return { exists: false };
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    return { exists: true, importedAt: meta.importedAt };
  } catch (e) {
    // No meta file — fall back to file mtime
    const stat = fs.statSync(csvPath);
    return { exists: true, importedAt: stat.mtimeMs };
  }
});

// ── Rule Profiles (save/load Python scripts) ──

const SCRIPT_FILES = PIPELINE_STEPS.map(s => s.script);

// List rule profiles
ipcMain.handle('list-profiles', async () => {
  const profilesDir = path.join(PROJECT_ROOT, 'rule_profiles');
  try {
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
    const dirs = fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        // Read description if exists
        const descFile = path.join(profilesDir, d.name, '_description.txt');
        const desc = fs.existsSync(descFile) ? fs.readFileSync(descFile, 'utf-8').trim() : '';
        return { name: d.name, description: desc };
      });
    return dirs;
  } catch (e) {
    return [];
  }
});

// Save rule profile (snapshot all Python scripts)
ipcMain.handle('save-profile', async (_, profileName, description) => {
  const profileDir = path.join(PROJECT_ROOT, 'rule_profiles', profileName);
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    for (const script of SCRIPT_FILES) {
      const src = path.join(PROJECT_ROOT, script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(profileDir, script));
      }
    }
    // Save description
    if (description) {
      fs.writeFileSync(path.join(profileDir, '_description.txt'), description, 'utf-8');
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Load rule profile (restore Python scripts from snapshot)
ipcMain.handle('load-profile', async (_, profileName) => {
  const profileDir = path.join(PROJECT_ROOT, 'rule_profiles', profileName);
  try {
    for (const script of SCRIPT_FILES) {
      const src = path.join(profileDir, script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(PROJECT_ROOT, script));
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// List scripts (for the editor)
ipcMain.handle('list-scripts', async () => {
  return SCRIPT_FILES.map(script => {
    const fullPath = path.join(PROJECT_ROOT, script);
    return {
      name: script,
      path: fullPath,
      size: fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0,
    };
  }).filter(f => f.size > 0);
});

// Find the most recently written descr_strat.txt in processed_output/
// Scripts may write to flat dir or timestamped subdirs
function findLatestOutputFile(fileName) {
  const outputDir = path.join(PROJECT_ROOT, 'processed_output');
  if (!fs.existsSync(outputDir)) return null;

  let best = null;
  let bestMtime = 0;

  // Check flat file
  const flat = path.join(outputDir, fileName);
  if (fs.existsSync(flat)) {
    const mt = fs.statSync(flat).mtimeMs;
    if (mt > bestMtime) { best = flat; bestMtime = mt; }
  }

  // Check subdirectories
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(outputDir, entry.name, fileName);
    if (fs.existsSync(candidate)) {
      const mt = fs.statSync(candidate).mtimeMs;
      if (mt > bestMtime) { best = candidate; bestMtime = mt; }
    }
  }
  return best;
}

// Chain support: after a step runs, copy its output strat back to config
// so the next step reads the updated version
ipcMain.handle('chain-strat-output', async () => {
  const latest = findLatestOutputFile('descr_strat.txt');
  const configStrat = path.join(PROJECT_ROOT, 'config', 'descr_strat.txt');
  if (latest) {
    fs.copyFileSync(latest, configStrat);
    // Also copy to flat processed_output/ for Save to Mod
    const flatOutput = path.join(PROJECT_ROOT, 'processed_output', 'descr_strat.txt');
    if (latest !== flatOutput) fs.copyFileSync(latest, flatOutput);
    return true;
  }
  return false;
});

// For hidden_resources: copy its output descr_regions.txt to config
ipcMain.handle('chain-regions-output', async () => {
  const latest = findLatestOutputFile('descr_regions.txt');
  const configRegions = path.join(PROJECT_ROOT, 'config', 'descr_regions.txt');
  if (latest) {
    fs.copyFileSync(latest, configRegions);
    const flatOutput = path.join(PROJECT_ROOT, 'processed_output', 'descr_regions.txt');
    if (latest !== flatOutput) fs.copyFileSync(latest, flatOutput);
    return true;
  }
  return false;
});

// Backup config files before a chained run, and restore after
ipcMain.handle('backup-config', async () => {
  const backupDir = path.join(PROJECT_ROOT, '_config_backup');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of ['descr_strat.txt', 'descr_regions.txt']) {
    const src = path.join(PROJECT_ROOT, 'config', name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, name));
    }
  }
  return true;
});

ipcMain.handle('restore-config', async () => {
  const backupDir = path.join(PROJECT_ROOT, '_config_backup');
  if (!fs.existsSync(backupDir)) return false;
  for (const name of ['descr_strat.txt', 'descr_regions.txt']) {
    const src = path.join(backupDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(PROJECT_ROOT, 'config', name));
    }
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
  return true;
});

// Run pipeline step
ipcMain.handle('run-step', async (event, stepId, configOverrides) => {
  const step = PIPELINE_STEPS.find(s => s.id === stepId);
  if (!step) return { success: false, error: 'Unknown step' };

  const scriptPath = path.join(PROJECT_ROOT, step.script);
  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: `Script not found: ${step.script}` };
  }

  return new Promise((resolve) => {
    const proc = spawn('python', [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...configOverrides },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      mainWindow.webContents.send('step-output', { stepId, text, stream: 'stdout' });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      mainWindow.webContents.send('step-output', { stepId, text, stream: 'stderr' });
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, stdout, stderr, code });
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message, stdout, stderr });
    });
  });
});

// Run full pipeline
ipcMain.handle('run-pipeline', async (event, stepIds) => {
  const results = {};
  for (const stepId of stepIds) {
    mainWindow.webContents.send('pipeline-step-start', stepId);
    const result = await ipcMain.emit('run-step', event, stepId, {});
    // We call run-step handler directly
    const step = PIPELINE_STEPS.find(s => s.id === stepId);
    const scriptPath = path.join(PROJECT_ROOT, step.script);

    if (!fs.existsSync(scriptPath)) {
      results[stepId] = { success: false, error: `Script not found: ${step.script}` };
      mainWindow.webContents.send('pipeline-step-done', { stepId, success: false });
      continue;
    }

    const stepResult = await new Promise((resolve) => {
      const proc = spawn('python', [scriptPath], {
        cwd: PROJECT_ROOT,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        mainWindow.webContents.send('step-output', { stepId, text, stream: 'stdout' });
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        mainWindow.webContents.send('step-output', { stepId, text, stream: 'stderr' });
      });

      proc.on('close', (code) => {
        resolve({ success: code === 0, stdout, stderr, code });
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message, stdout, stderr });
      });
    });

    results[stepId] = stepResult;
    mainWindow.webContents.send('pipeline-step-done', {
      stepId,
      success: stepResult.success,
    });

    if (!stepResult.success) break; // Stop pipeline on failure
  }
  return results;
});

// Run comparison: run pipeline with two different rule profiles (swap scripts)
ipcMain.handle('run-comparison', async (event, profileA, profileB, stepIds) => {
  const configDir = path.join(PROJECT_ROOT, 'config');

  // Backup current scripts
  const backupDir = path.join(PROJECT_ROOT, '_backup_scripts');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const script of SCRIPT_FILES) {
    const src = path.join(PROJECT_ROOT, script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, script));
    }
  }

  // Also backup descr_strat.txt since each run modifies it
  const stratPath = path.join(configDir, 'descr_strat.txt');
  const stratBackup = path.join(backupDir, 'descr_strat.txt');
  if (fs.existsSync(stratPath)) {
    fs.copyFileSync(stratPath, stratBackup);
  }

  const runWithRuleProfile = async (profileName, tag) => {
    // Restore original descr_strat.txt before each run
    if (fs.existsSync(stratBackup)) {
      fs.copyFileSync(stratBackup, stratPath);
    }

    // Swap in profile scripts if not 'current'
    if (profileName !== '__current__') {
      const profileDir = path.join(PROJECT_ROOT, 'rule_profiles', profileName);
      for (const script of SCRIPT_FILES) {
        const src = path.join(profileDir, script);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(PROJECT_ROOT, script));
        }
      }
    } else {
      // Restore originals for 'current'
      for (const script of SCRIPT_FILES) {
        const src = path.join(backupDir, script);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(PROJECT_ROOT, script));
        }
      }
    }

    const results = {};
    for (const stepId of stepIds) {
      const step = PIPELINE_STEPS.find(s => s.id === stepId);
      const scriptPath = path.join(PROJECT_ROOT, step.script);
      if (!fs.existsSync(scriptPath)) {
        results[stepId] = { success: false, error: 'Script not found' };
        continue;
      }

      const stepResult = await new Promise((resolve) => {
        const proc = spawn('python', [scriptPath], {
          cwd: PROJECT_ROOT,
          env: { ...process.env },
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => resolve({ success: code === 0, stdout, stderr }));
        proc.on('error', (err) => resolve({ success: false, error: err.message }));
      });
      results[stepId] = stepResult;
      mainWindow.webContents.send('comparison-step-done', { tag, stepId, success: stepResult.success });
      if (!stepResult.success) break;
    }

    // Read final descr_strat.txt after this run
    const finalStrat = fs.existsSync(stratPath)
      ? fs.readFileSync(stratPath, 'utf-8')
      : '';

    return { results, finalStrat };
  };

  try {
    mainWindow.webContents.send('comparison-status', `Running with rules: ${profileA}...`);
    const resultA = await runWithRuleProfile(profileA, 'A');

    mainWindow.webContents.send('comparison-status', `Running with rules: ${profileB}...`);
    const resultB = await runWithRuleProfile(profileB, 'B');

    // Restore original scripts
    for (const script of SCRIPT_FILES) {
      const src = path.join(backupDir, script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(PROJECT_ROOT, script));
      }
    }
    // Restore original descr_strat.txt
    if (fs.existsSync(stratBackup)) {
      fs.copyFileSync(stratBackup, stratPath);
    }

    fs.rmSync(backupDir, { recursive: true, force: true });

    return { profileA: resultA, profileB: resultB };
  } catch (e) {
    // Restore on error
    for (const script of SCRIPT_FILES) {
      const src = path.join(backupDir, script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(PROJECT_ROOT, script));
      }
    }
    if (fs.existsSync(stratBackup)) {
      fs.copyFileSync(stratBackup, stratPath);
    }
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    return { error: e.message };
  }
});

// Clear all previous output before a new run
ipcMain.handle('clear-stale-output', async () => {
  const outputDir = path.join(PROJECT_ROOT, 'processed_output');
  if (!fs.existsSync(outputDir)) return;
  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    const fp = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fp, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fp);
    }
  }
});

// Get latest output directory
ipcMain.handle('get-latest-output', async () => {
  const outputDir = path.join(PROJECT_ROOT, 'processed_output');
  try {
    if (!fs.existsSync(outputDir)) return null;

    const entries = fs.readdirSync(outputDir, { withFileTypes: true });

    // Check for flat changelog files (written by individual step runs)
    const flatChangelogFiles = entries.filter(e =>
      e.isFile() && e.name.includes('changelog')
    );
    let flatMtime = 0;
    for (const f of flatChangelogFiles) {
      const stat = fs.statSync(path.join(outputDir, f.name));
      if (stat.mtimeMs > flatMtime) flatMtime = stat.mtimeMs;
    }

    // Find the latest full_run directory
    const fullRunDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('full_run_'))
      .map(e => e.name)
      .sort();

    let fullRunMtime = 0;
    let latestRun = null;
    if (fullRunDirs.length > 0) {
      latestRun = fullRunDirs[fullRunDirs.length - 1];
      const stat = fs.statSync(path.join(outputDir, latestRun));
      fullRunMtime = stat.mtimeMs;
    }

    // Prefer whichever is newer: flat files or latest full_run
    const useFlat = flatMtime > fullRunMtime;

    if (useFlat || fullRunDirs.length === 0) {
      const contents = {};
      // Use '.' so paths resolve to processed_output/./file = processed_output/file
      const flatFiles = entries.filter(e => e.isFile()).map(e => e.name);
      if (flatFiles.some(f => f.includes('changelog'))) {
        contents['.'] = flatFiles;
      }
      // Also include any individual step dirs
      const dirsByPrefix = {};
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('full_run_')) {
          const prefixMatch = entry.name.match(/^(.+?)_\d{8}_\d{6}$/);
          const prefix = prefixMatch ? prefixMatch[1] : entry.name;
          if (!dirsByPrefix[prefix]) dirsByPrefix[prefix] = [];
          dirsByPrefix[prefix].push(entry.name);
        }
      }
      for (const [prefix, dirs] of Object.entries(dirsByPrefix)) {
        dirs.sort();
        const latest = dirs[dirs.length - 1];
        try {
          contents[latest] = fs.readdirSync(path.join(outputDir, latest));
        } catch (e) {}
      }
      if (Object.keys(contents).length === 0) return null;
      return { dir: 'processed_output', path: outputDir, contents };
    }

    // Use the latest full_run directory
    const latestDir = path.join(outputDir, latestRun);
    const contents = {};

    const subdirs = fs.readdirSync(latestDir, { withFileTypes: true });
    for (const sd of subdirs) {
      if (sd.isDirectory()) {
        contents[sd.name] = fs.readdirSync(path.join(latestDir, sd.name));
      } else if (sd.isFile()) {
        contents[sd.name] = 'file';
      }
    }

    if (Object.keys(contents).length === 0) return null;
    return { dir: latestRun, path: latestDir, contents };
  } catch (e) {
    return null;
  }
});

// Read output file
ipcMain.handle('read-output-file', async (_, relPath) => {
  try {
    return fs.readFileSync(relPath, 'utf-8');
  } catch (e) {
    return `Error: ${e.message}`;
  }
});

// Open folder in explorer
ipcMain.handle('open-folder', async (_, folderPath) => {
  shell.openPath(folderPath);
});

// Building chain → category mapping
const BUILDING_CATEGORIES = {
  'Farms': ['irrigated_farming', 'rainfed_farming', 'qanat_farming', 'highland_pastoralism',
    'sedentary_animal_husbandry', 'marsh_reclamation', 'wetland_pastoralism',
    'nomadic_pastoralism', 'forest_pastoralism', 'shifting_cultivation',
    'farms', 'herds'],
  'Food Storage & Grain': ['food_storage', 'grain_imports'],
  'Heavy Industry': ['smith', 'mines', 'purple_dye_production', 'marble_production',
    'jewelry', 'artisans', 'stone_quarry', 'sulphur_industry',
    'salt_production', 'pitch_gathering'],
  'Metal Exports': ['tin_industry', 'copper_industry', 'lead_industry', 'iron_industry',
    'hinterland_mines_silver',
    'tin_mine', 'lead_mine', 'silver_mine', 'gold_mine', 'copper_mine', 'iron_mine'],
  'Health & Sanitation': ['health', 'hospitals'],
  'Military': ['military_industrial_complex', 'garrison',
    'barracks', 'equestrian', 'missiles', 'siege_engineer'],
  'Government': ['governmentA', 'governmentB', 'governmentC', 'governmentD',
    'colony', 'liberation', 'core_building', 'hinterland_region'],
  'Law & Culture': ['justice_court', 'despotic_law', 'academic',
    'amphitheatres', 'racing_stadium', 'theatres', 'taverns',
    'autonomous_mint', 'centralized_mint'],
  'Rural Exploits': ['wine_industry', 'olive_cultivation', 'dates_cultivation',
    'agroforestry', 'papyrus_maker', 'honey_industry', 'hunters',
    'horse_trainer', 'timber_industry', 'camels_trade', 'hemp_cultivation'],
  'Urban Exploits': ['amber_trader', 'dyes_production', 'glass_production',
    'grain_industry', 'hides_industry', 'incense_trader', 'ivory_trade',
    'perfumes_industry', 'pottery_production', 'salted_fish', 'silk_trader',
    'slave_market', 'spices_trading', 'textiles_production'],
  'Ports': ['port', 'river_port1', 'river_port2', 'harbour', 'port_buildings', 'port_fishing', 'river_port'],
  'Settlement': ['defenses', 'hinterland_roads', 'market', 'capital_treasury'],
};

function getBuildingCategory(name) {
  for (const [cat, chains] of Object.entries(BUILDING_CATEGORIES)) {
    if (chains.includes(name)) return cat;
  }
  // Check for temple_complex_ prefix
  if (name.startsWith('temple_complex')) return 'Temples';
  return 'Other';
}

// Parse EDB building chains for the editor
ipcMain.handle('parse-edb-buildings', async () => {
  const edbPath = path.join(PROJECT_ROOT, 'config', 'export_descr_buildings.txt');
  try {
    const content = fs.readFileSync(edbPath, 'utf-8');
    const buildings = parseEDB(content);
    // Attach category to each building
    for (const b of buildings) {
      b.category = getBuildingCategory(b.name);
    }
    return buildings;
  } catch (e) {
    return { error: e.message };
  }
});

function parseEDB(content) {
  // EDB shape:
  //   building <chain>
  //   {
  //       <props>
  //       levels <l1> <l2> <l3>
  //       {
  //           <l1> requires <...>
  //           {
  //               settlement_min <tier>
  //               ...
  //           }
  //           <l2> requires <...>
  //           ...
  //       }
  //   }
  //
  // Brace depth: 0 outside the chain, 1 inside the chain block, 2 inside the
  // levels block, 3 inside a single level's requires block.

  const buildings = [];
  const lines = content.split('\n');
  let currentBuilding = null;
  let currentLevel = null;
  let braceDepth = 0;

  function pushLevel() {
    if (currentLevel && currentBuilding) {
      currentBuilding.levels.push(currentLevel);
      currentLevel = null;
    }
  }
  function pushBuilding() {
    pushLevel();
    if (currentBuilding) {
      buildings.push(currentBuilding);
      currentBuilding = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip ; comments
    const ci = line.indexOf(';');
    const trimmed = (ci >= 0 ? line.slice(0, ci) : line).trim();
    if (!trimmed) continue;

    // building <name> at top level starts a new chain
    const buildingMatch = trimmed.match(/^building\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (buildingMatch && braceDepth === 0) {
      pushBuilding();
      currentBuilding = {
        name: buildingMatch[1],
        line: i + 1,
        levels: [],
        rawLevelsLine: '',
      };
      continue;
    }
    if (!currentBuilding) continue;

    // levels line — at braceDepth 1 (inside the chain block).
    // Some EDBs place the trailing `{` on the same line; tolerate that.
    if (braceDepth === 1) {
      const levelsMatch = trimmed.match(/^levels\s+(.+?)\s*\{?\s*$/);
      if (levelsMatch) {
        currentBuilding.rawLevelsLine = levelsMatch[1].trim();
        continue;
      }
    }

    // Brace tracking. `{` and `}` may be on their own line OR appended to a
    // declaration line ("levels foo bar {"). We scan the line for them.
    let consumedBrace = false;
    if (trimmed === '{') { braceDepth++; consumedBrace = true; }
    else if (trimmed === '}') {
      braceDepth--;
      if (braceDepth === 2) pushLevel();   // closing a level's requires block
      consumedBrace = true;
    }
    if (consumedBrace) {
      if (braceDepth === 0) pushBuilding();
      continue;
    }

    // <levelName> requires <...> begins a level definition (braceDepth === 2,
    // inside the levels block).
    if (braceDepth === 2) {
      const levelMatch = trimmed.match(/^(\S+)\s+requires/);
      if (levelMatch) {
        pushLevel();
        currentLevel = {
          name: levelMatch[1],
          line: i + 1,
          settlementMin: '',
          requires: [],
        };
        continue;
      }
    }

    // Inside a level's requires { ... } block (braceDepth === 3).
    if (braceDepth === 3 && currentLevel) {
      const sm = trimmed.match(/^settlement_min\s+(\S+)/);
      if (sm) currentLevel.settlementMin = sm[1];
      currentLevel.requires.push(trimmed);
    }
  }
  pushBuilding();
  return buildings;
}

// ── Building icon resolver (ported from Provincia) ─────────────────────
// RTW/M2TW ship icons as `#<culture>_<level>.tga` in `data/ui/<c>/buildings/`.
// The resolver tries 7 progressively-broader passes, parsing
// `descr_ui_buildings.txt` for level aliases + culture fallbacks. Returns
// raw TGA bytes; the renderer decodes via canvas + blob URL.

const _uiBuildingsCache = new Map();   // modDataDir → { cultureFallbacks, levelAliases }

function _resetIconIndex() {
  _uiBuildingsCache.clear();
}

function parseDescrUiBuildings(modDataDir) {
  const cacheKey = modDataDir || '';
  if (_uiBuildingsCache.has(cacheKey)) return _uiBuildingsCache.get(cacheKey);

  const sources = [];
  if (modDataDir) {
    const p = path.join(modDataDir, 'descr_ui_buildings.txt');
    if (fs.existsSync(p)) sources.push(p);
  }

  const cultureFallbacks = {};
  const levelAliases = {};
  // Folder names RTW recognises as cultures — used to distinguish
  // culture-fallback entries from level-alias entries in lookup_variants.
  const CULTURES = new Set([
    'roman', 'greek', 'eastern', 'egyptian', 'barbarian', 'carthaginian',
    'nomad', 'parthian', 'scythian', 'german',
    'e_hellenistic', 'w_hellenistic',
    'anatolian', 'arab', 'brittonic', 'celtiberian', 'dacian', 'ethiopian',
    'germanic', 'iberian', 'illyrian', 'indian', 'iranian', 'libyan',
    'thracian',
  ]);

  for (const src of sources) {
    try {
      const text = fs.readFileSync(src, 'utf-8');
      let inBlock = false;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/;.*$/, '').trim();
        if (!line) continue;
        if (line === 'lookup_variants') { inBlock = true; continue; }
        if (line === '{') continue;
        if (line === '}') { inBlock = false; continue; }
        if (!inBlock) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const from = parts[0].toLowerCase();
        const to = parts[1].toLowerCase();
        if (CULTURES.has(from) && CULTURES.has(to)) {
          if (!cultureFallbacks[from]) cultureFallbacks[from] = [];
          if (!cultureFallbacks[from].includes(to)) cultureFallbacks[from].push(to);
        } else {
          levelAliases[from] = to;
        }
      }
    } catch {}
  }

  const result = { cultureFallbacks, levelAliases };
  _uiBuildingsCache.set(cacheKey, result);
  return result;
}

ipcMain.handle('resolve-building-icon', async (_event, modDataDir, culture, levelName, chainName) => {
  if (!culture || !levelName) return null;
  const c = String(culture).toLowerCase();
  const l = String(levelName).toLowerCase();
  const { cultureFallbacks, levelAliases } = parseDescrUiBuildings(modDataDir);

  // Token-suffix candidates: trim from the left so `temple_of_zoroaster_shrine`
  // also tries `of_zoroaster_shrine`, `zoroaster_shrine`, `shrine`.
  const levelTokens = l.split('_');
  const levelCandidates = [];
  for (let start = 0; start < levelTokens.length; start++) {
    const suffix = levelTokens.slice(start).join('_');
    if (suffix && !levelCandidates.includes(suffix)) levelCandidates.push(suffix);
  }
  // Walk alias chain (e.g. temple_of_battle_shrine → shrine), and also
  // add trimmed suffixes of each alias.
  if (levelAliases) {
    let cur = l;
    const seen = new Set([cur]);
    for (let i = 0; i < 8; i++) {
      const next = levelAliases[cur];
      if (!next || seen.has(next)) break;
      if (!levelCandidates.includes(next)) levelCandidates.push(next);
      const aliasTokens = next.split('_');
      for (let s = 1; s < aliasTokens.length; s++) {
        const suf = aliasTokens.slice(s).join('_');
        if (suf && !levelCandidates.includes(suf)) levelCandidates.push(suf);
      }
      seen.add(next);
      cur = next;
    }
  }

  const dirs = [];
  if (modDataDir && fs.existsSync(modDataDir)) {
    dirs.push(path.join(modDataDir, 'ui', c, 'buildings'));
    dirs.push(path.join(modDataDir, 'ui', c, 'buildings', 'construction'));
    dirs.push(path.join(modDataDir, 'ui', c, 'plugins'));
    dirs.push(path.join(modDataDir, 'ui', c, 'construction'));
  }

  // RIS ships per-level art under roman/, even for non-roman cultures, so
  // roman is checked alongside per-culture, not as a last-resort.
  const romanDirs = [];
  if (c !== 'roman' && modDataDir && fs.existsSync(modDataDir)) {
    romanDirs.push(path.join(modDataDir, 'ui', 'roman', 'buildings'));
    romanDirs.push(path.join(modDataDir, 'ui', 'roman', 'buildings', 'construction'));
    romanDirs.push(path.join(modDataDir, 'ui', 'roman', 'plugins'));
    romanDirs.push(path.join(modDataDir, 'ui', 'roman', 'construction'));
  }

  // Cross-culture fallback order from descr_ui_buildings.txt or sensible default.
  const declaredOrder = (cultureFallbacks && cultureFallbacks[c]) || [];
  const FALLBACK_CULTURES = declaredOrder.length ? declaredOrder : [
    'greek', 'e_hellenistic', 'w_hellenistic', 'barbarian', 'carthaginian',
    'eastern', 'egyptian', 'iberian', 'celtiberian', 'thracian', 'dacian',
    'scythian', 'iranian', 'anatolian', 'germanic', 'brittonic', 'illyrian',
    'arab', 'indian', 'ethiopian', 'libyan',
  ];
  const otherCultureDirs = [];
  for (const oc of FALLBACK_CULTURES) {
    if (oc === c || oc === 'roman') continue;
    if (modDataDir && fs.existsSync(modDataDir)) {
      otherCultureDirs.push({ culture: oc, dir: path.join(modDataDir, 'ui', oc, 'buildings') });
      otherCultureDirs.push({ culture: oc, dir: path.join(modDataDir, 'ui', oc, 'buildings', 'construction') });
      otherCultureDirs.push({ culture: oc, dir: path.join(modDataDir, 'ui', oc, 'plugins') });
      otherCultureDirs.push({ culture: oc, dir: path.join(modDataDir, 'ui', oc, 'construction') });
    }
  }

  // Strict mode rejects 2567-byte vanilla placeholders + tiny construction
  // thumbnails, so the proper-size art has a chance to win in a later pass.
  const VANILLA_PLACEHOLDER_SIZE = 2567;
  const MIN_CARD_DIMENSION = 100;
  const readTga = (dir, fn, strict) => {
    if (!fs.existsSync(dir)) return null;
    const full = path.join(dir, fn);
    if (!fs.existsSync(full)) return null;
    try {
      const buf = fs.readFileSync(full);
      if (strict) {
        if (buf.byteLength === VANILLA_PLACEHOLDER_SIZE) return null;
        if (buf.byteLength >= 18) {
          const w = buf.readUInt16LE(12);
          const h = buf.readUInt16LE(14);
          if (w > 0 && h > 0 && w < MIN_CARD_DIMENSION && h < MIN_CARD_DIMENSION) return null;
        }
      }
      return {
        buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        path: full,
      };
    } catch { return null; }
  };

  // Chain-name suffix candidates: same trimming logic as levels.
  const chainCandidates = [];
  if (chainName) {
    const ch = String(chainName).toLowerCase();
    const chainTokens = ch.split('_');
    for (let start = 0; start < chainTokens.length; start++) {
      const suffix = chainTokens.slice(start).join('_');
      if (suffix && !chainCandidates.includes(suffix)) chainCandidates.push(suffix);
    }
  }

  const tryNames = (names, dirSet, strict) => {
    for (const fn of names) {
      for (const dir of dirSet) {
        const r = readTga(dir, fn, strict);
        if (r) return r;
      }
    }
    return null;
  };

  // Pass 1 — per-culture, per-level, strict.
  for (const lc of levelCandidates) {
    const r = tryNames([`#${c}_${lc}.tga`, `#${c.toUpperCase()}_${lc}.tga`, `#${lc}.tga`, `${c}_${lc}.tga`], dirs, true);
    if (r) return r;
  }
  // Pass 2 — roman per-level (non-strict).
  if (c !== 'roman' && romanDirs.length) {
    for (const lc of levelCandidates) {
      const r = tryNames([`#roman_${lc}.tga`, `#ROMAN_${lc}.tga`, `roman_${lc}.tga`], romanDirs, false);
      if (r) return r;
    }
  }
  // Pass 3 — per-culture chain icon, strict.
  for (const cc of chainCandidates) {
    const r = tryNames([`#${c}_${cc}.tga`, `#${c.toUpperCase()}_${cc}.tga`, `#${cc}.tga`, `${c}_${cc}.tga`], dirs, true);
    if (r) return r;
  }
  // Pass 4 — roman chain icon (non-strict).
  if (c !== 'roman' && romanDirs.length) {
    for (const cc of chainCandidates) {
      const r = tryNames([`#roman_${cc}.tga`, `#ROMAN_${cc}.tga`, `roman_${cc}.tga`], romanDirs, false);
      if (r) return r;
    }
  }
  // Pass 5 — per-culture small/thumbnail icon (non-strict).
  for (const lc of levelCandidates) {
    const r = tryNames([`#${c}_${lc}.tga`, `#${c.toUpperCase()}_${lc}.tga`, `#${lc}.tga`, `${c}_${lc}.tga`], dirs, false);
    if (r) return r;
  }
  for (const cc of chainCandidates) {
    const r = tryNames([`#${c}_${cc}.tga`, `#${c.toUpperCase()}_${cc}.tga`, `#${cc}.tga`, `${c}_${cc}.tga`], dirs, false);
    if (r) return r;
  }
  // Pass 6 — per-culture wide `_constructed` banner.
  for (const lc of levelCandidates) {
    const r = tryNames([`#${c}_${lc}_constructed.tga`], dirs, false);
    if (r) return r;
  }
  // Pass 7 — roman wide `_constructed` banner.
  if (c !== 'roman' && romanDirs.length) {
    for (const lc of levelCandidates) {
      const r = tryNames([`#roman_${lc}_constructed.tga`], romanDirs, false);
      if (r) return r;
    }
    for (const cc of chainCandidates) {
      const r = tryNames([`#roman_${cc}_constructed.tga`], romanDirs, false);
      if (r) return r;
    }
  }
  for (const cc of chainCandidates) {
    const r = tryNames([`#${c}_${cc}_constructed.tga`], dirs, false);
    if (r) return r;
  }
  // Cross-culture fallback.
  for (const lc of levelCandidates) {
    for (const { dir } of otherCultureDirs) {
      const r = readTga(dir, `#${culture}_${lc}.tga`, false); if (r) return r;
    }
  }
  for (const cc of chainCandidates) {
    for (const { dir } of otherCultureDirs) {
      const r = readTga(dir, `#${culture}_${cc}.tga`, false); if (r) return r;
    }
  }
  for (const lc of levelCandidates) {
    for (const { culture: oc, dir } of otherCultureDirs) {
      const r = readTga(dir, `#${oc}_${lc}.tga`, false); if (r) return r;
    }
  }
  // Generic fallback.
  const genericRoots = [];
  if (modDataDir && fs.existsSync(modDataDir)) {
    genericRoots.push(path.join(modDataDir, 'ui', 'generic'));
  }
  for (const dir of genericRoots) {
    const got = readTga(dir, 'generic_building.tga', false);
    if (got) return got;
  }
  return null;
});

// ── Master pipeline: building allowlist + run ──────────────────────────

const ALLOWLIST_FILE = () => path.join(PROJECT_ROOT, 'config', 'building_allowlist.json');

ipcMain.handle('load-allowlist', async () => {
  try {
    const file = ALLOWLIST_FILE();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
});

ipcMain.handle('save-allowlist', async (_, data) => {
  try {
    const file = ALLOWLIST_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Returns {chains: {name: count}, levels: {chain: {level: count}}, totalBuildings, settlementCount}
// Counts how many settlements use each chain/level in the current config/descr_strat.txt.
ipcMain.handle('get-strat-stats', async () => {
  const stratPath = path.join(PROJECT_ROOT, 'config', 'descr_strat.txt');
  if (!fs.existsSync(stratPath)) {
    return { chains: {}, levels: {}, totalBuildings: 0, settlementCount: 0 };
  }
  const text = fs.readFileSync(stratPath, 'utf-8');
  const chains = {};
  const levels = {};
  let totalBuildings = 0;
  let settlementCount = 0;

  const settlementBlocks = text.matchAll(/settlement\s*\{([\s\S]*?)\n\}/g);
  for (const m of settlementBlocks) {
    settlementCount++;
    const block = m[1];
    for (const tm of block.matchAll(/type\s+(\S+)\s+(\S+)/g)) {
      const chain = tm[1];
      const level = tm[2];
      chains[chain] = (chains[chain] || 0) + 1;
      if (!levels[chain]) levels[chain] = {};
      levels[chain][level] = (levels[chain][level] || 0) + 1;
      totalBuildings++;
    }
  }
  return { chains, levels, totalBuildings, settlementCount };
});

ipcMain.handle('run-master', async (event) => {
  const scriptPath = path.join(PROJECT_ROOT, 'master_processor.py');
  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: `master_processor.py not found at ${scriptPath}` };
  }

  return new Promise((resolve) => {
    const proc = spawn('python', [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      mainWindow.webContents.send('master-output', { text, stream: 'stdout' });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      mainWindow.webContents.send('master-output', { text, stream: 'stderr' });
    });

    proc.on('close', (code) => {
      const result = { success: code === 0, stdout, stderr, code };
      mainWindow.webContents.send('master-done', result);
      resolve(result);
    });

    proc.on('error', (err) => {
      const result = { success: false, error: err.message, stdout, stderr };
      mainWindow.webContents.send('master-done', result);
      resolve(result);
    });
  });
});

// ── Shared parsers (ported from Provincia) ───────────────────────────

// descr_regions.txt — RTW:R uses 8-line region blocks (region, city, faction,
// culture, RGB, tags, farm_level, pop_level). Original RTW added a 9th
// "ethnicities" line. Detect the variant by checking whether the line after
// pop_level looks like a new region start (non-indented name) or a value.
function parseDescrRegions(text) {
  const lines = text.split(/\r?\n/);
  const regions = {};
  const isRegionStart = (raw) => {
    if (raw == null) return false;
    if (/^\s/.test(raw)) return false;
    const t = raw.trim();
    if (!t || t.startsWith(';')) return false;
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(t);
  };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = (raw || '').trim();
    if (!line || line.startsWith(';')) { i++; continue; }
    if (i + 7 >= lines.length) break;
    const region = line;
    const city = lines[i + 1].trim();
    const faction = lines[i + 2].trim();
    const culture = lines[i + 3].trim();
    const rgbParts = lines[i + 4].trim().split(/\s+/);
    if (rgbParts.length !== 3 || !/^\d+$/.test(rgbParts[0])) { i++; continue; }
    const rgbKey = rgbParts.join(',');
    const tags = lines[i + 5].trim();
    const farm_level = lines[i + 6].trim();
    const pop_level = lines[i + 7].trim();
    let ethnicities = '';
    let step = 8;
    const nextRaw = lines[i + 8];
    if (nextRaw != null && !isRegionStart(nextRaw)) {
      const nt = (nextRaw || '').trim();
      if (nt && !nt.startsWith(';')) { ethnicities = nt; step = 9; }
    }
    regions[rgbKey] = { region, city, faction, culture, tags, farm_level, pop_level, ethnicities };
    i += step;
  }
  return regions;
}

// descr_strat.txt → which regions each faction owns.
function parseDescrStratFactions(text) {
  const lines = text.split(/\r?\n/);
  const factionRegions = {};
  let currentFaction = null;
  let inSettlement = false;
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith(';')) continue;
    const fm = s.match(/^faction\s+(\w+)/);
    if (fm) {
      currentFaction = fm[1].toLowerCase();
      if (!factionRegions[currentFaction]) factionRegions[currentFaction] = [];
      inSettlement = false;
      continue;
    }
    if (s === 'settlement') { inSettlement = true; continue; }
    if (s === '}' && inSettlement) { inSettlement = false; continue; }
    if (inSettlement && s.startsWith('region')) {
      const rn = s.replace('region', '').trim();
      if (currentFaction && rn) factionRegions[currentFaction].push(rn);
    }
  }
  return Object.fromEntries(Object.entries(factionRegions).filter(([, v]) => v.length > 0));
}

// descr_strat.txt → faction → [{ region, level, population, faction_creator, buildings: [{type, level}] }]
function parseDescrStratBuildings(text) {
  const lines = text.split(/\r?\n/);
  let startIdx = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].includes('; >>>> start of factions section <<<<')) { startIdx = idx + 1; break; }
  }
  const getBlock = (start) => {
    let braces = 0, found = false;
    for (let j = start; j < lines.length; j++) {
      if (lines[j].includes('{')) found = true;
      if (found) {
        braces += (lines[j].match(/{/g) || []).length;
        braces -= (lines[j].match(/}/g) || []).length;
      }
      if (found && braces === 0) return { block: lines.slice(start, j + 1), end: j };
    }
    return { block: [], end: start };
  };
  const extractMeta = (block) => {
    let region = null, level = 'town', population = null, faction_creator = null;
    const buildings = [];
    let inBuilding = false;
    for (const ln of block) {
      const s = ln.trim();
      if (s.startsWith('region')) { const p = s.split(/\s+/); if (p.length >= 2) region = p[1]; }
      else if (s.startsWith('level')) { const p = s.split(/\s+/); if (p.length >= 2) level = p[1]; }
      else if (s.startsWith('population')) { const p = s.split(/\s+/); if (p.length >= 2) population = parseInt(p[1], 10) || null; }
      else if (s.startsWith('faction_creator')) { const p = s.split(/\s+/); if (p.length >= 2) faction_creator = p[1]; }
      else if (s.startsWith('building')) inBuilding = true;
      else if (inBuilding && s.startsWith('type')) { const p = s.split(/\s+/); if (p.length >= 3) buildings.push({ type: p[1], level: p[2] }); }
      else if (inBuilding && s.includes('}')) inBuilding = false;
    }
    return { region, level, population, faction_creator, buildings };
  };
  const factions = [];
  let i = startIdx;
  while (i < lines.length) {
    const s = lines[i].trim();
    const fm = s.match(/^faction\s+([^\s,]+)/);
    if (fm) {
      const factionName = fm[1];
      const settlements = [];
      i++;
      while (i < lines.length) {
        const s2 = lines[i].trim();
        if (s2.startsWith('faction') || s2.startsWith('; >>>>')) break;
        if (s2.startsWith('settlement')) { const { block, end } = getBlock(i); settlements.push(extractMeta(block)); i = end + 1; }
        else i++;
      }
      factions.push({ faction: factionName, settlements });
    } else i++;
  }
  return factions;
}

// descr_sm_factions.txt → { factionId: { primary: [r,g,b], secondary: [r,g,b] } }
function parseSmFactions(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  let currentFaction = null;
  let braceDepth = 0;
  let wasInBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith(';;') || s.startsWith(';')) continue;
    const prevDepth = braceDepth;
    for (const ch of s) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }
    if (wasInBlock && braceDepth === 0) {
      currentFaction = null;
      wasInBlock = false;
    }
    if (prevDepth === 0 && braceDepth === 0) {
      const fm = s.match(/^"([^"]+)"\s*:\s*(?:;.*)?$/);
      if (fm) {
        const name = fm[1].toLowerCase();
        if (name !== 'factions') currentFaction = name;
      }
    }
    if (currentFaction && prevDepth === 0 && braceDepth === 1) wasInBlock = true;
    if (currentFaction && braceDepth >= 1) {
      const cm = s.match(/"(primary|secondary)"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (cm) {
        if (!result[currentFaction]) result[currentFaction] = {};
        result[currentFaction][cm[1]] = [parseInt(cm[2]), parseInt(cm[3]), parseInt(cm[4])];
      }
    }
  }
  return result;
}

// ── Typo detection (Levenshtein, capped — ported from Manipula) ──────

function levenshtein(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return dp[n];
}

function findNearMatch(query, candidates, maxDist) {
  let best = null;
  let bestDist = maxDist + 1;
  for (const c of candidates) {
    if (c === query) continue;
    const d = levenshtein(query, c, maxDist);
    if (d < bestDist) { bestDist = d; best = c; if (d === 1) break; }
  }
  return bestDist <= maxDist ? best : null;
}

// ── Validation: check output descr_strat.txt for issues ──

const TIER_ORDER = ['village', 'town', 'large_town', 'minor_city', 'city', 'large_city', 'huge_city'];
const LEVEL_TO_TIER_VAL = { village: 0, town: 1, large_town: 2, minor_city: 3, city: 3, large_city: 4, huge_city: 5 };

ipcMain.handle('validate-output', async () => {
  const configDir = path.join(PROJECT_ROOT, 'config');
  const stratPath = path.join(configDir, 'descr_strat.txt');
  const edbPath = path.join(configDir, 'export_descr_buildings.txt');
  const regionsPath = path.join(configDir, 'descr_regions.txt');
  const factionsPath = path.join(configDir, 'descr_sm_factions.txt');

  if (!fs.existsSync(stratPath)) return { warnings: [], errors: [] };

  const stratContent = fs.readFileSync(stratPath, 'utf-8');
  const edbContent = fs.existsSync(edbPath) ? fs.readFileSync(edbPath, 'utf-8') : '';
  const regionsContent = fs.existsSync(regionsPath) ? fs.readFileSync(regionsPath, 'utf-8') : '';
  const factionsContent = fs.existsSync(factionsPath) ? fs.readFileSync(factionsPath, 'utf-8') : '';

  // EDB indices: chain → level names, level → chain, level → settlement_min
  const chainLevels = {};
  const levelToChain = {};
  const levelMinSettlement = {};
  const edbBuildings = parseEDB(edbContent);
  for (const b of edbBuildings) {
    chainLevels[b.name] = b.levels.map(l => l.name);
    for (const l of b.levels) {
      levelToChain[l.name] = b.name;
      if (l.settlementMin) levelMinSettlement[l.name] = l.settlementMin;
    }
  }
  const knownChains = new Set(Object.keys(chainLevels));
  const knownLevels = new Set(Object.keys(levelToChain));

  // Region index: every region declared in descr_regions.txt
  const regionsByRgb = regionsContent ? parseDescrRegions(regionsContent) : {};
  const knownRegions = new Set(Object.values(regionsByRgb).map(r => r.region).filter(Boolean));

  // Faction index from descr_sm_factions.txt (lowercased ids)
  const smFactions = factionsContent ? parseSmFactions(factionsContent) : {};
  const knownFactions = new Set(Object.keys(smFactions));

  const warnings = [];
  const errors = [];
  const seenUnknownChain = new Set();
  const seenUnknownRegion = new Set();
  const seenUnknownFaction = new Set();

  // Walk faction → settlements via Provincia parser (handles the start-of-factions
  // marker and brace-balanced settlement blocks robustly).
  const stratFactions = parseDescrStratBuildings(stratContent);

  for (const f of stratFactions) {
    const factionId = (f.faction || '').toLowerCase();
    if (factionId && knownFactions.size && !knownFactions.has(factionId)
        && !seenUnknownFaction.has(factionId)) {
      seenUnknownFaction.add(factionId);
      const near = findNearMatch(factionId, knownFactions, 2);
      errors.push({
        type: 'unknown_faction',
        region: '(faction header)',
        message: `Faction "${f.faction}" is not declared in descr_sm_factions.txt${near ? ` — did you mean "${near}"?` : ''}`,
      });
    }

    for (const s of f.settlements) {
      const region = s.region;
      const level = s.level;
      if (!region || !level) continue;
      const tier = LEVEL_TO_TIER_VAL[level] !== undefined ? LEVEL_TO_TIER_VAL[level] : 0;

      // Region must exist in descr_regions.txt
      if (knownRegions.size && !knownRegions.has(region) && !seenUnknownRegion.has(region)) {
        seenUnknownRegion.add(region);
        const near = findNearMatch(region, knownRegions, 2);
        errors.push({
          type: 'unknown_region',
          region,
          message: `${region}: region not declared in descr_regions.txt${near ? ` — did you mean "${near}"?` : ''}`,
        });
      }

      // Settlement level must be a known M2TW level keyword
      if (LEVEL_TO_TIER_VAL[level] === undefined) {
        const near = findNearMatch(level, new Set(TIER_ORDER), 2);
        errors.push({
          type: 'unknown_level',
          region,
          message: `${region}: unknown settlement level "${level}"${near ? ` — did you mean "${near}"?` : ''}`,
        });
      }

      const buildings = s.buildings || [];

      // Check 1: Duplicate chains
      const chainCounts = {};
      for (const bt of buildings) {
        chainCounts[bt.type] = (chainCounts[bt.type] || 0) + 1;
      }
      for (const [chain, count] of Object.entries(chainCounts)) {
        if (count > 1) {
          errors.push({
            type: 'duplicate_chain',
            region,
            message: `${region}: Duplicate building chain "${chain}" (${count} instances)`,
          });
        }
      }

      // Check 2: Multiple buildings from same parent chain family
      const seenChains = new Set();
      for (const bt of buildings) {
        const parentChain = levelToChain[bt.level] || bt.type;
        if (seenChains.has(parentChain)) {
          errors.push({
            type: 'duplicate_family',
            region,
            message: `${region}: Multiple buildings from chain "${parentChain}" — has both duplicate entries`,
          });
        }
        seenChains.add(parentChain);
      }

      // Check 3: Building level exceeds settlement tier
      for (const bt of buildings) {
        const minSettlement = levelMinSettlement[bt.level];
        if (minSettlement) {
          const requiredTier = LEVEL_TO_TIER_VAL[minSettlement] || 0;
          if (tier < requiredTier) {
            warnings.push({
              type: 'tier_exceeded',
              region,
              message: `${region}: Building "${bt.level}" requires ${minSettlement} (tier ${requiredTier}) but settlement is ${level} (tier ${tier})`,
              building: bt.level,
              required: minSettlement,
              actual: level,
            });
          }
        }
      }

      // Check 4: Chain referenced in strat must exist in EDB (with typo suggestion)
      if (knownChains.size) {
        for (const bt of buildings) {
          if (!knownChains.has(bt.type) && !seenUnknownChain.has(bt.type)) {
            seenUnknownChain.add(bt.type);
            const near = findNearMatch(bt.type, knownChains, 2);
            errors.push({
              type: 'unknown_chain',
              region,
              message: `${region}: building chain "${bt.type}" not declared in export_descr_buildings.txt${near ? ` — did you mean "${near}"?` : ''}`,
            });
          }
        }
      }

      // Check 5: Specific level must be valid for the chain (with typo suggestion)
      if (knownLevels.size) {
        for (const bt of buildings) {
          if (!knownLevels.has(bt.level)) continue; // unknown chain handles separately
          const expectedChain = levelToChain[bt.level];
          if (expectedChain && expectedChain !== bt.type) {
            errors.push({
              type: 'level_chain_mismatch',
              region,
              message: `${region}: level "${bt.level}" belongs to chain "${expectedChain}", not "${bt.type}"`,
            });
          }
        }
      }
    }
  }

  return { warnings, errors };
});
