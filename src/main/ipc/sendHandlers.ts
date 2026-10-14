import { ipcMain } from 'electron'
import { decode } from 'nostr-tools/nip19'
import { SimplePool } from 'nostr-tools'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools'
import {
  NvelopeClient,
  DirectMessage,
  NostrToolsTransport,
  NsecSigner,
} from 'nvelope-core'
import { getUnlockedSession } from './vaultHandlers'
import { getDb } from './dbHandlers'
import { CachingTransport } from '../relay/cachingTransport'
import * as dao from '../db/dao'

const MAX_EXTERNAL_REFERENCES = 10

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

let mainWindow: Electron.BrowserWindow | null = null

export function setMainWindowForSend(win: Electron.BrowserWindow | null): void {
  mainWindow = win
}

function decodeNsec(nsec: string): Uint8Array {
  const result = decode(nsec)
  if (result.type !== 'nsec') throw new Error('Invalid nsec format')
  return result.data as Uint8Array
}

function npubToHex(npub: string): string {
  const result = decode(npub)
  if (result.type !== 'npub') throw new Error('Invalid npub format')
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

/** Publish an event to a list of relays using SimplePool */
async function publishEvent(
  pool: SimplePool,
  relays: string[],
  event: NostrEvent,
  label: string,
): Promise<{ ok: boolean; details: Array<{ url: string; ok: boolean; reason?: string }> }> {
  const details: Array<{ url: string; ok: boolean; reason?: string }> = []

  // SimplePool.publish returns a Promise<void> per relay
  const pubs = pool.publish(relays, event)

  const results = await Promise.allSettled(
    pubs.map(async (pub, i) => {
      const url = relays[i]!
      try {
        await pub
        console.log(`[publish] ${label} OK on ${url}`)
        return { url, ok: true as const }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[publish] ${label} FAILED on ${url}: ${reason}`)
        return { url, ok: false as const, reason }
      }
    }),
  )

  for (const r of results) {
    if (r.status === 'fulfilled') {
      details.push(r.value)
    } else {
      details.push({ url: 'unknown', ok: false, reason: String(r.reason) })
    }
  }

  const anyOk = details.some((d) => d.ok)
  return { ok: anyOk, details }
}

/** Publish kind 30998 certificate + policy, and (unless skipKind0) kind 0 profile to relays */
async function publishProfileToRelays(
  account: {
    pubkey: string
    nsec: string
    certificatePublicKeyDerBase64: string
    displayName?: string
    picture?: string
    about?: string
  },
  relays: string[],
  options?: { skipKind0?: boolean },
): Promise<{ certificateEventId?: string; profileEventId?: string; errors: string[] }> {
  const secretKey = decodeNsec(account.nsec)
  const errors: string[] = []
  const results: { certificateEventId?: string; profileEventId?: string; errors: string[] } = { errors }

  const pool = new SimplePool()

  // Sanity check: does the nsec derive to the stored pubkey?
  const { npubEncode } = await import('nostr-tools/nip19')
  const derivedPubkey = getPublicKey(secretKey)
  if (derivedPubkey !== account.pubkey) {
    console.error(`[publish] PUBKEY MISMATCH! account.pubkey=${account.pubkey} derived=${derivedPubkey}`)
    errors.push(`nsec derives to ${derivedPubkey} but account claims ${account.pubkey}`)
    return results
  }
  console.log('[publish] Account npub:', npubEncode(account.pubkey))

  try {
    // Publish kind 30998 certificate event (d-tag must be "nv_public_key" per nvelope-core)
    const certEvent = finalizeEvent(
      {
        kind: 30998,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', 'nv_public_key']],
        content: account.certificatePublicKeyDerBase64,
      },
      secretKey,
    )

    console.log('[publish] Publishing kind 30998 certificate:', certEvent.id)
    const certResult = await publishEvent(pool, relays, certEvent, 'cert')
    if (certResult.ok) {
      results.certificateEventId = certEvent.id
    } else {
      errors.push('kind 30998 cert: failed on all relays')
      certResult.details.forEach((d) => {
        if (!d.ok) errors.push(`  ${d.url}: ${d.reason}`)
      })
    }

    // Publish kind 30998 recipient policy event (d-tag "nv_recipient_profile")
    const policyContent = JSON.stringify({
      allow: [],
      deny: [],
      global_minimum: { leadingzeros: 0 },
    })
    const policyEvent = finalizeEvent(
      {
        kind: 30998,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', 'nv_recipient_profile']],
        content: policyContent,
      },
      secretKey,
    )

    console.log('[publish] Publishing kind 30998 policy:', policyEvent.id)
    const polResult = await publishEvent(pool, relays, policyEvent, 'policy')
    if (polResult.ok) {
      // no separate id field for policy, but track success
    } else {
      errors.push('kind 30998 policy: failed on all relays')
      polResult.details.forEach((d) => {
        if (!d.ok) errors.push(`  ${d.url}: ${d.reason}`)
      })
    }

    // Publish kind 0 profile event (skipped for imported accounts — we only carry
    // name/about/picture and would clobber the account's existing full profile)
    if (!options?.skipKind0) {
      const profileContent = JSON.stringify({
        name: account.displayName || '',
        about: account.about || '',
        picture: account.picture || '',
      })

      const profileEvent = finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: profileContent,
        },
        secretKey,
      )

      console.log('[publish] Publishing kind 0 profile:', profileEvent.id)
      const profResult = await publishEvent(pool, relays, profileEvent, 'profile')
      if (profResult.ok) {
        results.profileEventId = profileEvent.id
      } else {
        errors.push('kind 0: failed on all relays')
        profResult.details.forEach((d) => {
          if (!d.ok) errors.push(`  ${d.url}: ${d.reason}`)
        })
      }
    }
  } finally {
    pool.close(relays)
  }

  return results
}

export function registerSendHandlers(): void {
  // Publish kind 30998 certificate + policy (+ kind 0 profile unless skipKind0)
  ipcMain.handle('profile:publish', async (_event, identityId: string, accountId: string, options?: { skipKind0?: boolean }) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')

    const account = session.payload.accounts.find((a) => a.pubkey === accountId)
    if (!account) throw new Error('Account not found')

    const relays = getRelaysFromSettings(session.payload.settings.preferences ?? {})
    const result = await publishProfileToRelays(account, relays, options)
    if (!result.certificateEventId && !result.profileEventId) {
      throw new Error('Failed to publish on all relays:\n' + result.errors.join('\n'))
    }
    return result
  })

  // Fetch a kind-0 profile (name/about/picture/nip05) for wizard account import.
  // Runs without an unlocked identity — the wizard has no session yet.
  ipcMain.handle('profile:fetchMetadata', async (_event, pubkeyHex: string, relays?: string[]) => {
    const relayList = Array.isArray(relays) && relays.length > 0 ? relays : getRelaysFromSettings({})
    const pool = new SimplePool()
    try {
      const events = await pool.querySync(relayList, { kinds: [0], authors: [pubkeyHex] })
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!newest) return null
      const content = JSON.parse(newest.content) as Record<string, unknown>
      return {
        name: typeof content.name === 'string' ? content.name : undefined,
        about: typeof content.about === 'string' ? content.about : undefined,
        picture: typeof content.picture === 'string' ? content.picture : undefined,
        nip05: typeof content.nip05 === 'string' ? content.nip05 : undefined,
      }
    } finally {
      pool.close(relayList)
    }
  })

  ipcMain.handle(
    'send:direct',
    async (
      _event,
      identityId: string,
      accountId: string,
      payload: {
        recipientNpub: string
        subject: string
        body: string
        format: 'plaintext' | 'markdown' | 'html'
        links?: string[]
      },
    ) => {
      const session = getUnlockedSession(identityId)
      if (!session) throw new Error('Identity is locked')

      const account = session.payload.accounts.find((a) => a.pubkey === accountId)
      if (!account) throw new Error('Account not found')

      const secretKey = decodeNsec(account.nsec)
      const derivedPubkey = getPublicKey(secretKey)
      if (derivedPubkey !== account.pubkey) {
        throw new Error(
          `Account key mismatch: stored pubkey ${account.pubkey} does not match nsec-derived pubkey ${derivedPubkey}. ` +
          `This account was likely created with an older buggy version. Please create a new identity/account.`
        )
      }

      const recipientHex = npubToHex(payload.recipientNpub)
      const signer = new NsecSigner(secretKey)
      const relays = getRelaysFromSettings(session.payload.settings.preferences ?? {})
      const transport = new CachingTransport(
        new NostrToolsTransport({ pool: new SimplePool(), maxWaitMs: 15000 }),
        getDb(identityId),
      )

      // Debug: query for recipient certificate before sending (uses same filter as nvelope-core)
      try {
        const filter = {
          kinds: [30998 as number],
          authors: [recipientHex],
          '#d': ['nv_public_key'],
        }
        const events = await transport.query(filter, relays)
        console.log('[send:direct] certificate query returned', events.length, 'events for', recipientHex)
        if (events.length > 0) {
          console.log('[send:direct] first event:', { id: events[0]!.id, pubkey: events[0]!.pubkey, tags: events[0]!.tags })
        }
      } catch (certErr) {
        console.error('[send:direct] certificate query error:', certErr)
      }

      const client = new NvelopeClient({
        transport,
        signer,
        relays,
        certificatePrivateKeyPem: account.certificatePrivateKeyPem,
        certificatePublicKeyDerBase64: account.certificatePublicKeyDerBase64,
      })

      const message = new DirectMessage()
        .setFrom(account.pubkey)
        .addRecipientTo(recipientHex)
        .setSubject(payload.subject)

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

      const links = payload.links?.length ? validateLinks(payload.links) : []
      for (const link of links) {
        message.addExternalReference('http', link)
      }

      console.log('[send:direct] Composer payload body length:', payload.body?.length ?? 0)
      console.log('[send:direct] Message contentWire before send:', JSON.stringify(message.contentModel.toWire()))
      console.log('[send:direct] Message formats:', JSON.stringify(message.getContentFormats()))

      const results = await client.sendDirectMail(message, {
        onProgress: (attempts: number) => {
          if (mainWindow) {
            mainWindow.webContents.send('send:progress', {
              identityId,
              accountId,
              recipientNpub: payload.recipientNpub,
              attempts,
            })
          }
        },
      })

      // Log publish results for each recipient
      for (const r of results) {
        const accepted = r.published.accepted
        const rejected = r.published.rejected
        console.log(`[send:direct] Publish result for ${r.recipient}: accepted=${accepted.length} (${accepted.join(', ')}) rejected=${rejected.length}`)
        for (const rej of rejected) {
          console.log(`[send:direct]   Rejected by ${rej.relay}: ${rej.message}`)
        }
      }

      transport.close()

      // Store sent mail
      const db = getDb(identityId)
      const sentFolder = dao.getSpecialFolder(db, accountId, 'sent')
      const sentFolderId = sentFolder?.id ?? null

      const innerEventId = results[0]?.event.id ?? `sent-${Date.now()}`
      const messageData = JSON.stringify({
        mailFrom: account.pubkey,
        mailToList: [recipientHex],
        subjectLine: payload.subject,
        messageType: 0,
        formats: {
          [payload.format]: payload.body,
        },
        externalReferences: links.map((link) => ['http', link]),
        hasAttachments: links.length > 0,
      })

      dao.insertMail(db, {
        innerEventId,
        accountId,
        folderId: sentFolderId,
        state: 'published',
        senderPubkey: account.pubkey,
        recipientPubkey: recipientHex,
        subject: payload.subject || null,
        threadId: innerEventId,
        isBroadcast: 0,
        createdAt: Math.floor(Date.now() / 1000),
        read: 1,
        marked: 0,
        messageData,
      })

      return results.map((r) => ({
        recipient: r.recipient,
        eventId: r.event.id,
        published: r.published,
      }))
    },
  )

  ipcMain.handle(
    'draft:save',
    async (
      _event,
      identityId: string,
      accountId: string,
      draftId: string | null,
      payload: {
        recipientNpub?: string
        subject?: string
        body?: string
        format?: 'plaintext' | 'markdown' | 'html'
      },
    ) => {
      const db = getDb(identityId)
      const draftsFolder = dao.getSpecialFolder(db, accountId, 'drafts')
      const folderId = draftsFolder?.id ?? null

      const id = draftId ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const messageData = JSON.stringify({
        draftId: id,
        recipientNpub: payload.recipientNpub ?? '',
        subjectLine: payload.subject ?? '',
        messageType: 0,
        formats: {
          [payload.format ?? 'plaintext']: payload.body ?? '',
        },
      })

      dao.insertMail(db, {
        innerEventId: id,
        accountId,
        folderId,
        state: 'draft',
        senderPubkey: accountId,
        recipientPubkey: payload.recipientNpub ? npubToHex(payload.recipientNpub) : null,
        subject: payload.subject || null,
        threadId: id,
        isBroadcast: 0,
        createdAt: Math.floor(Date.now() / 1000),
        read: 1,
        marked: 0,
        messageData,
      })

      return { draftId: id }
    },
  )
}
