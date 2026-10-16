import Database from 'better-sqlite3'

export interface MailRecord {
  innerEventId: string
  accountId: string
  folderId?: number | null
  state: 'received' | 'published' | 'processing' | 'pending' | 'scheduled' | 'deleted' | 'draft'
  senderPubkey: string
  recipientPubkey?: string | null
  subject?: string | null
  threadId?: string | null
  isBroadcast: number
  createdAt: number
  read: number
  marked: number
  spamScore?: number | null
  envelopeEventId?: string | null
  envelopeRecipient?: string | null
  nonce?: string | null
  messageType?: string | null
  keyInfo?: string | null
  messageData: string
}

export interface FolderRecord {
  id: number
  accountId: string
  name: string
  type: 'inbox' | 'sent' | 'outbox' | 'drafts' | 'junk' | 'user'
  sortOrder: number
  createdAt: number
}

export interface ContactRecord {
  id?: number
  accountId: string
  pubkey: string
  nip05?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  cachedAt?: number | null
  isNostrMailEnabled: number
}

export interface SubscriptionRecord {
  id?: number
  accountId: string
  naddr: string
  displayName?: string | null
  topic: string
  since?: number | null
  createdAt: number
}

// ------------------------------------------------------------------
// Mail DAO
// ------------------------------------------------------------------

export function insertMail(db: Database.Database, mail: MailRecord): void {
  const stmt = db.prepare(`
    INSERT INTO mail (
      innerEventId, accountId, folderId, state, senderPubkey, recipientPubkey,
      subject, threadId, isBroadcast, createdAt, read, marked, spamScore,
      envelopeEventId, envelopeRecipient, nonce, messageType, keyInfo, messageData
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(innerEventId) DO UPDATE SET
      folderId=excluded.folderId,
      state=excluded.state,
      read=excluded.read,
      marked=excluded.marked,
      spamScore=excluded.spamScore,
      messageData=excluded.messageData
  `)
  stmt.run(
    mail.innerEventId, mail.accountId, mail.folderId ?? null, mail.state,
    mail.senderPubkey, mail.recipientPubkey ?? null, mail.subject ?? null,
    mail.threadId ?? null, mail.isBroadcast, mail.createdAt, mail.read,
    mail.marked, mail.spamScore ?? null, mail.envelopeEventId ?? null,
    mail.envelopeRecipient ?? null, mail.nonce ?? null, mail.messageType ?? null,
    mail.keyInfo ?? null, mail.messageData,
  )
}

export function getMailByFolder(db: Database.Database, accountId: string, folderId: number): MailRecord[] {
  const stmt = db.prepare('SELECT * FROM mail WHERE accountId = ? AND folderId = ? ORDER BY createdAt DESC')
  return stmt.all(accountId, folderId) as MailRecord[]
}

export function getMailByThread(db: Database.Database, accountId: string, threadId: string): MailRecord[] {
  const stmt = db.prepare('SELECT * FROM mail WHERE accountId = ? AND threadId = ? ORDER BY createdAt ASC')
  return stmt.all(accountId, threadId) as MailRecord[]
}

export function getMailByEnvelopeId(db: Database.Database, envelopeEventId: string): MailRecord | undefined {
  const stmt = db.prepare('SELECT * FROM mail WHERE envelopeEventId = ? LIMIT 1')
  return stmt.get(envelopeEventId) as MailRecord | undefined
}

export function getMailByState(db: Database.Database, accountId: string, state: MailRecord['state']): MailRecord[] {
  const stmt = db.prepare('SELECT * FROM mail WHERE accountId = ? AND state = ? ORDER BY createdAt DESC')
  return stmt.all(accountId, state) as MailRecord[]
}

export function countUnreadByFolder(db: Database.Database, accountId: string, folderId: number): number {
  const stmt = db.prepare('SELECT COUNT(*) as c FROM mail WHERE accountId = ? AND folderId = ? AND read = 0')
  const row = stmt.get(accountId, folderId) as { c: number }
  return row.c
}

export function searchMail(db: Database.Database, accountId: string, query: string): MailRecord[] {
  const like = `%${query}%`
  const stmt = db.prepare(`
    SELECT * FROM mail WHERE accountId = ? AND state != 'deleted'
      AND (subject LIKE ? OR senderPubkey LIKE ? OR messageData LIKE ?)
    ORDER BY createdAt DESC
  `)
  return stmt.all(accountId, like, like, like) as MailRecord[]
}

