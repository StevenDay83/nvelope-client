import { useState, useEffect } from 'react'
import { npubEncode, nsecEncode, decode } from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

interface AccountData {
  pubkey: string
  nsec: string
  certificatePrivateKeyPem: string
  certificatePublicKeyDerBase64: string
  displayName?: string
  picture?: string
  about?: string
}

interface Props {
  identityId: string
  identityName: string
  accounts: AccountData[]
  onClose: () => void
  onRenamed: (name: string) => void
  onAccountsChanged?: (accounts: AccountData[]) => void
}

type Section = 'identity' | 'relays' | 'policy' | 'cache' | 'appearance' | 'security' | 'backup'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

function formatNpub(pubkeyHex: string): string {
  const npub = npubEncode(pubkeyHex)
  if (npub.length <= 28) return npub
  return npub.slice(0, 15) + '...' + npub.slice(-10)
}

export default function SettingsPanel({ identityId, identityName, accounts, onClose, onRenamed, onAccountsChanged }: Props) {
  const [section, setSection] = useState<Section>('identity')

  // Identity section
  const [nameInput, setNameInput] = useState(identityName)
  const [renameStatus, setRenameStatus] = useState('')
  const [currentPass, setCurrentPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [passStatus, setPassStatus] = useState('')
  const [passError, setPassError] = useState(false)

  // Relays section
  const [relays, setRelays] = useState<string[]>([])
  const [allPrefs, setAllPrefs] = useState<Record<string, unknown>>({})
  const [relayInput, setRelayInput] = useState('')
  const [relayStatus, setRelayStatus] = useState('')

  // Appearance section
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('dark')

  // Security section
  const [autoLockMinutes, setAutoLockMinutes] = useState(0)

  // Backup section
  const [backupStatus, setBackupStatus] = useState('')

  // Mail profile publishing (per account)
  const [publishingAccount, setPublishingAccount] = useState<string | null>(null)
  const [publishStatus, setPublishStatus] = useState<Record<string, string>>({})

  // Mail policy section
  const [contactsMinutes, setContactsMinutes] = useState(0)
  const [nonContactsMinutes, setNonContactsMinutes] = useState(0)
  const [denyUntrusted, setDenyUntrusted] = useState(false)
  const [benchmarkHpm, setBenchmarkHpm] = useState<number | undefined>(undefined)
  const [policyStatus, setPolicyStatus] = useState('')
  const [policySaving, setPolicySaving] = useState(false)
  const [benchmarking, setBenchmarking] = useState(false)

  // Account add/remove
  const [addingAccount, setAddingAccount] = useState(false)
  const [newNsec, setNewNsec] = useState('')
  const [newAccountName, setNewAccountName] = useState('')
  const [accountStatus, setAccountStatus] = useState('')
  const [accountError, setAccountError] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)

  // Cache & Data section
  const [cacheStatus, setCacheStatus] = useState('')
  const [cacheBusy, setCacheBusy] = useState(false)

  const policyBits = (minutes: number): string => {
    if (minutes <= 0 || !benchmarkHpm || benchmarkHpm <= 0) return 'no PoW required'
    return `≈ ${Math.round(Math.log2(minutes * benchmarkHpm))} bits PoW`
  }

  const handlePublishProfile = async (account: AccountData) => {
    setPublishingAccount(account.pubkey)
    try {
      const result = await window.nvelope.profile.publish(identityId, account.pubkey)
      setPublishStatus((prev) => ({
        ...prev,
        [account.pubkey]: result.certificateEventId
          ? 'Published'
          : 'Publish failed — check console',
      }))
    } catch (e) {
      const msg = String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')
      setPublishStatus((prev) => ({ ...prev, [account.pubkey]: 'Failed: ' + (msg.split('\n')[0] ?? msg) }))
    } finally {
      setPublishingAccount(null)
      setTimeout(() => setPublishStatus((prev) => {
        const next = { ...prev }
        delete next[account.pubkey]
        return next
      }), 8000)
    }
  }

  useEffect(() => {
    const load = async () => {
      try {
        const settings = await window.nvelope.vault.getSettings(identityId)
        const prefs = (settings.preferences ?? {}) as Record<string, unknown>
        setAllPrefs(prefs)
        const r = prefs.relays
        setRelays(Array.isArray(r) && r.length > 0 ? (r as string[]) : [...DEFAULT_RELAYS])
        const policies = (prefs.policies ?? {}) as { contactsMinutes?: number; nonContactsMinutes?: number; denyUntrusted?: boolean }
        setContactsMinutes(policies.contactsMinutes ?? 0)
        setNonContactsMinutes(policies.nonContactsMinutes ?? 0)
        setDenyUntrusted(policies.denyUntrusted === true)
      } catch (e) {
        console.error('[settings] failed to load vault settings:', e)
        setRelays([...DEFAULT_RELAYS])
      }
      // Hash rate is machine-level (client settings), shared across identities
      try {
        const [hpm, version] = await Promise.all([
          window.nvelope.settings.get('benchmarkHashesPerMinute'),
          window.nvelope.settings.get('benchmarkVersion'),
        ])
        if (typeof hpm === 'number' && hpm > 0 && version === 2) setBenchmarkHpm(hpm)
      } catch (e) {
        console.error('[settings] failed to load benchmark:', e)
      }
      const t = await window.nvelope.settings.get('theme')
      if (t === 'light' || t === 'dark' || t === 'system') setTheme(t)
      const al = await window.nvelope.settings.get('autoLockMinutes')
      if (typeof al === 'number') setAutoLockMinutes(al)
    }
    load()
  }, [identityId])

  const handleRename = async () => {
    const trimmed = nameInput.trim()
    if (!trimmed || trimmed === identityName) return
    try {
      const result = await window.nvelope.vault.renameIdentity(identityId, trimmed)
      onRenamed(result.name)
      setRenameStatus('Identity renamed')
      setTimeout(() => setRenameStatus(''), 4000)
    } catch (e) {
      setRenameStatus('Rename failed: ' + String(e))
      setTimeout(() => setRenameStatus(''), 4000)
    }
  }

  const handleChangePassphrase = async () => {
    setPassError(false)
    if (newPass.length < 8) {
      setPassStatus('New passphrase must be at least 8 characters')
      setPassError(true)
      return
    }
    if (newPass !== confirmPass) {
      setPassStatus('New passphrases do not match')
      setPassError(true)
      return
    }
    try {
      await window.nvelope.vault.changePassphrase(identityId, currentPass, newPass)
      setPassStatus('Passphrase changed')
      setCurrentPass('')
      setNewPass('')
      setConfirmPass('')
    } catch (e) {
      setPassStatus(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?/, ''))
      setPassError(true)
    }
    setTimeout(() => { setPassStatus(''); setPassError(false) }, 5000)
  }

  const handleAddRelay = () => {
    const url = relayInput.trim()
    if (!url.startsWith('wss://')) {
      setRelayStatus('Relay URL must start with wss://')
      setTimeout(() => setRelayStatus(''), 4000)
      return
    }
    if (relays.includes(url)) {
      setRelayStatus('Relay already in list')
      setTimeout(() => setRelayStatus(''), 4000)
      return
    }
    setRelays([...relays, url])
    setRelayInput('')
  }

  const handleSaveRelays = async () => {
    try {
      const settings = await window.nvelope.vault.getSettings(identityId)
      await window.nvelope.vault.updateSettings(identityId, {
        ...settings,
        preferences: { ...allPrefs, relays },
      })
      setRelayStatus('Relays saved — applies to next scan/send')
    } catch (e) {
      setRelayStatus('Save failed: ' + String(e))
    }
    setTimeout(() => setRelayStatus(''), 5000)
  }

  const handleSavePolicy = async () => {
    setPolicySaving(true)
    try {
      const settings = await window.nvelope.vault.getSettings(identityId)
      await window.nvelope.vault.updateSettings(identityId, {
        ...settings,
        preferences: {
          ...allPrefs,
          policies: { contactsMinutes, nonContactsMinutes, denyUntrusted },
        },
      })
      // Re-publish every account's certificate so the new policy takes effect
      let published = 0
      for (const account of accounts) {
        const result = await window.nvelope.profile.publish(identityId, account.pubkey)
        if (result.certificateEventId) published++
      }
      setPolicyStatus(`Policy saved — re-published ${published}/${accounts.length} account profile${accounts.length === 1 ? '' : 's'}`)
    } catch (e) {
      const msg = String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')
      setPolicyStatus('Save failed: ' + (msg.split('\n')[0] ?? msg))
    } finally {
      setPolicySaving(false)
      setTimeout(() => setPolicyStatus(''), 8000)
    }
  }

  const handleRerunBenchmark = async () => {
    setBenchmarking(true)
    setPolicyStatus('')
    try {
      const result = await window.nvelope.benchmark.runPowBenchmark()
      await window.nvelope.settings.set('benchmarkHashesPerMinute', result.hashesPerMinute)
      await window.nvelope.settings.set('benchmarkVersion', 2)
      setBenchmarkHpm(result.hashesPerMinute)
      setPolicyStatus(`Benchmark updated: ${result.hashesPerSecond.toLocaleString()} hashes/sec — re-save the policy to apply it`)
    } catch (e) {
      setPolicyStatus('Benchmark failed: ' + String(e))
    } finally {
      setBenchmarking(false)
      setTimeout(() => setPolicyStatus(''), 10000)
    }
  }

  const handleClearCacheAndResync = async () => {
    if (!confirm('Clear the cached mail certificates and recipient policies, then resync contacts from the relays? Contact names and notes you entered are kept.')) return
    setCacheBusy(true)
    setCacheStatus('')
    try {
      const result = await window.nvelope.contacts.clearCacheAndResync(identityId)
      setCacheStatus(`Cache cleared — resynced ${result.contacts} contacts (${result.mailEnabled} can receive mail)`)
    } catch (e) {
      setCacheStatus('Failed: ' + String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '').split('\n')[0])
    } finally {
      setCacheBusy(false)
      setTimeout(() => setCacheStatus(''), 8000)
    }
  }

  const handleResetScanCursor = async () => {
    if (!confirm('Reset mail scan history? The next mail check re-downloads every envelope from the relays. Already-stored mail is kept and deduplicated.')) return
    setCacheBusy(true)
    setCacheStatus('')
    try {
      await window.nvelope.vault.resetScanCursor(identityId)
      setCacheStatus('Scan history reset — the next Check Mail performs a full rescan')
    } catch (e) {
      setCacheStatus('Failed: ' + String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '').split('\n')[0])
    } finally {
      setCacheBusy(false)
      setTimeout(() => setCacheStatus(''), 8000)
    }
  }

  const refreshAccounts = async () => {
    const list = (await window.nvelope.vault.listAccounts(identityId)) as AccountData[]
    onAccountsChanged?.(list)
  }

  const handleAddAccount = async (mode: 'import' | 'generate') => {
    setAccountBusy(true)
    setAccountError(false)
    try {
      let nsec: string
      if (mode === 'import') {
        const trimmed = newNsec.trim()
        const decoded = decode(trimmed)
        if (decoded.type !== 'nsec') throw new Error('Expected an nsec1… secret key')
        nsec = trimmed
      } else {
        nsec = nsecEncode(generateSecretKey())
      }
      const sk = decode(nsec).data as Uint8Array
      const pubkey = getPublicKey(sk)
      if (accounts.some((a) => a.pubkey === pubkey)) throw new Error('That account is already in this identity')
      const cert = await window.nvelope.cert.generate(2048)
      await window.nvelope.vault.addAccount(identityId, {
        pubkey,
        nsec,
        certificatePrivateKeyPem: cert.privateKeyPem,
        certificatePublicKeyDerBase64: cert.publicKeyDerBase64,
        displayName: newAccountName.trim() || undefined,
      })
      await refreshAccounts()
      setAddingAccount(false)
      setNewNsec('')
      setNewAccountName('')
      setAccountStatus(mode === 'import' ? 'Account imported' : 'Account generated — export the nsec from Backup to keep a copy')
      setAccountError(false)
    } catch (e) {
      const msg = String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')
      setAccountStatus(msg.split('\n')[0] ?? msg)
      setAccountError(true)
    } finally {
      setAccountBusy(false)
      setTimeout(() => { setAccountStatus(''); setAccountError(false) }, 8000)
    }
  }

  const handleRemoveAccount = async (account: AccountData) => {
    if (accounts.length <= 1) {
      setAccountStatus('Cannot remove the last account in an identity')
      setAccountError(true)
      setTimeout(() => { setAccountStatus(''); setAccountError(false) }, 5000)
      return
    }
    const label = account.displayName || formatNpub(account.pubkey)
    if (!confirm(`Remove account ${label} from this identity? Its stored mail stays on disk, but the account will no longer be usable here.`)) return
    setAccountBusy(true)
    try {
      await window.nvelope.vault.deleteAccount(identityId, account.pubkey)
      await refreshAccounts()
      setAccountStatus('Account removed')
      setAccountError(false)
    } catch (e) {
      setAccountStatus('Remove failed: ' + String(e))
      setAccountError(true)
    } finally {
      setAccountBusy(false)
      setTimeout(() => { setAccountStatus(''); setAccountError(false) }, 5000)
    }
  }

  const handleThemeChange = async (value: 'dark' | 'light' | 'system') => {
    setTheme(value)
    await window.nvelope.settings.set('theme', value)
    document.documentElement.dataset.theme = value
  }

  const handleAutoLockChange = async (minutes: number) => {
    setAutoLockMinutes(minutes)
    await window.nvelope.settings.set('autoLockMinutes', minutes)
  }

  const handleExportVault = async () => {
    try {
      const result = await window.nvelope.vault.exportVault(identityId)
      setBackupStatus(result.canceled ? '' : `Vault exported to ${result.path}`)
    } catch (e) {
      setBackupStatus('Export failed: ' + String(e))
    }
    setTimeout(() => setBackupStatus(''), 8000)
  }

  const handleExportNsec = async (account: AccountData) => {
    if (!confirm('This saves your secret key (nsec) in PLAINTEXT. Anyone with this file controls your account. Continue?')) return
    const label = account.displayName || formatNpub(account.pubkey)
    const content = [
      `nVelope account backup — ${label}`,
      `npub: ${npubEncode(account.pubkey)}`,
      `nsec: ${account.nsec}`,
      '',
      'Keep this file private. Anyone with the nsec controls this account.',
    ].join('\n')
    const result = await window.nvelope.file.saveTextFile(`nvelope-${label.replace(/\s+/g, '-').toLowerCase()}-nsec.txt`, content)
    setBackupStatus(result.canceled ? '' : `nsec exported to ${result.path}`)
    setTimeout(() => setBackupStatus(''), 8000)
  }

  const sections: Array<{ id: Section; label: string }> = [
    { id: 'identity', label: 'Identity' },
    { id: 'relays', label: 'Relays' },
    { id: 'policy', label: 'Mail Policy' },
    { id: 'cache', label: 'Cache & Data' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'security', label: 'Security' },
    { id: 'backup', label: 'Backup' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[520px] w-[720px] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Section nav */}
        <div className="w-44 shrink-0 border-r border-neutral-700/50 bg-neutral-800/50 p-3">
          <h2 className="mb-3 px-2 text-sm font-bold tracking-tight">Settings</h2>
          <div className="space-y-0.5">
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                  section === s.id
                    ? 'bg-blue-600/20 text-blue-300'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-neutral-700/50 px-5 py-3">
            <h3 className="text-sm font-semibold">{sections.find((s) => s.id === section)?.label}</h3>
            <button
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">
            {section === 'identity' && (
              <div className="space-y-6">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Identity name</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleRename}
                      disabled={!nameInput.trim() || nameInput.trim() === identityName}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                    >
                      Rename
                    </button>
                  </div>
                  {renameStatus && <p className="mt-1.5 text-xs text-emerald-400">{renameStatus}</p>}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Change passphrase</label>
                  <div className="space-y-2">
                    <input
                      type="password"
                      placeholder="Current passphrase"
                      value={currentPass}
                      onChange={(e) => setCurrentPass(e.target.value)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    />
                    <input
                      type="password"
                      placeholder="New passphrase (min 8 characters)"
                      value={newPass}
                      onChange={(e) => setNewPass(e.target.value)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    />
                    <input
                      type="password"
                      placeholder="Confirm new passphrase"
                      value={confirmPass}
                      onChange={(e) => setConfirmPass(e.target.value)}
                      className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleChangePassphrase}
                      disabled={!currentPass || !newPass || !confirmPass}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                    >
                      Change passphrase
                    </button>
                    {passStatus && (
                      <p className={`text-xs ${passError ? 'text-red-400' : 'text-emerald-400'}`}>{passStatus}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Accounts</label>
                  <div className="space-y-1">
                    {accounts.map((a) => (
                      <div key={a.pubkey} className="flex items-center justify-between gap-2 rounded-md border border-neutral-700/50 bg-neutral-800/50 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="text-neutral-200">{a.displayName || '(unnamed)'}</span>
                          <span className="ml-2 text-xs text-neutral-500">{formatNpub(a.pubkey)}</span>
                          {publishStatus[a.pubkey] && (
                            <span className={`ml-2 text-xs ${publishStatus[a.pubkey]!.startsWith('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>
                              {publishStatus[a.pubkey]}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <button
                            onClick={() => handlePublishProfile(a)}
                            disabled={publishingAccount === a.pubkey}
                            title="Publish mail certificate + recipient policy (kind 30998) to your relays"
                            className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                          >
                            {publishingAccount === a.pubkey ? 'Publishing…' : 'Publish profile'}
                          </button>
                          <button
                            onClick={() => handleRemoveAccount(a)}
                            disabled={accountBusy || accounts.length <= 1}
                            title={accounts.length <= 1 ? 'Cannot remove the last account' : 'Remove this account from the identity'}
                            className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-400 hover:text-red-400 hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {addingAccount ? (
                    <div className="mt-2 space-y-2 rounded-md border border-neutral-700/50 bg-neutral-800/50 p-3">
                      <input
                        type="text"
                        placeholder="Display name (optional)"
                        value={newAccountName}
                        onChange={(e) => setNewAccountName(e.target.value)}
                        className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                      />
                      <input
                        type="password"
                        placeholder="nsec1… (leave empty to generate a new key)"
                        value={newNsec}
                        onChange={(e) => setNewNsec(e.target.value)}
                        className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => (newNsec.trim() ? handleAddAccount('import') : handleAddAccount('generate'))}
                          disabled={accountBusy}
                          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                        >
                          {accountBusy ? 'Adding…' : newNsec.trim() ? 'Import account' : 'Generate account'}
                        </button>
                        <button
                          onClick={() => { setAddingAccount(false); setNewNsec(''); setNewAccountName('') }}
                          disabled={accountBusy}
                          className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-xs text-neutral-500">
                        A fresh 2048-bit mail certificate is generated for the account. Publish its profile to make it reachable.
                      </p>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingAccount(true)}
                      className="mt-2 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 transition-colors"
                    >
                      Add account…
                    </button>
                  )}
                  {accountStatus && (
                    <p className={`mt-1.5 text-xs ${accountError ? 'text-red-400' : 'text-emerald-400'}`}>{accountStatus}</p>
                  )}
                  <p className="mt-1.5 text-xs text-neutral-500">
                    Publishing makes the account reachable — contacts can only send mail to accounts with a published certificate.
                  </p>
                </div>
              </div>
            )}

            {section === 'relays' && (
              <div className="space-y-4">
                <p className="text-xs text-neutral-500">
                  These relays are used for sending and scanning mail for this identity.
                </p>
                <div className="space-y-1">
                  {relays.map((relay, i) => (
                    <div key={relay} className="flex items-center justify-between rounded-md border border-neutral-700/50 bg-neutral-800/50 px-3 py-1.5">
                      <span className="text-sm text-neutral-200">{relay}</span>
                      <button
                        onClick={() => setRelays(relays.filter((_, idx) => idx !== i))}
                        className="text-xs text-neutral-500 hover:text-red-400 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="wss://your-relay.example"
                    value={relayInput}
                    onChange={(e) => setRelayInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddRelay() }}
                    className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleAddRelay}
                    disabled={!relayInput.trim()}
                    className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                  >
                    Add
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSaveRelays}
                    disabled={relays.length === 0}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                  >
                    Save relays
                  </button>
                  <button
                    onClick={() => setRelays([...DEFAULT_RELAYS])}
                    className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 transition-colors"
                  >
                    Reset to defaults
                  </button>
                </div>
                {relayStatus && <p className="text-xs text-emerald-400">{relayStatus}</p>}
              </div>
            )}

            {section === 'policy' && (
              <div className="space-y-5">
                <p className="text-xs text-neutral-500">
                  Sets the proof-of-work you require from senders before you accept their mail. Saving re-publishes every account's mail certificate (kind 30998) with the new policy.
                </p>
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span>Contacts (People I know)</span>
                    <span className="text-neutral-400">{contactsMinutes} Minutes</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    value={contactsMinutes}
                    onChange={(e) => setContactsMinutes(parseInt(e.target.value))}
                    className="w-full accent-blue-500"
                  />
                  <div className="flex justify-between text-xs text-neutral-500 mt-1">
                    <span>0 Minutes</span>
                    <span>{policyBits(contactsMinutes)}</span>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span>Non-Contacts (People I may not know)</span>
                    <span className="text-neutral-400">{nonContactsMinutes} Minutes</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    value={nonContactsMinutes}
                    onChange={(e) => setNonContactsMinutes(parseInt(e.target.value))}
                    className="w-full accent-blue-500"
                  />
                  <div className="flex justify-between text-xs text-neutral-500 mt-1">
                    <span>0 Minutes</span>
                    <span>{policyBits(nonContactsMinutes)}</span>
                  </div>
                </div>
                <label className="flex items-center gap-2.5 rounded-md border border-neutral-700/50 bg-neutral-800/50 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800">
                  <input
                    type="checkbox"
                    checked={denyUntrusted}
                    onChange={(e) => setDenyUntrusted(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span>Reject mail from non-contacts</span>
                </label>
                {benchmarkHpm ? (
                  <p className="text-xs text-neutral-500">
                    Measured hash rate: ~{Math.round(benchmarkHpm / 60).toLocaleString()} hashes/sec
                  </p>
                ) : (
                  <p className="text-xs text-amber-400/90">
                    No hash-rate benchmark recorded for this identity — PoW difficulty is estimated from the benchmark run during setup, so minute targets are approximate.
                  </p>
                )}
                <button
                  onClick={handleRerunBenchmark}
                  disabled={benchmarking || policySaving}
                  title="Measure this machine's hash rate again (10 seconds). Re-save the policy afterwards to apply it."
                  className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                >
                  {benchmarking ? 'Benchmarking (10s)…' : 'Re-run benchmark'}
                </button>
                <button
                  onClick={handleSavePolicy}
                  disabled={policySaving}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {policySaving ? 'Saving & publishing…' : 'Save policy'}
                </button>
                {policyStatus && <p className="text-xs text-emerald-400">{policyStatus}</p>}
              </div>
            )}

            {section === 'cache' && (
              <div className="space-y-5">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Contact data</label>
                  <p className="mb-2 text-xs text-neutral-500">
                    Mail certificates and recipient policies are cached locally to keep loading fast. If a contact's mail status or PoW estimate looks stale, clear the cache and pull fresh data from the relays.
                  </p>
                  <button
                    onClick={handleClearCacheAndResync}
                    disabled={cacheBusy}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                  >
                    {cacheBusy ? 'Working…' : 'Clear cache & resync contacts'}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Mail scanning</label>
                  <p className="mb-2 text-xs text-neutral-500">
                    Mail checks only fetch envelopes newer than the last check. Reset this to force a full rescan — stored mail is kept and duplicates are ignored.
                  </p>
                  <button
                    onClick={handleResetScanCursor}
                    disabled={cacheBusy}
                    className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                  >
                    Reset mail scan history
                  </button>
                </div>
                {cacheStatus && <p className="text-xs text-emerald-400">{cacheStatus}</p>}
              </div>
            )}

            {section === 'appearance' && (
              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">Theme</label>
                  <div className="space-y-1.5">
                    {(['dark', 'light', 'system'] as const).map((value) => (
                      <label key={value} className="flex items-center gap-2.5 rounded-md border border-neutral-700/50 bg-neutral-800/50 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800">
                        <input
                          type="radio"
                          name="theme"
                          checked={theme === value}
                          onChange={() => handleThemeChange(value)}
                          className="accent-blue-500"
                        />
                        <span className="capitalize">{value}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-neutral-500">
                  Light theme is coming in a future update — nVelope currently displays dark only. Your choice is saved and will be honored when it lands.
                </p>
              </div>
            )}

            {section === 'security' && (
              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-neutral-500">Auto-lock after inactivity</label>
                  <select
                    value={autoLockMinutes}
                    onChange={(e) => handleAutoLockChange(Number(e.target.value))}
                    className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                  >
                    <option value={0}>Never</option>
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                  </select>
                  <p className="mt-1.5 text-xs text-neutral-500">
                    Locks the identity (returns to the unlock screen) after this much idle time.
                  </p>
                </div>
              </div>
            )}

            {section === 'backup' && (
              <div className="space-y-5">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Encrypted vault backup</label>
                  <p className="mb-2 text-xs text-neutral-500">
                    Exports a copy of your encrypted vault file. Stays passphrase-protected — safe to store anywhere.
                  </p>
                  <button
                    onClick={handleExportVault}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
                  >
                    Export encrypted vault
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Plaintext nsec export</label>
                  <p className="mb-2 text-xs text-red-400/80">
                    Saves your secret key in plaintext. Anyone with this file controls your account.
                  </p>
                  <div className="space-y-1">
                    {accounts.map((a) => (
                      <div key={a.pubkey} className="flex items-center justify-between rounded-md border border-neutral-700/50 bg-neutral-800/50 px-3 py-1.5">
                        <span className="text-sm text-neutral-200">{a.displayName || formatNpub(a.pubkey)}</span>
                        <button
                          onClick={() => handleExportNsec(a)}
                          className="text-xs text-neutral-400 hover:text-amber-400 transition-colors"
                        >
                          Export nsec
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                {backupStatus && <p className="text-xs text-emerald-400 break-all">{backupStatus}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
