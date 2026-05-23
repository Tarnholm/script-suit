const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Pipeline
  getPipelineSteps: () => ipcRenderer.invoke('get-pipeline-steps'),
  getProjectRoot: () => ipcRenderer.invoke('get-project-root'),
  runStep: (stepId, overrides) => ipcRenderer.invoke('run-step', stepId, overrides || {}),
  runPipeline: (stepIds) => ipcRenderer.invoke('run-pipeline', stepIds),

  // Config files
  listConfigFiles: () => ipcRenderer.invoke('list-config-files'),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),
  saveFileAs: (name, content) => ipcRenderer.invoke('save-file-as', name, content),

  // Rule Profiles (script snapshots)
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  saveProfile: (name, desc) => ipcRenderer.invoke('save-profile', name, desc),
  loadProfile: (name) => ipcRenderer.invoke('load-profile', name),
  listScripts: () => ipcRenderer.invoke('list-scripts'),

  // Comparison
  runComparison: (profileA, profileB, stepIds) =>
    ipcRenderer.invoke('run-comparison', profileA, profileB, stepIds),

  // Output
  getLatestOutput: () => ipcRenderer.invoke('get-latest-output'),
  readOutputFile: (path) => ipcRenderer.invoke('read-output-file', path),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),

  // EDB parsing
  parseEdbBuildings: () => ipcRenderer.invoke('parse-edb-buildings'),

  // Master / building allowlist
  loadAllowlist: () => ipcRenderer.invoke('load-allowlist'),
  saveAllowlist: (data) => ipcRenderer.invoke('save-allowlist', data),
  runMaster: () => ipcRenderer.invoke('run-master'),
  getStratStats: () => ipcRenderer.invoke('get-strat-stats'),
  resolveBuildingIcon: (modDataDir, culture, levelName, chainName) =>
    ipcRenderer.invoke('resolve-building-icon', modDataDir, culture, levelName, chainName),

  // Validation
  validateOutput: () => ipcRenderer.invoke('validate-output'),

  // Mod folder / import
  selectModFolder: () => ipcRenderer.invoke('select-mod-folder'),
  getModPrefs: () => ipcRenderer.invoke('get-mod-prefs'),
  loadModFiles: (dataDir, campaign) => ipcRenderer.invoke('load-mod-files', dataDir, campaign),
  selectParentMod: () => ipcRenderer.invoke('select-parent-mod'),
  loadParentModFiles: (parentDataDir, missingFiles) =>
    ipcRenderer.invoke('load-parent-mod-files', parentDataDir, missingFiles),
  saveBackToMod: (dataDir, campaign) => ipcRenderer.invoke('save-back-to-mod', dataDir, campaign),
  importHiddenResourcesCsv: () => ipcRenderer.invoke('import-hidden-resources-csv'),
  checkHiddenResourcesCsv: () => ipcRenderer.invoke('check-hidden-resources-csv'),
  clearStaleOutput: () => ipcRenderer.invoke('clear-stale-output'),
  backupConfig: () => ipcRenderer.invoke('backup-config'),
  restoreConfig: () => ipcRenderer.invoke('restore-config'),
  chainStratOutput: () => ipcRenderer.invoke('chain-strat-output'),
  chainRegionsOutput: () => ipcRenderer.invoke('chain-regions-output'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterQuitAndInstall: () => ipcRenderer.invoke('updater-quit-and-install'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  onUpdateStatus: (cb) => {
    ipcRenderer.on('update-status', (_e, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('update-status');
  },

  // Events
  onStepOutput: (cb) => ipcRenderer.on('step-output', (_, data) => cb(data)),
  onPipelineStepStart: (cb) => ipcRenderer.on('pipeline-step-start', (_, stepId) => cb(stepId)),
  onPipelineStepDone: (cb) => ipcRenderer.on('pipeline-step-done', (_, data) => cb(data)),
  onComparisonStepDone: (cb) => ipcRenderer.on('comparison-step-done', (_, data) => cb(data)),
  onComparisonStatus: (cb) => ipcRenderer.on('comparison-status', (_, msg) => cb(msg)),
  onMasterOutput: (cb) => ipcRenderer.on('master-output', (_, data) => cb(data)),
  onMasterDone: (cb) => ipcRenderer.on('master-done', (_, data) => cb(data)),
});