export function markRead(db: Database.Database, innerEventId: string, read: boolean): void {
  const stmt = db.prepare('UPDATE mail SET read = ? WHERE innerEventId = ?')
  stmt.run(read ? 1 : 0, innerEventId)
}

export function toggleMarked(db: Database.Database, innerEventId: string): boolean {
  const current = db.prepare('SELECT marked FROM mail WHERE innerEventId = ?').get(innerEventId) as { marked: number } | undefined
  const newVal = current ? (current.marked ? 0 : 1) : 1
  db.prepare('UPDATE mail SET marked = ? WHERE innerEventId = ?').run(newVal, innerEventId)
  return newVal === 1
}

export function moveToFolder(db: Database.Database, innerEventId: string, folderId: number | null): void {
  const stmt = db.prepare('UPDATE mail SET folderId = ? WHERE innerEventId = ?')
  stmt.run(folderId ?? null, innerEventId)
}

export function softDeleteMail(db: Database.Database, innerEventId: string): void {
  const stmt = db.prepare("UPDATE mail SET state = 'deleted' WHERE innerEventId = ?")
  stmt.run(innerEventId)
}

export function deleteMail(db: Database.Database, innerEventId: string): void {
  const stmt = db.prepare('DELETE FROM mail WHERE innerEventId = ?')
  stmt.run(innerEventId)
}

// ------------------------------------------------------------------
// Outbox queue helpers
// ------------------------------------------------------------------

export function getQueuedMail(db: Database.Database, accountId: string): MailRecord[] {
  const stmt = db.prepare("SELECT * FROM mail WHERE accountId = ? AND state = 'pending' ORDER BY createdAt ASC")
  return stmt.all(accountId) as MailRecord[]
}

export function setMailState(db: Database.Database, innerEventId: string, state: MailRecord['state']): void {
  db.prepare('UPDATE mail SET state = ? WHERE innerEventId = ?').run(state, innerEventId)
}

export function updateMailMessageData(db: Database.Database, innerEventId: string, messageData: string): void {
  db.prepare('UPDATE mail SET messageData = ? WHERE innerEventId = ?').run(messageData, innerEventId)
}

/** Recovery: rows stuck in 'processing' when the app quit go back to the queue. */
export function resetProcessingToPending(db: Database.Database): void {
  db.prepare("UPDATE mail SET state = 'pending' WHERE state = 'processing'").run()
}

/** Move a queued row to Sent after successful publish. */
export function markMailSent(db: Database.Database, innerEventId: string, sentFolderId: number | null, envelopeEventId: string): void {
  db.prepare("UPDATE mail SET folderId = ?, state = 'published', envelopeEventId = ? WHERE innerEventId = ?")
    .run(sentFolderId ?? null, envelopeEventId, innerEventId)
}

// ------------------------------------------------------------------
// Folder DAO
// ------------------------------------------------------------------

export function getFolders(db: Database.Database, accountId: string): FolderRecord[] {
  const stmt = db.prepare('SELECT * FROM folders WHERE accountId = ? OR accountId = ? ORDER BY sortOrder')
  return stmt.all(accountId, '__global__') as FolderRecord[]
}

export function getSpecialFolder(db: Database.Database, accountId: string, type: FolderRecord['type']): FolderRecord | undefined {
  const stmt = db.prepare('SELECT * FROM folders WHERE (accountId = ? OR accountId = ?) AND type = ? LIMIT 1')
  return stmt.get(accountId, '__global__', type) as FolderRecord | undefined
}

export function createFolder(db: Database.Database, accountId: string, name: string): number {
  const maxStmt = db.prepare('SELECT COALESCE(MAX(sortOrder), 0) + 1 as nextOrder FROM folders WHERE accountId = ?')
  const { nextOrder } = maxStmt.get(accountId) as { nextOrder: number }
  const stmt = db.prepare('INSERT INTO folders (accountId, name, type, sortOrder) VALUES (?, ?, ?, ?)')
  const result = stmt.run(accountId, name, 'user', nextOrder)
  return Number(result.lastInsertRowid)
}

