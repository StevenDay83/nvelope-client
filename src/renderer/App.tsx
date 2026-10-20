import { useState, useEffect, useCallback, useRef } from 'react'
import IdentityUnlock from './components/IdentityUnlock'
import OnboardingWizard from './components/onboarding/OnboardingWizard'
import InboxView from './components/InboxView'

interface IdentityMeta {
  id: string
  name: string
}

interface AccountData {
  pubkey: string
  nsec: string
  certificatePrivateKeyPem: string
  certificatePublicKeyDerBase64: string
  displayName?: string
  picture?: string
  about?: string
}

type AppView = 'loading' | 'onboard' | 'unlock' | 'inbox'

export default function App() {
  const [view, setView] = useState<AppView>('loading')
  const [identities, setIdentities] = useState<IdentityMeta[]>([])
  const [activeIdentity, setActiveIdentity] = useState<IdentityMeta | null>(null)
  const [lastIdentityId, setLastIdentityId] = useState<string>('')
  const [accounts, setAccounts] = useState<AccountData[]>([])
  const [error, setError] = useState('')
  const [autoLockMinutes, setAutoLockMinutes] = useState(0)
  const autoLockTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastActivityReset = useRef(0)

  const refreshAutoLock = useCallback(async () => {
    const v = await window.nvelope.settings.get('autoLockMinutes')
    setAutoLockMinutes(typeof v === 'number' ? v : 0)
  }, [])

  useEffect(() => {
    refreshAutoLock()
  }, [refreshAutoLock])

  useEffect(() => {
    loadIdentities()
  }, [])

  // Login screen errors dismiss themselves after a few seconds
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(''), 5000)
    return () => clearTimeout(timer)
  }, [error])

  const loadIdentities = async () => {
    try {
      if (typeof window === 'undefined' || !window.nvelope) {
        setError('Preload API not available. Check DevTools console for details.')
        setView('unlock')
        return
      }
      const list = await window.nvelope.vault.listIdentities()
      setIdentities(list)
      const lastId = await window.nvelope.settings.get('lastIdentityId')
      if (typeof lastId === 'string') setLastIdentityId(lastId)
      if (list.length === 0) {
        setView('onboard')
      } else {
        setView('unlock')
      }
    } catch (e) {
      setError(String(e))
      setView('unlock')
    }
  }

  const handleOnboardComplete = useCallback(async (identityId: string, _name: string, newAccounts: AccountData[]) => {
    try {
      const list = await window.nvelope.vault.listIdentities()
      setIdentities(list)
      const identity = list.find((i) => i.id === identityId)
      if (identity) {
        setActiveIdentity(identity)
        setAccounts(newAccounts)
        setLastIdentityId(identityId)
        await window.nvelope.settings.set('lastIdentityId', identityId)
        await window.nvelope.relay.startAutoScan(identityId)
        setView('inbox')
      } else {
        setView('unlock')
      }
    } catch (e) {
      setError(String(e))
      setView('unlock')
    }
  }, [])

  const handleUnlock = useCallback(async (identityId: string, passphrase: string) => {
    setError('')
    try {
      const data = await window.nvelope.vault.unlockIdentity(identityId, passphrase)
      const identity = identities.find((i) => i.id === identityId) ?? { id: identityId, name: 'Unknown' }
      setActiveIdentity(identity)
      setAccounts(data.accounts)
      await window.nvelope.db.initSchema(identityId)

      await window.nvelope.relay.startAutoScan(identityId)
      setLastIdentityId(identityId)
      await window.nvelope.settings.set('lastIdentityId', identityId)
      // Fire-and-forget: pull kind 3 / NIP-51 contacts + certificate status in the background
      window.nvelope.contacts.sync(identityId).catch((e) => console.error('[contacts] sync failed:', e))
      // Refresh per-account NIP-65 relay lists in the background
      window.nvelope.relayList.sync(identityId, true).catch((e) => console.error('[relayList] sync failed:', e))
      setView('inbox')
    } catch (e) {
      setError('Invalid passphrase or corrupted vault')
    }
  }, [identities])

  const handleLock = useCallback(async () => {
    if (activeIdentity) {
      await window.nvelope.relay.stopAutoScan(activeIdentity.id)
      await window.nvelope.vault.lockIdentity(activeIdentity.id)
    }
    setAccounts([])
    setActiveIdentity(null)
    setError('')
    setView('unlock')
  }, [activeIdentity])

  const handleIdentityRenamed = useCallback((name: string) => {
    setActiveIdentity((prev) => (prev ? { ...prev, name } : prev))
    setIdentities((prev) => prev.map((i) => (i.id === activeIdentity?.id ? { ...i, name } : i)))
  }, [activeIdentity])

  // Auto-lock after N minutes of inactivity (0 = never)
  useEffect(() => {
    if (view !== 'inbox' || autoLockMinutes <= 0) return
    const resetTimer = () => {
      const now = Date.now()
      if (now - lastActivityReset.current < 1000) return
      lastActivityReset.current = now
      if (autoLockTimer.current) clearTimeout(autoLockTimer.current)
      autoLockTimer.current = setTimeout(() => {
        handleLock()
      }, autoLockMinutes * 60_000)
    }
    const events = ['mousemove', 'keydown', 'click'] as const
    events.forEach((e) => window.addEventListener(e, resetTimer))
    resetTimer()
    return () => {
      if (autoLockTimer.current) clearTimeout(autoLockTimer.current)
      events.forEach((e) => window.removeEventListener(e, resetTimer))
    }
  }, [view, autoLockMinutes, handleLock])

  if (view === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg">Loading nVelope...</div>
      </div>
    )
  }

  if (view === 'onboard') {
    return (
      <OnboardingWizard
        onComplete={handleOnboardComplete}
        onClose={() => setView('unlock')}
      />
    )
  }

  if (view === 'unlock') {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-900">
        <IdentityUnlock
          identities={identities}
          initialIdentityId={lastIdentityId}
          onUnlock={handleUnlock}
          onCreateNew={() => setView('onboard')}
          onDeleted={loadIdentities}
          error={error}
        />
      </div>
    )
  }

  return (
    <InboxView
      identityId={activeIdentity?.id ?? ''}
      accounts={accounts}
      onAccountsChanged={setAccounts}
      onLock={handleLock}
      identityName={activeIdentity?.name ?? ''}
      onIdentityRenamed={handleIdentityRenamed}
      onSettingsClosed={refreshAutoLock}
    />
  )
}
