import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../ipc/dbHandlers'
import * as dao from '../db/dao'

export const AVATAR_TTL_MS = 4 * 60 * 60 * 1000 // re-download avatars every 4h
const MAX_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8000

function avatarDir(): string {
  const dir = path.join(app.getPath('userData'), 'avatars')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function avatarPath(pubkey: string): string {
  return path.join(avatarDir(), pubkey)
}

/**
 * The contact's avatar as a data URL, or null when the contact has no
 * picture or the download fails. Files are cached on disk per pubkey and
 * re-downloaded after AVATAR_TTL_MS; the cache survives restarts.
 */
export async function getContactAvatar(identityId: string, accountId: string, pubkey: string): Promise<string | null> {
  const db = getDb(identityId)
  const contact = dao.getContact(db, accountId, pubkey)
  const url = contact?.avatarUrl
  if (!url || !/^https?:\/\//.test(url)) return null

  const cached = dao.getAvatarCache(db, pubkey)
  if (cached && Date.now() - cached.fetchedAt < AVATAR_TTL_MS) {
    const dataUrl = readAsDataUrl(pubkey, cached.contentType)
    if (dataUrl) return dataUrl
    // File vanished — fall through to re-download
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    clearTimeout(timer)
    if (!response.ok) return null
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!contentType.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > MAX_BYTES) return null

    fs.writeFileSync(avatarPath(pubkey), buffer)
    dao.setAvatarCache(db, { pubkey, contentType, fetchedAt: Date.now() })
    return `data:${contentType};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

function readAsDataUrl(pubkey: string, contentType: string): string | null {
  try {
    const buffer = fs.readFileSync(avatarPath(pubkey))
    return `data:${contentType};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** Delete cached avatar files; the per-identity table is cleared separately. */
export function clearAvatarFiles(): void {
  try {
    fs.rmSync(avatarDir(), { recursive: true, force: true })
  } catch { /* nothing to clear */ }
}