export function deleteFolder(db: Database.Database, folderId: number): void {
  const stmt = db.prepare('DELETE FROM folders WHERE id = ? AND type = ?')
  stmt.run(folderId, 'user')
}

// ------------------------------------------------------------------
// Contact DAO
// ------------------------------------------------------------------

export function upsertContact(db: Database.Database, contact: ContactRecord): void {
  const stmt = db.prepare(`
    INSERT INTO contacts (accountId, pubkey, nip05, displayName, avatarUrl, cachedAt, isNostrMailEnabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(accountId, pubkey) DO UPDATE SET
      nip05=excluded.nip05,
      displayName=excluded.displayName,
      avatarUrl=excluded.avatarUrl,
      cachedAt=excluded.cachedAt,
      isNostrMailEnabled=excluded.isNostrMailEnabled
  `)
  stmt.run(
    contact.accountId, contact.pubkey, contact.nip05 ?? null,
    contact.displayName ?? null, contact.avatarUrl ?? null,
    contact.cachedAt ?? null, contact.isNostrMailEnabled,
  )
}

export function getContact(db: Database.Database, accountId: string, pubkey: string): ContactRecord | null {
  const stmt = db.prepare('SELECT * FROM contacts WHERE accountId = ? AND pubkey = ? LIMIT 1')
  return (stmt.get(accountId, pubkey) as ContactRecord) ?? null
}

export function getContacts(db: Database.Database, accountId: string): ContactRecord[] {
  const stmt = db.prepare('SELECT * FROM contacts WHERE accountId = ? ORDER BY displayName, pubkey')
  return stmt.all(accountId) as ContactRecord[]
}

export function deleteContact(db: Database.Database, accountId: string, pubkey: string): void {
  const stmt = db.prepare('DELETE FROM contacts WHERE accountId = ? AND pubkey = ?')
  stmt.run(accountId, pubkey)
}

// ------------------------------------------------------------------
// Profile cache DAO (kind-30998 cert/policy events, keyed per identity db)
// ------------------------------------------------------------------

export interface ProfileCacheRecord {
  pubkey: string
  dTag: string
  /** Full event JSON, or NULL when the relay query found nothing. */
  eventJson: string | null
  fetchedAt: number
}

export function getProfileCache(db: Database.Database, dTag: string, pubkeys: string[]): ProfileCacheRecord[] {
  if (pubkeys.length === 0) return []
  const marks = pubkeys.map(() => '?').join(',')
  const stmt = db.prepare(`SELECT * FROM profile_cache WHERE dTag = ? AND pubkey IN (${marks})`)
  return stmt.all(dTag, ...pubkeys) as ProfileCacheRecord[]
}

export function setProfileCache(db: Database.Database, record: ProfileCacheRecord): void {
  db.prepare(`
    INSERT INTO profile_cache (pubkey, dTag, eventJson, fetchedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(pubkey, dTag) DO UPDATE SET eventJson=excluded.eventJson, fetchedAt=excluded.fetchedAt
  `).run(record.pubkey, record.dTag, record.eventJson, record.fetchedAt)
}

/** Drop every cached cert/policy entry — next lookups go back to the relays. */
export function clearProfileCache(db: Database.Database): void {
  db.prepare('DELETE FROM profile_cache').run()
}

// ------------------------------------------------------------------
// Subscription DAO
// ------------------------------------------------------------------

export function addSubscription(db: Database.Database, sub: SubscriptionRecord): number {
  const stmt = db.prepare(`
    INSERT INTO subscriptions (accountId, naddr, displayName, topic, since, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    sub.accountId, sub.naddr, sub.displayName ?? null,
    sub.topic, sub.since ?? null, sub.createdAt,
  )
  return Number(result.lastInsertRowid)
}

export function removeSubscription(db: Database.Database, id: number): void {
  const stmt = db.prepare('DELETE FROM subscriptions WHERE id = ?')
  stmt.run(id)
}

export function getSubscriptions(db: Database.Database, accountId: string): SubscriptionRecord[] {
  const stmt = db.prepare('SELECT * FROM subscriptions WHERE accountId = ? ORDER BY createdAt DESC')
  return stmt.all(accountId) as SubscriptionRecord[]
}
