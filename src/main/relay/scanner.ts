import { Notification } from 'electron'
import { decode } from 'nostr-tools/nip19'
import { SimplePool } from 'nostr-tools'
import {
  NvelopeClient,
  NostrToolsTransport,
  NsecSigner,
  type ScannedDirectMail,
  type ScannedBroadcast,
} from 'nvelope-core'
import { getUnlockedSession, persistUnlockedSession } from '../ipc/vaultHandlers'
import type { VaultPayload } from '../ipc/vaultHandlers'
import { recoverOutbox } from '../outbox/processor'
import { getDb } from '../ipc/dbHandlers'
import { CachingTransport } from './cachingTransport'
import { getRelaysForAccount } from './relayPrefs'
import { syncRelayLists } from '../ipc/relayListHandlers'
import * as dao from '../db/dao'

interface ScanState {
  directIntervalId: ReturnType<typeof setInterval>
  broadcastIntervalId: ReturnType<typeof setInterval>
}

const scanStates = new Map<string, ScanState>()
const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000 // direct mail: 5 minutes
const BROADCAST_SCAN_INTERVAL_MS = 15 * 60 * 1000 // broadcast: 15 minutes (different relays, slower retrieval)

function decodeNsec(nsec: string): Uint8Array {
  const result = decode(nsec)
  if (result.type !== 'nsec') throw new Error('Invalid nsec format')
  return result.data as Uint8Array
}

function getSinceForAccount(settings: VaultPayload['settings'], pubkey: string): number | undefined {
  const lastRetrieved = settings.lastRetrievedPerAccount?.[pubkey]
  if (lastRetrieved) return lastRetrieved
  // Default: 7 days ago to avoid fetching too much history on first scan
  return Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
}

// Broadcast runs on its own schedule, so it needs its own cursor — sharing the
// direct cursor would skip broadcast events that arrive between direct scans.
function getBroadcastSinceForAccount(settings: VaultPayload['settings'], pubkey: string): number | undefined {
  const lastRetrieved = settings.lastBroadcastRetrievedPerAccount?.[pubkey]
  if (lastRetrieved) return lastRetrieved
  return Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
}

async function storeDirectMail(
  identityId: string,
  accountId: string,
  mail: ScannedDirectMail,
): Promise<boolean> {
  console.log(`[scanner] storeDirectMail START innerEventId=${mail.innerEventId.slice(0, 16)}...`)
  const db = getDb(identityId)

  // Skip envelopes we already stored — re-inserting would clobber
  // read/marked/folder state via insertMail's ON CONFLICT DO UPDATE.
  if (dao.getMailByEnvelopeId(db, mail.event.id)) {
    console.log(`[scanner] storeDirectMail: duplicate envelope ${mail.event.id.slice(0, 16)}... skipped`)
    return false
  }

  const inbox = dao.getSpecialFolder(db, accountId, 'inbox')
  const inboxId = inbox?.id ?? null
  console.log(`[scanner] storeDirectMail: inbox folder=${inbox?.name ?? 'NOT FOUND'} id=${inboxId}`)

  const msg = mail.message
  const subject = msg.getSubject()
  const externalReferences = msg.getExternalReferences()
  const formats = msg.getContentFormats()
  const bodyText = msg.getMarkdown() || msg.getPlaintext() || msg.getHtml() || ''
  // contentModel is stale after fromWire (library bug) — build the wire map
  // from the getters instead of msg.contentModel.toWire()
  const messageType: Record<string, string> = {}
  const pt = msg.getPlaintext()
  const md = msg.getMarkdown()
  const html = msg.getHtml()
  if (pt) messageType.plaintext = Buffer.from(pt, 'utf8').toString('base64')
  if (md) messageType.md = Buffer.from(md, 'utf8').toString('base64')
  if (html) messageType.html = Buffer.from(html, 'utf8').toString('base64')
  console.log(`[scanner] storeDirectMail: bodyText length=${bodyText.length} formats=${JSON.stringify(formats)}`)
  const messageData = JSON.stringify({
    mailFrom: msg.getFrom(),
    mailToList: msg.getRecipientsTo(),
    subjectLine: subject,
    messageType,
    formats,
    bodyText,
    externalReferences,
    hasAttachments: externalReferences.length > 0,
  })
  console.log(`[scanner] storeDirectMail: messageData length=${messageData.length}`)

  try {
    dao.insertMail(db, {
      innerEventId: mail.innerEventId,
      accountId,
      folderId: inboxId,
      state: 'received',
      senderPubkey: mail.senderPubkey,
      subject: subject || null,
      threadId: msg.getThreadId() || mail.innerEventId,
      isBroadcast: 0,
      createdAt: mail.innerCreatedAt,
      read: 0,
      marked: 0,
      envelopeEventId: mail.event.id,
      messageData,
    })
    console.log(`[scanner] storeDirectMail: SUCCESS innerEventId=${mail.innerEventId.slice(0, 16)}...`)
    return true
  } catch (e) {
    console.error(`[scanner] storeDirectMail: FAILED innerEventId=${mail.innerEventId.slice(0, 16)}... error=${String(e)}`)
    throw e
  }
}

