// Centralized IPC channel names shared by main, preload, and renderer.
// Renderer -> main use ipcRenderer.invoke / ipcMain.handle.
// Main -> renderer use webContents.send / ipcRenderer.on.
export const IPC = {
  // Renderer -> main (invoke / handle)
  bridgeStart: 'bridge:start',
  bridgeStop: 'bridge:stop',
  setPipelineConfig: 'cfg:pipeline',
  learnBackground: 'cfg:learn-bg',
  resetBackground: 'cfg:reset-bg',
  setCalibration: 'cfg:calibration',
  setZones: 'cfg:zones',
  setOscConfig: 'cfg:osc',
  // Calibration capture in progress: disables the ROI mask and touch output so
  // the operator can touch the projected corners outside the old quad.
  setCalibrating: 'cfg:calibrating',
  savePreset: 'preset:save',
  loadPreset: 'preset:load',
  getState: 'state:get',
  networkDiagnose: 'network:diagnose',
  networkConfigure: 'network:configure',
  networkProbe: 'network:probe',
  getConnection: 'settings:connection',

  // Main -> renderer (send / on)
  frame: 'frame',
  status: 'bridge-status',
  log: 'bridge-log',
  zoneEvent: 'zone-event',
  // Full live state (Preset) pushed after main restores or replaces it, so a
  // (re)loaded renderer hydrates without guessing.
  state: 'state'
} as const
