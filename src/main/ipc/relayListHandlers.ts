import { ipcMain } from 'electron'
import { SimplePool } from 'nostr-tools'
import type { Event as NostrEvent } from 'nostr-tools'
import { finalizeEvent } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { getUnlockedSession, persistUnlockedSession } from './vaultHandlers'
import { DEFAULT_RELAYS, getRelaysForAccount, type RelayFetchRecord } from '../relay/relayPrefs'

const RELAY_LIST_KIND = 10002
const CONTACT_LIST_KIND = 3
const RELAY_LIST_TTL_MS = 6 * 60 * 60 * 1000 // re-check kind 10002 every 6 hours

function decodeNsec(nsec: string): Uint8Array {
  const result = decode(nsec)
  if (result.type !== 'nsec') throw new Error('Invalid nsec format')
  return result.data as Uint8Array
}

function isRelayUrl(value: unknown): value is string {
  return typeof value === 'string' && /^wss?:\/\/.+/.test(value)
}

/** Latest kind-10002 relay list for a pubkey, queried across candidate relays. */
async function fetchNip65Relays(
  pubkey: string,
  candidates: string[],
): Promise<{ relays: string[]; createdAt: number } | null> {
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(candidates, { kinds: [RELAY_LIST_KIND], authors: [pubkey] })
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return null
    const relays = newest.tags
      .filter((t) => t[0] === 'r' && isRelayUrl(t[1]))
      .map((t) => t[1] as string)
    return { relays: [...new Set(relays)], createdAt: newest.created_at }
  } finally {
    pool.close(candidates)
  }
}

/** Relay URLs from the latest kind-3 contact list content (NIP-02 relay map). */
async function fetchKind3Relays(pubkey: string, candidates: string[]): Promise<string[]> {
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(candidates, { kinds: [CONTACT_LIST_KIND], authors: [pubkey] })
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest?.content) return []
    try {
      const content = JSON.parse(newest.content) as Record<string, unknown>
      const relayMap = (
        content.relays && typeof content.relays === 'object' ? content.relays : content
      ) as Record<string, unknown>
      return [...new Set(Object.keys(relayMap).filter(isRelayUrl))]
    } catch {
      return []
    }
  } finally {
    pool.close(candidates)
  }
}

