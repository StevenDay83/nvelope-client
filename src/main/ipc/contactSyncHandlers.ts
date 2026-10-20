import { BrowserWindow, ipcMain } from 'electron'
import { SimplePool } from 'nostr-tools'
import type { Filter } from 'nostr-tools'
import { NostrToolsTransport, type NostrEvent, fetchRecipientPolicy, difficultyFromTarget } from 'nvelope-core'
import { getUnlockedSession } from './vaultHandlers'
import { getDb } from './dbHandlers'
import { getBenchmarkHashesPerMinute } from '../clientSettings'
import { CachingTransport } from '../relay/cachingTransport'
import { getRelaysForAccount } from '../relay/relayPrefs'
import { enrichContactProfiles } from '../relay/profileEnrich'
import { getContactAvatar, clearAvatarFiles } from '../relay/avatarCache'
import * as dao from '../db/dao'

const CONTACT_LIST_KIND = 3
const MUTE_LIST_KIND = 10000
const PEOPLE_LIST_KIND = 30000
const PROFILE_KIND = 30998
const CERT_D_TAG = 'nv_public_key'

function newestPerKind(events: NostrEvent[], kind: number): NostrEvent | undefined {
  return events
    .filter((e) => e.kind === kind)
    .sort((a, b) => b.created_at - a.created_at)[0]
}

function pTagPubkeys(event: NostrEvent | undefined): string[] {
  if (!event) return []
  return event.tags.filter((t) => t[0] === 'p' && typeof t[1] === 'string').map((t) => t[1])
}

/** kind 3: content JSON array plus p tags are allowed (SPEC §11). */
function kind3Allowed(event: NostrEvent | undefined): Set<string> {
  const allowed = new Set(pTagPubkeys(event))
  if (event?.content) {
    try {
      const content = JSON.parse(event.content) as unknown
      if (Array.isArray(content)) {
        for (const entry of content) if (typeof entry === 'string') allowed.add(entry)
      }
    } catch {
      // malformed kind-3 content — p tags alone still apply
    }
  }
  return allowed
}

async function syncAccountContacts(
  transport: CachingTransport,
  identityId: string,
  accountId: string,
  relays: string[],
): Promise<{ contacts: number; mailEnabled: number }> {
  const db = getDb(identityId)
  const listEvents = await transport.query(
    [
      { kinds: [CONTACT_LIST_KIND], authors: [accountId] },
      { kinds: [MUTE_LIST_KIND], authors: [accountId] },
      { kinds: [PEOPLE_LIST_KIND], authors: [accountId] },
    ] as Filter[],
    relays,
  )

  // Allowed: kind 3 + every kind-30000 people list. Muted: kind-10000 p tags.
  const allowed = kind3Allowed(newestPerKind(listEvents, CONTACT_LIST_KIND))
  for (const ev of listEvents.filter((e) => e.kind === PEOPLE_LIST_KIND)) {
    for (const pk of pTagPubkeys(ev)) allowed.add(pk)
  }
  const muted = new Set(pTagPubkeys(newestPerKind(listEvents, MUTE_LIST_KIND)))
  allowed.delete(accountId)
  for (const pk of muted) allowed.delete(pk)

  const now = Math.floor(Date.now() / 1000)
  for (const pubkey of allowed) {
    const existing = dao.getContact(db, accountId, pubkey)
    dao.upsertContact(db, {
      accountId,
      pubkey,
      // Relay lists carry no profile metadata — keep any locally entered fields.
      nip05: existing?.nip05 ?? null,
      displayName: existing?.displayName ?? null,
      avatarUrl: existing?.avatarUrl ?? null,
      cachedAt: now,
      isNostrMailEnabled: existing?.isNostrMailEnabled ?? 0,
    })
  }

  // Certificate check over the full contact list (synced + manual), batched
  // into one query; served from the profile cache when fresh.
  const contacts = dao.getContacts(db, accountId)
  let mailEnabled = 0
  if (contacts.length > 0) {
    const certEvents = await transport.query(
      { kinds: [PROFILE_KIND], authors: contacts.map((c) => c.pubkey), '#d': [CERT_D_TAG] } as Filter,
      relays,
    )
    const newestByAuthor = new Map<string, NostrEvent>()
    for (const ev of certEvents) {
      const prev = newestByAuthor.get(ev.pubkey)
      if (!prev || ev.created_at > prev.created_at) newestByAuthor.set(ev.pubkey, ev)
    }
    for (const contact of contacts) {
      const cert = newestByAuthor.get(contact.pubkey)
      const enabled = cert && cert.content ? 1 : 0
      if (enabled) mailEnabled++
      if (enabled !== contact.isNostrMailEnabled) {
        dao.upsertContact(db, { ...contact, isNostrMailEnabled: enabled })
      }
    }
  }

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('contacts:changed', { identityId, accountId })
  }
  return { contacts: allowed.size, mailEnabled }
}

