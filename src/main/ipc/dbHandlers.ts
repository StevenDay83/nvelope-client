import { ipcMain, app, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import * as dao from '../db/dao'

// 'databases' is a reserved name: Chromium deletes userData/databases on startup
// as leftover WebSQL storage (Electron 32+). Keep app data under a different name.
const DB_DIR = path.join(app.getPath('userData'), 'nvdb')

const dbConnections = new Map<string, Database.Database>()

function broadcastContactsChanged(identityId: string, accountId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('contacts:changed', { identityId, accountId })
  }
}

function ensureDbDir(): void {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
}

function getDbPath(identityId: string): string {
  return path.join(DB_DIR, `${identityId}.db`)
}

export function getDb(identityId: string): Database.Database {
  if (!dbConnections.has(identityId)) {
    ensureDbDir()
    const db = new Database(getDbPath(identityId))
    dbConnections.set(identityId, db)
  }
  return dbConnections.get(identityId)!
}

export function closeAllDbs(): void {
  for (const [identityId, db] of dbConnections) {
    try {
      db.close()
    } catch (e) {
      console.error(`[db] failed to close db for ${identityId}:`, e)
    }
  }
  dbConnections.clear()
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'user',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(accountId, type)
);

CREATE TABLE IF NOT EXISTS mail (
  innerEventId TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  folderId INTEGER,
  state TEXT NOT NULL DEFAULT 'received',
  senderPubkey TEXT,
  recipientPubkey TEXT,
  subject TEXT,
  threadId TEXT,
  isBroadcast INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  marked INTEGER NOT NULL DEFAULT 0,
  spamScore REAL,
  envelopeEventId TEXT,
  envelopeRecipient TEXT,
  nonce TEXT,
  messageType TEXT,
  keyInfo TEXT,
  messageData TEXT NOT NULL,
  FOREIGN KEY (folderId) REFERENCES folders(id)
);

CREATE INDEX IF NOT EXISTS idx_mail_account ON mail(accountId);
CREATE INDEX IF NOT EXISTS idx_mail_folder ON mail(folderId);
CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail(threadId);
CREATE INDEX IF NOT EXISTS idx_mail_sender ON mail(senderPubkey);
CREATE INDEX IF NOT EXISTS idx_mail_created ON mail(createdAt);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId TEXT NOT NULL,
  naddr TEXT NOT NULL,
  displayName TEXT,
  topic TEXT NOT NULL,
  since INTEGER,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  nip05 TEXT,
  displayName TEXT,
  avatarUrl TEXT,
  cachedAt INTEGER,
  isNostrMailEnabled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(accountId, pubkey)
);

CREATE INDEX IF NOT EXISTS idx_contacts_pubkey ON contacts(accountId, pubkey);

CREATE TABLE IF NOT EXISTS identity_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS profile_cache (
  pubkey TEXT NOT NULL,
  dTag TEXT NOT NULL,
  eventJson TEXT,
  fetchedAt INTEGER NOT NULL,
  PRIMARY KEY (pubkey, dTag)
);

