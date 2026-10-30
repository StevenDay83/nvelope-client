import { ipcMain } from 'electron'
import { decode } from 'nostr-tools/nip19'
import { SimplePool } from 'nostr-tools'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools'
import { RecipientPolicy } from 'nvelope-core'
import { getUnlockedSession } from './vaultHandlers'
import { getDb } from './dbHandlers'
import { getBenchmarkHashesPerMinute } from '../clientSettings'
import { DEFAULT_RELAYS, getRelaysForAccount } from '../relay/relayPrefs'
import * as dao from '../db/dao'

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

export interface PolicyPreferences {
  contactsMinutes?: number
  nonContactsMinutes?: number
  denyUntrusted?: boolean
}

/** Convert "minutes of sender effort" sliders to NIP-13 leading-zero bits via
 *  the benchmarked local hash rate (expected hashes = 2^bits). */
export function minutesToLeadingZeros(minutes: number | undefined, hashesPerMinute: number | undefined): number | undefined {
  if (!minutes || minutes <= 0) return undefined
  if (!hashesPerMinute || hashesPerMinute <= 0) {
    console.warn('[policy] no benchmark hash rate — treating non-zero minutes as no PoW requirement')
    return undefined
  }
  return Math.max(0, Math.round(Math.log2(minutes * hashesPerMinute)))
}

function buildRecipientPolicyJson(policies: PolicyPreferences | undefined, hashesPerMinute: number | undefined): string {
  const policy = new RecipientPolicy()
  const contactsBits = minutesToLeadingZeros(policies?.contactsMinutes, hashesPerMinute)
  const untrustedBits = minutesToLeadingZeros(policies?.nonContactsMinutes, hashesPerMinute)
  if (contactsBits !== undefined) policy.setAllowContactsPolicy({ leadingZeros: contactsBits })
  if (untrustedBits !== undefined) policy.setAllowUntrustedPolicy({ leadingZeros: untrustedBits })
  if (policies?.denyUntrusted) policy.setDenyUntrusted(true)
  return policy.toJson()
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
  options?: { skipKind0?: boolean; skipPolicy?: boolean; policies?: PolicyPreferences; benchmarkHashesPerMinute?: number },
): Promise<{ certificateEventId?: string; profileEventId?: string; errors: string[]; certEvent?: NostrEvent; policyEvent?: NostrEvent }> {
  const secretKey = decodeNsec(account.nsec)
  const errors: string[] = []
  const results: { certificateEventId?: string; profileEventId?: string; errors: string[]; certEvent?: NostrEvent; policyEvent?: NostrEvent } = { errors }

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
      results.certEvent = certEvent
    } else {
      errors.push('kind 30998 cert: failed on all relays')
      certResult.details.forEach((d) => {
        if (!d.ok) errors.push(`  ${d.url}: ${d.reason}`)
      })
    }

    // Publish kind 30998 recipient policy event (d-tag "nv_recipient_profile"),
    // built from the identity's policy preferences (wizard sliders / Settings → Mail Policy).
    // Skipped for imported accounts — clobbering an existing policy is not ours to do.
    if (!options?.skipPolicy) {
    const policyContent = buildRecipientPolicyJson(options?.policies, options?.benchmarkHashesPerMinute)
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
      results.policyEvent = policyEvent
    } else {
      errors.push('kind 30998 policy: failed on all relays')
      polResult.details.forEach((d) => {
        if (!d.ok) errors.push(`  ${d.url}: ${d.reason}`)
      })
    }
    }

    // Publish kind 0 profile event (skipped for imported accounts — we only carry
    // name/about/picture and would clobber the account's existing full profile).
    // Kind 0 is replaceable, so merge with the newest existing event first:
    // fields we don't manage (nip05, lud16, banner, website, ...) are preserved.
    if (!options?.skipKind0) {
      let existing: Record<string, unknown> = {}
      try {
        const events = await pool.querySync(relays, { kinds: [0], authors: [account.pubkey] })
        const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
        if (newest) {
          const parsed = JSON.parse(newest.content) as unknown
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing = parsed as Record<string, unknown>
          }
        }
      } catch (e) {
        console.warn('[publish] kind-0 merge: could not fetch existing profile, publishing ours only:', e)
      }

      const profileContent = JSON.stringify({
        ...existing,
        name: account.displayName || (typeof existing.name === 'string' ? existing.name : ''),
        about: account.about || (typeof existing.about === 'string' ? existing.about : ''),
        picture: account.picture || (typeof existing.picture === 'string' ? existing.picture : ''),
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
  ipcMain.handle('profile:publish', async (_event, identityId: string, accountId: string, options?: { skipKind0?: boolean; skipPolicy?: boolean }) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')

    const account = session.payload.accounts.find((a) => a.pubkey === accountId)
    if (!account) throw new Error('Account not found')

    const relays = getRelaysForAccount((session.payload.settings.preferences ?? {}) as Record<string, unknown>, account.pubkey)
    const prefs = (session.payload.settings.preferences ?? {}) as Record<string, unknown>
    const hpm = getBenchmarkHashesPerMinute()
    const result = await publishProfileToRelays(account, relays, {
      ...options,
      policies: prefs.policies as PolicyPreferences | undefined,
      benchmarkHashesPerMinute: hpm,
    })
    // Publish goes through a raw SimplePool, so write the fresh events into the
    // profile cache ourselves — otherwise scans/sends keep seeing the old policy
    // until the cache TTL expires.
    const db = getDb(identityId)
    const now = Date.now()
    for (const ev of [result.certEvent, result.policyEvent]) {
      if (!ev) continue
      const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
      if (dTag) dao.setProfileCache(db, { pubkey: ev.pubkey, dTag, eventJson: JSON.stringify(ev), fetchedAt: now })
    }
    if (!result.certificateEventId && !result.profileEventId) {
      throw new Error('Failed to publish on all relays:\n' + result.errors.join('\n'))
    }
    return result
  })

  // Fetch the published kind-30998 mail certificate (d-tag nv_public_key) for a
  // pubkey. Runs without an unlocked identity — the import wizard needs it to
  // detect an existing certificate before the identity exists.
  ipcMain.handle('profile:fetchCert', async (_event, pubkeyHex: string, relays?: string[]) => {
    const relayList = Array.isArray(relays) && relays.length > 0 ? relays : DEFAULT_RELAYS
    const pool = new SimplePool()
    try {
      const events = await pool.querySync(relayList, { kinds: [30998], authors: [pubkeyHex], '#d': ['nv_public_key'] })
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!newest || !newest.content) return null
      return { certificate: newest.content, createdAt: newest.created_at }
    } finally {
      pool.close(relayList)
    }
  })

  // Fetch a kind-0 profile (name/about/picture/nip05) for wizard account import.
  // Runs without an unlocked identity — the wizard has no session yet.
  ipcMain.handle('profile:fetchMetadata', async (_event, pubkeyHex: string, relays?: string[]) => {
    const relayList = Array.isArray(relays) && relays.length > 0 ? relays : DEFAULT_RELAYS
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

      // To field is ';'-separated and may be partially typed during autosave
      const firstRecipient = payload.recipientNpub?.split(';')[0]?.trim() ?? ''
      let recipientHex: string | null = null
      if (firstRecipient.startsWith('npub1')) {
        try {
          recipientHex = npubToHex(firstRecipient)
        } catch { /* partial input — leave null */ }
      }

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
        recipientPubkey: recipientHex,
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
