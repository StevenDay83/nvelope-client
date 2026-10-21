import { ipcMain, dialog } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { finalizeEvent } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { getUnlockedSession } from './vaultHandlers'

// BUD-02: PUT /upload with a kind-24242 Nostr auth event in the Authorization
// header. All Blossom servers here are https-only.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const AUTH_EVENT_KIND = 24242
const AUTH_EXPIRATION_SEC = 300

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function decodeNsec(nsec: string): Uint8Array {
  const result = decode(nsec)
  if (result.type !== 'nsec') throw new Error('Invalid nsec format')
  return result.data as Uint8Array
}

function normalizeHost(host: string): string {
  const h = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(h) || h.includes('..')) {
    throw new Error('Invalid Blossom server host')
  }
  return h
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Extract the blob URL from a descriptor — servers return an object per
 *  BUD-02, but some return the descriptor's tag array instead. */
function extractDescriptorUrl(body: unknown): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const url = (body as Record<string, unknown>).url
    if (typeof url === 'string') return url
  }
  if (Array.isArray(body)) {
    const tag = body.find((t) => Array.isArray(t) && t[0] === 'url' && typeof t[1] === 'string')
    if (tag) return tag[1] as string
  }
  return null
}

export function registerBlossomHandlers(): void {
  ipcMain.handle('blossom:upload', async (_event, identityId: string, accountId: string, serverHost: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const account = session.payload.accounts.find((a) => a.pubkey === accountId)
    if (!account) throw new Error('Account not found')
    const host = normalizeHost(serverHost)

    const picked = await dialog.showOpenDialog({ properties: ['openFile'] })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }
    const filePath = picked.filePaths[0]!
    const fileName = path.basename(filePath)

    const stat = fs.statSync(filePath)
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error('File is too large (100 MB max for uploads)')
    }
    const fileBytes = fs.readFileSync(filePath)
    const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex')
    const mime = guessMime(filePath)

    const authEvent = finalizeEvent(
      {
        kind: AUTH_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', 'upload'],
          ['x', sha256],
          ['expiration', String(Math.floor(Date.now() / 1000) + AUTH_EXPIRATION_SEC)],
        ],
        content: `Upload ${fileName}`,
      },
      decodeNsec(account.nsec),
    )
    const authorization = `Nostr ${Buffer.from(JSON.stringify(authEvent), 'utf-8').toString('base64')}`

    let res: Response
    try {
      res = await fetch(`https://${host}/upload`, {
        method: 'PUT',
        headers: { Authorization: authorization, 'Content-Type': mime },
        body: new Uint8Array(fileBytes),
      })
    } catch (e) {
      throw new Error(`Could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch { /* non-JSON response — handled below */ }

    if (!res.ok) {
      const reason = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).reason
        : null
      throw new Error(typeof reason === 'string' && reason ? reason : `Upload failed (HTTP ${res.status})`)
    }

    const url = extractDescriptorUrl(body)
    if (!url || !/^https:\/\//.test(url)) {
      throw new Error('Server did not return a valid blob URL')
    }
    return { canceled: false, url, sha256, size: stat.size, mime, name: fileName }
  })
}
