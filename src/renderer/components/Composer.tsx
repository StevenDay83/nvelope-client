import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { npubEncode } from 'nostr-tools/nip19'
import MailBody from './MailBody'
import ExternalReferenceList from './ExternalReferenceList'
import RecipientChipsInput, {
  chipFromContact,
  parseChips,
  serializeChips,
  type RecipientChip,
} from './RecipientChipsInput'
import { chipLabelForContact } from '../lib/identityLabel'
import type { ContactRecord } from '../../preload'

// Attachments are external http(s) links (SPEC §3.1 external_references) —
// Nostr events can't carry significant binary data.
const MAX_ATTACHMENT_LINKS = 10

interface Props {
  identityId: string
  accountId: string
  accountDisplayName?: string
  accountNpub?: string
  initialRecipient?: string
  initialSubject?: string
  initialBody?: string
  initialFormat?: 'plaintext' | 'markdown' | 'html'
  initialThreadId?: string
  initialDraftId?: string
  windowMode?: boolean
  onClose: () => void
  onSent: () => void
}

export default function Composer({
  identityId,
  accountId,
  accountDisplayName,
  accountNpub,
  initialRecipient = '',
  initialSubject = '',
  initialBody = '',
  initialFormat = 'plaintext',
  initialThreadId,
  initialDraftId,
  onClose,
  onSent,
}: Props) {
  const [chips, setChips] = useState<RecipientChip[]>(() => parseChips(initialRecipient))
  const [pendingTo, setPendingTo] = useState('')
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)
  const [format, setFormat] = useState<'plaintext' | 'markdown' | 'html'>(initialFormat)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [contacts, setContacts] = useState<ContactRecord[]>([])
  const [links, setLinks] = useState<string[]>([])
  const [linkInput, setLinkInput] = useState('')
  const [showLinkInput, setShowLinkInput] = useState(false)
  const [blossomHost, setBlossomHost] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null)
  const [showAddressBook, setShowAddressBook] = useState(false)

  const addLink = useCallback(() => {
    const candidate = linkInput.trim()
    if (!candidate) return
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
      const url = parsed.toString()
      setLinks((prev) => {
        if (prev.includes(url) || prev.length >= MAX_ATTACHMENT_LINKS) return prev
        return [...prev, url]
      })
      setLinkInput('')
      setError('')
    } catch {
      setError('Attachments must be valid http(s) links')
    }
  }, [linkInput])

  // Blossom upload target comes from Settings → Media & Upload (per identity)
  useEffect(() => {
    if (!identityId) return
    window.nvelope.vault.getSettings(identityId).then((settings) => {
      const bp = ((settings.preferences ?? {}) as Record<string, unknown>).blossom as
        | { enabled?: boolean; selectedHost?: string }
        | undefined
      setBlossomHost(bp?.enabled && bp.selectedHost ? bp.selectedHost : null)
    }).catch((e) => console.error('[composer] failed to load blossom settings:', e))
  }, [identityId])

  const handleUpload = async () => {
    if (!blossomHost || uploading) return
    setUploading(true)
    setError('')
    try {
      const result = await window.nvelope.blossom.upload(identityId, accountId, blossomHost)
      if (result.canceled || !result.url) return
      // Uploaded URL lands in the text box — the user presses Add to attach it
      setLinkInput(result.url)
    } catch (e) {
      setError('Upload failed: ' + String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    } finally {
      setUploading(false)
    }
  }

  const loadContacts = useCallback(async () => {
    if (!identityId || !accountId) return
    try {
      const list = (await window.nvelope.db.contactsGetAll(identityId, accountId)) as ContactRecord[]
      setContacts(list)
    } catch (e) {
      console.error('[composer] failed to load contacts:', e)
    }
  }, [identityId, accountId])

  useEffect(() => {
    loadContacts()
    const unsub = window.nvelope.contacts.onChanged((change) => {
      if (change.identityId === identityId && change.accountId === accountId) loadContacts()
    })
    return unsub
  }, [loadContacts, identityId, accountId])

  // Recipients are chips; drafts persist them as the legacy ';'-joined string
  // (npub where resolved, raw input otherwise).
  const recipientString = useMemo(() => serializeChips(chips, pendingTo), [chips, pendingTo])

  // Pubkeys currently chipped (address book checkbox state)
  const chipPubkeys = useMemo(
    () => new Set(chips.map((c) => c.pubkey).filter(Boolean)),
    [chips],
  )

  const toggleRecipient = (contact: ContactRecord) => {
    if (!contact.isNostrMailEnabled) return
    if (chipPubkeys.has(contact.pubkey)) {
      setChips((prev) => prev.filter((c) => c.pubkey !== contact.pubkey))
    } else {
      setChips((prev) => [...prev, chipFromContact(contact)])
    }
  }

  const fromNpub = useMemo(() => {
    if (accountNpub) return accountNpub
    try {
      return npubEncode(accountId)
    } catch {
      return ''
    }
  }, [accountNpub, accountId])
  const fromLabel = accountDisplayName && fromNpub
    ? `${accountDisplayName} <${fromNpub}>`
    : fromNpub || accountId.slice(0, 20) + '...'

  // Autosave draft every 10s
  useEffect(() => {
    const timer = setInterval(async () => {
      if (!recipientString && !subject && !body) return
      try {
        const result = await window.nvelope.send.saveDraft(identityId, accountId, draftId, {
          recipientNpub: recipientString || undefined,
          subject: subject || undefined,
          body: body || undefined,
          format,
          threadId: initialThreadId,
        })
        if (result.draftId !== draftId) setDraftId(result.draftId)
      } catch (e) {
        console.error('Autosave failed:', e)
      }
    }, 10000)
    return () => clearInterval(timer)
  }, [recipientString, subject, body, format, identityId, accountId, draftId, initialThreadId])

  const insertFormat = useCallback((before: string, after: string) => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const text = el.value
    const selected = text.slice(start, end)
    const newText = text.slice(0, start) + before + selected + after + text.slice(end)
    setBody(newText)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + before.length, end + before.length)
    })
  }, [])

  const handleSend = async () => {
    const pending = pendingTo.trim()
    if (chips.length === 0 && !pending) {
      setError('Please add at least one recipient (contact, npub, or user@domain)')
      return
    }
    if (pending) {
      setError(`Press Enter or ; to add "${pending}" as a recipient first`)
      return
    }
    if (!subject.trim() && !body.trim()) {
      setError('Please enter a subject or body')
      return
    }
    const resolving = chips.filter((c) => c.status === 'resolving')
    if (resolving.length > 0) {
      setError('Still resolving recipients — please wait a moment')
      return
    }
    const invalid = chips.filter((c) => c.status === 'invalid')
    if (invalid.length > 0) {
      setError(
        `Cannot send to: ${invalid.map((c) => `${c.label} (${c.invalidReason ?? 'invalid recipient'})`).join(', ')}`,
      )
      return
    }
    setSending(true)
    setError('')
    try {
      const resolved: string[] = []
      for (const chip of chips) {
        if (chip.npub && !resolved.includes(chip.npub)) resolved.push(chip.npub)
      }
      setProgress('Queueing…')
      await window.nvelope.send.queue(identityId, accountId, {
        recipients: resolved,
        subject: subject.trim(),
        body: body.trim(),
        format,
        links: links.length > 0 ? links : undefined,
        threadId: initialThreadId,
      })
      if (draftId) {
        try {
          await window.nvelope.db.mailDelete(identityId, draftId)
        } catch (e) {
          console.error('Draft cleanup failed:', e)
        }
      }
      setProgress('Queued for sending — see Outbox')
      setTimeout(() => {
        onSent()
      }, 800)
    } catch (e) {
      setError('Send failed: ' + String(e))
      setSending(false)
      setProgress('')
    }
  }

  const handleSaveDraft = async () => {
    try {
      const result = await window.nvelope.send.saveDraft(identityId, accountId, draftId, {
        recipientNpub: recipientString || undefined,
        subject: subject || undefined,
        body: body || undefined,
        format,
        threadId: initialThreadId,
      })
      if (result.draftId !== draftId) setDraftId(result.draftId)
      setProgress('Draft saved')
      setTimeout(() => setProgress(''), 2000)
    } catch (e) {
      setError('Draft save failed: ' + String(e))
    }
  }

  // Close keeps any content as a draft (autosave-on-close), then closes.
  const handleClose = async () => {
    if (recipientString || subject || body) {
      try {
        const result = await window.nvelope.send.saveDraft(identityId, accountId, draftId, {
          recipientNpub: recipientString || undefined,
          subject: subject || undefined,
          body: body || undefined,
          format,
          threadId: initialThreadId,
        })
        if (result.draftId !== draftId) setDraftId(result.draftId)
      } catch { /* closing anyway */ }
    }
    onClose()
  }

  // Discard removes the autosaved draft outright (never the Deleted folder).
  // With nothing saved yet it just closes the window.
  const handleDiscard = async () => {
    if (!draftId) {
      onClose()
      return
    }
    if (!confirm('Are you sure you want to delete this draft?')) return
    try {
      await window.nvelope.db.mailDelete(identityId, draftId)
    } catch { /* already gone */ }
    onClose()
  }

  const isMarkdown = format === 'markdown'

  // Preview mode renders the body through the same pipeline the reader uses
  // (markdown renderer / sanitized-HTML iframe / plaintext line breaks).
  const [showPreview, setShowPreview] = useState(false)
  const previewMessageData = useMemo(
    () => JSON.stringify({ bodyText: body, messageType: 0, formats: { [format]: body } }),
    [body, format],
  )

  return (
    <div className="flex h-full flex-col">
      {/* Title bar / toolbar */}
      <div className="flex items-center justify-between border-b border-neutral-700 bg-neutral-800 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleSend}
            disabled={sending}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            Send
          </button>
          <button
            onClick={handleSaveDraft}
            disabled={sending}
            className="flex items-center gap-1 rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1.5 text-sm hover:bg-neutral-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            Save
          </button>
          <button
            onClick={handleDiscard}
            disabled={sending}
            title={draftId ? 'Discard this draft permanently' : 'Discard and close'}
            className="flex items-center gap-1 rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1.5 text-sm hover:bg-neutral-700 hover:text-red-300 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Discard
          </button>
          <button
            onClick={() => setShowLinkInput((v) => !v)}
            disabled={sending}
            title="Attach a link"
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
              showLinkInput || links.length > 0
                ? 'border-blue-600 bg-blue-600/10 text-blue-300'
                : 'border-neutral-600 bg-neutral-800 hover:bg-neutral-700'
            } disabled:opacity-50`}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            Attach
          </button>
          <button
            onClick={handleClose}
            className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1.5 text-sm hover:bg-neutral-700 transition-colors"
          >
            Close
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-neutral-600 text-xs">
            <button
              onClick={() => setShowPreview(false)}
              className={`px-2.5 py-1.5 transition-colors ${!showPreview ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              Write
            </button>
            <button
              onClick={() => setShowPreview(true)}
              className={`px-2.5 py-1.5 transition-colors ${showPreview ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              Preview
            </button>
          </div>
          {progress && (
            <span className="text-sm text-neutral-400">{progress}</span>
          )}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as 'plaintext' | 'markdown' | 'html')}
            className="rounded-md border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm outline-none focus:border-blue-500"
          >
            <option value="plaintext">Plain Text</option>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
          </select>
        </div>
      </div>

      {/* Header fields */}
      <div className="border-b border-neutral-700 bg-neutral-900">
        {/* From */}
        <div className="flex items-center border-b border-neutral-800 px-3">
          <label className="w-16 shrink-0 text-sm text-neutral-500">From</label>
          <div className="flex-1 py-2 text-sm text-neutral-300">{fromLabel}</div>
        </div>
        {/* To */}
        <div className="relative flex items-start border-b border-neutral-800 px-3">
          <label className="w-16 shrink-0 py-2.5 text-sm text-neutral-500">To</label>
          <RecipientChipsInput
            identityId={identityId}
            accountId={accountId}
            contacts={contacts}
            chips={chips}
            onChipsChange={setChips}
            pendingText={pendingTo}
            onPendingTextChange={setPendingTo}
          />
          <button
            type="button"
            onClick={() => setShowAddressBook((v) => !v)}
            title="Pick recipients from address book"
            className={`ml-2 mt-2 shrink-0 rounded p-1 transition-colors ${showAddressBook ? 'text-blue-300 bg-neutral-700' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </button>
          {showAddressBook && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAddressBook(false)} />
              <div className="absolute left-16 right-0 top-full z-20 max-h-64 overflow-y-auto rounded-b-md border border-neutral-700 bg-neutral-800 shadow-xl">
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  Address book — mail-enabled contacts
                </div>
                {contacts.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-neutral-500">No contacts yet</div>
                ) : (
                  contacts.map((c) => {
                    const npub = npubEncode(c.pubkey)
                    const checked = chipPubkeys.has(c.pubkey)
                    return (
                      <button
                        key={c.pubkey}
                        onClick={() => toggleRecipient(c)}
                        disabled={!c.isNostrMailEnabled}
                        title={c.isNostrMailEnabled ? undefined : 'No mail certificate published — cannot receive mail'}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                          c.isNostrMailEnabled ? 'text-neutral-200 hover:bg-neutral-700' : 'cursor-not-allowed opacity-40 text-neutral-500'
                        }`}
                      >
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-blue-500 bg-blue-600' : 'border-neutral-600'}`}>
                          {checked && (
                            <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                        <span className="font-medium truncate">{chipLabelForContact(c)}</span>
                        <span className="text-xs text-neutral-500 truncate">{npub.slice(0, 20)}…</span>
                        {!c.isNostrMailEnabled && (
                          <span className="ml-auto shrink-0 text-[10px] text-neutral-600">no mail cert</span>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </>
          )}
        </div>
        {/* Subject */}
        <div className="flex items-center px-3">
          <label className="w-16 shrink-0 text-sm text-neutral-500">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 bg-transparent py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none"
          />
        </div>
      </div>

      {/* Attachments: external links (SPEC §3.1 external_references) */}
      {(showLinkInput || links.length > 0) && (
        <div className="border-b border-neutral-700 bg-neutral-900 px-3 py-2">
          {showLinkInput && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink() } }}
                placeholder="https://example.com/file.png"
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-blue-500"
              />
              <button
                onClick={addLink}
                disabled={links.length >= MAX_ATTACHMENT_LINKS}
                className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
              >
                Add
              </button>
              {blossomHost && (
                <button
                  onClick={handleUpload}
                  disabled={uploading || links.length >= MAX_ATTACHMENT_LINKS}
                  title={`Upload a file to ${blossomHost}`}
                  className="rounded-md border border-neutral-600 bg-neutral-800 px-2.5 py-1 text-sm hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                >
                  {uploading ? 'Uploading…' : 'Upload…'}
                </button>
              )}
            </div>
          )}
          {links.length > 0 && (
            <div className={`flex flex-wrap items-center gap-2 ${showLinkInput ? 'mt-2' : ''}`}>
              {links.map((link) => (
                <span key={link} className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
                  <svg className="h-3.5 w-3.5 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  <span className="max-w-64 truncate">{link}</span>
                  <button
                    onClick={() => setLinks((prev) => prev.filter((l) => l !== link))}
                    title="Remove link"
                    className="ml-0.5 text-neutral-500 hover:text-red-400 transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
              <span className="text-xs text-neutral-500">{links.length} / {MAX_ATTACHMENT_LINKS}</span>
            </div>
          )}
        </div>
      )}

      {/* Formatting toolbar (markdown / html) — write mode only */}
      {isMarkdown && !showPreview && (
        <div className="flex items-center gap-1 border-b border-neutral-700 bg-neutral-800 px-3 py-1.5">
          <ToolbarButton onClick={() => insertFormat('**', '**')} title="Bold">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6V4zm0 8h9a4 4 0 014 4 4 4 0 01-4 4H6v-8z" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('*', '*')} title="Italic">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l-4 16" /></svg>
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-neutral-600" />
          <ToolbarButton onClick={() => insertFormat('# ', '')} title="Heading">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('> ', '')} title="Quote">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('```\n', '\n```')} title="Code block">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-neutral-600" />
          <ToolbarButton onClick={() => insertFormat('- ', '')} title="Bullet list">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('1. ', '')} title="Numbered list">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-neutral-600" />
          <ToolbarButton onClick={() => insertFormat('[', '](url)')} title="Link">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
          </ToolbarButton>
        </div>
      )}
      {format === 'html' && !showPreview && (
        <div className="flex items-center gap-1 border-b border-neutral-700 bg-neutral-800 px-3 py-1.5">
          <ToolbarButton onClick={() => insertFormat('<strong>', '</strong>')} title="Bold">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6V4zm0 8h9a4 4 0 014 4 4 4 0 01-4 4H6v-8z" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('<em>', '</em>')} title="Italic">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l-4 16" /></svg>
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-neutral-600" />
          <ToolbarButton onClick={() => insertFormat('<h2>', '</h2>')} title="Heading">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('<blockquote>', '</blockquote>')} title="Quote">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('<pre><code>', '</code></pre>')} title="Code block">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-neutral-600" />
          <ToolbarButton onClick={() => insertFormat('<ul>\n  <li>', '</li>\n</ul>')} title="Bullet list">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('<ol>\n  <li>', '</li>\n</ol>')} title="Numbered list">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-neutral-600" />
          <ToolbarButton onClick={() => insertFormat('<a href="https://">', '</a>')} title="Link">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
          </ToolbarButton>
          <ToolbarButton onClick={() => insertFormat('<p>', '</p>')} title="Paragraph">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10" /></svg>
          </ToolbarButton>
        </div>
      )}

      {/* Body — write or rendered preview */}
      <div className="flex-1 overflow-hidden">
        {showPreview ? (
          <div className="h-full overflow-y-auto bg-neutral-900 p-4">
            {body || links.length > 0 ? (
              <>
                <MailBody mail={{ messageData: previewMessageData }} />
                <ExternalReferenceList references={links.map((link) => ['http', link])} />
              </>
            ) : (
              <span className="text-sm text-neutral-600">Nothing to preview yet</span>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={format === 'html' ? '<p>Enter HTML here…</p>' : 'Write your message here…'}
            className="h-full w-full resize-none bg-neutral-900 p-4 text-sm text-neutral-100 placeholder-neutral-600 outline-none"
            spellCheck
          />
        )}
      </div>

      {/* Footer status */}
      {error && (
        <div className="border-t border-red-800/30 bg-red-900/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}

function ToolbarButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
    >
      {children}
    </button>
  )
}
