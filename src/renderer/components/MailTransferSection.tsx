import { useState, useEffect, useCallback } from 'react'
import { npubEncode } from 'nostr-tools/nip19'
import type { MailExportOptions, MailImportSummary } from '../../preload'

interface AccountData {
  pubkey: string
  displayName?: string
}

interface Props {
  identityId: string
  accounts: AccountData[]
}

function shortNpub(pubkeyHex: string): string {
  const npub = npubEncode(pubkeyHex)
  return npub.length <= 28 ? npub : npub.slice(0, 15) + '...' + npub.slice(-10)
}

function accountLabel(a: AccountData): string {
  return a.displayName || shortNpub(a.pubkey)
}

type StatusState =
  | { kind: 'export' | 'import'; status: 'running' }
  | { kind: 'export'; status: 'success'; path: string; count: number }
  | { kind: 'import'; status: 'success'; imported: number; skipped: number; foldersCreated: number }
  | { kind: 'export' | 'import'; status: 'error'; message: string }

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
        <h3 className="mb-3 text-sm font-semibold text-neutral-100">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function CheckRow({
  checked,
  onChange,
  label,
  count,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  count?: number
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800">
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5 accent-blue-500"
        />
        {label}
      </span>
      {count !== undefined && <span className="text-xs text-neutral-500">{count}</span>}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-blue-500'
const primaryBtn =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors'
const secondaryBtn =
  'rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 transition-colors'

export default function MailTransferSection({ identityId, accounts }: Props) {
  // Export modal
  const [showExport, setShowExport] = useState(false)
  const [exportAccount, setExportAccount] = useState(accounts[0]?.pubkey ?? '')
  const [exportOptions, setExportOptions] = useState<MailExportOptions | null>(null)
  const [checkedFolders, setCheckedFolders] = useState<Set<number>>(new Set())
  const [exportOutbox, setExportOutbox] = useState(false)
  const [exportDrafts, setExportDrafts] = useState(false)
  const [exportPassword, setExportPassword] = useState('')

  // Import flow
  const [importPasswordFor, setImportPasswordFor] = useState<string | null>(null)
  const [importPassword, setImportPassword] = useState('')
  const [importPasswordError, setImportPasswordError] = useState('')
  const [decrypting, setDecrypting] = useState(false)
  const [importSelect, setImportSelect] = useState<{ path: string; password: string | null; summary: MailImportSummary } | null>(null)
  const [importAccount, setImportAccount] = useState(accounts[0]?.pubkey ?? '')
  const [importChecked, setImportChecked] = useState<Set<string>>(new Set())
  const [importOutbox, setImportOutbox] = useState(false)
  const [importDrafts, setImportDrafts] = useState(false)

  // Shared status modal
  const [status, setStatus] = useState<StatusState | null>(null)

  const loadExportOptions = useCallback(async (accountId: string) => {
    if (!accountId) return
    try {
      const options = await window.nvelope.mailTransfer.exportOptions(identityId, accountId)
      setExportOptions(options)
      setCheckedFolders(new Set(options.folders.map((f) => f.id)))
    } catch (e) {
      console.error('[mail-transfer] failed to load export options:', e)
    }
  }, [identityId])

  useEffect(() => {
    if (showExport) loadExportOptions(exportAccount)
  }, [showExport, exportAccount, loadExportOptions])

  const openExport = () => {
    setExportAccount(accounts[0]?.pubkey ?? '')
    setExportOptions(null)
    setExportOutbox(false)
    setExportDrafts(false)
    setExportPassword('')
    setShowExport(true)
  }

  const handleExport = async () => {
    setShowExport(false)
    setStatus({ kind: 'export', status: 'running' })
    try {
      const result = await window.nvelope.mailTransfer.exportRun(identityId, exportAccount, {
        folderIds: [...checkedFolders],
        includeOutbox: exportOutbox,
        includeDrafts: exportDrafts,
        password: exportPassword || undefined,
      })
      if (result.canceled) {
        setStatus(null)
        setShowExport(true)
        return
      }
      setStatus({ kind: 'export', status: 'success', path: result.path!, count: result.count ?? 0 })
    } catch (e) {
      setStatus({ kind: 'export', status: 'error', message: String(e) })
    }
  }

  const folderImportKey = (f: { name: string; type: string }) => (f.type === 'user' ? `user:${f.name}` : f.type)

  const handleImportPick = async () => {
    try {
      const result = await window.nvelope.mailTransfer.importInspect()
      if (result.canceled) return
      if (result.error || !result.path) {
        setStatus({ kind: 'import', status: 'error', message: result.error ?? 'Could not read the file' })
        return
      }
      if (result.encrypted) {
        setImportPassword('')
        setImportPasswordError('')
        setImportPasswordFor(result.path)
        return
      }
      if (!result.summary) {
        setStatus({ kind: 'import', status: 'error', message: 'Export file is missing its payload' })
        return
      }
      openImportSelect(result.path, null, result.summary)
    } catch (e) {
      setStatus({ kind: 'import', status: 'error', message: String(e) })
    }
  }

  const openImportSelect = (path: string, password: string | null, summary: MailImportSummary) => {
    setImportAccount(accounts[0]?.pubkey ?? '')
    setImportChecked(new Set(summary.folders.map(folderImportKey)))
    setImportOutbox(false)
    setImportDrafts(false)
    setImportPasswordFor(null)
    setImportSelect({ path, password, summary })
  }

  const handleDecrypt = async () => {
    if (!importPasswordFor) return
    setDecrypting(true)
    setImportPasswordError('')
    try {
      const result = await window.nvelope.mailTransfer.importDecrypt(importPasswordFor, importPassword)
      if (result.error || !result.summary) {
        setImportPasswordError(result.error ?? 'Decryption failed')
        return
      }
      openImportSelect(importPasswordFor, importPassword, result.summary)
    } finally {
      setDecrypting(false)
    }
  }

  const handleImport = async () => {
    if (!importSelect) return
    const { path, password, summary } = importSelect
    setImportSelect(null)
    setStatus({ kind: 'import', status: 'running' })
    try {
      const result = await window.nvelope.mailTransfer.importRun(identityId, importAccount, path, password, {
        folders: summary.folders.filter((f) => importChecked.has(folderImportKey(f))),
        includeOutbox: importOutbox,
        includeDrafts: importDrafts,
      })
      if (result.error) {
        setStatus({ kind: 'import', status: 'error', message: result.error })
        return
      }
      setStatus({
        kind: 'import',
        status: 'success',
        imported: result.imported ?? 0,
        skipped: result.skipped ?? 0,
        foldersCreated: result.foldersCreated ?? 0,
      })
    } catch (e) {
      setStatus({ kind: 'import', status: 'error', message: String(e) })
    }
  }

  return (
    <>
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Export mail</label>
        <p className="mb-2 text-xs text-neutral-500">
          Exports folders, drafts, and/or the outbox queue to a JSON file (optionally password-encrypted) that another
          nVelope client can import.
        </p>
        <button onClick={openExport} className={primaryBtn}>
          Export mail…
        </button>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-neutral-500">Import mail</label>
        <p className="mb-2 text-xs text-neutral-500">
          Imports a mail export file into one of your accounts. Duplicates already in the database are skipped.
        </p>
        <button onClick={() => void handleImportPick()} className={primaryBtn}>
          Import mail…
        </button>
      </div>

      {showExport && (
        <Modal title="Export mail">
          <div className="space-y-3">
            {accounts.length > 1 && (
              <div>
                <label className="mb-1 block text-xs text-neutral-500">Account</label>
                <select value={exportAccount} onChange={(e) => setExportAccount(e.target.value)} className={inputClass}>
                  {accounts.map((a) => (
                    <option key={a.pubkey} value={a.pubkey}>{accountLabel(a)}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Folders</label>
              <div className="rounded-md border border-neutral-700/50 bg-neutral-800/40 py-1">
                {exportOptions === null ? (
                  <p className="px-2 py-1.5 text-xs text-neutral-500">Loading…</p>
                ) : (
                  <>
                    {exportOptions.folders.map((f) => (
                      <CheckRow
                        key={f.id}
                        checked={checkedFolders.has(f.id)}
                        onChange={(v) => {
                          const next = new Set(checkedFolders)
                          if (v) next.add(f.id)
                          else next.delete(f.id)
                          setCheckedFolders(next)
                        }}
                        label={f.name}
                        count={f.count}
                      />
                    ))}
                    <div className="mx-2 my-1 border-t border-neutral-700/50" />
                    <CheckRow checked={exportOutbox} onChange={setExportOutbox} label="Export Outbox Queue" count={exportOptions.outboxCount} />
                    <CheckRow checked={exportDrafts} onChange={setExportDrafts} label="Export saved drafts" count={exportOptions.draftsCount} />
                  </>
                )}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Password (optional — encrypts the file)</label>
              <input
                type="password"
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
                placeholder="Leave blank for an unencrypted export"
                className={inputClass}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowExport(false)} className={secondaryBtn}>Cancel</button>
              <button
                onClick={() => void handleExport()}
                disabled={exportOptions === null || (checkedFolders.size === 0 && !exportOutbox && !exportDrafts)}
                className={primaryBtn}
              >
                Export to File…
              </button>
            </div>
          </div>
        </Modal>
      )}

      {importPasswordFor && (
        <Modal title="Password required">
          <div className="space-y-3">
            <p className="text-xs text-neutral-400">This export file is password-protected.</p>
            <input
              type="password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && importPassword && !decrypting) void handleDecrypt() }}
              placeholder="Export password"
              autoFocus
              className={inputClass}
            />
            {importPasswordError && <p className="text-xs text-red-400">{importPasswordError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setImportPasswordFor(null)} className={secondaryBtn}>Cancel</button>
              <button onClick={() => void handleDecrypt()} disabled={!importPassword || decrypting} className={primaryBtn}>
                {decrypting ? 'Decrypting…' : 'Decrypt'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {importSelect && (
        <Modal title="Import mail">
          <div className="space-y-3">
            <p className="text-xs text-neutral-500">
              Exported {new Date(importSelect.summary.exportedAt * 1000).toLocaleString()} ·{' '}
              {importSelect.summary.total} message{importSelect.summary.total === 1 ? '' : 's'}
              {importSelect.summary.sourceAccountId ? ` · from ${shortNpub(importSelect.summary.sourceAccountId)}` : ''}
            </p>
            {accounts.length > 1 && (
              <div>
                <label className="mb-1 block text-xs text-neutral-500">Import into account</label>
                <select value={importAccount} onChange={(e) => setImportAccount(e.target.value)} className={inputClass}>
                  {accounts.map((a) => (
                    <option key={a.pubkey} value={a.pubkey}>{accountLabel(a)}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Folders</label>
              <div className="rounded-md border border-neutral-700/50 bg-neutral-800/40 py-1">
                {importSelect.summary.folders.map((f) => {
                  const key = folderImportKey(f)
                  return (
                    <CheckRow
                      key={key}
                      checked={importChecked.has(key)}
                      onChange={(v) => {
                        const next = new Set(importChecked)
                        if (v) next.add(key)
                        else next.delete(key)
                        setImportChecked(next)
                      }}
                      label={f.name}
                      count={f.count}
                    />
                  )
                })}
                {(importSelect.summary.outboxCount > 0 || importSelect.summary.draftsCount > 0) && (
                  <div className="mx-2 my-1 border-t border-neutral-700/50" />
                )}
                {importSelect.summary.outboxCount > 0 && (
                  <CheckRow checked={importOutbox} onChange={setImportOutbox} label="Import Outbox Queue" count={importSelect.summary.outboxCount} />
                )}
                {importSelect.summary.draftsCount > 0 && (
                  <CheckRow checked={importDrafts} onChange={setImportDrafts} label="Import saved drafts" count={importSelect.summary.draftsCount} />
                )}
              </div>
              {importOutbox && (
                <p className="mt-1 text-xs text-amber-400/80">
                  Imported queued messages will be processed and sent by this client.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setImportSelect(null)} className={secondaryBtn}>Cancel</button>
              <button
                onClick={() => void handleImport()}
                disabled={importChecked.size === 0 && !importOutbox && !importDrafts}
                className={primaryBtn}
              >
                Import
              </button>
            </div>
          </div>
        </Modal>
      )}

      {status && (
        <Modal title={status.kind === 'export' ? 'Export mail' : 'Import mail'}>
          <div className="space-y-3">
            {status.status === 'running' && (
              <p className="text-sm text-neutral-300">{status.kind === 'export' ? 'Exporting…' : 'Importing…'}</p>
            )}
            {status.status === 'success' && status.kind === 'export' && (
              <p className="text-sm text-neutral-300">
                Export complete — {status.count} message{status.count === 1 ? '' : 's'} written to{' '}
                <span className="break-all text-neutral-400">{status.path}</span>
              </p>
            )}
            {status.status === 'success' && status.kind === 'import' && (
              <p className="text-sm text-neutral-300">
                Import complete — {status.imported} message{status.imported === 1 ? '' : 's'} imported
                {status.skipped > 0 && `, ${status.skipped} duplicate${status.skipped === 1 ? '' : 's'} skipped`}
                {status.foldersCreated > 0 && `, ${status.foldersCreated} folder${status.foldersCreated === 1 ? '' : 's'} created`}.
              </p>
            )}
            {status.status === 'error' && (
              <p className="break-all text-sm text-red-400">{status.message}</p>
            )}
            {status.status !== 'running' && (
              <div className="flex justify-end pt-1">
                <button onClick={() => setStatus(null)} className={primaryBtn}>OK</button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
