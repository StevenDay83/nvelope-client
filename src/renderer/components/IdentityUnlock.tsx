import { useState } from 'react'

interface IdentityMeta {
  id: string
  name: string
}

interface Props {
  identities: IdentityMeta[]
  onUnlock: (identityId: string, passphrase: string) => Promise<void>
  onCreateNew: () => void
  error: string
}

export default function IdentityUnlock({ identities, onUnlock, onCreateNew, error }: Props) {
  const [selectedId, setSelectedId] = useState(identities[0]?.id ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [unlocking, setUnlocking] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedId || !passphrase) return
    setUnlocking(true)
    try {
      await onUnlock(selectedId, passphrase)
    } finally {
      setUnlocking(false)
    }
  }

  const hasIdentities = identities.length > 0

  return (
    <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-800 p-6 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold">Unlock nVelope</h2>
      <p className="mb-4 text-sm text-neutral-400">
        {hasIdentities
          ? 'Select an identity and enter your passphrase.'
          : 'No identities found on this device.'}
      </p>

      {hasIdentities ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Identity</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Passphrase</label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase"
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          {error && <div className="rounded bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}

          <button
            type="submit"
            disabled={unlocking || !selectedId || !passphrase}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {unlocking ? 'Unlocking...' : 'Unlock'}
          </button>

          <div className="border-t border-neutral-700 pt-4">
            <button
              type="button"
              onClick={onCreateNew}
              className="w-full rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700"
            >
              Create New Identity
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          {error && <div className="rounded bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</div>}
          <button
            onClick={onCreateNew}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Create New Identity
          </button>
        </div>
      )}
    </div>
  )
}
