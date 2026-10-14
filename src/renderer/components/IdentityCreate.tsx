import { useState } from 'react'

interface Props {
  onCreate: (name: string, passphrase: string) => Promise<void>
  error: string
}

export default function IdentityCreate({ onCreate, error }: Props) {
  const [name, setName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState('')
  const [creating, setCreating] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError('')
    if (!name.trim()) {
      setLocalError('Identity name is required')
      return
    }
    if (passphrase.length < 8) {
      setLocalError('Passphrase must be at least 8 characters')
      return
    }
    if (passphrase !== confirm) {
      setLocalError('Passphrases do not match')
      return
    }
    setCreating(true)
    try {
      await onCreate(name.trim(), passphrase)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-800 p-6 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold">Welcome to nVelope</h2>
      <p className="mb-4 text-sm text-neutral-400">Create your first identity to get started.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Identity Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Personal"
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Passphrase</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Min 8 characters"
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-neutral-500">This unlocks all accounts in this identity. There is no recovery — do not forget it.</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Confirm Passphrase</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        {(localError || error) && (
          <div className="rounded bg-red-900/30 px-3 py-2 text-sm text-red-400">{localError || error}</div>
        )}

        <button
          type="submit"
          disabled={creating}
          className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? 'Creating...' : 'Create Identity'}
        </button>
      </form>
    </div>
  )
}
