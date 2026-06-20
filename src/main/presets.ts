import { dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { Preset } from '../shared/types'

/**
 * Preset persistence for the main process.
 *
 * `savePreset` / `loadPreset` drive the native file dialogs and read/write a
 * JSON snapshot of the full {@link Preset} (calibration, zones, pipeline, osc).
 * No renderer code lives here; the integrate phase wires these behind the
 * `preset:save` / `preset:load` IPC handlers.
 */

// Shallow structural check: a valid Preset always carries `pipeline` and `osc`.
function isPreset(value: unknown): value is Preset {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.pipeline === 'object' && v.pipeline !== null && typeof v.osc === 'object' && v.osc !== null
}

/**
 * Prompts the user with a native save dialog and writes the preset as
 * pretty-printed JSON. Returns false if the dialog is canceled.
 */
export async function savePreset(win: Electron.BrowserWindow | null, preset: Preset): Promise<boolean> {
  const result = win
    ? await dialog.showSaveDialog(win, {
        defaultPath: 'tracker-preset.json',
        filters: [{ name: 'Tracker Preset', extensions: ['json'] }]
      })
    : await dialog.showSaveDialog({
        defaultPath: 'tracker-preset.json',
        filters: [{ name: 'Tracker Preset', extensions: ['json'] }]
      })

  if (result.canceled || !result.filePath) return false

  await writeFile(result.filePath, JSON.stringify(preset, null, 2), 'utf-8')
  return true
}

/**
 * Prompts the user with a native open dialog, reads + parses the chosen JSON,
 * and shallow-validates that it looks like a {@link Preset}. Returns null if the
 * dialog is canceled or the file is missing/invalid.
 */
export async function loadPreset(win: Electron.BrowserWindow | null): Promise<Preset | null> {
  const result = win
    ? await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Tracker Preset', extensions: ['json'] }]
      })
    : await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Tracker Preset', extensions: ['json'] }]
      })

  if (result.canceled || result.filePaths.length === 0) return null

  try {
    const text = await readFile(result.filePaths[0], 'utf-8')
    const parsed: unknown = JSON.parse(text)
    return isPreset(parsed) ? parsed : null
  } catch {
    return null
  }
}
