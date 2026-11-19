import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import * as dao from './db/dao'

// Mail export/import file format. JSON envelope, optionally with the payload
// AES-256-GCM encrypted under a scrypt-derived key. `version` gates import:
// same major app version keeps compatibility, so only bump it on breaking
// layout changes — importers reject anything newer than what they know.
export const EXPORT_FORMAT = 'nvelope-mail-export'
export const EXPORT_VERSION = 1

export interface ExportSelection {
  folderIds: number[]
  includeOutbox: boolean
  includeDrafts: boolean
}

export interface ImportSelection {
  folders: Array<{ name: string; type: string }>
  includeOutbox: boolean
  includeDrafts: boolean
}

interface ExportedMailRow {
  innerEventId: string
  state: string
  senderPubkey: string
  recipientPubkey: string | null
  subject: string | null
  threadId: string | null
  isBroadcast: number
  createdAt: number
  read: number
  marked: number
  spamScore: number | null
  envelopeEventId: string | null
  envelopeRecipient: string | null
  nonce: string | null
  messageType: string | null
  keyInfo: string | null
  messageData: string
  deletedAt: number | null
  prevState: string | null
  folderType: string
  folderName: string
}

export interface ExportPayload {
  accountId: string
  exportedAt: number
  mail: ExportedMailRow[]
}

export interface ImportSummary {
  exportedAt: number
  sourceAccountId: string
  folders: Array<{ name: string; type: string; count: number }>
  outboxCount: number
  draftsCount: number
  total: number
}

// Special folders match by type (their names are fixed); user folders match by
// name. Outbox/drafts rows are grouped under their pseudo-types.
function folderKey(folderType: string, folderName: string): string {
  return folderType === 'user' ? `user:${folderName}` : folderType
}

function serializeMailRow(row: dao.MailRecord, folderType: string, folderName: string): ExportedMailRow {
  return {
    innerEventId: row.innerEventId,
    state: row.state,
    senderPubkey: row.senderPubkey,
    recipientPubkey: row.recipientPubkey ?? null,
    subject: row.subject ?? null,
    threadId: row.threadId ?? null,
    isBroadcast: row.isBroadcast,
    createdAt: row.createdAt,
    read: row.read,
    marked: row.marked,
    spamScore: row.spamScore ?? null,
    envelopeEventId: row.envelopeEventId ?? null,
    envelopeRecipient: row.envelopeRecipient ?? null,
    nonce: row.nonce ?? null,
    messageType: row.messageType ?? null,
    keyInfo: row.keyInfo ?? null,
    messageData: row.messageData,
    deletedAt: row.deletedAt ?? null,
    prevState: row.prevState ?? null,
    folderType,
    folderName,
  }
}

export function buildExportPayload(db: Database.Database, accountId: string, selection: ExportSelection): ExportPayload {
  const mail: ExportedMailRow[] = []
  for (const folder of dao.getFolders(db, accountId)) {
    if (!selection.folderIds.includes(folder.id)) continue
    if (folder.type === 'outbox' || folder.type === 'drafts') continue
    for (const row of dao.getMailByFolder(db, accountId, folder.id)) {
      mail.push(serializeMailRow(row, folder.type, folder.name))
    }
  }
  if (selection.includeOutbox) {
    const outboxName = dao.getSpecialFolder(db, accountId, 'outbox')?.name ?? 'Outbox'
    for (const state of ['pending', 'processing'] as const) {
      for (const row of dao.getMailByState(db, accountId, state)) {
        mail.push(serializeMailRow(row, 'outbox', outboxName))
      }
    }
  }
  if (selection.includeDrafts) {
    const draftsName = dao.getSpecialFolder(db, accountId, 'drafts')?.name ?? 'Drafts'
    for (const row of dao.getMailByState(db, accountId, 'draft')) {
      mail.push(serializeMailRow(row, 'drafts', draftsName))
    }
  }
  return { accountId, exportedAt: Math.floor(Date.now() / 1000), mail }
}

export function serializeEnvelope(payload: ExportPayload, appVersion: string, password?: string): string {
  const envelope: Record<string, unknown> = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    appVersion,
    exportedAt: payload.exportedAt,
    encrypted: !!password,
  }
  if (!password) {
    envelope.payload = payload
    return JSON.stringify(envelope, null, 2)
  }
  const salt = crypto.randomBytes(16)
  const nonce = crypto.randomBytes(12)
  const key = crypto.scryptSync(password, salt, 32)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  envelope.kdf = { algo: 'scrypt', N: 16384, r: 8, p: 1, salt: salt.toString('base64') }
  envelope.cipher = {
    algo: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  return JSON.stringify(envelope, null, 2)
}

interface Envelope {
  format: string
  version: number
  appVersion?: string
  exportedAt?: number
  encrypted: boolean
  payload?: ExportPayload
  kdf?: { algo: string; N: number; r: number; p: number; salt: string }
  cipher?: { algo: string; nonce: string; tag: string; data: string }
}

