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
  savePreset: 'preset:save',
  loadPreset: 'preset:load',
  getState: 'state:get',

  // Main -> renderer (send / on)
  frame: 'frame',
  status: 'bridge-status',
  log: 'bridge-log',
  zoneEvent: 'zone-event'
} as const
