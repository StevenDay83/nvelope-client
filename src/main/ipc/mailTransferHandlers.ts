import { app, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import { getDb, broadcastMailChanged } from './dbHandlers'
import * as dao from '../db/dao'
import {
  buildExportPayload,
  serializeEnvelope,
  parseEnvelope,
  decryptPayload,
  summarizePayload,
  runImport,
  type ExportSelection,
  type ImportSelection,
} from '../mailTransfer'

const FILE_FILTERS = [
  { name: 'nVelope mail export', extensions: ['json'] },
  { name: 'All files', extensions: ['*'] },
]

function defaultFileName(): string {
  const stamp = new Date().toISOString().slice(0, 10)
  return `nvelope-mail-${stamp}.json`
}

function summarizeFile(path: string, password?: string) {
  const env = parseEnvelope(fs.readFileSync(path, 'utf8'))
  if (env.encrypted && password === undefined) {
    return { encrypted: true as const, appVersion: env.appVersion }
  }
  const payload = decryptPayload(env, password)
  return { encrypted: false as const, appVersion: env.appVersion, summary: summarizePayload(payload) }
}

export function registerMailTransferHandlers(): void {
  // Folder checklist (with counts) for the export modal. Outbox/drafts rows
  // are state-based, not folder-based, so they get separate counters.
  ipcMain.handle('mailExport:options', async (_event, identityId: string, accountId: string) => {
    const db = getDb(identityId)
    const folders = dao
      .getFolders(db, accountId)
      .filter((f) => f.type !== 'outbox' && f.type !== 'drafts')
      .map((f) => ({ id: f.id, name: f.name, type: f.type, count: dao.countByFolder(db, accountId, f.id) }))
    const outboxCount =
      dao.getMailByState(db, accountId, 'pending').length + dao.getMailByState(db, accountId, 'processing').length
    const draftsCount = dao.getMailByState(db, accountId, 'draft').length
    return { folders, outboxCount, draftsCount }
  })

  ipcMain.handle(
    'mailExport:run',
    async (_event, identityId: string, accountId: string, selection: ExportSelection & { password?: string }) => {
      const result = await dialog.showSaveDialog({
        defaultPath: defaultFileName(),
        filters: FILE_FILTERS,
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      const payload = buildExportPayload(getDb(identityId), accountId, selection)
      const json = serializeEnvelope(payload, app.getVersion(), selection.password || undefined)
      fs.writeFileSync(result.filePath, json, 'utf8')
      return { canceled: false, path: result.filePath, count: payload.mail.length }
    },
  )

  // Pick + parse a file. Encrypted files only report that fact — the renderer
  // asks for a password, then calls mailImport:decrypt.
  ipcMain.handle('mailImport:inspect', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: FILE_FILTERS })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const path = result.filePaths[0]!
    try {
      return { canceled: false, path, ...summarizeFile(path) }
    } catch (e) {
      return { canceled: false, path, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('mailImport:decrypt', async (_event, path: string, password: string) => {
    try {
      return summarizeFile(path, password)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'mailImport:run',
    async (
      _event,
      identityId: string,
      accountId: string,
      path: string,
      password: string | null,
      selection: ImportSelection,
    ) => {
      try {
        const env = parseEnvelope(fs.readFileSync(path, 'utf8'))
        const payload = decryptPayload(env, password ?? undefined)
        const outcome = runImport(getDb(identityId), accountId, payload, selection)
        broadcastMailChanged(identityId)
        return outcome
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  )
}