export function registerContactSyncHandlers(): void {
  ipcMain.handle('contacts:checkCert', async (_event, identityId: string, accountId: string, pubkey: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const relays = getRelaysForAccount(session.payload.settings.preferences as Record<string, unknown> | undefined, accountId)
    const db = getDb(identityId)
    const transport = new CachingTransport(
      new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 10000 }),
      db,
    )
    try {
      const certEvents = await transport.query(
        { kinds: [PROFILE_KIND], authors: [pubkey], '#d': [CERT_D_TAG] } as Filter,
        relays,
      )
      const newest = certEvents.sort((a, b) => b.created_at - a.created_at)[0]
      const enabled = newest && newest.content ? 1 : 0
      const existing = dao.getContact(db, accountId, pubkey)
      if (existing && existing.isNostrMailEnabled !== enabled) {
        dao.upsertContact(db, { ...existing, isNostrMailEnabled: enabled })
      }
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('contacts:changed', { identityId, accountId })
      }
      return { mailEnabled: enabled === 1 }
    } finally {
      transport.close()
    }
  })

  // Estimated send cost to a contact: the recipient's policy evaluated the same
  // way sendDirectMail evaluates it (sender as untrusted), against the
  // identity's benchmarked hash rate. Cached via CachingTransport.
  ipcMain.handle('contacts:policyEta', async (_event, identityId: string, accountId: string, pubkey: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const relays = getRelaysForAccount(session.payload.settings.preferences as Record<string, unknown> | undefined, accountId)
    const db = getDb(identityId)
    const transport = new CachingTransport(
      new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 10000 }),
      db,
    )
    try {
      const policy = await fetchRecipientPolicy(transport, pubkey, relays)
      if (!policy) return { bits: 0, etaMinutes: null }
      const decision = policy.evaluate(accountId, false)
      if (!decision.allowed) return { denied: true as const, reason: decision.reason, bits: 0, etaMinutes: null }
      const difficulty = difficultyFromTarget(decision.target)
      if (difficulty <= 1n) return { bits: 0, etaMinutes: null }
      const bits = difficulty.toString(2).length - 1
      const hpm = getBenchmarkHashesPerMinute()
      const hashesPerSecond = hpm ? Math.round(hpm / 60) : null
      const etaMinutes = hashesPerSecond ? Number(difficulty) / (hashesPerSecond * 60) : null
      return { bits, etaMinutes, hashesPerSecond }
    } finally {
      transport.close()
    }
  })

  async function runContactSync(identityId: string): Promise<{ contacts: number; mailEnabled: number }> {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const transport = new CachingTransport(
      new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 10000 }),
      getDb(identityId),
    )
    try {
      let contacts = 0
      let mailEnabled = 0
      for (const account of session.payload.accounts) {
        const relays = getRelaysForAccount(session.payload.settings.preferences as Record<string, unknown> | undefined, account.pubkey)
        const result = await syncAccountContacts(transport, identityId, account.pubkey, relays)
        contacts += result.contacts
        mailEnabled += result.mailEnabled
        await enrichContactProfiles(transport, identityId, account.pubkey, relays)
      }
      return { contacts, mailEnabled }
    } finally {
      transport.close()
    }
  }

  ipcMain.handle('contacts:sync', (_event, identityId: string) => runContactSync(identityId))

  // Drop the cached cert/policy answers first so the resync re-reads relays.
  // Also forces kind-0 profile re-enrichment and wipes cached avatars.
  ipcMain.handle('contacts:clearCacheAndResync', async (_event, identityId: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const db = getDb(identityId)
    dao.clearProfileCache(db)
    dao.clearAvatarCache(db)
    clearAvatarFiles()
    const result = await runContactSync(identityId)
    const transport = new CachingTransport(
      new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 10000 }),
      db,
    )
    try {
      for (const account of session.payload.accounts) {
        const relays = getRelaysForAccount(session.payload.settings.preferences as Record<string, unknown> | undefined, account.pubkey)
        await enrichContactProfiles(transport, identityId, account.pubkey, relays, { force: true })
      }
    } finally {
      transport.close()
    }
    return result
  })

  // TTL-gated kind-0 refresh (30 min) — called when the address book opens.
  ipcMain.handle('contacts:refreshProfiles', async (_event, identityId: string, accountId: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const relays = getRelaysForAccount(session.payload.settings.preferences as Record<string, unknown> | undefined, accountId)
    const transport = new CachingTransport(
      new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 10000 }),
      getDb(identityId),
    )
    try {
      return await enrichContactProfiles(transport, identityId, accountId, relays)
    } finally {
      transport.close()
    }
  })

  // Contact avatar as a data URL, cached on disk (4h TTL).
  ipcMain.handle('contacts:getAvatar', (_event, identityId: string, accountId: string, pubkey: string) =>
    getContactAvatar(identityId, accountId, pubkey),
  )
}
