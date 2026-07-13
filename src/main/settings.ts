import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionSettings } from '../shared/types'

/**
 * App settings persistence for the main process.
 *
 * Mirrors the presets.ts style but uses synchronous fs and swallows every
 * error: settings are a convenience (last-used connection restore), never a
 * hard dependency, so a missing/corrupt file must degrade to defaults rather
 * than surface. The file lives at userData/settings.json.
 */

export interface AppSettings {
  connection?: ConnectionSettings
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

// A ConnectionSettings is valid only with a string ip and a finite numeric port.
function isConnectionSettings(value: unknown): value is ConnectionSettings {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.ip === 'string' && Number.isFinite(v.port)
}

/**
 * Reads userData/settings.json. Returns {} on any error (missing file, bad
 * JSON) and drops a `connection` that fails shape validation.
 */
export function loadSettings(): AppSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const raw = parsed as Record<string, unknown>
    const out: AppSettings = {}
    if (isConnectionSettings(raw.connection)) {
      out.connection = { ip: raw.connection.ip, port: raw.connection.port }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Read-merge-write: shallow-merges `patch` over the current settings and
 * persists. Errors are swallowed (disk full, permissions).
 */
export function saveSettings(patch: Partial<AppSettings>): void {
  try {
    const merged: AppSettings = { ...loadSettings(), ...patch }
    writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch {
    // Persisting settings is best-effort; ignore failures.
  }
}
