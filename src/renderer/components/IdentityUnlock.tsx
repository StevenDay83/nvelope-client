import { useState, useEffect } from 'react'

interface IdentityMeta {
  id: string
  name: string
}

interface Props {
  identities: IdentityMeta[]
  initialIdentityId?: string
  onUnlock: (identityId: string, passphrase: string) => Promise<void>
  onCreateNew: () => void
  onDeleted: () => void
  error: string
}

export default function IdentityUnlock({ identities, initialIdentityId, onUnlock, onCreateNew, onDeleted, error }: Props) {
  const [selectedId, setSelectedId] = useState(
    identities.find((i) => i.id === initialIdentityId)?.id ?? identities[0]?.id ?? '',
  )
  const [passphrase, setPassphrase] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // The identities prop reloads after a delete — keep the selection valid
  useEffect(() => {
    if (!identities.some((i) => i.id === selectedId)) {
      setSelectedId(identities[0]?.id ?? '')
    }
  }, [identities, selectedId])

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

  const handleDelete = async () => {
    if (!selectedId) return
    setDeleting(true)
    setDeleteError('')
    try {
      await window.nvelope.vault.deleteIdentity(selectedId)
      setConfirmingDelete(false)
      setPassphrase('')
      onDeleted()
    } catch (e) {
      setDeleteError(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    } finally {
      setDeleting(false)
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

          <div className="border-t border-neutral-700 pt-4 space-y-2">
            <button
              type="button"
              onClick={onCreateNew}
              className="w-full rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700"
            >
              Create New Identity
            </button>
            {confirmingDelete ? (
              <div className="rounded border border-red-800/50 bg-red-900/10 p-3 space-y-3">
                <p className="text-xs text-red-300">
                  Deleting an identity will remove all associated accounts, saved mail, and private certificate data. If you have not backed up the identity, once you delete it there is no chance for recovery.
                </p>
                {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex-1 rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmingDelete(false); setDeleteError('') }}
                    disabled={deleting}
                    className="flex-1 rounded border border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={!selectedId}
                className="w-full rounded bg-red-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                Delete Identity
              </button>
            )}
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
