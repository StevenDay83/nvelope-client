import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19'
import { chipLabelForContact, expandNip05, formatPartialNpub } from '../lib/identityLabel'
import type { ContactRecord } from '../../preload'

export interface RecipientChip {
  id: string
  input: string // raw text the user entered (npub, NIP-05, contact name, …)
  npub?: string // resolved bech32 npub
  pubkey?: string // resolved hex pubkey
  label: string // display text
  status: 'resolving' | 'valid' | 'invalid'
  invalidReason?: string
}

let chipCounter = 0
function newChipId(): string {
  return `chip-${Date.now()}-${chipCounter++}`
}

// Instant chip from the contact cache — no relay round-trips needed.
export function chipFromContact(c: ContactRecord): RecipientChip {
  return {
    id: newChipId(),
    input: npubEncode(c.pubkey),
    npub: npubEncode(c.pubkey),
    pubkey: c.pubkey,
    label: chipLabelForContact(c),
    status: c.isNostrMailEnabled ? 'valid' : 'invalid',
    invalidReason: c.isNostrMailEnabled ? undefined : 'No mail certificate — cannot receive nVelope mail',
  }
}

// Drafts persist recipients as the legacy ';'-joined string, so chips
// round-trip through it: resolved chips store their npub, unresolved chips
// keep the raw input.
export function parseChips(value: string): RecipientChip[] {
  return value
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((input) => ({
      id: newChipId(),
      input,
      label: input.toLowerCase().startsWith('npub1') ? formatPartialNpub(input) : input,
      status: 'resolving' as const,
    }))
}

export function serializeChips(chips: RecipientChip[], pendingText: string): string {
  const parts = chips.map((c) => c.npub ?? c.input)
  const pending = pendingText.trim()
  if (pending) parts.push(pending)
  return parts.join('; ')
}

interface Props {
  identityId: string
  accountId: string
  contacts: ContactRecord[]
  chips: RecipientChip[]
  onChipsChange: (chips: RecipientChip[]) => void
  pendingText: string
  onPendingTextChange: (text: string) => void
  placeholder?: string
}

