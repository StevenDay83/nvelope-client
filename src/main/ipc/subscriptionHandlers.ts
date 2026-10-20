import { ipcMain } from 'electron'
import { SimplePool } from 'nostr-tools'
import { decodeBroadcastNaddr } from 'nvelope-core'
import { getUnlockedSession } from './vaultHandlers'
import { getDb } from './dbHandlers'
import { getRelaysForAccount } from '../relay/relayPrefs'
import * as dao from '../db/dao'

function accountRelays(identityId: string, accountId: string): string[] {
  const prefs = (getUnlockedSession(identityId)?.payload.settings.preferences ?? {}) as Record<string, unknown>
  return getRelaysForAccount(prefs, accountId)
}

/**
 * Best-effort kind-0 lookup for the broadcast author so the subscription
 * list can show a human name. Uses the account relays plus the naddr hints.
 */
async function fetchAuthorDisplayName(authorHex: string, relays: string[]): Promise<string | null> {
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(relays, { kinds: [0], authors: [authorHex] })
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return null
    const content = JSON.parse(newest.content) as Record<string, unknown>
    const name = content.display_name ?? content.displayName ?? content.name
    return typeof name === 'string' && name.trim() ? name.trim() : null
  } catch {
    return null
  } finally {
    pool.close(relays)
  }
}

export function registerSubscriptionHandlers(): void {
  // Validate + store a broadcast subscription from its naddr credential.
  // The naddr relay hints are kept — broadcast envelopes are pulled from
  // those relays first since that's where the list publisher posts.
  ipcMain.handle('subs:subscribe', async (_event, identityId: string, accountId: string, naddr: string) => {
    const trimmed = naddr.trim()
    if (!trimmed) throw new Error('Enter an naddr (naddr1…)')
    const cred = decodeBroadcastNaddr(trimmed) // throws with a precise reason on invalid input

    const db = getDb(identityId)
    const existing = dao.getSubscriptions(db, accountId)
    if (existing.some((s) => s.author === cred.author && s.topic === cred.topic)) {
      throw new Error(`Already subscribed to "${cred.topic}"`)
    }

    const relays = [...new Set([...(cred.relays ?? []), ...accountRelays(identityId, accountId)])]
    const displayName = await fetchAuthorDisplayName(cred.author, relays)

    const sub: dao.SubscriptionRecord = {
      accountId,
      naddr: trimmed,
      displayName,
      topic: cred.topic,
      author: cred.author,
      relays: cred.relays && cred.relays.length > 0 ? JSON.stringify(cred.relays) : null,
      createdAt: Math.floor(Date.now() / 1000),
    }
    const id = dao.addSubscription(db, sub)
    return { id, ...sub }
  })
}
