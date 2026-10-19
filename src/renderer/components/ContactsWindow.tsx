import { useState, useEffect, useCallback } from 'react'
import { npubEncode, decode } from 'nostr-tools/nip19'
import type { ContactRecord } from '../../preload'

interface Props {
  data: Record<string, unknown>
}

function formatNpub(pubkeyHex: string): string {
  const npub = npubEncode(pubkeyHex)
  if (npub.length <= 32) return npub
  return npub.slice(0, 18) + '...' + npub.slice(-10)
}

function contactLabel(c: ContactRecord): string {
  return c.displayName || (c.nip05Verified ? c.nip05 : null) || c.kind0DisplayName || c.kind0Name || formatNpub(c.pubkey)
}

export default function ContactsWindow({ data }: Props) {
  const identityId = data.identityId as string
  const accountId = data.accountId as string
  const accountDisplayName = data.accountDisplayName as string | undefined
  const prefillPubkey = data.prefillPubkey as string | undefined

  const [contacts, setContacts] = useState<ContactRecord[]>([])
  const [editing, setEditing] = useState<ContactRecord | 'new' | null>(null)
  const [status, setStatus] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [policyEtas, setPolicyEtas] = useState<Record<string, { bits: number; etaMinutes: number | null; hashesPerSecond?: number | null; denied?: boolean }>>({})
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [mailOnly, setMailOnly] = useState(false)

  const loadAvatars = useCallback(async (list: ContactRecord[]) => {
    const entries = await Promise.all(
      list.filter((c) => c.avatarUrl).map(async (c) => {
        try {
          const dataUrl = await window.nvelope.contacts.getAvatar(identityId, accountId, c.pubkey)
          return [c.pubkey, dataUrl] as const
        } catch {
          return [c.pubkey, null] as const
        }
      }),
    )
    setAvatars(Object.fromEntries(entries.filter(([, v]) => v !== null) as Array<readonly [string, string]>))
  }, [identityId, accountId])

  const loadPolicyEtas = useCallback(async (list: ContactRecord[]) => {
    const entries = await Promise.all(
      list.filter((c) => c.isNostrMailEnabled).map(async (c) => {
        try {
          const eta = await window.nvelope.contacts.policyEta(identityId, accountId, c.pubkey)
          return [c.pubkey, eta] as const
        } catch {
          return [c.pubkey, null] as const
        }
      }),
    )
    setPolicyEtas(Object.fromEntries(entries.filter(([, v]) => v !== null) as Array<readonly [string, { bits: number; etaMinutes: number | null; hashesPerSecond?: number | null; denied?: boolean }]>))
  }, [identityId, accountId])

  const handleCopy = async (c: ContactRecord) => {
    await navigator.clipboard.writeText((c.nip05Verified ? c.nip05 : null) || npubEncode(c.pubkey))
    setCopiedKey(c.pubkey)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  const handleSync = async () => {
    setSyncing(true)
    setStatus('')
    try {
      const result = await window.nvelope.contacts.sync(identityId)
      setStatus(`Synced ${result.contacts} contacts (${result.mailEnabled} can receive mail)`)
    } catch (e) {
      setStatus('Sync failed: ' + String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    } finally {
      setSyncing(false)
      setTimeout(() => setStatus(''), 5000)
    }
  }

  const loadContacts = useCallback(async () => {
    if (!identityId || !accountId) return
    const list = (await window.nvelope.db.contactsGetAll(identityId, accountId)) as ContactRecord[]
    setContacts(list)
    loadPolicyEtas(list)
    loadAvatars(list)
  }, [identityId, accountId, loadPolicyEtas, loadAvatars])

  useEffect(() => {
    loadContacts()
  }, [loadContacts])

  // TTL-gated; enrichment broadcasts contacts:changed which reloads the list
  useEffect(() => {
    if (!identityId || !accountId) return
    window.nvelope.contacts.refreshProfiles(identityId, accountId).catch((e) => console.error('[contacts] profile refresh failed:', e))
  }, [identityId, accountId])

  useEffect(() => {
    const unsub = window.nvelope.contacts.onChanged((change) => {
      if (change.identityId === identityId && change.accountId === accountId) loadContacts()
    })
    return unsub
  }, [identityId, accountId, loadContacts])

  // "Add to Contacts" from the inbox can arrive while this window is already open
  useEffect(() => {
    const unsub = window.nvelope.contacts.onPrefill((d) => {
      if (d.prefillPubkey) {
        setEditing({ accountId, pubkey: d.prefillPubkey as string, isNostrMailEnabled: 0 })
      }
    })
    return unsub
  }, [accountId])

  // Prefill via launch args (fresh window)
  useEffect(() => {
    if (prefillPubkey) {
      setEditing({ accountId, pubkey: prefillPubkey, isNostrMailEnabled: 0 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDelete = async (contact: ContactRecord) => {
    const label = contactLabel(contact)
    if (!confirm(`Delete contact ${label}?`)) return
    await window.nvelope.db.contactsRemove(identityId, accountId, contact.pubkey)
    setStatus('Contact deleted')
    setTimeout(() => setStatus(''), 3000)
  }

  const handleWrite = (contact: ContactRecord) => {
    window.nvelope.compose.open({
      identityId,
      accountId,
      accountDisplayName: accountDisplayName || undefined,
      accountNpub: npubEncode(accountId),
      recipientNpub: npubEncode(contact.pubkey),
    })
  }

  const filteredContacts = contacts.filter((c) => {
    if (mailOnly && !c.isNostrMailEnabled) return false
    const q = searchQuery.trim().toLowerCase()
    if (!q) return true
    return (
      contactLabel(c).toLowerCase().includes(q) ||
      (c.nip05?.toLowerCase().includes(q) ?? false) ||
      (c.kind0Name?.toLowerCase().includes(q) ?? false) ||
      (c.kind0DisplayName?.toLowerCase().includes(q) ?? false) ||
      npubEncode(c.pubkey).toLowerCase().includes(q)
    )
  })

  return (
    <div className="flex h-screen flex-col bg-neutral-900 text-neutral-100">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-neutral-700/50 bg-neutral-800/50 px-3 py-2">
        <h1 className="text-sm font-bold tracking-tight">Address Book</h1>
        <div className="flex items-center gap-2">
          {status && <span className="text-xs text-emerald-400">{status}</span>}
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Fetch kind 3 / NIP-51 contact lists from relays and refresh certificate status"
            className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync from Relays'}
          </button>
          <button
            onClick={() => setEditing('new')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
          >
            Add Contact
          </button>
        </div>
      </div>

      {/* Add/Edit form */}
      {editing !== null && (
        <ContactForm
          identityId={identityId}
          accountId={accountId}
          contact={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null)
            loadContacts()
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* Search + mail-enabled filter */}
      <div className="border-b border-neutral-800 px-3 py-2 space-y-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search contacts (name, NIP-05, npub)…"
          className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
        />
        <label className="flex w-fit items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={mailOnly}
            onChange={(e) => setMailOnly(e.target.checked)}
            className="accent-blue-500"
          />
          Mail-enabled only
          <span className="text-neutral-600">(has a mail certificate)</span>
        </label>
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto">
        {contacts.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-500">
            <svg className="h-10 w-10 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span className="text-sm">No contacts yet</span>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            {searchQuery.trim() ? `No contacts match "${searchQuery}"` : 'No contacts match the current filter'}
          </div>
        ) : (
          <div className="divide-y divide-neutral-800">
            {filteredContacts.map((c) => (
              <div key={c.pubkey} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-800/50 ${c.isNostrMailEnabled ? '' : 'opacity-50'}`}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-blue-500/20 text-xs font-bold text-blue-300">
                  {avatars[c.pubkey] ? (
                    <img src={avatars[c.pubkey]} alt="" className="h-full w-full object-cover" />
                  ) : (
                    contactLabel(c).trim().slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-neutral-100 truncate">
                    {contactLabel(c)}
                  </div>
                  <div className="text-xs text-neutral-500 truncate">
                    {c.nip05Verified && c.nip05 && contactLabel(c) !== c.nip05 ? `${c.nip05} · ` : ''}{formatNpub(c.pubkey)}
                  </div>
                </div>
                {c.isNostrMailEnabled ? (
                  <>
                    <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400" title="Publishes a mail certificate (kind 30998) — can receive nVelope mail">
                      Mail
                    </span>
                    {(() => {
                      const eta = policyEtas[c.pubkey]
                      if (!eta) return null
                      if (eta.denied) {
                        return (
                          <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400" title="This contact's recipient policy denies mail from your account">
                            Blocked
                          </span>
                        )
                      }
                      if (eta.bits === 0) return null
                      const label = eta.etaMinutes === null
                        ? `PoW ~${eta.bits} bits`
                        : eta.etaMinutes < 1
                          ? '~<1 min'
                          : eta.etaMinutes < 60
                            ? `~${Math.round(eta.etaMinutes)} min`
                            : `~${(eta.etaMinutes / 60).toFixed(1)} hrs`
                      return (
                        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300" title={`This contact requires proof-of-work (≈${eta.bits} bits) — sending takes about ${label.replace('~', '')} on this machine${eta.hashesPerSecond ? ` at your measured ~${eta.hashesPerSecond.toLocaleString()} hashes/sec` : ''}`}>
                          {label}
                        </span>
                      )
                    })()}
                  </>
                ) : (
                  <span className="shrink-0 rounded bg-neutral-700/40 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500" title="No mail certificate published — cannot receive nVelope mail">
                    No mail cert
                  </span>
                )}
                <button
                  onClick={() => handleCopy(c)}
                  title={`Copy ${c.nip05Verified && c.nip05 ? 'NIP-05' : 'npub'} to clipboard`}
                  className="shrink-0 rounded-md border border-neutral-600 bg-neutral-800 p-1.5 text-neutral-400 hover:text-blue-300 hover:bg-neutral-700 transition-colors"
                >
                  {copiedKey === c.pubkey ? (
                    <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={() => handleWrite(c)}
                  disabled={!c.isNostrMailEnabled}
                  title={c.isNostrMailEnabled ? 'Compose mail to this contact' : 'Cannot receive mail — no certificate published'}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 transition-colors"
                >
                  Write
                </button>
                <button
                  onClick={() => setEditing(c)}
                  className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-700 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(c)}
                  className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-400 hover:text-red-400 hover:bg-neutral-700 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ContactForm({
  identityId,
  accountId,
  contact,
  onDone,
  onCancel,
}: {
  identityId: string
  accountId: string
  contact: ContactRecord | null
  onDone: () => void
  onCancel: () => void
}) {
  const [identifier, setIdentifier] = useState(contact?.nip05 || (contact?.pubkey ? npubEncode(contact.pubkey) : ''))
  const [displayName, setDisplayName] = useState(contact?.displayName ?? '')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)

  const resolveIdentifier = async (): Promise<{ pubkey: string; nip05: string | null }> => {
    const trimmed = identifier.trim()
    if (trimmed.startsWith('npub1')) {
      const decoded = decode(trimmed)
      if (decoded.type !== 'npub') throw new Error('Invalid npub')
      return { pubkey: decoded.data as string, nip05: contact?.nip05 ?? null }
    }
    if (trimmed.includes('@')) {
      const profile = await window.nvelope.nip05.resolve(trimmed)
      return { pubkey: profile.pubkey, nip05: profile.nip05 }
    }
    throw new Error('Enter an npub (npub1…) or a NIP-05 identifier (user@domain)')
  }

  const handleSave = async () => {
    setError('')
    setWorking(true)
    try {
      const { pubkey, nip05 } = await resolveIdentifier()
      await window.nvelope.db.contactsUpsert(identityId, {
        accountId,
        pubkey,
        nip05,
        displayName: displayName.trim() || null,
        avatarUrl: contact?.avatarUrl ?? null,
        cachedAt: Math.floor(Date.now() / 1000),
        isNostrMailEnabled: contact?.isNostrMailEnabled ?? 0,
      })
      // Immediately check for a mail certificate so the Write button and
      // composer availability are correct without a full relay sync
      try {
        await window.nvelope.contacts.checkCert(identityId, accountId, pubkey)
      } catch (e) {
        console.error('[contacts] cert check failed (will retry on next sync):', e)
      }
      window.nvelope.contacts.refreshProfiles(identityId, accountId).catch((e) => console.error('[contacts] profile refresh failed:', e))
      onDone()
    } catch (e) {
      setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
      setWorking(false)
    }
  }

  return (
    <div className="border-b border-neutral-700/50 bg-neutral-800/30 px-4 py-3 space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="npub1… or user@domain"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
        />
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Name (petname)"
          className="w-48 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={working || !identifier.trim()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {working ? 'Saving…' : contact ? 'Save changes' : 'Add contact'}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 transition-colors"
        >
          Cancel
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        NIP-05 identifiers (user@domain) are resolved to a public key when saving.
      </p>
    </div>
  )
}