CREATE TABLE IF NOT EXISTS avatar_cache (
  pubkey TEXT PRIMARY KEY,
  contentType TEXT NOT NULL,
  fetchedAt INTEGER NOT NULL
);
`

// Columns added after the initial schema — ALTERs fail harmlessly once applied.
const MIGRATION_STATEMENTS = [
  'ALTER TABLE contacts ADD COLUMN kind0Name TEXT',
  'ALTER TABLE contacts ADD COLUMN kind0DisplayName TEXT',
  'ALTER TABLE contacts ADD COLUMN nip05Verified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE contacts ADD COLUMN profileFetchedAt INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE mail ADD COLUMN deletedAt INTEGER',
  'ALTER TABLE mail ADD COLUMN prevState TEXT',
  'ALTER TABLE mail ADD COLUMN prevFolderId INTEGER',
]

export function registerDbHandlers(): void {
  ipcMain.handle('db:initSchema', async (_event, identityId: string) => {
    const db = getDb(identityId)
    db.exec(INIT_SQL)
    for (const stmt of MIGRATION_STATEMENTS) {
      try {
        db.exec(stmt)
      } catch { /* column already exists */ }
    }

    // Clean up duplicate global folders from old schema (pre-UNIQUE constraint)
    const dupCheck = db.prepare(`
      SELECT type FROM folders WHERE accountId = '__global__'
      GROUP BY type HAVING COUNT(*) > 1
    `)
    const dups = dupCheck.all() as Array<{ type: string }>
    for (const { type } of dups) {
      // Keep the oldest (lowest id) row, delete the rest
      db.prepare(`
        DELETE FROM folders WHERE accountId = '__global__' AND type = ? AND id NOT IN (
          SELECT MIN(id) FROM folders WHERE accountId = '__global__' AND type = ?
        )
      `).run(type, type)
    }

    // Seed global folders only if they don't already exist
    const globalCount = db.prepare("SELECT COUNT(*) as count FROM folders WHERE accountId = '__global__'").get() as { count: number }
    if (globalCount.count === 0) {
      db.prepare(`
        INSERT INTO folders (accountId, name, type, sortOrder) VALUES
          ('__global__', 'Inbox', 'inbox', 0),
          ('__global__', 'Sent', 'sent', 1),
          ('__global__', 'Outbox', 'outbox', 2),
          ('__global__', 'Drafts', 'drafts', 3),
          ('__global__', 'Junk', 'junk', 4),
          ('__global__', 'Deleted', 'deleted', 5)
      `).run()
    }

    // The Deleted folder was added after the initial seed — add it to existing dbs
    db.prepare(`
      INSERT INTO folders (accountId, name, type, sortOrder)
      SELECT '__global__', 'Deleted', 'deleted', 5
      WHERE NOT EXISTS (SELECT 1 FROM folders WHERE accountId = '__global__' AND type = 'deleted')
    `).run()

    // Pre-Deleted-folder soft deletes left rows in place with state='deleted'
    const deletedFolder = db.prepare("SELECT id FROM folders WHERE accountId = '__global__' AND type = 'deleted'").get() as { id: number } | undefined
    if (deletedFolder) {
      db.prepare(`
        UPDATE mail SET folderId = ?, deletedAt = COALESCE(deletedAt, strftime('%s','now'))
        WHERE state = 'deleted' AND (folderId IS NULL OR folderId != ?)
      `).run(deletedFolder.id, deletedFolder.id)
    }

    // Permanently purge messages past the 14-day Deleted-folder retention
    dao.purgeDeletedMail(db, 14)
  })

  // --- Mail ---
  ipcMain.handle('db:mail:insert', async (_event, identityId: string, mail: dao.MailRecord) => {
    dao.insertMail(getDb(identityId), mail)
  })

  ipcMain.handle('db:mail:getByFolder', async (_event, identityId: string, accountId: string, folderId: number) => {
    return dao.getMailByFolder(getDb(identityId), accountId, folderId)
  })

  ipcMain.handle('db:mail:getByState', async (_event, identityId: string, accountId: string, state: dao.MailRecord['state']) => {
    return dao.getMailByState(getDb(identityId), accountId, state)
  })

  ipcMain.handle('db:mail:getByThread', async (_event, identityId: string, accountId: string, threadId: string) => {
    return dao.getMailByThread(getDb(identityId), accountId, threadId)
  })

  ipcMain.handle('db:mail:countUnread', async (_event, identityId: string, accountId: string, folderId: number) => {
    return dao.countUnreadByFolder(getDb(identityId), accountId, folderId)
  })

  ipcMain.handle('db:mail:search', async (_event, identityId: string, accountId: string, query: string) => {
    return dao.searchMail(getDb(identityId), accountId, query)
  })

  ipcMain.handle('db:mail:markRead', async (_event, identityId: string, innerEventId: string, read: boolean) => {
    dao.markRead(getDb(identityId), innerEventId, read)
  })

  ipcMain.handle('db:mail:toggleMarked', async (_event, identityId: string, innerEventId: string) => {
    return dao.toggleMarked(getDb(identityId), innerEventId)
  })

  ipcMain.handle('db:mail:moveToFolder', async (_event, identityId: string, innerEventId: string, folderId: number | null) => {
    const db = getDb(identityId)
    const mail = db.prepare('SELECT state FROM mail WHERE innerEventId = ?').get(innerEventId) as { state: string } | undefined
    const target = folderId == null
      ? undefined
      : db.prepare('SELECT type FROM folders WHERE id = ?').get(folderId) as { type: string } | undefined
    if (target?.type === 'deleted') {
      dao.softDeleteMail(db, innerEventId)
    } else if (mail?.state === 'deleted') {
      dao.restoreMail(db, innerEventId, folderId)
    } else {
      dao.moveToFolder(db, innerEventId, folderId)
    }
  })

  ipcMain.handle('db:mail:softDelete', async (_event, identityId: string, innerEventId: string) => {
    dao.softDeleteMail(getDb(identityId), innerEventId)
  })

  ipcMain.handle('db:mail:delete', async (_event, identityId: string, innerEventId: string) => {
    dao.deleteMail(getDb(identityId), innerEventId)
  })

  // --- Folders ---
  ipcMain.handle('db:folders:get', async (_event, identityId: string, accountId: string) => {
    return dao.getFolders(getDb(identityId), accountId)
  })

  ipcMain.handle('db:folders:getSpecial', async (_event, identityId: string, accountId: string, type: dao.FolderRecord['type']) => {
    return dao.getSpecialFolder(getDb(identityId), accountId, type)
  })

  ipcMain.handle('db:folders:create', async (_event, identityId: string, accountId: string, name: string) => {
    return dao.createFolder(getDb(identityId), accountId, name)
  })

  ipcMain.handle('db:folders:delete', async (_event, identityId: string, folderId: number) => {
    dao.deleteFolder(getDb(identityId), folderId)
  })

  // --- Contacts ---
  ipcMain.handle('db:contacts:upsert', async (_event, identityId: string, contact: dao.ContactRecord) => {
    dao.upsertContact(getDb(identityId), contact)
    broadcastContactsChanged(identityId, contact.accountId)
  })

  ipcMain.handle('db:contacts:get', async (_event, identityId: string, accountId: string, pubkey: string) => {
    return dao.getContact(getDb(identityId), accountId, pubkey)
  })

  ipcMain.handle('db:contacts:getAll', async (_event, identityId: string, accountId: string) => {
    return dao.getContacts(getDb(identityId), accountId)
  })

  ipcMain.handle('db:contacts:remove', async (_event, identityId: string, accountId: string, pubkey: string) => {
    dao.deleteContact(getDb(identityId), accountId, pubkey)
    broadcastContactsChanged(identityId, accountId)
  })

  // --- Subscriptions ---
  ipcMain.handle('db:subs:add', async (_event, identityId: string, sub: dao.SubscriptionRecord) => {
    return dao.addSubscription(getDb(identityId), sub)
  })

  ipcMain.handle('db:subs:remove', async (_event, identityId: string, id: number) => {
    dao.removeSubscription(getDb(identityId), id)
  })

  ipcMain.handle('db:subs:getAll', async (_event, identityId: string, accountId: string) => {
    return dao.getSubscriptions(getDb(identityId), accountId)
  })
}