export default function RecipientChipsInput({
  identityId,
  accountId,
  contacts,
  chips,
  onChipsChange,
  pendingText,
  onPendingTextChange,
  placeholder,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [dropdownDismissed, setDropdownDismissed] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; chip: RecipientChip } | null>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolution results land asynchronously — keep a live ref so concurrent
  // completions patch the latest chip list instead of clobbering each other.
  const chipsRef = useRef(chips)
  chipsRef.current = chips

  const applyPatch = useCallback(
    (id: string, updates: Partial<RecipientChip>) => {
      const current = chipsRef.current
      const idx = current.findIndex((c) => c.id === id)
      if (idx === -1 || current[idx]!.status !== 'resolving') return
      const next = current.slice()
      next[idx] = { ...current[idx]!, ...updates }
      chipsRef.current = next
      onChipsChange(next)
    },
    [onChipsChange],
  )

  const resolveChip = useCallback(
    async (chip: RecipientChip) => {
      const input = chip.input.trim()
      let pubkey: string | null = null
      let verifiedNip05: string | null = null

      if (input.toLowerCase().startsWith('npub1')) {
        try {
          const decoded = nip19Decode(input)
          if (decoded.type === 'npub') pubkey = decoded.data as string
        } catch {
          // fall through to invalid
        }
        if (!pubkey) {
          applyPatch(chip.id, { status: 'invalid', invalidReason: 'Invalid npub' })
          return
        }
      } else if (input.includes('@')) {
        try {
          const profile = await window.nvelope.nip05.resolve(input)
          pubkey = profile.pubkey
          verifiedNip05 = profile.nip05
        } catch {
          applyPatch(chip.id, { status: 'invalid', invalidReason: 'NIP-05 resolution failed' })
          return
        }
      } else {
        const q = input.toLowerCase()
        const byName = contacts.find(
          (c) =>
            c.displayName?.toLowerCase() === q ||
            c.nip05?.toLowerCase() === q ||
            c.kind0DisplayName?.toLowerCase() === q ||
            c.kind0Name?.toLowerCase() === q,
        )
        if (!byName) {
          applyPatch(chip.id, {
            status: 'invalid',
            invalidReason: 'Unknown recipient — use npub1…, user@domain, or a contact name',
          })
          return
        }
        pubkey = byName.pubkey
      }

      const npub = npubEncode(pubkey)
      const partial = formatPartialNpub(npub)
      const contact = contacts.find((c) => c.pubkey === pubkey)
      let username = contact?.kind0DisplayName || contact?.kind0Name || null

      // Highest display order first: verified NIP-05 → local display name →
      // kind-0 username → bare partial npub.
      let label: string | null = null
      if (verifiedNip05) label = expandNip05(verifiedNip05, username)
      else if (contact?.nip05Verified && contact.nip05) label = expandNip05(contact.nip05, username)

      if (!label) {
        const hasProfileData = !!(
          contact &&
          (contact.displayName || contact.kind0DisplayName || contact.kind0Name)
        )
        if (!hasProfileData) {
          // Unknown key — fetch kind-0 metadata, then verify any NIP-05 it
          // claims by resolving it back to the same pubkey.
          const metadata = await window.nvelope.profile.fetchMetadata(pubkey).catch(() => null)
          if (metadata?.name) username = username || metadata.name
          if (metadata?.nip05) {
            try {
              const check = await window.nvelope.nip05.resolve(metadata.nip05)
              if (check.pubkey === pubkey) label = expandNip05(metadata.nip05, username)
            } catch {
              // unverified NIP-05 — fall through to name/npub display
            }
          }
        }
      }

      if (!label) {
        if (contact?.displayName) label = `${contact.displayName} <${partial}>`
        else if (username) label = `${username} <${partial}>`
        else label = partial
      }

      // Mail certificate (kind 30998): instant from the contact cache, relay
      // lookup (cache-first via CachingTransport) for unknown keys.
      let mailEnabled = false
      if (contact) {
        mailEnabled = !!contact.isNostrMailEnabled
      } else {
        try {
          mailEnabled = (await window.nvelope.contacts.checkCert(identityId, accountId, pubkey)).mailEnabled
        } catch {
          // unreachable relays — treated as not mail-enabled
        }
      }

      applyPatch(chip.id, {
        npub,
        pubkey,
        label,
        status: mailEnabled ? 'valid' : 'invalid',
        invalidReason: mailEnabled ? undefined : 'No mail certificate — cannot receive nVelope mail',
      })
    },
    [contacts, identityId, accountId, applyPatch],
  )

  // Run the pipeline for every chip that hasn't been resolved yet.
  useEffect(() => {
    for (const chip of chips) {
      if (chip.status === 'resolving') void resolveChip(chip)
    }
  }, [chips, resolveChip])

  const query = pendingText.trim()
  const matches = useMemo(() => {
    const q = query.toLowerCase()
    if (!q || (q.startsWith('npub1') && q.length > 20)) return []
    const taken = new Set(chips.map((c) => c.pubkey).filter(Boolean))
    return contacts
      .filter((c) => {
        if (taken.has(c.pubkey)) return false
        const npub = npubEncode(c.pubkey).toLowerCase()
        return (
          (c.displayName && c.displayName.toLowerCase().includes(q)) ||
          (c.nip05 && c.nip05.toLowerCase().includes(q)) ||
          (c.kind0DisplayName && c.kind0DisplayName.toLowerCase().includes(q)) ||
          (c.kind0Name && c.kind0Name.toLowerCase().includes(q)) ||
          npub.startsWith(q)
        )
      })
      .slice(0, 8)
  }, [query, contacts, chips])

  const showNip05Option = query.includes('@') && !query.toLowerCase().startsWith('npub1')
  const showDropdown = focused && !dropdownDismissed && (matches.length > 0 || showNip05Option)

  const commitPending = useCallback(() => {
    const text = pendingText.trim()
    if (!text) return
    const dup = chipsRef.current.some((c) => c.input === text || c.npub === text)
    onPendingTextChange('')
    setHighlightIndex(0)
    setDropdownDismissed(false)
    if (dup) return
    onChipsChange([
      ...chipsRef.current,
      {
        id: newChipId(),
        input: text,
        label: text.toLowerCase().startsWith('npub1') ? formatPartialNpub(text) : text,
        status: 'resolving',
      },
    ])
  }, [pendingText, onChipsChange, onPendingTextChange])

  const addContactChip = useCallback(
    (c: ContactRecord) => {
      onChipsChange([...chipsRef.current, chipFromContact(c)])
      onPendingTextChange('')
      setHighlightIndex(0)
      inputRef.current?.focus()
    },
    [onChipsChange, onPendingTextChange],
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ';' || e.key === ',') {
      e.preventDefault()
      commitPending()
      return
    }
    if (e.key === 'Backspace' && !pendingText && chips.length > 0) {
      // Pop the last chip back into the input for editing
      const last = chips[chips.length - 1]!
      onChipsChange(chips.slice(0, -1))
      onPendingTextChange(last.input)
      return
    }
    if (showDropdown) {
      const optionCount = matches.length + (showNip05Option ? 1 : 0)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIndex((i) => (i + 1) % optionCount)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIndex((i) => (i - 1 + optionCount) % optionCount)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (highlightIndex < matches.length) addContactChip(matches[highlightIndex]!)
        else if (showNip05Option) commitPending()
      } else if (e.key === 'Escape') {
        setDropdownDismissed(true)
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commitPending()
    }
  }

  return (
    <div className="relative flex-1">
      <div
        className="flex flex-wrap items-center gap-1 py-1"
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((chip) => (
          <span
            key={chip.id}
            title={`${chip.npub ?? chip.input}${chip.invalidReason ? `\n${chip.invalidReason}` : ''}`}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, chip })
            }}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              chip.status === 'valid'
                ? 'border-emerald-700 bg-emerald-900/40 text-emerald-300'
                : chip.status === 'invalid'
                  ? 'border-red-700 bg-red-900/40 text-red-300'
                  : 'border-neutral-600 bg-neutral-700/60 text-neutral-300'
            }`}
          >
            <span className="max-w-56 truncate">{chip.label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onChipsChange(chips.filter((c) => c.id !== chip.id))
              }}
              title="Remove recipient"
              className="ml-0.5 opacity-60 transition-opacity hover:opacity-100"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={pendingText}
          onChange={(e) => {
            onPendingTextChange(e.target.value)
            setHighlightIndex(0)
            setDropdownDismissed(false)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Delay so a dropdown click registers before the dropdown closes
            blurTimer.current = setTimeout(() => {
              setFocused(false)
              commitPending()
            }, 150)
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            chips.length === 0
              ? (placeholder ?? 'Name, npub1…, or user@domain — Enter or ; to add')
              : ''
          }
          className="min-w-40 flex-1 bg-transparent py-1 text-sm text-neutral-100 placeholder-neutral-600 outline-none"
        />
      </div>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-20 max-h-64 overflow-y-auto rounded-b-md border border-neutral-700 bg-neutral-800 shadow-xl">
          {matches.map((c, i) => (
            <button
              key={c.pubkey}
              onMouseDown={(e) => {
                e.preventDefault()
                if (c.isNostrMailEnabled) addContactChip(c)
              }}
              onMouseEnter={() => setHighlightIndex(i)}
              disabled={!c.isNostrMailEnabled}
              title={c.isNostrMailEnabled ? undefined : 'No mail certificate published — cannot receive mail'}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                c.isNostrMailEnabled
                  ? i === highlightIndex
                    ? 'bg-blue-600/20 text-blue-200'
                    : 'text-neutral-200'
                  : 'cursor-not-allowed text-neutral-500 opacity-40'
              }`}
            >
              <span className="truncate font-medium">{chipLabelForContact(c)}</span>
              <span className="truncate text-xs text-neutral-500">
                {formatPartialNpub(npubEncode(c.pubkey))}
              </span>
              {!c.isNostrMailEnabled && (
                <span className="ml-auto shrink-0 text-[10px] text-neutral-600">no mail cert</span>
              )}
            </button>
          ))}
          {showNip05Option && (
            <button
              onMouseDown={(e) => {
                e.preventDefault()
                commitPending()
              }}
              onMouseEnter={() => setHighlightIndex(matches.length)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                highlightIndex === matches.length ? 'bg-blue-600/20 text-blue-200' : 'text-neutral-200'
              }`}
            >
              <span>Resolve {query} via NIP-05</span>
            </button>
          )}
        </div>
      )}

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="fixed z-50 min-w-44 rounded-md border border-neutral-700 bg-neutral-800 py-1 shadow-xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 190),
              top: Math.min(menu.y, window.innerHeight - 90),
            }}
          >
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(menu.chip.label)
                setMenu(null)
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Copy address text
            </button>
            <button
              type="button"
              disabled={!menu.chip.npub}
              onClick={() => {
                if (menu.chip.npub) void navigator.clipboard.writeText(menu.chip.npub)
                setMenu(null)
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              Copy npub
            </button>
          </div>
        </>
      )}
    </div>
  )
}
