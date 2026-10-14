import { useState, useEffect } from 'react'
import { npubEncode } from 'nostr-tools/nip19'

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
}

type Section = 'identity' | 'relays' | 'appearance' | 'security' | 'backup'

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

export default function SettingsPanel({ identityId, identityName, accounts, onClose, onRenamed }: Props) {
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
      } catch (e) {
        console.error('[settings] failed to load vault settings:', e)
        setRelays([...DEFAULT_RELAYS])
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
                        <button
                          onClick={() => handlePublishProfile(a)}
                          disabled={publishingAccount === a.pubkey}
                          title="Publish mail certificate + recipient policy (kind 30998) to your relays"
                          className="shrink-0 rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                        >
                          {publishingAccount === a.pubkey ? 'Publishing…' : 'Publish profile'}
                        </button>
                      </div>
                    ))}
                  </div>
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
