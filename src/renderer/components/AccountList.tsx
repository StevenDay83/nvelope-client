import { useState } from 'react'
import { getPublicKey } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'

interface AccountData {
  pubkey: string
  nsec: string
  certificatePrivateKeyPem: string
  certificatePublicKeyDerBase64: string
  displayName?: string
}

interface Props {
  accounts: AccountData[]
  identityId: string
  onAccountsChange: (accounts: AccountData[]) => void
}

export default function AccountList({ accounts, identityId, onAccountsChange }: Props) {
  const [showAdd, setShowAdd] = useState(false)
  const [nsec, setNsec] = useState('')
  const [certPem, setCertPem] = useState('')
  const [certPub, setCertPub] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [generatingCert, setGeneratingCert] = useState(false)

  const derivePubkey = (nsecValue: string): string | null => {
    try {
      const decoded = decode(nsecValue)
      if (decoded.type !== 'nsec') return null
      return getPublicKey(decoded.data as Uint8Array)
    } catch {
      return null
    }
  }

  const handleGenerateCert = async () => {
    setGeneratingCert(true)
    setError('')
    try {
      const cert = await window.nvelope.cert.generate(4096)
      setCertPem(cert.privateKeyPem)
      setCertPub(cert.publicKeyDerBase64)
    } catch (e) {
      setError('Failed to generate certificate: ' + String(e))
    } finally {
      setGeneratingCert(false)
    }
  }

  const handleLoadPem = async () => {
    setError('')
    try {
      const result = await window.nvelope.file.openPemFile()
      if (result.canceled) return
      setCertPem(result.content)
      const derived = await window.nvelope.cert.derivePublic(result.content)
      if (derived.publicKeyDerBase64) {
        setCertPub(derived.publicKeyDerBase64)
      }
    } catch (e) {
      setError('Failed to load PEM file: ' + String(e))
    }
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!nsec.trim()) {
      setError('nsec is required')
      return
    }

    const pubkey = derivePubkey(nsec.trim())
    if (!pubkey) {
      setError('Invalid nsec — could not derive public key')
      return
    }

    if (!certPem.trim()) {
      setError('Certificate private key is required')
      return
    }

    setAdding(true)
    try {
      const account: AccountData = {
        pubkey,
        nsec: nsec.trim(),
        certificatePrivateKeyPem: certPem.trim(),
        certificatePublicKeyDerBase64: certPub.trim(),
        displayName: displayName.trim() || undefined,
      }
      await window.nvelope.vault.addAccount(identityId, account)
      onAccountsChange([...accounts, account])
      setShowAdd(false)
      resetForm()
    } catch (e) {
      setError(String(e))
    } finally {
      setAdding(false)
    }
  }

  const resetForm = () => {
    setNsec('')
    setCertPem('')
    setCertPub('')
    setDisplayName('')
  }

  const handleDelete = async (pubkey: string) => {
    if (!confirm('Delete this account? This cannot be undone.')) return
    try {
      await window.nvelope.vault.deleteAccount(identityId, pubkey)
      onAccountsChange(accounts.filter((a) => a.pubkey !== pubkey))
    } catch (e) {
      alert('Failed to delete: ' + String(e))
    }
  }

  const derivedPubkey = derivePubkey(nsec)

  if (accounts.length === 0 && !showAdd) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-neutral-400">No accounts yet.</p>
        <button onClick={() => setShowAdd(true)} className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500">
          Add Account
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Accounts</h2>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500">
            Add Account
          </button>
        )}
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="rounded border border-neutral-700 bg-neutral-800 p-4 space-y-3">
          <h3 className="font-medium">New Account</h3>

          <div>
            <label className="mb-1 block text-sm font-medium">nsec</label>
            <input
              placeholder="nsec1..."
              value={nsec}
              onChange={(e) => setNsec(e.target.value)}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm font-mono"
            />
            {derivedPubkey ? (
              <p className="mt-1 text-xs text-green-400 font-mono">Derived npub: {derivedPubkey.slice(0, 16)}...{derivedPubkey.slice(-8)}</p>
            ) : nsec ? (
              <p className="mt-1 text-xs text-red-400">Invalid nsec</p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Certificate Private Key (PEM)</label>
            <textarea
              placeholder="-----BEGIN PRIVATE KEY-----..."
              value={certPem}
              onChange={(e) => setCertPem(e.target.value)}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm font-mono"
              rows={4}
            />
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={handleGenerateCert}
                disabled={generatingCert}
                className="rounded bg-green-700 px-3 py-1 text-xs text-white hover:bg-green-600 disabled:opacity-50"
              >
                {generatingCert ? 'Generating 4096-bit...' : 'Generate 4096-bit Certificate'}
              </button>
              <button
                type="button"
                onClick={handleLoadPem}
                className="rounded border border-neutral-600 px-3 py-1 text-xs hover:bg-neutral-700"
              >
                Load from PEM file
              </button>
            </div>
            {certPub && (
              <p className="mt-1 text-xs text-green-400 font-mono">Public key derived from certificate</p>
            )}
          </div>

          <input
            placeholder="Display Name - optional"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm"
          />

          {error && <div className="text-sm text-red-400">{error}</div>}

          <div className="flex gap-2">
            <button type="submit" disabled={adding} className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
              {adding ? 'Adding...' : 'Add Account'}
            </button>
            <button
              type="button"
              onClick={() => { setShowAdd(false); resetForm() }}
              className="rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {accounts.map((account) => (
          <div key={account.pubkey} className="flex items-center justify-between rounded border border-neutral-700 bg-neutral-800 px-4 py-3">
            <div>
              <div className="font-medium">{account.displayName || account.pubkey.slice(0, 16) + '...'}</div>
              <div className="text-xs text-neutral-500 font-mono">{account.pubkey}</div>
              <div className="mt-1 flex gap-2 text-xs">
                <span className={account.nsec ? 'text-green-400' : 'text-red-400'}>
                  {account.nsec ? 'Can Send' : 'No nsec'}
                </span>
                <span className={account.certificatePrivateKeyPem ? 'text-green-400' : 'text-red-400'}>
                  {account.certificatePrivateKeyPem ? 'Can Receive' : 'No Cert Key'}
                </span>
              </div>
            </div>
            <button
              onClick={() => handleDelete(account.pubkey)}
              className="rounded border border-red-800 px-3 py-1 text-xs text-red-400 hover:bg-red-900/30"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
