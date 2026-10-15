import { BrowserWindow, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { decode } from 'nostr-tools/nip19'
import { SimplePool } from 'nostr-tools'
import {
  NvelopeClient,
  DirectMessage,
  NostrToolsTransport,
  NsecSigner,
  createDirectMessageEvent,
  fetchRecipientPolicy,
  difficultyFromTarget,
} from 'nvelope-core'
import { getUnlockedSession } from '../ipc/vaultHandlers'
import { getDb } from '../ipc/dbHandlers'
import { getBenchmarkHashesPerMinute } from '../clientSettings'
import { CachingTransport } from '../relay/cachingTransport'
import * as dao from '../db/dao'

const MAX_EXTERNAL_REFERENCES = 10

export interface OutgoingPayload {
  recipients: string[] // npubs
  subject: string
  body: string
  format: 'plaintext' | 'markdown' | 'html'
  links?: string[]
  threadId?: string
}

interface SendPayloadWire {
  recipients: string[]
  subject: string
  body: string
  format: 'plaintext' | 'markdown' | 'html'
  links: string[]
  threadId: string
}

function decodeNsec(nsec: string): Uint8Array {
  const result = decode(nsec)
  if (result.type !== 'nsec') throw new Error('Invalid nsec format')
  return result.data as Uint8Array
}

function npubToHex(npub: string): string {
  const result = decode(npub)
  if (result.type !== 'npub') throw new Error(`Invalid npub: ${npub}`)
  return result.data as string
}

function getRelaysFromSettings(settings: Record<string, unknown>): string[] {
  const relays = settings.relays
  if (Array.isArray(relays) && relays.length > 0) return relays as string[]
  return [
    'wss://relay.damus.io',
    'wss://nostr.mom',
    'wss://nos.lol',
    'wss://relay.primal.net',
  ]
}

/** External references (SPEC §3.1): this client emits http(s) links only. */
function validateLinks(links: string[]): string[] {
  if (links.length > MAX_EXTERNAL_REFERENCES) {
    throw new Error(`Too many attachments (max ${MAX_EXTERNAL_REFERENCES} links)`)
  }
  return links.map((link) => {
    const parsed = new URL(link)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Only http/https links are supported: ${link}`)
    }
    return parsed.toString()
  })
}

function buildMessage(payload: SendPayloadWire, fromPubkey: string): DirectMessage {
  const message = new DirectMessage().setFrom(fromPubkey).setSubject(payload.subject)
  for (const npub of payload.recipients) {
    message.addRecipientTo(npubToHex(npub))
  }
  switch (payload.format) {
    case 'html':
      message.setHtml(payload.body)
      break
    case 'markdown':
      message.setMarkdown(payload.body)
      break
    default:
      message.setPlaintext(payload.body)
  }
  for (const link of payload.links) {
    message.addExternalReference('http', link)
  }
  message.setThreadId(payload.threadId)
  return message
}

function broadcast(channel: string, data: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

// ------------------------------------------------------------------
// Queue processor — one identity at a time, one message at a time
// (PoW mining is CPU-bound; parallel mining gains nothing)
// ------------------------------------------------------------------

const pumping = new Set<string>()
const controllers = new Map<string, AbortController>()

export function kickOutbox(identityId: string): void {
  if (pumping.has(identityId)) return
  pumping.add(identityId)
  void pump(identityId)
    .catch((e) => console.error('[outbox] pump error:', e))
    .finally(() => pumping.delete(identityId))
}

/** App-start/unlock recovery: un-stick interrupted sends and resume the queue. */
export function recoverOutbox(identityId: string): void {
  dao.resetProcessingToPending(getDb(identityId))
  kickOutbox(identityId)
}

async function pump(identityId: string): Promise<void> {
  const session = getUnlockedSession(identityId)
  if (!session) return
  const db = getDb(identityId)

  for (const account of session.payload.accounts) {
    const queued = dao.getQueuedMail(db, account.pubkey)
    for (const row of queued) {
      // Session may have locked mid-queue
      if (!getUnlockedSession(identityId)) return
      await processRow(identityId, account.pubkey, account.nsec, account.certificatePrivateKeyPem, account.certificatePublicKeyDerBase64, row, session.payload.settings as Record<string, unknown>)
    }
  }
}

async function processRow(
  identityId: string,
  accountId: string,
  nsec: string,
  certificatePrivateKeyPem: string,
  certificatePublicKeyDerBase64: string,
  row: dao.MailRecord,
  settings: Record<string, unknown>,
): Promise<void> {
  const db = getDb(identityId)
  const innerEventId = row.innerEventId

  let payload: SendPayloadWire
  try {
    payload = JSON.parse(row.messageData).sendPayload as SendPayloadWire
    if (!payload || !Array.isArray(payload.recipients) || payload.recipients.length === 0) {
      throw new Error('missing send payload')
    }
  } catch {
    dao.setMailState(db, innerEventId, 'pending')
    return
  }

  dao.setMailState(db, innerEventId, 'processing')
  const controller = new AbortController()
  controllers.set(innerEventId, controller)

  const emit = (data: Record<string, unknown>) =>
    broadcast('outbox:progress', { identityId, accountId, innerEventId, ...data })

  try {
    const secretKey = decodeNsec(nsec)
    const relays = getRelaysFromSettings((settings.preferences ?? {}) as Record<string, unknown>)
    const transport = new CachingTransport(
      new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 15000 }),
      db,
    )
    const client = new NvelopeClient({
      transport,
      signer: new NsecSigner(secretKey),
      relays,
      certificatePrivateKeyPem,
      certificatePublicKeyDerBase64,
    })

    // Pre-resolve per-recipient PoW difficulty for progress display.
    // CachingTransport means sendDirectMail's own resolution hits the cache.
    const hpm = getBenchmarkHashesPerMinute() ?? 0
    const recipientHexes = payload.recipients.map(npubToHex)
    const bitsPerRecipient: number[] = []
    for (const hex of recipientHexes) {
      let bits = 0
      try {
        const policy = await fetchRecipientPolicy(transport, hex, relays)
        const decision = policy?.evaluate(accountId, false)
        if (decision && decision.allowed) {
          const difficulty = difficultyFromTarget(decision.target)
          bits = difficulty > 1n ? difficulty.toString(2).length - 1 : 0
        }
      } catch (e) {
        console.warn('[outbox] policy estimate failed for', hex.slice(0, 16), e)
      }
      bitsPerRecipient.push(bits)
    }

    const message = buildMessage(payload, accountId)

    // The attempts counter resets per recipient — infer the switch
    let recipientIndex = 0
    let lastAttempts = 0
    let announced = false
    const results = await client.sendDirectMail(message, {
      signal: controller.signal,
      onProgress: (attempts: number) => {
        if (attempts < lastAttempts) {
          recipientIndex++
          announced = false
        }
        lastAttempts = attempts
        if (!announced) {
          announced = true
          const bits = bitsPerRecipient[recipientIndex] ?? 0
          emit({
            phase: 'mining',
            recipientIndex,
            recipientCount: recipientHexes.length,
            bits,
            etaMinutes: hpm > 0 && bits > 0 ? Math.round((2 ** bits / hpm) * 10) / 10 : null,
          })
        }
        emit({ phase: 'mining', recipientIndex, recipientCount: recipientHexes.length, attempts })
      },
    })

    const sentFolder = dao.getSpecialFolder(db, accountId, 'sent')
    dao.markMailSent(db, innerEventId, sentFolder?.id ?? null, results[0]?.event.id ?? '')
    emit({ phase: 'sent' })
    console.log(`[outbox] sent ${innerEventId.slice(0, 16)}... to ${recipientHexes.length} recipient(s)`)
  } catch (e) {
    const isAbort = e instanceof Error && e.name === 'AbortError'
    dao.setMailState(db, innerEventId, 'pending')
    if (isAbort) {
      emit({ phase: 'cancelled' })
      console.log(`[outbox] cancelled ${innerEventId.slice(0, 16)}...`)
    } else {
      const error = String(e).replace(/^Error: /, '')
      try {
        const data = JSON.parse(row.messageData)
        data.sendError = error
        dao.updateMailMessageData(db, innerEventId, JSON.stringify(data))
      } catch { /* row stays pending regardless */ }
      emit({ phase: 'error', error })
      console.error(`[outbox] send failed for ${innerEventId.slice(0, 16)}...:`, error)
    }
  } finally {
    controllers.delete(innerEventId)
  }
}

// ------------------------------------------------------------------
// IPC
// ------------------------------------------------------------------

export function registerOutboxHandlers(): void {
  ipcMain.handle(
    'send:queue',
    async (_event, identityId: string, accountId: string, payload: OutgoingPayload) => {
      const session = getUnlockedSession(identityId)
      if (!session) throw new Error('Identity is locked')
      const account = session.payload.accounts.find((a) => a.pubkey === accountId)
      if (!account) throw new Error('Account not found')
      if (!Array.isArray(payload.recipients) || payload.recipients.length === 0) {
        throw new Error('At least one recipient is required')
      }

      const secretKey = decodeNsec(account.nsec)
      const links = payload.links?.length ? validateLinks(payload.links) : []
      // SPEC §3.1: thread_id is an opaque random key chosen by the originator
      const threadId = payload.threadId ?? randomBytes(16).toString('hex')

      const wire: SendPayloadWire = {
        recipients: payload.recipients,
        subject: payload.subject,
        body: payload.body,
        format: payload.format,
        links,
        threadId,
      }

      // The inner event id is deterministic for To recipients (SPEC §8) —
      // compute it now so the queue row carries the canonical identity.
      const message = buildMessage(wire, accountId)
      const innerEventId = createDirectMessageEvent(message, secretKey).id

      const db = getDb(identityId)
      const outbox = dao.getSpecialFolder(db, accountId, 'outbox')
      const recipientHexes = payload.recipients.map(npubToHex)
      dao.insertMail(db, {
        innerEventId,
        accountId,
        folderId: outbox?.id ?? null,
        state: 'pending',
        senderPubkey: accountId,
        recipientPubkey: recipientHexes[0] ?? null,
        subject: payload.subject || null,
        threadId,
        isBroadcast: 0,
        createdAt: Math.floor(Date.now() / 1000),
        read: 1,
        marked: 0,
        messageData: JSON.stringify({
          mailFrom: accountId,
          mailToList: recipientHexes,
          subjectLine: payload.subject,
          messageType: 0,
          formats: { [payload.format]: payload.body },
          bodyText: payload.body,
          externalReferences: links.map((link) => ['http', link]),
          hasAttachments: links.length > 0,
          sendPayload: wire,
        }),
      })

      broadcast('outbox:progress', { identityId, accountId, innerEventId, phase: 'queued' })
      kickOutbox(identityId)
      return { innerEventId }
    },
  )

  ipcMain.handle('send:cancel', async (_event, _identityId: string, innerEventId: string) => {
    controllers.get(innerEventId)?.abort()
  })

  ipcMain.handle('send:retry', async (_event, identityId: string, innerEventId: string) => {
    const db = getDb(identityId)
    try {
      const data = JSON.parse(
        (db.prepare('SELECT messageData FROM mail WHERE innerEventId = ?').get(innerEventId) as { messageData: string } | undefined)?.messageData ?? '{}',
      )
      delete data.sendError
      dao.updateMailMessageData(db, innerEventId, JSON.stringify(data))
    } catch { /* nothing to clear */ }
    kickOutbox(identityId)
  })
}