export function parseEnvelope(text: string): Envelope {
  let env: Envelope
  try {
    env = JSON.parse(text) as Envelope
  } catch {
    throw new Error('Not a valid JSON file')
  }
  if (!env || env.format !== EXPORT_FORMAT) {
    throw new Error('This is not an nVelope mail export file')
  }
  if (typeof env.version !== 'number' || env.version > EXPORT_VERSION) {
    throw new Error(
      `This export was created by a newer version of nVelope (file version ${String(env.version)}; this client supports up to ${EXPORT_VERSION})`,
    )
  }
  return env
}

export function decryptPayload(env: Envelope, password?: string): ExportPayload {
  if (!env.encrypted) {
    if (!env.payload) throw new Error('Export file is missing its payload')
    return env.payload
  }
  try {
    const kdf = env.kdf!
    const cipher = env.cipher!
    const key = crypto.scryptSync(password ?? '', Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p })
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.nonce, 'base64'))
    decipher.setAuthTag(Buffer.from(cipher.tag, 'base64'))
    const json = Buffer.concat([decipher.update(Buffer.from(cipher.data, 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(json) as ExportPayload
  } catch {
    throw new Error('Wrong password or corrupted file')
  }
}

const SPECIAL_ORDER = ['inbox', 'sent', 'junk', 'deleted']

export function summarizePayload(payload: ExportPayload): ImportSummary {
  const folderCounts = new Map<string, { name: string; type: string; count: number }>()
  let outboxCount = 0
  let draftsCount = 0
  for (const row of payload.mail) {
    if (row.folderType === 'outbox') {
      outboxCount++
    } else if (row.folderType === 'drafts') {
      draftsCount++
    } else {
      const key = folderKey(row.folderType, row.folderName)
      const entry = folderCounts.get(key) ?? { name: row.folderName, type: row.folderType, count: 0 }
      entry.count++
      folderCounts.set(key, entry)
    }
  }
  const folders = [...folderCounts.values()].sort((a, b) => {
    const ai = SPECIAL_ORDER.indexOf(a.type)
    const bi = SPECIAL_ORDER.indexOf(b.type)
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    return a.name.localeCompare(b.name)
  })
  return {
    exportedAt: payload.exportedAt,
    sourceAccountId: payload.accountId,
    folders,
    outboxCount,
    draftsCount,
    total: payload.mail.length,
  }
}

export interface ImportResult {
  imported: number
  skipped: number
  foldersCreated: number
}

export function runImport(
  db: Database.Database,
  targetAccountId: string,
  payload: ExportPayload,
  selection: ImportSelection,
): ImportResult {
  const wanted = new Set(selection.folders.map((f) => folderKey(f.type, f.name)))
  const userFolderIds = new Map<string, number>()
  let imported = 0
  let skipped = 0
  let foldersCreated = 0

  const insert = db.prepare(`
    INSERT OR IGNORE INTO mail (
      innerEventId, accountId, folderId, state, senderPubkey, recipientPubkey,
      subject, threadId, isBroadcast, createdAt, read, marked, spamScore,
      envelopeEventId, envelopeRecipient, nonce, messageType, keyInfo, messageData,
      deletedAt, prevState, prevFolderId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const importAll = db.transaction(() => {
    for (const row of payload.mail) {
      const isOutbox = row.folderType === 'outbox'
      const isDrafts = row.folderType === 'drafts'
      if (isOutbox && !selection.includeOutbox) continue
      if (isDrafts && !selection.includeDrafts) continue
      if (!isOutbox && !isDrafts && !wanted.has(folderKey(row.folderType, row.folderName))) continue

      let folderId: number | null
      if (isOutbox || isDrafts) {
        folderId = dao.getSpecialFolder(db, targetAccountId, isOutbox ? 'outbox' : 'drafts')?.id ?? null
      } else if (row.folderType === 'user') {
        if (!userFolderIds.has(row.folderName)) {
          let existing = db
            .prepare("SELECT id FROM folders WHERE accountId = ? AND type = 'user' AND name = ?")
            .get(targetAccountId, row.folderName) as { id: number } | undefined
          if (!existing) {
            const newId = dao.createFolder(db, targetAccountId, row.folderName)
            foldersCreated++
            existing = { id: newId }
          }
          userFolderIds.set(row.folderName, existing.id)
        }
        folderId = userFolderIds.get(row.folderName)!
      } else {
        folderId = dao.getSpecialFolder(db, targetAccountId, row.folderType as dao.FolderRecord['type'])?.id ?? null
      }

      // Queued rows from another machine restart as plain pending — a row that
      // was mid-processing there can only be mined/sent here.
      const state = isOutbox ? 'pending' : row.state

      const result = insert.run(
        row.innerEventId, targetAccountId, folderId, state,
        row.senderPubkey, row.recipientPubkey, row.subject, row.threadId,
        row.isBroadcast, row.createdAt, row.read, row.marked, row.spamScore,
        row.envelopeEventId, row.envelopeRecipient, row.nonce, row.messageType,
        row.keyInfo, row.messageData, row.deletedAt, row.prevState,
        // prevFolderId points at a folder id from the source database, which is
        // meaningless here; restore falls back to the folder the user picks.
        null,
      )
      if (result.changes > 0) imported++
      else skipped++
    }
  })
  importAll()

  return { imported, skipped, foldersCreated }
}