async function storeBroadcastMail(
  identityId: string,
  accountId: string,
  scanned: ScannedBroadcast,
): Promise<boolean> {
  const db = getDb(identityId)

  if (dao.getMailByEnvelopeId(db, scanned.event.id)) {
    return false
  }

  const inbox = dao.getSpecialFolder(db, accountId, 'inbox')
  const inboxId = inbox?.id ?? null

  const msg = scanned.message
  const formats = msg.getContentFormats()
  const externalReferences = msg.getExternalReferences()
  // NOTE: BroadcastMessage.fromWire reassigns .content but contentModel still
  // points at the original empty instance (library bug) — always read the body
  // through the getPlaintext/getMarkdown/getHtml getters, never contentModel.
  const bodyText = msg.getMarkdown() || msg.getPlaintext() || msg.getHtml() || ''
  const messageType: Record<string, string> = {}
  const pt = msg.getPlaintext()
  const md = msg.getMarkdown()
  const html = msg.getHtml()
  if (pt) messageType.plaintext = Buffer.from(pt, 'utf8').toString('base64')
  if (md) messageType.md = Buffer.from(md, 'utf8').toString('base64')
  if (html) messageType.html = Buffer.from(html, 'utf8').toString('base64')
  const messageData = JSON.stringify({
    mailFrom: msg.getAuthor(),
    mailToList: [],
    replyTo: msg.getReplyTo() || null,
    topic: msg.getTopic(),
    subjectLine: msg.getSubject(),
    messageType,
    formats,
    bodyText,
    externalReferences,
    hasAttachments: externalReferences.length > 0,
  })

  dao.insertMail(db, {
    innerEventId: scanned.event.id,
    accountId,
    folderId: inboxId,
    state: 'received',
    senderPubkey: msg.getAuthor(),
    subject: msg.getSubject() || null,
    threadId: scanned.event.id,
    isBroadcast: 1,
    createdAt: scanned.event.created_at,
    read: 0,
    marked: 0,
    envelopeEventId: scanned.event.id,
    messageData,
  })
  return true
}

