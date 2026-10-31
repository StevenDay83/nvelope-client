import { useState, useCallback, useEffect } from 'react'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { nsecEncode, npubEncode, decode } from 'nostr-tools/nip19'

function formatNpub(pubkeyHex: string): string {
  const npub = npubEncode(pubkeyHex)
  if (npub.length <= 28) return npub
  return npub.slice(0, 15) + '...' + npub.slice(-10)
}

function formatPolicyMinutes(m: number): string {
  if (m % 1 === 0) return `${m} minute${m === 1 ? '' : 's'}`
  return `${Math.floor(m)} min 30 sec`
}

// Welcome message sender: throwaway all-zeros pubkey (never a real signer).
const WELCOME_SENDER_PUBKEY = '0'.repeat(64)
// Official nVelope account — the welcome message's Reply-To address.
const NVELOPE_REPLY_TO_HEX = '31844eb87bf5e0974a20287e37c5317d9115002b2b8ca06ceb8628e7764bdcab'

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface AccountData {
  pubkey: string
  nsec: string
  certificatePrivateKeyPem: string
  certificatePublicKeyDerBase64: string
  displayName?: string
  picture?: string
  about?: string
}

interface WizardData {
  identityName: string
  passphrase: string
  benchmarkHpm: number
  accountType: 'new' | 'existing' | null
  profile: { imageUrl: string; nickname: string; about: string }
  nsec: string
  pubkey: string
  policies: { contactsMinutes: number; nonContactsMinutes: number }
  cert: { keySize: 2048 | 4096; privateKeyPem: string; publicKeyDerBase64: string }
  relays: string[]
  relaySource: 'nip65' | 'kind3' | 'defaults' | null
  relayCreatedAt: number | null
}

interface Props {
  onComplete: (identityId: string, name: string, accounts: AccountData[]) => void
  onClose: () => void
}

type Screen =
  | 'welcome'
  | 'benchmark'
  | 'identity'
  | 'accountChoice'
  | 'accountImport'
  | 'accountProfile'
  | 'accountCreated'
  | 'policies'
  | 'certificate'
  | 'network'
  | 'review'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

const STEP_LABELS = ['Benchmark', 'Identity', 'Accounts', 'Network', 'Review']

function stepIndexForScreen(screen: Screen): number {
  switch (screen) {
    case 'welcome': return -1
    case 'benchmark': return 0
    case 'identity': return 1
    case 'accountChoice':
    case 'accountImport':
    case 'accountProfile':
    case 'accountCreated':
    case 'policies':
    case 'certificate': return 2
    case 'network': return 3
    case 'review': return 4
  }
}

// ------------------------------------------------------------------
// Step Indicator
// ------------------------------------------------------------------

