import type Database from 'better-sqlite3'
import type { Filter } from 'nostr-tools'
import { NostrToolsTransport, type NostrEvent, type PublishResult, type Transport } from 'nvelope-core'
import * as dao from '../db/dao'

/** Certificate/policy events change rarely — cache hits skip relay round trips. */
const PROFILE_KIND = 30998
const TTL_PRESENT_MS = 6 * 60 * 60 * 1000 // published cert/policy: 6h
const TTL_ABSENT_MS = 30 * 60 * 1000 // "nothing published" answer: 30min

interface ProfileFilterShape {
  authors: string[]
  dTag: string
}

/** Matches only the exact filter shape fetchCertificate/fetchRecipientPolicy emit. */
function matchProfileFilter(filter: Filter): ProfileFilterShape | null {
  const kinds = filter.kinds
  const authors = filter.authors
  const dTags = filter['#d']
  if (
    Array.isArray(kinds) && kinds.length === 1 && kinds[0] === PROFILE_KIND &&
    Array.isArray(authors) && authors.length > 0 &&
    Array.isArray(dTags) && dTags.length === 1 && typeof dTags[0] === 'string'
  ) {
    return { authors: authors as string[], dTag: dTags[0] }
  }
  return null
}

/**
 * Transport wrapper that serves kind-30998 (cert / recipient-policy) queries
 * from SQLite when fresh, and records network answers (including "not found")
 * back into the cache. All other filters pass straight through.
 */
export class CachingTransport implements Transport {
  constructor(
    private readonly inner: NostrToolsTransport,
    private readonly db: Database.Database,
  ) {}

  async query(filters: Filter | Filter[], relays: string[]): Promise<NostrEvent[]> {
    const list = Array.isArray(filters) ? filters : [filters]
    const shapes = list.map(matchProfileFilter)
    if (shapes.some((s) => s === null)) {
      return this.inner.query(filters, relays)
    }

    const now = Date.now()
    const served: NostrEvent[] = []
    const staleByDTag = new Map<string, string[]>()

    for (const shape of shapes as ProfileFilterShape[]) {
      const rows = new Map(dao.getProfileCache(this.db, shape.dTag, shape.authors).map((r) => [r.pubkey, r]))
      for (const author of shape.authors) {
        const row = rows.get(author)
        const ttl = row?.eventJson ? TTL_PRESENT_MS : TTL_ABSENT_MS
        if (row && now - row.fetchedAt < ttl) {
          if (row.eventJson) served.push(JSON.parse(row.eventJson) as NostrEvent)
        } else {
          const stale = staleByDTag.get(shape.dTag) ?? []
          stale.push(author)
          staleByDTag.set(shape.dTag, stale)
        }
      }
    }

    for (const [dTag, authors] of staleByDTag) {
      const fresh = await this.inner.query({ kinds: [PROFILE_KIND], authors, '#d': [dTag] } as Filter, relays)
      const newestByAuthor = new Map<string, NostrEvent>()
      for (const ev of fresh) {
        const prev = newestByAuthor.get(ev.pubkey)
        if (!prev || ev.created_at > prev.created_at) newestByAuthor.set(ev.pubkey, ev)
      }
      for (const author of authors) {
        const ev = newestByAuthor.get(author)
        dao.setProfileCache(this.db, {
          pubkey: author,
          dTag,
          eventJson: ev ? JSON.stringify(ev) : null,
          fetchedAt: now,
        })
        if (ev) served.push(ev)
      }
    }

    return served
  }

  async publish(event: NostrEvent, relays: string[]): Promise<PublishResult> {
    const result = await this.inner.publish(event, relays)
    // Publishing our own cert/policy makes the cached entry current immediately.
    if (event.kind === PROFILE_KIND) {
      const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
      if (dTag) {
        dao.setProfileCache(this.db, { pubkey: event.pubkey, dTag, eventJson: JSON.stringify(event), fetchedAt: Date.now() })
      }
    }
    return result
  }

  close(relays?: string[]): void {
    this.inner.close(relays)
  }
}