async function scanIdentity(
  identityId: string,
  payload: VaultPayload,
  mainWindow: Electron.BrowserWindow | null,
  mode: 'both' | 'direct' | 'broadcast' = 'both',
): Promise<{ direct: number; broadcast: number; errors: string[] }> {
  const errors: string[] = []
  let directCount = 0
  let broadcastCount = 0

  // Refresh the NIP-65 relay mirrors (TTL-gated) in the background — this scan
  // uses whatever is already stored so it never blocks on relay-list fetches.
  void syncRelayLists(identityId, false).catch((e) => console.error('[scanner] relay list sync error:', e))

  const transport = new CachingTransport(
    new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 8000 }),
    getDb(identityId),
  )

  for (const account of payload.accounts) {
    try {
      const relays = getRelaysForAccount(payload.settings.preferences as Record<string, unknown> | undefined, account.pubkey)
      const secretKey = decodeNsec(account.nsec)
      const signer = new NsecSigner(secretKey)
      const client = new NvelopeClient({
        transport,
        signer,
        relays,
        certificatePrivateKeyPem: account.certificatePrivateKeyPem,
        certificatePublicKeyDerBase64: account.certificatePublicKeyDerBase64,
      })

      const since = getSinceForAccount(payload.settings, account.pubkey)

      if (mode !== 'broadcast') {
      console.log(`[scanner] Scanning direct inbox for ${account.pubkey.slice(0, 16)}... since=${since} (${new Date((since ?? 0) * 1000).toISOString()})`)

      // Debug: query ALL direct envelopes without since to verify visibility
      try {
        const allEvents = await transport.query(
          { kinds: [8500 as number], '#l': ['direct_message'] },
          relays,
        )
        console.log(`[scanner] Raw query (no since): ${allEvents.length} kind-8500 direct_message events found`)
        if (allEvents.length > 0) {
          const newest = allEvents.reduce((a, b) => b.created_at > a.created_at ? b : a, allEvents[0]!)
          console.log(`[scanner] Newest envelope created_at=${newest.created_at}, id=${newest.id.slice(0, 16)}...`)
        }
      } catch (e) {
        console.error('[scanner] Raw query error:', e)
      }

      // Direct mail. isContact comes from our address book — without it every
      // sender is evaluated as untrusted (contacts PoW never applies, and
      // "reject non-contacts" would wrongly reject contacts).
      const db = getDb(identityId)
      const directResult = await client.checkDirectInbox({
        since,
        isContact: (pubkey: string) => dao.getContact(db, account.pubkey, pubkey) !== null,
      })
      console.log(`[scanner] Direct scan result: ${directResult.inbox.length} inbox, ${directResult.rejected.length} rejected`)
      for (const rej of directResult.rejected) {
        console.log(`[scanner]   Rejected: sender=${rej.senderPubkey.slice(0, 16)}... reason=${rej.reason}${rej.requiredTarget ? ' target=' + rej.requiredTarget : ''}`)
      }
      for (let i = 0; i < directResult.inbox.length; i++) {
        const mail = directResult.inbox[i]!
        const msg = mail.message
        console.log(`[scanner] Decrypted mail ${i + 1}/${directResult.inbox.length}: innerEventId=${mail.innerEventId.slice(0, 16)}...`)
        console.log(`[scanner]   subject=${msg.getSubject()} formats=${JSON.stringify(msg.getContentFormats())}`)
        console.log(`[scanner]   contentWire=${JSON.stringify(msg.contentModel.toWire())}`)
        try {
          if (await storeDirectMail(identityId, account.pubkey, mail)) {
            directCount++
            console.log(`[scanner] Stored mail ${i + 1} OK, directCount=${directCount}`)
          }
        } catch (e) {
          console.error(`[scanner] Storing mail ${i + 1} FAILED:`, e)
        }
      }

      // Verify rows are in DB
      const count = db.prepare('SELECT COUNT(*) as c FROM mail WHERE accountId = ?').get(account.pubkey) as { c: number }
      console.log(`[scanner] DB verify: ${count.c} total mail rows for account ${account.pubkey.slice(0, 16)}...`)

      // Update lastRetrieved (direct cursor)
      const now = Math.floor(Date.now() / 1000)
      payload.settings.lastRetrievedPerAccount = {
        ...(payload.settings.lastRetrievedPerAccount ?? {}),
        [account.pubkey]: now,
      }
      } // end direct scan

      if (mode !== 'direct') {
      // Broadcast mail. Subscription relay hints from the naddr are where the
      // publisher posts, so scan those in addition to the account relays.
      const bcDb = getDb(identityId)
      const subs = dao.getSubscriptions(bcDb, account.pubkey)
      for (const sub of subs) {
        try {
          client.addBroadcastCredential(sub.naddr)
        } catch (e) {
          errors.push(`Invalid broadcast credential: ${String(e)}`)
        }
      }

      if (subs.length > 0) {
        const hintRelays = subs.flatMap((s) => {
          try {
            return s.relays ? (JSON.parse(s.relays) as string[]) : []
          } catch {
            return []
          }
        })
        const broadcastRelays = [...new Set([...hintRelays, ...relays])]
        const broadcastSince = getBroadcastSinceForAccount(payload.settings, account.pubkey)
        console.log(`[scanner] Scanning broadcast inbox for ${account.pubkey.slice(0, 16)}... since=${broadcastSince} relays=${broadcastRelays.length} (${hintRelays.length} from naddr hints)`)
        const broadcastResult = await client.checkBroadcastInbox({ since: broadcastSince, relays: broadcastRelays })
        for (const mail of broadcastResult) {
          if (await storeBroadcastMail(identityId, account.pubkey, mail)) {
            broadcastCount++
          }
        }

        // Broadcast runs on its own schedule — its cursor advances separately
        // so direct scans never skip broadcast events (and vice versa)
        payload.settings.lastBroadcastRetrievedPerAccount = {
          ...(payload.settings.lastBroadcastRetrievedPerAccount ?? {}),
          [account.pubkey]: Math.floor(Date.now() / 1000),
        }
      }
      } // end broadcast scan
    } catch (e) {
      errors.push(`Account ${account.pubkey.slice(0, 16)}...: ${String(e)}`)
    }
  }

  transport.close()

  // Persist lastRetrievedPerAccount so the next scan (even after a restart)
  // only fetches envelopes newer than this one
  persistUnlockedSession(identityId)

  const totalNew = directCount + broadcastCount
  if (totalNew > 0 && mainWindow) {
    // Send to renderer
    mainWindow.webContents.send('mail:new', {
      identityId,
      directCount,
      broadcastCount,
    })

    // OS notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'nVelope',
        body: `You have ${totalNew} new message${totalNew > 1 ? 's' : ''}`,
      }).show()
    }
  }

  return { direct: directCount, broadcast: broadcastCount, errors }
}

