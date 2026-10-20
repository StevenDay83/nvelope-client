export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

export interface RelayFetchRecord {
  fetchedAt: number
  createdAt?: number
}

/** Relay list for one account: the per-account NIP-65 mirror first, then the
 *  legacy identity-wide list (pre-NIP-65 vaults), then built-in defaults. */
export function getRelaysForAccount(
  preferences: Record<string, unknown> | undefined,
  pubkey?: string,
): string[] {
  const prefs = preferences ?? {}
  if (pubkey) {
    const perAccount = prefs.relaysPerAccount
    if (perAccount && typeof perAccount === 'object') {
      const list = (perAccount as Record<string, unknown>)[pubkey]
      if (Array.isArray(list) && list.length > 0) return list as string[]
    }
  }
  const legacy = prefs.relays
  if (Array.isArray(legacy) && legacy.length > 0) return legacy as string[]
  return DEFAULT_RELAYS
}