/** Sign and publish a kind-10002 list. Bare ['r', url] tags mean read+write (NIP-65). */
async function publishRelayList(
  nsec: string,
  relays: string[],
  publishTo: string[],
): Promise<{ ok: boolean; event: NostrEvent; details: Array<{ url: string; ok: boolean; reason?: string }> }> {
  const event = finalizeEvent(
    {
      kind: RELAY_LIST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: relays.map((url) => ['r', url]),
      content: '',
    },
    decodeNsec(nsec),
  )
  const pool = new SimplePool()
  const details: Array<{ url: string; ok: boolean; reason?: string }> = []
  try {
    const pubs = pool.publish(publishTo, event)
    const results = await Promise.allSettled(
      pubs.map(async (pub, i) => {
        const url = publishTo[i]!
        try {
          await pub
          console.log(`[relayList] kind 10002 OK on ${url}`)
          return { url, ok: true as const }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          console.error(`[relayList] kind 10002 FAILED on ${url}: ${reason}`)
          return { url, ok: false as const, reason }
        }
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') details.push(r.value)
      else details.push({ url: 'unknown', ok: false, reason: String(r.reason) })
    }
  } finally {
    pool.close(publishTo)
  }
  return { ok: details.some((d) => d.ok), event, details }
}

/**
 * Re-fetch each account's kind-10002 list and mirror it into the vault.
 * Skips accounts checked within the TTL unless forced. A remote list only
 * replaces the local one when the remote event is newer than what we last
 * saw (local edits publish first and bump that timestamp).
 */
export async function syncRelayLists(identityId: string, force: boolean): Promise<void> {
  const session = getUnlockedSession(identityId)
  if (!session) return
  const prefs = (session.payload.settings.preferences ?? {}) as Record<string, unknown>
  const perAccount = { ...((prefs.relaysPerAccount ?? {}) as Record<string, string[]>) }
  const fetched = { ...((prefs.relaysFetchedPerAccount ?? {}) as Record<string, RelayFetchRecord>) }
  let changed = false

  for (const account of session.payload.accounts) {
    const rec = fetched[account.pubkey]
    if (!force && rec && Date.now() - rec.fetchedAt < RELAY_LIST_TTL_MS) continue
    const candidates = [...new Set([...getRelaysForAccount(prefs, account.pubkey), ...DEFAULT_RELAYS])]
    try {
      const remote = await fetchNip65Relays(account.pubkey, candidates)
      fetched[account.pubkey] = { fetchedAt: Date.now(), createdAt: remote?.createdAt ?? rec?.createdAt }
      if (
        remote &&
        remote.relays.length > 0 &&
        (rec?.createdAt === undefined || remote.createdAt > rec.createdAt)
      ) {
        perAccount[account.pubkey] = remote.relays
      }
      changed = true
    } catch (e) {
      console.error(`[relayList] sync failed for ${account.pubkey.slice(0, 16)}...:`, e)
    }
  }

  if (changed) {
    prefs.relaysPerAccount = perAccount
    prefs.relaysFetchedPerAccount = fetched
    session.payload.settings.preferences = prefs
    persistUnlockedSession(identityId)
  }
}

export function registerRelayListHandlers(): void {
  // Wizard nsec import: resolve the account's relays without a session.
  // NIP-65 first, then the kind-3 relay map, then built-in defaults.
  ipcMain.handle('relayList:resolveImport', async (_event, pubkey: string, candidateRelays?: string[]) => {
    const candidates = [
      ...new Set([...(Array.isArray(candidateRelays) ? candidateRelays.filter(isRelayUrl) : []), ...DEFAULT_RELAYS]),
    ]
    const nip65 = await fetchNip65Relays(pubkey, candidates)
    if (nip65 && nip65.relays.length > 0) {
      return { relays: nip65.relays, source: 'nip65' as const, createdAt: nip65.createdAt }
    }
    const kind3 = await fetchKind3Relays(pubkey, candidates)
    if (kind3.length > 0) {
      return { relays: kind3, source: 'kind3' as const }
    }
    return { relays: DEFAULT_RELAYS, source: 'defaults' as const }
  })

  // Publish the account's currently stored list as kind 10002.
  ipcMain.handle('relayList:publish', async (_event, identityId: string, pubkey: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const account = session.payload.accounts.find((a) => a.pubkey === pubkey)
    if (!account) throw new Error('Account not found')
    const prefs = (session.payload.settings.preferences ?? {}) as Record<string, unknown>
    const relays = getRelaysForAccount(prefs, pubkey)

    const result = await publishRelayList(account.nsec, relays, [...new Set([...relays, ...DEFAULT_RELAYS])])
    if (!result.ok) {
      throw new Error('Failed to publish relay list on all relays:\n' + result.details.map((d) => `${d.url}: ${d.reason}`).join('\n'))
    }

    const fetched = { ...((prefs.relaysFetchedPerAccount ?? {}) as Record<string, RelayFetchRecord>) }
    fetched[pubkey] = { fetchedAt: Date.now(), createdAt: result.event.created_at }
    prefs.relaysFetchedPerAccount = fetched
    session.payload.settings.preferences = prefs
    persistUnlockedSession(identityId)
    return { eventId: result.event.id, createdAt: result.event.created_at, details: result.details }
  })

  ipcMain.handle('relayList:getAll', async (_event, identityId: string) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const prefs = (session.payload.settings.preferences ?? {}) as Record<string, unknown>
    const relaysPerAccount: Record<string, string[]> = {}
    for (const account of session.payload.accounts) {
      relaysPerAccount[account.pubkey] = getRelaysForAccount(prefs, account.pubkey)
    }
    return {
      relaysPerAccount,
      fetched: (prefs.relaysFetchedPerAccount ?? {}) as Record<string, RelayFetchRecord>,
    }
  })

  // Replace an account's list, publish kind 10002 (to old + new relays), store.
  ipcMain.handle('relayList:setForAccount', async (_event, identityId: string, pubkey: string, relays: string[]) => {
    const session = getUnlockedSession(identityId)
    if (!session) throw new Error('Identity is locked')
    const account = session.payload.accounts.find((a) => a.pubkey === pubkey)
    if (!account) throw new Error('Account not found')
    if (!Array.isArray(relays) || relays.length === 0 || !relays.every(isRelayUrl)) {
      throw new Error('Relay list must contain at least one ws:// or wss:// URL')
    }
    const cleaned = [...new Set(relays.map((r) => r.trim()))]

    const prefs = (session.payload.settings.preferences ?? {}) as Record<string, unknown>
    const old = getRelaysForAccount(prefs, pubkey)
    const result = await publishRelayList(account.nsec, cleaned, [...new Set([...old, ...cleaned, ...DEFAULT_RELAYS])])
    if (!result.ok) {
      throw new Error('Failed to publish relay list on all relays:\n' + result.details.map((d) => `${d.url}: ${d.reason}`).join('\n'))
    }

    prefs.relaysPerAccount = { ...((prefs.relaysPerAccount ?? {}) as Record<string, string[]>), [pubkey]: cleaned }
    const fetched = { ...((prefs.relaysFetchedPerAccount ?? {}) as Record<string, RelayFetchRecord>) }
    fetched[pubkey] = { fetchedAt: Date.now(), createdAt: result.event.created_at }
    prefs.relaysFetchedPerAccount = fetched
    session.payload.settings.preferences = prefs
    persistUnlockedSession(identityId)
    return { eventId: result.event.id, createdAt: result.event.created_at, details: result.details }
  })

  ipcMain.handle('relayList:sync', async (_event, identityId: string, force?: boolean) => {
    await syncRelayLists(identityId, force === true)
    return { synced: true }
  })
}