export async function manualScan(
  identityId: string,
  mainWindow: Electron.BrowserWindow | null,
): Promise<{ direct: number; broadcast: number; errors: string[] }> {
  const session = getUnlockedSession(identityId)
  if (!session) {
    throw new Error('Identity is locked')
  }
  return scanIdentity(identityId, session.payload, mainWindow)
}

export function startAutoScan(
  identityId: string,
  mainWindow: Electron.BrowserWindow | null,
): void {
  if (scanStates.has(identityId)) return // already running

  // Un-stick sends interrupted by an app quit and resume the outbox queue
  recoverOutbox(identityId)

  const runScan = async (mode: 'direct' | 'broadcast') => {
    const session = getUnlockedSession(identityId)
    if (!session) {
      stopAutoScan(identityId)
      return
    }
    try {
      await scanIdentity(identityId, session.payload, mainWindow, mode)
    } catch (e) {
      console.error(`[scanner] auto-scan (${mode}) error for ${identityId}:`, e)
    }
  }

  const directIntervalId = setInterval(() => { void runScan('direct') }, AUTO_SCAN_INTERVAL_MS)
  const broadcastIntervalId = setInterval(() => { void runScan('broadcast') }, BROADCAST_SCAN_INTERVAL_MS)

  scanStates.set(identityId, { directIntervalId, broadcastIntervalId })
  console.log(`[scanner] auto-scan started for ${identityId} (direct ${AUTO_SCAN_INTERVAL_MS / 60000}m, broadcast ${BROADCAST_SCAN_INTERVAL_MS / 60000}m)`)
}

export function stopAutoScan(identityId: string): void {
  const state = scanStates.get(identityId)
  if (state) {
    clearInterval(state.directIntervalId)
    clearInterval(state.broadcastIntervalId)
    scanStates.delete(identityId)
    console.log(`[scanner] auto-scan stopped for ${identityId}`)
  }
}

export function stopAllScans(): void {
  for (const [identityId, state] of scanStates) {
    clearInterval(state.directIntervalId)
    clearInterval(state.broadcastIntervalId)
    console.log(`[scanner] auto-scan stopped for ${identityId}`)
  }
  scanStates.clear()
}

export function getScanStatus(): Array<{ identityId: string; active: boolean }> {
  return Array.from(scanStates.entries()).map(([identityId]) => ({
    identityId,
    active: true,
  }))
}