function StepIndicator({
  currentStep,
  onStepClick,
}: {
  currentStep: number
  onStepClick?: (step: number) => void
}) {
  return (
    <div className="flex items-center justify-center gap-1 text-sm mb-6">
      {STEP_LABELS.map((label, i) => {
        const clickable = onStepClick && i < currentStep
        return (
          <div key={label} className="flex items-center gap-1">
            <span
              onClick={clickable ? () => onStepClick!(i) : undefined}
              className={
                (i < currentStep
                  ? 'text-green-400'
                  : i === currentStep
                    ? 'text-blue-400 font-semibold'
                    : 'text-neutral-500') +
                (clickable ? ' cursor-pointer underline decoration-dotted' : ' cursor-default')
              }
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <span className="text-neutral-600 mx-1">●</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------
// Navigation Buttons
// ------------------------------------------------------------------

function NavButtons({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  onBack?: () => void
  onNext: () => void
  nextLabel?: string
  nextDisabled?: boolean
}) {
  return (
    <div className="flex gap-3">
      {onBack && (
        <button
          onClick={onBack}
          className="flex-1 rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700"
        >
          Back
        </button>
      )}
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className={`flex-1 rounded px-4 py-2 text-sm text-white disabled:opacity-50 ${
          nextDisabled ? 'bg-neutral-600' : 'bg-blue-600 hover:bg-blue-500'
        }`}
      >
        {nextLabel || 'Next'}
      </button>
    </div>
  )
}

// ------------------------------------------------------------------
// Wizard
// ------------------------------------------------------------------

export default function OnboardingWizard({ onComplete, onClose }: Props) {
  const [screen, setScreen] = useState<Screen>('welcome')
  const [data, setData] = useState<WizardData>({
    identityName: '',
    passphrase: '',
    benchmarkHpm: 0,
    accountType: null,
    profile: { imageUrl: '', nickname: '', about: '' },
    nsec: '',
    pubkey: '',
    policies: { contactsMinutes: 0.5, nonContactsMinutes: 2 },
    cert: { keySize: 4096, privateKeyPem: '', publicKeyDerBase64: '' },
    relays: [...DEFAULT_RELAYS],
    relaySource: null,
    relayCreatedAt: null,
  })
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [nsecSaved, setNsecSaved] = useState(false)
  const [nsecWarned, setNsecWarned] = useState(false)
  const [, setStoredBenchmarkLoaded] = useState(false)
  const [keypairGenerated, setKeypairGenerated] = useState(false)
  const [importInput, setImportInput] = useState('')
  const [importPreview, setImportPreview] = useState<{ pubkey: string; name?: string; picture?: string; about?: string; relaySource?: 'nip65' | 'kind3' | 'defaults'; relayCount?: number } | null>(null)
  // Imported accounts: a kind-30998 cert may already be published for the npub
  const [publishedCert, setPublishedCert] = useState<string | null>(null)
  const [certChecked, setCertChecked] = useState(false)
  const [certMatchesPublished, setCertMatchesPublished] = useState(false)

  // Load benchmark from general client settings on mount (v2 = hash-only algorithm;
  // older benchmarks measured sign+hash and read ~60x too slow — treat as absent)
  useEffect(() => {
    Promise.all([
      window.nvelope.settings.get('benchmarkHashesPerMinute'),
      window.nvelope.settings.get('benchmarkVersion'),
    ]).then(([value, version]) => {
      const hpm = typeof value === 'number' ? value : 0
      if (hpm > 0 && version === 2) {
        setData((d) => ({ ...d, benchmarkHpm: hpm }))
      }
      setStoredBenchmarkLoaded(true)
    }).catch(() => setStoredBenchmarkLoaded(true))
  }, [])

  // Imported accounts: check the relays for an already-published mail
  // certificate so the wizard can require the matching private key instead of
  // silently clobbering it.
  useEffect(() => {
    if (screen !== 'certificate' || data.accountType !== 'existing' || certChecked) return
    setCertChecked(true)
    window.nvelope.profile.fetchCert(data.pubkey, data.relays)
      .then((res) => setPublishedCert(res?.certificate ?? null))
      .catch(() => setPublishedCert(null))
  }, [screen, data.accountType, data.pubkey, data.relays, certChecked])

  const update = useCallback(<K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    setData((d) => ({ ...d, [key]: value }))
  }, [])

  // ----------------------------------------------------------------
  // Actions
  // ----------------------------------------------------------------

  const runBenchmark = async () => {
    setWorking(true)
    setError('')
    try {
      const result = await window.nvelope.benchmark.runPowBenchmark()
      await window.nvelope.settings.set('benchmarkHashesPerMinute', result.hashesPerMinute)
      await window.nvelope.settings.set('benchmarkVersion', 2)
      update('benchmarkHpm', result.hashesPerMinute)
    } catch (e) {
      setError('Benchmark failed: ' + String(e))
    } finally {
      setWorking(false)
    }
  }

  const generateKeys = async () => {
    if (keypairGenerated && data.pubkey && data.nsec) {
      console.log('[wizard] Keypair already generated, skipping regeneration')
      setScreen('accountCreated')
      return
    }
    setWorking(true)
    setError('')
    try {
      const sk = generateSecretKey()
      const pubkey = getPublicKey(sk)
      const nsec = nsecEncode(sk)

      // Verify round-trip: nsec → decode → getPublicKey should match
      const decoded = decode(nsec)
      if (decoded.type !== 'nsec') throw new Error('nsecEncode produced invalid nsec')
      const roundtripPubkey = getPublicKey(decoded.data as Uint8Array)
      if (roundtripPubkey !== pubkey) {
        throw new Error(`Key verification failed: encoded pubkey ${pubkey} !== roundtrip ${roundtripPubkey}`)
      }

      console.log('[wizard] Generated keypair:', {
        pubkey,
        npub: npubEncode(pubkey),
        nsecPrefix: nsec.slice(0, 20) + '...',
      })

      update('pubkey', pubkey)
      update('nsec', nsec)
      setNsecSaved(false)
      setNsecWarned(false)
      setKeypairGenerated(true)
      setScreen('accountCreated')
    } catch (e) {
      console.error('[wizard] Key generation failed:', e)
      setError('Key generation failed: ' + String(e))
    } finally {
      setWorking(false)
    }
  }

  const validateImport = async () => {
    setError('')
    setWorking(true)
    setImportPreview(null)
    try {
      const trimmed = importInput.trim()
      const decoded = decode(trimmed)
      if (decoded.type !== 'nsec') throw new Error('Expected an nsec1… secret key')
      const pubkey = getPublicKey(decoded.data as Uint8Array)

      // Resolve the account's relays: its NIP-65 kind-10002 list first, then
      // the kind-3 relay map, then built-in defaults (NIP-65 is republished on
      // finalize for the kind-3/defaults fallbacks).
      let resolvedRelays = data.relays
      let relaySource: 'nip65' | 'kind3' | 'defaults' = 'defaults'
      try {
        const resolved = await window.nvelope.relayList.resolveImport(pubkey, data.relays)
        resolvedRelays = resolved.relays
        relaySource = resolved.source
        update('relays', resolved.relays)
        update('relaySource', resolved.source)
        update('relayCreatedAt', resolved.createdAt ?? null)
      } catch {
        update('relaySource', 'defaults')
        update('relayCreatedAt', null)
      }

      let preview: { pubkey: string; name?: string; picture?: string; about?: string } = { pubkey }
      try {
        const meta = await window.nvelope.profile.fetchMetadata(pubkey, resolvedRelays)
        if (meta) preview = { pubkey, name: meta.name, picture: meta.picture, about: meta.about }
      } catch {
        // profile fetch is best-effort — the account still imports without it
      }
      setImportPreview({ ...preview, relaySource, relayCount: resolvedRelays.length })
    } catch (e) {
      setError('Invalid secret key: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setWorking(false)
    }
  }

  const confirmImport = () => {
    if (!importPreview) return
    update('nsec', importInput.trim())
    update('pubkey', importPreview.pubkey)
    update('profile', {
      imageUrl: importPreview.picture ?? '',
      nickname: importPreview.name ?? '',
      about: importPreview.about ?? '',
    })
    setKeypairGenerated(true)
    // Imported accounts skip the policy screen — an existing npub may already
    // have a published recipient policy, and we must not clobber it
    setScreen(data.accountType === 'existing' ? 'certificate' : 'policies')
  }

  const generateCert = async () => {
    setWorking(true)
    setError('')
    try {
      if (publishedCert && !certMatchesPublished) {
        const overwrite = confirm(
          'A public key certificate is already published for this account.\n\n' +
            'Overwrite the published certificate with a newly generated key? ' +
            'Without the matching private key you cannot decrypt mail encrypted to the published certificate.'
        )
        if (!overwrite) return
      }
      const cert = await window.nvelope.cert.generate(data.cert.keySize)
      update('cert', { ...data.cert, privateKeyPem: cert.privateKeyPem, publicKeyDerBase64: cert.publicKeyDerBase64 })
      setCertMatchesPublished(false)
    } catch (e) {
      setError('Certificate generation failed: ' + String(e))
    } finally {
      setWorking(false)
    }
  }

  const importCert = async () => {
    setError('')
    try {
      const result = await window.nvelope.file.openPemFile()
      if (result.canceled) return
      const derived = await window.nvelope.cert.derivePublic(result.content)
      if (publishedCert) {
        if (derived.publicKeyDerBase64 === publishedCert) {
          update('cert', { ...data.cert, privateKeyPem: result.content, publicKeyDerBase64: derived.publicKeyDerBase64 })
          setCertMatchesPublished(true)
        } else {
          const overwrite = confirm(
            'The imported private key does NOT match the public key certificate published for this account.\n\n' +
              'OK = overwrite the published certificate with this new key\n' +
              'Cancel = do nothing'
          )
          if (!overwrite) return
          update('cert', { ...data.cert, privateKeyPem: result.content, publicKeyDerBase64: derived.publicKeyDerBase64 })
          setCertMatchesPublished(false)
        }
      } else {
        update('cert', { ...data.cert, privateKeyPem: result.content, publicKeyDerBase64: derived.publicKeyDerBase64 })
        setCertMatchesPublished(false)
      }
    } catch (e) {
      setError('Failed to import certificate: ' + String(e))
    }
  }

  const saveNsec = async () => {
    try {
      const npub = data.pubkey ? npubEncode(data.pubkey) : ''
      const result = await window.nvelope.file.saveTextFile(
        'nvelope-nsec.txt',
        `nVelope Account Backup\n======================\n\nPublic Key (npub):\n${npub}\n\nSecret Key (nsec — keep private):\n${data.nsec}\n\nKeep the nsec safe. Anyone with this key can send mail as you.`,
      )
      if (result.canceled) return
      setNsecSaved(true)
    } catch (e) {
      setError('Failed to save file: ' + String(e))
    }
  }

  const handleAccountCreatedNext = () => {
    if (!nsecSaved && !nsecWarned) {
      setNsecWarned(true)
      const ok = confirm(
        'WARNING: You have not saved your account secret key (nsec).\n\n' +
          'If you lose this key, you will NOT be able to send messages or recover this account.\n\n' +
          'Are you sure you want to continue without saving?'
      )
      if (!ok) return
    }
    setScreen('policies')
  }

  const finish = useCallback(async () => {
    setWorking(true)
    setError('')
    try {
      // Final keypair verification before creating the identity
      if (data.nsec && data.pubkey) {
        const decoded = decode(data.nsec)
        if (decoded.type === 'nsec') {
          const derived = getPublicKey(decoded.data as Uint8Array)
          if (derived !== data.pubkey) {
            throw new Error(
              `Wizard keypair mismatch: data.pubkey=${data.pubkey} but nsec derives to ${derived}. ` +
              `Do not proceed — keys were corrupted during wizard navigation.`
            )
          }
        }
      }

      console.log('[wizard] finish() creating identity with account:', {
        pubkey: data.pubkey,
        npub: data.pubkey ? npubEncode(data.pubkey) : '',
        nsecPrefix: data.nsec ? data.nsec.slice(0, 20) + '...' : '',
      })

      const account: AccountData = {
        pubkey: data.pubkey,
        nsec: data.nsec,
        certificatePrivateKeyPem: data.cert.privateKeyPem,
        certificatePublicKeyDerBase64: data.cert.publicKeyDerBase64,
        displayName: data.profile.nickname || undefined,
        picture: data.profile.imageUrl || undefined,
        about: data.profile.about || undefined,
      }

      const identity = await window.nvelope.vault.createIdentity(data.identityName, data.passphrase)
      console.log('[wizard] Created identity:', identity.id)
      await window.nvelope.db.initSchema(identity.id)
      await window.nvelope.vault.addAccount(identity.id, account)
      console.log('[wizard] Account added to vault')
      await window.nvelope.vault.updateSettings(identity.id, {
        preferences: {
          // Per-account NIP-65 mirror; `relays` stays as the legacy fallback
          relays: data.relays,
          relaysPerAccount: { [data.pubkey]: data.relays },
          ...(data.relaySource === 'nip65'
            ? { relaysFetchedPerAccount: { [data.pubkey]: { fetchedAt: Date.now(), createdAt: data.relayCreatedAt ?? undefined } } }
            : {}),
          policies: data.policies,
        },
      })

      // Imported accounts whose imported private key matched the published
      // certificate skip publishing entirely — the existing cert and policy stay
      // untouched. Other imported accounts publish the cert only (skip kind 0
      // AND the recipient policy — we must not clobber an existing policy).
      const keepExistingCert = data.accountType === 'existing' && certMatchesPublished
      if (!keepExistingCert) {
      try {
        const pubResult = await window.nvelope.profile.publish(identity.id, data.pubkey, {
          skipKind0: data.accountType === 'existing',
          skipPolicy: data.accountType === 'existing',
        })
        console.log('[onboarding] Profile published:', pubResult)
      } catch (publishErr) {
        console.warn('[onboarding] Profile publish failed:', publishErr)
        // Don't block onboarding if publish fails — user can retry later via Inbox
      }
      }

      // Publish the NIP-65 kind-10002 relay list: always for new accounts; for
      // imports only when the account had no usable list of its own (kind-3
      // relays get republished as 10002, defaults get published fresh).
      if (data.accountType === 'new' || data.relaySource !== 'nip65') {
        try {
          const rlResult = await window.nvelope.relayList.publish(identity.id, data.pubkey)
          console.log('[onboarding] Relay list published:', rlResult)
        } catch (rlErr) {
          console.warn('[onboarding] Relay list publish failed:', rlErr)
        }
      }

      // Inject welcome message. Sender is a throwaway all-zeros pubkey (never
      // a real signer); Reply-To points at the official nVelope account so
      // users can actually respond (previously the pseudo-sender 'nvelope'
      // crashed npubEncode on reply).
      const inbox = await window.nvelope.db.foldersGetSpecial(identity.id, data.pubkey, 'inbox')
      const inboxId = (inbox as { id: number } | null)?.id ?? null
      const welcomeId = 'welcome-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
      await window.nvelope.db.mailInsert(identity.id, {
        innerEventId: welcomeId,
        accountId: data.pubkey,
        folderId: inboxId,
        state: 'received',
        senderPubkey: WELCOME_SENDER_PUBKEY,
        subject: 'Welcome to nVelope',
        threadId: welcomeId,
        isBroadcast: 0,
        createdAt: Math.floor(Date.now() / 1000),
        read: 0,
        marked: 0,
        messageData: JSON.stringify({
          mailFrom: WELCOME_SENDER_PUBKEY,
          mailToList: [data.pubkey],
          replyTo: NVELOPE_REPLY_TO_HEX,
          subjectLine: 'Welcome to nVelope',
          messageType: 0,
          formats: {
            markdown: `Welcome to nVelope, ${data.profile.nickname || 'friend'}!\n\nThis is your first message. You can send and receive Nostr-Mail, manage broadcast subscriptions, and configure your recipient policy.\n\nHappy mailing!`,
          },
        }),
      })

      onComplete(identity.id, data.identityName, [account])
    } catch (e) {
      setError('Failed to finalize: ' + String(e))
      setWorking(false)
    }
  }, [data, onComplete, certMatchesPublished])

  // ----------------------------------------------------------------
  // Step indicator navigation: allow clicking completed steps
  // ----------------------------------------------------------------

  const handleStepClick = (step: number) => {
    const current = stepIndexForScreen(screen)
    if (step >= current) return
    // Map step index back to the first screen of that step
    switch (step) {
      case 0: setScreen('benchmark'); break
      case 1: setScreen('identity'); break
      case 2: setScreen('accountChoice'); break
      case 3: setScreen(data.accountType === 'existing' ? 'certificate' : 'network'); break
      case 4: setScreen('review'); break
    }
  }

  const requestClose = () => {
    if (confirm('Exit identity setup? Your progress will not be saved.')) onClose()
  }

  // Import an exported .vault backup as a new identity, then back to login
  const handleImportIdentity = async () => {
    setError('')
    try {
      const result = await window.nvelope.vault.importIdentity()
      if (result.canceled) return
      onClose()
    } catch (e) {
      setError('Import failed: ' + String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    }
  }

  // ----------------------------------------------------------------
  // Render helpers
  // ----------------------------------------------------------------

  const stepIndex = stepIndexForScreen(screen)

  const renderWelcome = () => (
    <div className="text-center space-y-5">
      <div className="inline-block border border-neutral-600 px-4 py-1 text-sm text-neutral-400">
        nVelope Client v0.1.0
      </div>
      <h1 className="text-2xl font-bold">Welcome to nVelope</h1>
      <p className="text-neutral-400 leading-relaxed">
        Self-sovereign email over the Internet.
      </p>
      <p className="text-sm text-neutral-400 leading-relaxed">
        We will guide you through the set up of your nVelope client Identity and Account creation.
        If you already have an Identity or Account to import, you will have the opportunity to do so later in the wizard.
      </p>
      <div className="flex gap-3 justify-center pt-2">
        <button
          onClick={onClose}
          className="rounded border border-neutral-600 px-6 py-2 text-sm hover:bg-neutral-700"
        >
          Close
        </button>
        <button
          onClick={() => {
            if (data.benchmarkHpm > 0) {
              setScreen('identity')
            } else {
              setScreen('benchmark')
            }
          }}
          className="rounded bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-500"
        >
          Next
        </button>
      </div>
      <button
        onClick={handleImportIdentity}
        className="text-sm text-blue-400 underline decoration-dotted hover:text-blue-300"
      >
        Import an identity from a backup (.vault)
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )

  const renderBenchmark = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold text-center">Proof-of-Work Benchmark</h2>
      <p className="text-sm text-neutral-400 leading-relaxed text-center">
        Before we begin setting up your Identity and Accounts, we need to quickly benchmark how fast your computer can process nVelope Mail.
        nVelope uses &quot;Proof-of-Work&quot; to disincentivize the sending of spam and other junk email.
      </p>
      <p className="text-sm text-neutral-400 leading-relaxed text-center">
        Other recipients on the network will also have their own processing safeguards as well. We will conduct a quick 10-second benchmark to help you decide on your processing policy and gauge how long it will take you to send to others.
      </p>

      {data.benchmarkHpm > 0 ? (
        <div className="rounded bg-neutral-800 p-4 text-center space-y-2">
          <p className="text-green-400 font-medium">Benchmark Complete</p>
          <p className="text-sm text-neutral-400">
            Your computer can process approximately{' '}
            <span className="font-mono text-neutral-200">{data.benchmarkHpm.toLocaleString()}</span> hashes per minute.
          </p>
          <NavButtons onNext={() => setScreen('identity')} />
        </div>
      ) : (
        <div className="space-y-3">
          {working && (
            <div className="py-2">
              <div className="mb-2 h-2 w-full rounded bg-neutral-700 overflow-hidden">
                <div className="h-full animate-pulse rounded bg-blue-500" style={{ width: '100%' }} />
              </div>
              <p className="text-center text-sm text-neutral-400">Running 10-second benchmark...</p>
            </div>
          )}
          <div className="flex justify-center">
            <button
              onClick={runBenchmark}
              disabled={working}
              className="rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {working ? 'Benchmarking...' : 'Start Benchmark'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  )

  const renderIdentity = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <div className="space-y-3">
        <p className="text-sm text-neutral-400 leading-relaxed">
          Your nVelope client identity is your local collection of accounts. All your preferences, messages, and secure private data will be stored here. If you have an identity file to import, select <strong>Import</strong> instead.
        </p>
        <p className="text-sm text-neutral-400">Start by giving your identity a unique name.</p>
        <p className="text-sm text-neutral-400">
          You will also need to provide a secret passphrase that should not be shared with anyone and stored in a secure place.
        </p>
        <p className="text-sm text-yellow-500">
          NOTE: If your passphrase is lost, you will not be able to access your identity.
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium">Name *</label>
          <input
            value={data.identityName}
            onChange={(e) => update('identityName', e.target.value)}
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Passphrase *</label>
          <input
            type="password"
            value={data.passphrase}
            onChange={(e) => update('passphrase', e.target.value)}
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <NavButtons
        onBack={() => setScreen('benchmark')}
        onNext={() => {
          if (!data.identityName.trim() || data.passphrase.length < 8) {
            setError('Name and passphrase (8+ chars) are required')
            return
          }
          setError('')
          setScreen('accountChoice')
        }}
      />
    </div>
  )

  const renderAccountChoice = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">Account Setup</h2>
      <p className="text-sm text-neutral-400 leading-relaxed">
        Now that we have an Identity in nVelope, let&apos;s add your first account.
      </p>
      <p className="text-sm text-neutral-400 leading-relaxed">
        If you have an existing account selected we will pull your profile data and get it set up for sending and receiving nVelope.
      </p>
      <p className="text-sm text-neutral-400 leading-relaxed">
        If this is an entirely new account you are creating, we&apos;ll walk you through the steps of creating your profile and nVelope policies.
      </p>

      <div className="space-y-2">
        <label className="flex items-center gap-3 rounded border border-neutral-700 bg-neutral-800 p-3 cursor-pointer hover:bg-neutral-750">
          <input
            type="radio"
            name="accountType"
            checked={data.accountType === 'existing'}
            onChange={() => update('accountType', 'existing')}
            className="h-4 w-4"
          />
          <span className="text-sm">I have an existing account</span>
        </label>
        <label className="flex items-center gap-3 rounded border border-neutral-700 bg-neutral-800 p-3 cursor-pointer hover:bg-neutral-750">
          <input
            type="radio"
            name="accountType"
            checked={data.accountType === 'new'}
            onChange={() => update('accountType', 'new')}
            className="h-4 w-4"
          />
          <span className="text-sm">I am creating an entirely new account</span>
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <NavButtons
        onBack={() => setScreen('identity')}
        onNext={() => {
          if (!data.accountType) {
            setError('Please select an option')
            return
          }
          setError('')
          if (data.accountType === 'existing') {
            setScreen('accountImport')
          } else {
            setScreen('accountProfile')
          }
        }}
      />
    </div>
  )

  const renderAccountImport = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">Import Existing Account</h2>
      <p className="text-sm text-neutral-400 leading-relaxed">
        Paste your account&apos;s secret key (nsec). We&apos;ll validate it, derive your public key, and try to pull your existing profile from your relays.
      </p>
      <p className="text-sm text-yellow-500">
        Your nsec stays inside this identity&apos;s encrypted vault — it is never sent anywhere except as required to sign your events.
      </p>

      <div className="space-y-2">
        <label className="mb-1 block text-sm font-medium">Secret key (nsec) *</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={importInput}
            onChange={(e) => { setImportInput(e.target.value); setImportPreview(null) }}
            placeholder="nsec1…"
            className="flex-1 rounded border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={validateImport}
            disabled={working || !importInput.trim()}
            className="rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700 disabled:opacity-50"
          >
            {working ? 'Checking…' : 'Validate'}
          </button>
        </div>
      </div>

      {importPreview && (
        <div className="rounded border border-green-800 bg-green-900/20 p-3 space-y-2">
          <p className="text-sm text-green-400">Valid key — account found:</p>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-purple-600 flex items-center justify-center text-xs text-white overflow-hidden flex-shrink-0">
              {importPreview.picture ? (
                <img src={importPreview.picture} alt="avatar" className="h-full w-full object-cover" />
              ) : (
                '?'
              )}
            </div>
            <div className="min-w-0 text-sm">
              <p className="text-neutral-200">{importPreview.name || '(no profile name found)'}</p>
              <p className="font-mono text-xs text-blue-400" title={npubEncode(importPreview.pubkey)}>
                {formatNpub(importPreview.pubkey)}
              </p>
              {importPreview.relaySource && (
                <p className="text-xs text-neutral-400 mt-1">
                  Relays: {importPreview.relayCount} found{' '}
                  {importPreview.relaySource === 'nip65'
                    ? 'from your NIP-65 relay list'
                    : importPreview.relaySource === 'kind3'
                      ? 'from your contact list (kind 3) — will be published as a NIP-65 list'
                      : '— none published; using defaults (will be published as a NIP-65 list)'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <NavButtons
        onBack={() => setScreen('accountChoice')}
        onNext={confirmImport}
        nextDisabled={!importPreview}
      />
    </div>
  )

  const renderAccountProfile = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">New Account Creation: Profile</h2>
      <p className="text-sm text-neutral-400">Let&apos;s get started with your Profile information.</p>
      <p className="text-xs text-neutral-500">Note: Images must be hosted from another location and cannot be uploaded.</p>

      <div className="flex gap-4 items-start">
        <div className="flex flex-col items-center gap-2">
          <div className="h-20 w-20 rounded-full bg-purple-600 flex items-center justify-center text-xs text-white overflow-hidden text-center leading-tight">
            {data.profile.imageUrl ? (
              <img src={data.profile.imageUrl} alt="avatar" className="h-full w-full object-cover" />
            ) : (
              <>Image<br />here</>
            )}
          </div>
        </div>
        <div className="flex-1 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Image URL</label>
            <input
              placeholder="https://..."
              value={data.profile.imageUrl}
              onChange={(e) => update('profile', { ...data.profile, imageUrl: e.target.value })}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Your nickname *</label>
            <input
              value={data.profile.nickname}
              onChange={(e) => update('profile', { ...data.profile, nickname: e.target.value })}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Something about you</label>
            <textarea
              value={data.profile.about}
              onChange={(e) => update('profile', { ...data.profile, about: e.target.value })}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              rows={3}
            />
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <NavButtons
        onBack={() => setScreen('accountChoice')}
        onNext={() => {
          if (!data.profile.nickname.trim()) {
            setError('Nickname is required')
            return
          }
          setError('')
          generateKeys()
        }}
        nextLabel={working ? 'Creating...' : 'Create Account'}
        nextDisabled={working}
      />
    </div>
  )

  const renderAccountCreated = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">New Account Creation: Profile</h2>
      <p className="text-sm text-neutral-300">
        Your new Account{' '}
        <span
          className="font-mono text-blue-400"
          title={data.pubkey ? npubEncode(data.pubkey) : ''}
        >
          {data.pubkey ? formatNpub(data.pubkey) : ''}
        </span>{' '}
        has been created!
      </p>
      <p className="text-sm text-yellow-500">
        Please download your Account secret key and store it somewhere safe. If lost, you may not be able to access your Account or send messages.
      </p>

      <div className="flex gap-4 items-start">
        <div className="h-20 w-20 rounded-full bg-purple-600 flex items-center justify-center text-xs text-white overflow-hidden flex-shrink-0 text-center leading-tight">
          {data.profile.imageUrl ? (
            <img src={data.profile.imageUrl} alt="avatar" className="h-full w-full object-cover" />
          ) : (
            <>Image<br />here</>
          )}
        </div>
        <div className="space-y-1 text-sm">
          <p>
            <span className="text-neutral-400">Nickname:</span>{' '}
            <span className="text-neutral-200">{data.profile.nickname}</span>
          </p>
          {data.profile.about && (
            <p>
              <span className="text-neutral-400">About:</span>{' '}
              <span className="text-neutral-200">{data.profile.about}</span>
            </p>
          )}
        </div>
      </div>

      <button
        onClick={saveNsec}
        className="rounded bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-500"
      >
        Save account secret key...
      </button>
      {nsecSaved && <p className="text-xs text-green-400">Secret key saved.</p>}

      <p className="text-sm text-neutral-400">
        Once you have saved your secret key, let&apos;s move on to setting up your nVelope policies.
      </p>

      <NavButtons
        onBack={() => setScreen('accountProfile')}
        onNext={handleAccountCreatedNext}
      />

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )

  const renderPolicies = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">nVelope Policies</h2>
      <p className="text-sm text-neutral-400">
        We will create a simple and optimized recipient policy for you to start. You will be able to customize it after we are all set up.
      </p>

      <div className="space-y-5">
        <div>
          <div className="flex justify-between text-sm mb-2">
            <span>Contacts (People I know)</span>
            <span className="text-neutral-400">{formatPolicyMinutes(data.policies.contactsMinutes)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={60}
            step={0.5}
            value={data.policies.contactsMinutes}
            onChange={(e) =>
              update('policies', { ...data.policies, contactsMinutes: parseFloat(e.target.value) })
            }
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-neutral-500 mt-1">
            <span>0 minutes</span>
            <span>60 minutes</span>
          </div>
        </div>

        <div>
          <div className="flex justify-between text-sm mb-2">
            <span>Non-Contacts (People I may not know)</span>
            <span className="text-neutral-400">{formatPolicyMinutes(data.policies.nonContactsMinutes)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={60}
            step={0.5}
            value={data.policies.nonContactsMinutes}
            onChange={(e) =>
              update('policies', { ...data.policies, nonContactsMinutes: parseFloat(e.target.value) })
            }
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-neutral-500 mt-1">
            <span>0 minutes</span>
            <span>60 minutes</span>
          </div>
        </div>
      </div>

      <p className="text-sm text-neutral-400">
        Once you set your recipient policy, let&apos;s go ahead and create your certificate.
      </p>

      <NavButtons
        onBack={() => setScreen(data.accountType === 'existing' ? 'accountImport' : 'accountCreated')}
        onNext={() => setScreen('certificate')}
      />
    </div>
  )

  const renderCertificate = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">Account Certificate</h2>
      <p className="text-sm text-neutral-400 leading-relaxed">
        You will need a nvelope certificate to allow others to send you mail. If you have a private key certificate generated elsewhere you want to import, you can do so now. Otherwise we can generate one for you.
      </p>
      <p className="text-sm text-yellow-500">
        Note: Your private key certificate MUST be kept safe at all times. nVelope will lock it in its vault and you should make a backup. If your private key certificate is lost you will no longer be able to read any new mail.
      </p>
      <p className="text-sm text-neutral-400">
        The larger the key length the more secure. Please note this will also be slower to process on some machines. We recommend 4096-bit.
      </p>

      <div className="space-y-2">
        {[2048, 4096].map((size) => (
          <label
            key={size}
            className="flex items-center gap-3 rounded border border-neutral-700 bg-neutral-800 p-3 cursor-pointer hover:bg-neutral-750"
          >
            <input
              type="radio"
              name="certSize"
              checked={data.cert.keySize === size}
              onChange={() => update('cert', { ...data.cert, keySize: size as 2048 | 4096 })}
              className="h-4 w-4"
            />
            <span className="text-sm">
              {size}-bit
              {size === 4096 && ' (Recommended)'}
              {size === 2048 && ' (Quicker, less secure)'}
            </span>
          </label>
        ))}
      </div>

      {data.cert.privateKeyPem && (
        <div className="rounded bg-green-900/20 border border-green-800 p-3 text-sm">
          <p className="text-green-400">Certificate generated successfully!</p>
        </div>
      )}

      {data.accountType === 'existing' && certChecked && publishedCert && (
        certMatchesPublished ? (
          <p className="rounded border border-green-800 bg-green-900/20 p-2 text-xs text-green-400">
            The imported private key matches the certificate published for this account — the existing certificate will be kept and nothing will be re-published.
          </p>
        ) : (
          <p className="rounded border border-amber-800 bg-amber-900/20 p-2 text-xs text-amber-300">
            A public key certificate is already published for this account. Import the matching private key (.pem) to keep using it, or generate/import a new key to overwrite the published certificate.
          </p>
        )
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={generateCert}
          disabled={working}
          className="flex-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {working ? 'Generating...' : 'Generate Certificate'}
        </button>
        <button
          onClick={importCert}
          className="flex-1 rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700"
        >
          Import Key...
        </button>
      </div>

      <NavButtons
        onBack={() => setScreen(data.accountType === 'existing' ? 'accountImport' : 'policies')}
        onNext={() => {
          if (!data.cert.privateKeyPem) {
            setError('Please generate or import a certificate first')
            return
          }
          setError('')
          // Imported accounts already have relays (resolved during import) —
          // the relay editor only applies to brand-new accounts.
          setScreen(data.accountType === 'existing' ? 'review' : 'network')
        }}
        nextDisabled={!data.cert.privateKeyPem}
      />
    </div>
  )

  const renderNetwork = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">Network</h2>
      <p className="text-sm text-neutral-400 leading-relaxed">
        nVelope operates over what is known as Nostr or &quot;The Nostr Network&quot;. It is a series of independently owned servers used for everything from sending nVelope Mail to Social media.
      </p>
      <p className="text-sm text-neutral-400">
        To help get you started we provided you with some defaults that should be fine to use. If you are familiar with Nostr or have other relay servers you want to add you can adjust here.
      </p>

      <div className="rounded border border-neutral-700 bg-neutral-800 p-3">
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {data.relays.map((relay, i) => (
            <div key={i} className="flex items-center justify-between text-sm py-1">
              <span className="font-mono text-blue-400">{relay}</span>
              <button
                onClick={() => update('relays', data.relays.filter((_, idx) => idx !== i))}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => {
            const url = prompt('Enter relay URL (wss://...)')
            if (url && url.startsWith('wss://')) {
              update('relays', [...data.relays, url])
            } else if (url) {
              setError('Relay URL must start with wss://')
            }
          }}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
        >
          Add
        </button>
        <button
          onClick={() => update('relays', [...DEFAULT_RELAYS])}
          className="rounded border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-700"
        >
          Reset to Defaults
        </button>
      </div>

      <p className="text-sm text-neutral-400">Click next to review all your information.</p>

      <NavButtons
        onBack={() => setScreen('certificate')}
        onNext={() => setScreen('review')}
      />

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )

  const renderReview = () => (
    <div className="space-y-5">
      <StepIndicator currentStep={stepIndex} onStepClick={handleStepClick} />
      <h2 className="text-xl font-semibold">Review</h2>
      <p className="text-sm text-neutral-400">
        Please review all information about your Identity, Accounts, and Network. If anything needs to be adjusted go back to the associated section.
      </p>

      <div className="rounded border border-neutral-700 bg-neutral-800 p-4 space-y-3 text-sm">
        <div>
          <span className="text-neutral-400">Identity Name:</span>{' '}
          <span className="text-neutral-200">{data.identityName}</span>
        </div>
        <div>
          <span className="text-neutral-400">Account:</span>{' '}
          <span
            className="font-mono text-neutral-200"
            title={data.pubkey ? npubEncode(data.pubkey) : ''}
          >
            {data.pubkey ? formatNpub(data.pubkey) : ''}
          </span>
        </div>
        <div>
          <span className="text-neutral-400">Nickname:</span>{' '}
          <span className="text-neutral-200">{data.profile.nickname}</span>
        </div>
        <div>
          <span className="text-neutral-400">Certificate:</span>{' '}
          <span className="text-neutral-200">{data.cert.keySize}-bit</span>
        </div>
        {data.accountType !== 'existing' && (
          <>
            <div>
              <span className="text-neutral-400">Contact Policy:</span>{' '}
              <span className="text-neutral-200">{formatPolicyMinutes(data.policies.contactsMinutes)}</span>
            </div>
            <div>
              <span className="text-neutral-400">Non-Contact Policy:</span>{' '}
              <span className="text-neutral-200">{formatPolicyMinutes(data.policies.nonContactsMinutes)}</span>
            </div>
          </>
        )}
        <div>
          <span className="text-neutral-400">Relays:</span>{' '}
          <span className="text-neutral-200">
            {data.relays.length} configured
            {data.accountType === 'existing' && data.relaySource && (
              <span className="text-neutral-500">
                {' '}({data.relaySource === 'nip65' ? 'from NIP-65 relay list' : data.relaySource === 'kind3' ? 'from kind 3 contact list' : 'defaults'})
              </span>
            )}
          </span>
        </div>
        <div>
          <span className="text-neutral-400">Benchmark:</span>{' '}
          <span className="text-neutral-200">{data.benchmarkHpm.toLocaleString()} hashes/min</span>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <NavButtons
        onBack={() => setScreen(data.accountType === 'existing' ? 'certificate' : 'network')}
        onNext={finish}
        nextLabel={working ? 'Saving...' : 'Save and Publish'}
        nextDisabled={working}
      />
    </div>
  )

  // ----------------------------------------------------------------
  // Main render
  // ----------------------------------------------------------------

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-900 px-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-700 bg-neutral-800 p-6 shadow-xl">
        {screen !== 'welcome' && (
          <div className="-mt-2 -mr-2 mb-1 flex justify-end">
            <button
              onClick={requestClose}
              title="Cancel setup"
              className="rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-300 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        {screen === 'welcome' && renderWelcome()}
        {screen === 'benchmark' && renderBenchmark()}
        {screen === 'identity' && renderIdentity()}
        {screen === 'accountChoice' && renderAccountChoice()}
        {screen === 'accountImport' && renderAccountImport()}
        {screen === 'accountProfile' && renderAccountProfile()}
        {screen === 'accountCreated' && renderAccountCreated()}
        {screen === 'policies' && renderPolicies()}
        {screen === 'certificate' && renderCertificate()}
        {screen === 'network' && renderNetwork()}
        {screen === 'review' && renderReview()}
      </div>
    </div>
  )
}
