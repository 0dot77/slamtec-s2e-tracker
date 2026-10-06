import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionSettings, Preset } from '../shared/types'
import type { BackgroundSnapshot } from './pipeline/background'
import { sanitizePreset } from './validate'

/**
 * App settings persistence for the main process (userData/).
 *
 * - settings.json      last-used connection
 * - installation.json  live installation state (calibration, zones, pipeline,
 *                      OSC), saved automatically so an unattended restart comes
 *                      back exactly as configured
 * - background.json    learned background baseline, keyed by sensor address
 *
 * Reads degrade to "nothing saved" on any error. Writes go to a temp file and
 * are renamed into place so a power cut mid-write cannot corrupt the file.
 */

export interface AppSettings {
  connection?: ConnectionSettings
}

const file = (name: string): string => join(app.getPath('userData'), name)

function readJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(file(name), 'utf-8'))
  } catch {
    return undefined
  }
}

/** Atomic write; returns false (and logs) on failure. */
function writeJson(name: string, value: unknown): boolean {
  const target = file(name)
  const tmp = `${target}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value), 'utf-8')
    renameSync(tmp, target)
    return true
  } catch (err) {
    console.warn(`[settings] failed to write ${name}: ${(err as Error).message}`)
    return false
  }
}

function isConnectionSettings(value: unknown): value is ConnectionSettings {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.ip === 'string' && Number.isFinite(v.port)
}

export function loadSettings(): AppSettings {
  const parsed = readJson('settings.json')
  if (typeof parsed !== 'object' || parsed === null) return {}
  const raw = parsed as Record<string, unknown>
  const out: AppSettings = {}
  if (isConnectionSettings(raw.connection)) {
    out.connection = { ip: raw.connection.ip, port: raw.connection.port }
  }
  return out
}

export function saveSettings(patch: Partial<AppSettings>): void {
  writeJson('settings.json', { ...loadSettings(), ...patch })
}

// --- Installation state -----------------------------------------------------

export function loadInstallation(): Preset | null {
  const raw = readJson('installation.json')
  if (typeof raw !== 'object' || raw === null) return null
  return sanitizePreset((raw as Record<string, unknown>).preset)
}

let installTimer: ReturnType<typeof setTimeout> | undefined
let installPending: Preset | null = null
let installRetryMs = 500

/** Debounced save (config edits arrive per keystroke / slider tick). */
export function saveInstallation(preset: Preset): void {
  installPending = preset
  if (installTimer) return
  installTimer = setTimeout(() => flushPendingInstallation(false), 500)
}

/** Flush on quit, with one immediate retry if the atomic write fails. */
export function flushInstallation(): void {
  flushPendingInstallation(true)
}

function flushPendingInstallation(retryOnce: boolean): void {
  if (installTimer) {
    clearTimeout(installTimer)
    installTimer = undefined
  }
  if (!installPending) return
  const value = { version: 1, savedAt: new Date().toISOString(), preset: installPending }
  if (writeJson('installation.json', value) || (retryOnce && writeJson('installation.json', value))) {
    installPending = null
    installRetryMs = 500
    return
  }
  // Retain the latest edit until the rename succeeds. A retry must not keep
  // the process alive after the final quit-time flush.
  installTimer = setTimeout(() => flushPendingInstallation(false), installRetryMs)
  installTimer.unref?.()
  installRetryMs = Math.min(10000, installRetryMs * 2)
}

// --- Background baseline ----------------------------------------------------

interface BackgroundFile {
  version: 1
  sensor: string // "ip:port" the baseline was learned on
  snapshot: BackgroundSnapshot
}

export function loadBackground(sensor: string): BackgroundSnapshot | null {
  const raw = readJson('background.json') as Partial<BackgroundFile> | undefined
  if (!raw || raw.version !== 1 || raw.sensor !== sensor || typeof raw.snapshot !== 'object') return null
  return raw.snapshot as BackgroundSnapshot
}

export function saveBackground(sensor: string, snapshot: BackgroundSnapshot): void {
  writeJson('background.json', { version: 1, sensor, snapshot } satisfies BackgroundFile)
}

/** Atomically replace the old baseline before reset/relearn can succeed. */
export function invalidateBackground(): boolean {
  return writeJson('background.json', null)
}
