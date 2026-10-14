import { useState, useEffect, useCallback, useMemo } from 'react'
import { npubEncode } from 'nostr-tools/nip19'
import { renderMarkdown } from '../lib/markdown'
import SettingsPanel from './SettingsPanel'
import type { ContactRecord } from '../../preload'

interface FolderRecord {
  id: number
  accountId: string
  name: string
  type: 'inbox' | 'sent' | 'outbox' | 'drafts' | 'junk' | 'user'
  sortOrder: number
  createdAt: number
}

interface MailRecord {
  innerEventId: string
  accountId: string
  folderId?: number | null
  state: string
  senderPubkey: string
  recipientPubkey?: string | null
  subject?: string | null
  threadId?: string | null
  isBroadcast: number
  createdAt: number
  read: number
  marked: number
  messageData: string
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

interface Props {
  identityId: string
  accounts: AccountData[]
  onLock: () => void
  identityName: string
  onIdentityRenamed?: (name: string) => void
  onSettingsClosed?: () => void
}

function formatNpub(pubkeyHex: string): string {
  const npub = npubEncode(pubkeyHex)
  if (npub.length <= 28) return npub
  return npub.slice(0, 15) + '...' + npub.slice(-10)
}

function getInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday'
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatDateFull(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function InboxView({ identityId, accounts, onLock, identityName, onIdentityRenamed, onSettingsClosed }: Props) {
  const [selectedAccount, setSelectedAccount] = useState(accounts[0]?.pubkey ?? '')
  const [folders, setFolders] = useState<FolderRecord[]>([])
  const [selectedFolder, setSelectedFolder] = useState<number | null>(null)
  const [mails, setMails] = useState<MailRecord[]>([])
  const [selectedMail, setSelectedMail] = useState<MailRecord | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string>('')
  const [newMailCount, setNewMailCount] = useState(0)
  const [sendStatus] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [folderUnreadCounts, setFolderUnreadCounts] = useState<Record<number, number>>({})
  const [showSettings, setShowSettings] = useState(false)
  const [contactsByPubkey, setContactsByPubkey] = useState<Record<string, ContactRecord>>({})

  const loadContacts = useCallback(async () => {
    if (!selectedAccount) return
    try {
      const list = (await window.nvelope.db.contactsGetAll(identityId, selectedAccount)) as ContactRecord[]
      const map: Record<string, ContactRecord> = {}
      for (const c of list) map[c.pubkey] = c
      setContactsByPubkey(map)
    } catch (e) {
      console.error('[inbox] failed to load contacts:', e)
    }
  }, [identityId, selectedAccount])

  useEffect(() => {
    loadContacts()
  }, [loadContacts])

  useEffect(() => {
    const unsub = window.nvelope.contacts.onChanged((change) => {
      if (change.identityId === identityId) loadContacts()
    })
    return unsub
  }, [identityId, loadContacts])

  const loadFolders = useCallback(async () => {
    if (!selectedAccount) return
    const list = (await window.nvelope.db.foldersGet(identityId, selectedAccount)) as FolderRecord[]
    setFolders(list)
    if (list.length > 0 && selectedFolder === null) {
      const inbox = list.find((f) => f.type === 'inbox')
      setSelectedFolder(inbox?.id ?? list[0]!.id)
    }
    // Load unread counts for each folder
    const counts: Record<number, number> = {}
    for (const folder of list) {
      counts[folder.id] = await window.nvelope.db.mailCountUnread(identityId, selectedAccount, folder.id)
    }
    setFolderUnreadCounts(counts)
  }, [identityId, selectedAccount, selectedFolder])

  const loadMails = useCallback(async () => {
    if (!selectedAccount || selectedFolder === null) return
    const list = (await window.nvelope.db.mailGetByFolder(identityId, selectedAccount, selectedFolder)) as MailRecord[]
    setMails(list)
  }, [identityId, selectedAccount, selectedFolder])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  useEffect(() => {
    loadMails()
  }, [loadMails])

  // Listen for new mail notifications from main process
  useEffect(() => {
    const unsubscribe = window.nvelope.mail.onNewMail((data) => {
      if (data.identityId === identityId) {
        setNewMailCount((c) => c + data.directCount + data.broadcastCount)
        setScanResult(`+${data.directCount + data.broadcastCount} new messages`)
        loadMails()
        loadFolders()
        setTimeout(() => setScanResult(''), 5000)
      }
    })
    return unsubscribe
  }, [identityId, loadMails, loadFolders])

  const handleScan = async () => {
    setScanning(true)
    setScanResult('')
    try {
      const result = await window.nvelope.relay.manualScan(identityId)
      const total = result.direct + result.broadcast
      if (total > 0) {
        setScanResult(`Found ${total} new message${total > 1 ? 's' : ''}`)
        loadMails()
        loadFolders()
      } else {
        setScanResult('No new messages')
      }
    } catch (e) {
      setScanResult('Scan failed: ' + String(e))
    } finally {
      setScanning(false)
      setTimeout(() => setScanResult(''), 5000)
    }
  }

  const handleMarkRead = async (mail: MailRecord, read: boolean) => {
    await window.nvelope.db.mailMarkRead(identityId, mail.innerEventId, read)
    loadMails()
    loadFolders()
    if (selectedMail?.innerEventId === mail.innerEventId) {
      setSelectedMail({ ...selectedMail, read: read ? 1 : 0 })
    }
  }

  const handleDelete = async (mail: MailRecord) => {
    if (!confirm('Move this message to trash?')) return
    await window.nvelope.db.mailSoftDelete(identityId, mail.innerEventId)
    loadMails()
    loadFolders()
    if (selectedMail?.innerEventId === mail.innerEventId) {
      setSelectedMail(null)
    }
  }

  const handleToggleMarked = async (mail: MailRecord) => {
    await window.nvelope.db.mailToggleMarked(identityId, mail.innerEventId)
    loadMails()
    if (selectedMail?.innerEventId === mail.innerEventId) {
      setSelectedMail({ ...selectedMail, marked: selectedMail.marked ? 0 : 1 })
    }
  }

  const handleSpam = async (mail: MailRecord) => {
    const junkFolder = folders.find((f) => f.type === 'junk')
    if (!junkFolder) {
      alert('No Junk folder found')
      return
    }
    await window.nvelope.db.mailMoveToFolder(identityId, mail.innerEventId, junkFolder.id)
    loadMails()
    loadFolders()
    if (selectedMail?.innerEventId === mail.innerEventId) {
      setSelectedMail(null)
    }
  }

  const handleReply = (mail: MailRecord) => {
    const acct = accounts.find((a) => a.pubkey === selectedAccount)
    const replySubject = mail.subject?.startsWith('Re:') ? mail.subject : `Re: ${mail.subject || '(no subject)'}`
    let replyBody = ''
    try {
      const data = JSON.parse(mail.messageData)
      const originalBody = data.bodyText || ''
      replyBody = `\n\n--- On ${formatDateFull(mail.createdAt)}, ${getSenderDisplay(mail)} wrote ---\n${originalBody}`
    } catch {
      replyBody = '\n\n--- Original message ---\n'
    }
    window.nvelope.compose.open({
      identityId,
      accountId: selectedAccount,
      accountDisplayName: acct?.displayName || undefined,
      accountNpub: acct ? npubEncode(acct.pubkey) : undefined,
      recipientNpub: npubEncode(mail.senderPubkey),
      subject: replySubject,
      body: replyBody,
      format: 'plaintext',
    })
  }

  const handleForward = (mail: MailRecord) => {
    const acct = accounts.find((a) => a.pubkey === selectedAccount)
    const fwdSubject = mail.subject?.startsWith('Fwd:') ? mail.subject : `Fwd: ${mail.subject || '(no subject)'}`
    let fwdBody = ''
    try {
      const data = JSON.parse(mail.messageData)
      const originalBody = data.bodyText || ''
      fwdBody = `\n\n--- Forwarded message ---\nFrom: ${getSenderDisplay(mail)}\nSubject: ${mail.subject || '(no subject)'}\nDate: ${formatDateFull(mail.createdAt)}\n\n${originalBody}`
    } catch {
      fwdBody = '\n\n--- Forwarded message ---\n'
    }
    window.nvelope.compose.open({
      identityId,
      accountId: selectedAccount,
      accountDisplayName: acct?.displayName || undefined,
      accountNpub: acct ? npubEncode(acct.pubkey) : undefined,
      subject: fwdSubject,
      body: fwdBody,
      format: 'plaintext',
    })
  }

  const handleSelectMail = async (mail: MailRecord) => {
    setSelectedMail(mail)
    if (!mail.read) {
      await window.nvelope.db.mailMarkRead(identityId, mail.innerEventId, true)
      loadMails()
      loadFolders()
    }
  }

  const mailHasAttachments = (mail: MailRecord): boolean => {
    try {
      return !!JSON.parse(mail.messageData).hasAttachments
    } catch {
      return false
    }
  }

  const getExternalReferences = (mail: MailRecord): string[][] => {
    try {
      const refs = JSON.parse(mail.messageData).externalReferences
      if (!Array.isArray(refs)) return []
      // Wire shape (SPEC §3.1): [["<type>", "<value>", ...], ...] — http links only here
      return refs.filter(
        (r): r is string[] => Array.isArray(r) && r[0] === 'http' && typeof r[1] === 'string' && /^https?:\/\//.test(r[1]),
      )
    } catch {
      return []
    }
  }

  const handleSearch = async (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      setIsSearching(false)
      loadMails()
      return
    }
    setIsSearching(true)
    try {
      const results = (await window.nvelope.db.mailSearch(identityId, selectedAccount, query.trim())) as MailRecord[]
      setMails(results)
    } catch (e) {
      console.error('Search failed:', e)
    }
  }

  const getSenderDisplay = (mail: MailRecord): string => {
    if (mail.senderPubkey === 'nvelope') return 'nVelope'
    const contact = contactsByPubkey[mail.senderPubkey]
    if (contact) return contact.displayName || contact.nip05 || formatNpub(mail.senderPubkey)
    return formatNpub(mail.senderPubkey)
  }

  const handleAddSenderToContacts = (mail: MailRecord) => {
    const acct = accounts.find((a) => a.pubkey === selectedAccount)
    window.nvelope.contactsWindow.open({
      identityId,
      accountId: selectedAccount,
      accountDisplayName: acct?.displayName || undefined,
      prefillPubkey: mail.senderPubkey,
    })
  }

  const getMailBodyHtml = (mail: MailRecord): string => {
    try {
      const data = JSON.parse(mail.messageData)
      if (data.bodyText) {
        // Detect if it's HTML
        if (data.formats?.includes('html') || data.messageType?.html) {
          return data.bodyText
        }
        // Render markdown
        return renderMarkdown(data.bodyText)
      }
      const mt = data.messageType ?? {}
      if (mt.md) return renderMarkdown(atob(mt.md))
      if (mt.plaintext) return renderMarkdown(atob(mt.plaintext))
      if (mt.html) return atob(mt.html)
      if (data.formats?.markdown) return renderMarkdown(data.formats.markdown)
      if (data.formats?.plaintext) return renderMarkdown(data.formats.plaintext)
      return renderMarkdown(mail.messageData)
    } catch {
      return renderMarkdown(mail.messageData)
    }
  }

  const getMailPreview = (mail: MailRecord): string => {
    try {
      const data = JSON.parse(mail.messageData)
      const text = data.bodyText || data.formats?.plaintext || data.formats?.markdown || ''
      return text.slice(0, 120).replace(/\n/g, ' ')
    } catch {
      return ''
    }
  }

  // Group mails by thread
  const threadGroups = useMemo(() => {
    const groups = new Map<string, MailRecord[]>()
    for (const mail of mails) {
      const tid = mail.threadId || mail.innerEventId
      if (!groups.has(tid)) groups.set(tid, [])
      groups.get(tid)!.push(mail)
    }
    // Sort each thread by date (newest first)
    for (const [, items] of groups) {
      items.sort((a, b) => b.createdAt - a.createdAt)
    }
    return groups
  }, [mails])

  // Flatten for display: one row per thread, showing newest message
  const displayMails = useMemo(() => {
    const result: MailRecord[] = []
    for (const [, items] of threadGroups) {
      result.push(items[0]!) // Show newest in thread
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  }, [threadGroups])

  const threadCount = (mail: MailRecord): number => {
    const tid = mail.threadId || mail.innerEventId
    return threadGroups.get(tid)?.length ?? 1
  }

  const selectedFolderName = folders.find((f) => f.id === selectedFolder)?.name ?? ''

  return (
    <div className="flex h-screen flex-col bg-neutral-900 text-neutral-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-700/50 bg-neutral-800/50 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">nVelope</h1>
          <span className="text-sm text-neutral-500">{identityName}</span>
          {accounts.length > 1 && (
            <select
              value={selectedAccount}
              onChange={(e) => {
                setSelectedAccount(e.target.value)
                setSelectedFolder(null)
                setSelectedMail(null)
                setSearchQuery('')
                setIsSearching(false)
              }}
              className="rounded-md border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm outline-none focus:border-blue-500"
            >
              {accounts.map((a) => (
                <option key={a.pubkey} value={a.pubkey}>
                  {a.displayName || formatNpub(a.pubkey)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {scanResult && (
            <span className={`text-sm ${scanResult.includes('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>
              {scanResult}
            </span>
          )}
          {sendStatus && (
            <span className="text-sm text-emerald-400">{sendStatus}</span>
          )}
          {newMailCount > 0 && (
            <span className="rounded-full bg-blue-500 px-2 py-0.5 text-xs font-semibold text-white">
              {newMailCount}
            </span>
          )}
          <button
            onClick={() => {
              const acct = accounts.find((a) => a.pubkey === selectedAccount)
              window.nvelope.compose.open({
                identityId,
                accountId: selectedAccount,
                accountDisplayName: acct?.displayName || undefined,
                accountNpub: acct ? npubEncode(acct.pubkey) : undefined,
              })
            }}
            title="Compose"
            className="rounded-md bg-emerald-600 p-1.5 text-white hover:bg-emerald-500 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button
            onClick={handleScan}
            disabled={scanning}
            title="Check Mail"
            className="rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {scanning ? (
              <svg className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5 9a8 8 0 0114-3M19 15a8 8 0 01-14 3" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v9m0 0l-3-3m3 3l3-3M4 13h4l2 3h4l2-3h4v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => {
              const acct = accounts.find((a) => a.pubkey === selectedAccount)
              window.nvelope.contactsWindow.open({
                identityId,
                accountId: selectedAccount,
                accountDisplayName: acct?.displayName || undefined,
              })
            }}
            title="Address Book"
            className="rounded-md border border-neutral-600 bg-neutral-800 p-1.5 text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            className="rounded-md border border-neutral-600 bg-neutral-800 p-1.5 text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={onLock}
            className="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      {/* Three-pane layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Folder pane */}
        <div className="w-52 border-r border-neutral-700/50 overflow-y-auto bg-neutral-900">
          <div className="p-3">
            <h3 className="mb-1 px-2 text-[11px] font-bold uppercase tracking-wider text-neutral-500">
              {(() => {
                const acct = accounts.find((a) => a.pubkey === selectedAccount)
                return acct?.displayName || formatNpub(selectedAccount)
              })()}
            </h3>
            <div className="space-y-0.5">
              {folders.map((folder) => {
                const unread = folderUnreadCounts[folder.id] ?? 0
                const isActive = selectedFolder === folder.id
                return (
                  <button
                    key={folder.id}
                    onClick={() => {
                      setSelectedFolder(folder.id)
                      setSelectedMail(null)
                      setSearchQuery('')
                      setIsSearching(false)
                    }}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm text-left transition-colors ${
                      isActive
                        ? 'bg-blue-600/20 text-blue-300'
                        : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <FolderIcon type={folder.type} />
                      <span>{folder.name}</span>
                    </div>
                    {unread > 0 && (
                      <span className="rounded-full bg-blue-500 px-1.5 py-0 text-[10px] font-bold text-white min-w-[18px] text-center">
                        {unread}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Mail list pane */}
        <div className="w-80 border-r border-neutral-700/50 flex flex-col bg-neutral-900">
          {/* Search bar */}
          <div className="border-b border-neutral-700/50 p-2">
            <div className="relative">
              <input
                type="text"
                placeholder="Search messages..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 py-1.5 pl-8 pr-3 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-blue-500 transition-colors"
              />
              <svg className="absolute left-2.5 top-2 h-4 w-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {isSearching && (
                <button
                  onClick={() => {
                    setSearchQuery('')
                    setIsSearching(false)
                    loadMails()
                  }}
                  className="absolute right-2 top-1.5 text-xs text-neutral-500 hover:text-neutral-300"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Message count header */}
          <div className="border-b border-neutral-700/50 px-3 py-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
              {isSearching ? `Search results` : selectedFolderName}
            </span>
            <span className="text-xs text-neutral-600">{displayMails.length} message{displayMails.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Message list */}
          <div className="flex-1 overflow-y-auto">
            {displayMails.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-neutral-500">
                <svg className="h-8 w-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <span className="text-sm">{isSearching ? 'No matches found' : 'No messages'}</span>
              </div>
            ) : (
              <div className="divide-y divide-neutral-800">
                {displayMails.map((mail) => (
                  <button
                    key={mail.innerEventId}
                    onClick={() => handleSelectMail(mail)}
                    className={`group flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors ${
                      selectedMail?.innerEventId === mail.innerEventId
                        ? 'bg-blue-600/10'
                        : 'hover:bg-neutral-800/50'
                    } ${mail.read ? 'text-neutral-400' : 'text-white'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-sm truncate ${mail.read ? 'font-normal' : 'font-semibold'}`}>
                        {getSenderDisplay(mail)}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {threadCount(mail) > 1 && (
                          <span className="rounded-full bg-neutral-700 px-1.5 text-[10px] text-neutral-400">
                            {threadCount(mail)}
                          </span>
                        )}
                        {mail.isBroadcast ? (
                          <span className="rounded bg-purple-500/20 px-1 text-[10px] font-medium text-purple-300">BC</span>
                        ) : null}
                        <span className="text-xs text-neutral-500">{formatDate(mail.createdAt)}</span>
                      </div>
                    </div>
                    <span className={`text-sm truncate ${mail.read ? 'text-neutral-400' : 'text-neutral-200 font-medium'}`}>
                      {mail.subject || '(no subject)'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {mailHasAttachments(mail) && (
                        <svg className="h-3.5 w-3.5 shrink-0 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                      )}
                      <span
                        onClick={(e) => { e.stopPropagation(); handleToggleMarked(mail) }}
                        className="shrink-0 cursor-pointer"
                        title={mail.marked ? 'Unstar' : 'Star'}
                      >
                        {mail.marked ? (
                          <svg className="h-4 w-4 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4 text-neutral-600 group-hover:text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        )}
                      </span>
                      <span className="text-xs text-neutral-600 truncate">{getMailPreview(mail)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Preview pane */}
        <div className="flex-1 overflow-y-auto bg-neutral-900">
          {selectedMail ? (
            <div className="flex h-full flex-col">
              {/* Action toolbar */}
              <div className="flex items-center gap-0.5 border-b border-neutral-700/50 bg-neutral-800 px-2 py-1">
                <ActionButton onClick={() => handleReply(selectedMail)} title="Reply">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                  <span className="text-xs">Reply</span>
                </ActionButton>
                <ActionButton onClick={() => handleForward(selectedMail)} title="Forward">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                  <span className="text-xs">Forward</span>
                </ActionButton>
                <div className="mx-1 h-4 w-px bg-neutral-600" />
                <ActionButton onClick={() => handleSpam(selectedMail)} title="Spam">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  <span className="text-xs">Spam</span>
                </ActionButton>
                <ActionButton onClick={() => handleDelete(selectedMail)} title="Delete">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  <span className="text-xs">Delete</span>
                </ActionButton>
                <div className="mx-1 h-4 w-px bg-neutral-600" />
                <ActionButton onClick={() => handleToggleMarked(selectedMail)} title={selectedMail.marked ? 'Unstar' : 'Star'}>
                  {selectedMail.marked ? (
                    <svg className="h-4 w-4 text-amber-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
                  )}
                  <span className="text-xs">{selectedMail.marked ? 'Starred' : 'Star'}</span>
                </ActionButton>
                <div className="ml-auto">
                  <button
                    onClick={() => handleMarkRead(selectedMail, !selectedMail.read)}
                    className="rounded p-1.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                    title={selectedMail.read ? 'Mark as unread' : 'Mark as read'}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={selectedMail.read ? 'M3 19l6-6m0 0l6 6m-6-6v12' : 'M5 13l4 4L19 7'} />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Message header */}
              <div className="border-b border-neutral-700/50 bg-neutral-900 p-4">
                <h2 className="text-lg font-semibold text-white leading-snug">
                  {selectedMail.subject || '(no subject)'}
                </h2>
                <div className="mt-3 flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-sm font-bold text-emerald-400">
                    {getInitials(getSenderDisplay(selectedMail))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-neutral-200">
                      {getSenderDisplay(selectedMail)}
                      {selectedMail.senderPubkey !== 'nvelope' && !contactsByPubkey[selectedMail.senderPubkey] && (
                        <button
                          onClick={() => handleAddSenderToContacts(selectedMail)}
                          title="Add sender to address book"
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 border border-neutral-700 hover:text-blue-300 hover:border-blue-600 transition-colors"
                        >
                          + Contact
                        </button>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      <span className="text-neutral-600">To:</span>{' '}
                      {(() => {
                        const acct = accounts.find((a) => a.pubkey === selectedAccount)
                        return acct?.displayName ? `${acct.displayName} <${formatNpub(selectedAccount)}>` : formatNpub(selectedAccount)
                      })()}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {formatDateFull(selectedMail.createdAt)}
                      {selectedMail.isBroadcast && (
                        <span className="ml-2 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">Broadcast</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Message body */}
              <div className="flex-1 overflow-y-auto p-5">
                <div
                  className="prose prose-invert max-w-none prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-blockquote:border-blue-500 prose-code:text-amber-300"
                  dangerouslySetInnerHTML={{ __html: getMailBodyHtml(selectedMail) }}
                />
                <ExternalReferenceList references={getExternalReferences(selectedMail)} />
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-600">
              <svg className="h-12 w-12 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="text-sm">Select a message to preview</span>
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <SettingsPanel
          identityId={identityId}
          identityName={identityName}
          accounts={accounts}
          onClose={() => {
            setShowSettings(false)
            onSettingsClosed?.()
          }}
          onRenamed={(name) => onIdentityRenamed?.(name)}
        />
      )}
    </div>
  )
}

const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp)(\?|#|$)/i

function linkLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const file = parsed.pathname.split('/').filter(Boolean).pop()
    return file ? decodeURIComponent(file) : parsed.hostname
  } catch {
    return url
  }
}

/** Renders a message's external references (SPEC §3.1): image links inline,
 *  everything else as a generic file+link chip that opens in the browser. */
function ExternalReferenceList({ references }: { references: string[][] }) {
  if (references.length === 0) return null
  const open = (url: string) => window.nvelope.file.openExternal(url).catch((e) => console.error('Open link failed:', e))
  return (
    <div className="mt-4 border-t border-neutral-800 pt-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">Attachments</div>
      <div className="flex flex-col gap-2">
        {references.map((ref) => {
          const url = ref[1]
          if (IMAGE_URL_RE.test(url)) {
            return (
              <button key={url} onClick={() => open(url)} title={`Open ${url} in browser`} className="w-fit cursor-pointer">
                <img
                  src={url}
                  alt={linkLabel(url)}
                  className="max-h-64 max-w-full rounded-md border border-neutral-700 object-contain"
                />
                <span className="mt-1 block truncate text-left text-xs text-neutral-500">{linkLabel(url)}</span>
              </button>
            )
          }
          return (
            <button
              key={url}
              onClick={() => open(url)}
              title={`Open ${url} in browser`}
              className="flex w-fit items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:border-blue-600 hover:text-blue-300 transition-colors"
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="max-w-80 truncate">{linkLabel(url)}</span>
              <svg className="h-3.5 w-3.5 shrink-0 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ActionButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 rounded px-2 py-1 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
    >
      {children}
    </button>
  )
}

function FolderIcon({ type }: { type: FolderRecord['type'] }) {
  const icons: Record<string, JSX.Element> = {
    inbox: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    sent: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
      </svg>
    ),
    outbox: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
      </svg>
    ),
    drafts: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
    junk: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
      </svg>
    ),
    user: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    ),
  }
  return icons[type] || icons.user
}
