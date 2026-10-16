import { BrowserWindow } from 'electron'
import { queryProfile } from 'nostr-tools/nip05'
import type { Filter } from 'nostr-tools'
import type { NostrEvent } from 'nvelope-core'
import type { CachingTransport } from './cachingTransport'
import { getDb } from '../ipc/dbHandlers'
import * as dao from '../db/dao'

const KIND0 = 0
export const PROFILE_TTL_MS = 30 * 60 * 1000 // re-check kind-0 profiles every 30 min
const NIP05_CONCURRENCY = 4
const NIP05_TIMEOUT_MS = 5000

interface Kind0Content {
  name?: string
  display_name?: string
  displayName?: string
  picture?: string
  nip05?: string
}

/** A NIP-05 identifier only counts when it resolves back to the same pubkey. */
async function verifyNip05(nip05: string, pubkey: string): Promise<boolean> {
  try {
    const result = (await Promise.race([
      queryProfile(nip05.trim().toLowerCase()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NIP05_TIMEOUT_MS)),
    ])) as { pubkey?: string } | null
    return result?.pubkey === pubkey
  } catch {
    return false
  }
}

/**
 * Refresh kind-0 profile data (name, display name, verified NIP-05, picture)
 * for an account's contacts. Only contacts whose profile is older than
 * PROFILE_TTL_MS are re-fetched unless force is set. One batched relay query
 * for all stale contacts; NIP-05 verification runs with bounded concurrency.
 * The user's manual displayName override is never touched.
 */
export async function enrichContactProfiles(
  transport: CachingTransport,
  identityId: string,
  accountId: string,
  relays: string[],
  options?: { force?: boolean },
): Promise<{ enriched: number }> {
  const db = getDb(identityId)
  const contacts = dao.getContacts(db, accountId)
  const now = Date.now()
  const stale = options?.force
    ? contacts
    : contacts.filter((c) => now - (c.profileFetchedAt ?? 0) >= PROFILE_TTL_MS)
  if (stale.length === 0) return { enriched: 0 }

  const events = await transport.query(
    { kinds: [KIND0], authors: stale.map((c) => c.pubkey) } as Filter,
    relays,
  )
  const newestByAuthor = new Map<string, NostrEvent>()
  for (const ev of events) {
    const prev = newestByAuthor.get(ev.pubkey)
    if (!prev || ev.created_at > prev.created_at) newestByAuthor.set(ev.pubkey, ev)
  }

  // NIP-05 verification with bounded concurrency
  const verified = new Map<string, boolean>()
  const withNip05 = stale
    .map((c) => {
      const content = parseKind0(newestByAuthor.get(c.pubkey))
      return content?.nip05 ? { pubkey: c.pubkey, nip05: content.nip05 } : null
    })
    .filter((x): x is { pubkey: string; nip05: string } => x !== null)
  for (let i = 0; i < withNip05.length; i += NIP05_CONCURRENCY) {
    const batch = withNip05.slice(i, i + NIP05_CONCURRENCY)
    await Promise.all(
      batch.map(async ({ pubkey, nip05 }) => {
        verified.set(pubkey, await verifyNip05(nip05, pubkey))
      }),
    )
  }

  for (const contact of stale) {
    const content = parseKind0(newestByAuthor.get(contact.pubkey))
    const nip05 = content?.nip05?.trim() || null
    dao.updateContactProfile(db, accountId, contact.pubkey, {
      kind0Name: content?.name?.trim() || null,
      kind0DisplayName: (content?.display_name ?? content?.displayName)?.trim() || null,
      nip05,
      nip05Verified: nip05 && verified.get(contact.pubkey) ? 1 : 0,
      avatarUrl: content?.picture?.trim() || null,
      profileFetchedAt: now,
    })
  }

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('contacts:changed', { identityId, accountId })
  }
  return { enriched: stale.length }
}

function parseKind0(event: NostrEvent | undefined): Kind0Content | null {
  if (!event?.content) return null
  try {
    const parsed = JSON.parse(event.content) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Kind0Content
  } catch {
    return null
  }
}
