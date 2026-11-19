import { npubEncode } from 'nostr-tools/nip19'
import type { ContactRecord } from '../../preload'

// Shared sender/recipient label helpers — one fallback order everywhere:
// verified NIP-05 → local display name + partial npub → kind-0 username +
// partial npub → bare partial npub.

export function formatPartialNpub(npub: string): string {
  return npub.length > 27 ? `${npub.slice(0, 15)}...${npub.slice(-10)}` : npub
}

// NIP-05's `_@domain` catch-all stands in for any username — display it as
// <kind0 username>@domain when we know one, else just the domain.
export function expandNip05(nip05: string, username?: string | null): string {
  if (nip05.startsWith('_@')) {
    const domain = nip05.slice(2)
    return username ? `${username}@${domain}` : domain
  }
  return nip05
}

export function chipLabelForContact(c: ContactRecord): string {
  const partial = formatPartialNpub(npubEncode(c.pubkey))
  if (c.nip05Verified && c.nip05) return expandNip05(c.nip05, c.kind0DisplayName || c.kind0Name)
  if (c.displayName) return `${c.displayName} <${partial}>`
  const kind0 = c.kind0DisplayName || c.kind0Name
  if (kind0) return `${kind0} <${partial}>`
  return partial
}

// Session-level async resolution for pubkeys that aren't contacts: one relay
// kind-0/NIP-05 lookup per pubkey, shared by every surface (identity chips,
// message list rows, conversation headers). `short` is the compact form for
// list rows; `chip` follows the full chip fallback order.
export interface ResolvedIdentity {
  short: string
  chip: string
}

const resolvedIdentities = new Map<string, ResolvedIdentity>()
const pendingResolutions = new Set<string>()
const labelListeners = new Set<() => void>()

export function getResolvedIdentity(pubkey: string): ResolvedIdentity | null {
  return resolvedIdentities.get(pubkey) ?? null
}

export function subscribeIdentityLabels(listener: () => void): () => void {
  labelListeners.add(listener)
  return () => {
    labelListeners.delete(listener)
  }
}

export function ensureIdentityLabel(pubkey: string): void {
  if (resolvedIdentities.has(pubkey) || pendingResolutions.has(pubkey)) return
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return
  let npub: string
  try {
    npub = npubEncode(pubkey)
  } catch {
    return
  }
  pendingResolutions.add(pubkey)
  void (async () => {
    const partial = formatPartialNpub(npub)
    let nip05Label: string | null = null
    const metadata = await window.nvelope.profile.fetchMetadata(pubkey).catch(() => null)
    const username = metadata?.name || null
    if (metadata?.nip05) {
      try {
        // Only display a NIP-05 that verifies back to this pubkey
        const check = await window.nvelope.nip05.resolve(metadata.nip05)
        if (check.pubkey === pubkey) nip05Label = expandNip05(metadata.nip05, username)
      } catch {
        // unverified — fall through to name/npub display
      }
    }
    resolvedIdentities.set(pubkey, {
      short: nip05Label ?? username ?? partial,
      chip: nip05Label ?? (username ? `${username} <${partial}>` : partial),
    })
    pendingResolutions.delete(pubkey)
    for (const listener of labelListeners) listener()
  })()
}
