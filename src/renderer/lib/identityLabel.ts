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
