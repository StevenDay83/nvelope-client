import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const SETTINGS_FILE = path.join(app.getPath('userData'), 'client-settings.json')

export interface ClientSettings {
  benchmarkHashesPerMinute?: number
  benchmarkTimestamp?: number
  benchmarkVersion?: number
  theme?: 'light' | 'dark' | 'system'
  language?: string
  [key: string]: unknown
}

/** Benchmark algorithm version: 2 = hash-only (matches minePow). Older values
 *  measured sign+hash throughput and read ~60x too slow — treat as absent. */
export const BENCHMARK_VERSION = 2

/** Machine-level PoW hash rate — a property of this client, not any identity. */
export function getBenchmarkHashesPerMinute(): number | undefined {
  const s = readSettings()
  if (s.benchmarkVersion !== BENCHMARK_VERSION) return undefined
  return typeof s.benchmarkHashesPerMinute === 'number' ? s.benchmarkHashesPerMinute : undefined
}

function readSettings(): ClientSettings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {}
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as ClientSettings
  } catch {
    return {}
  }
}

function writeSettings(settings: ClientSettings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

export function getClientSetting<K extends keyof ClientSettings>(key: K): ClientSettings[K] | undefined {
  return readSettings()[key]
}

export function setClientSetting<K extends keyof ClientSettings>(key: K, value: ClientSettings[K]): void {
  const settings = readSettings()
  settings[key] = value
  writeSettings(settings)
}

export function getAllClientSettings(): ClientSettings {
  return readSettings()
}

export function setAllClientSettings(settings: ClientSettings): void {
  writeSettings(settings)
}
