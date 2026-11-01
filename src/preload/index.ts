import { contextBridge, ipcRenderer } from 'electron'

// Read compose-data from command-line arg injected by main process for compose windows
const composeDataArg = typeof process !== 'undefined'
  ? process.argv.find((arg) => arg.startsWith('--compose-data='))
  : undefined
const composeData = composeDataArg
  ? (JSON.parse(composeDataArg.slice('--compose-data='.length)) as Record<string, unknown>)
  : undefined

// Read window-data from command-line arg injected by main process for auxiliary windows (address book)
const windowDataArg = typeof process !== 'undefined'
  ? process.argv.find((arg) => arg.startsWith('--window-data='))
  : undefined
const windowData = windowDataArg
  ? (JSON.parse(windowDataArg.slice('--window-data='.length)) as Record<string, unknown>)
  : undefined

export interface VaultAPI {
  createIdentity: (name: string, passphrase: string) => Promise<{ id: string; name: string }>
  listIdentities: () => Promise<Array<{ id: string; name: string }>>
  unlockIdentity: (identityId: string, passphrase: string) => Promise<{ accounts: AccountData[]; settings: IdentitySettings }>
  lockIdentity: (identityId: string) => Promise<void>
  addAccount: (identityId: string, account: AccountData) => Promise<void>
  deleteAccount: (identityId: string, pubkey: string) => Promise<void>
  updateSettings: (identityId: string, settings: IdentitySettings) => Promise<void>
  resetScanCursor: (identityId: string) => Promise<void>
  renameIdentity: (identityId: string, name: string) => Promise<{ id: string; name: string }>
  deleteIdentity: (identityId: string) => Promise<void>
  changePassphrase: (identityId: string, currentPassphrase: string, newPassphrase: string) => Promise<void>
  getSettings: (identityId: string) => Promise<IdentitySettings>
  listAccounts: (identityId: string) => Promise<AccountData[]>
  exportVault: (identityId: string) => Promise<{ canceled: boolean; path?: string }>
  importIdentity: () => Promise<{ canceled: boolean; id?: string; name?: string }>
}

export interface ContactRecord {
  id?: number
  accountId: string
  pubkey: string
  nip05?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  kind0Name?: string | null
  kind0DisplayName?: string | null
  nip05Verified?: number
  profileFetchedAt?: number
  cachedAt?: number | null
  isNostrMailEnabled: number
}

export interface DbAPI {
  initSchema: (identityId: string) => Promise<void>
  mailInsert: (identityId: string, mail: unknown) => Promise<void>
  mailGetByFolder: (identityId: string, accountId: string, folderId: number) => Promise<unknown[]>
  mailGetByState: (identityId: string, accountId: string, state: string) => Promise<unknown[]>
  mailGetByThread: (identityId: string, accountId: string, threadId: string) => Promise<unknown[]>
  mailCountUnread: (identityId: string, accountId: string, folderId: number) => Promise<number>
  mailSearch: (identityId: string, accountId: string, query: string) => Promise<unknown[]>
  mailMarkRead: (identityId: string, innerEventId: string, read: boolean) => Promise<void>
  mailToggleMarked: (identityId: string, innerEventId: string) => Promise<boolean>
  mailMoveToFolder: (identityId: string, innerEventId: string, folderId: number | null) => Promise<void>
  mailSoftDelete: (identityId: string, innerEventId: string) => Promise<void>
  mailDelete: (identityId: string, innerEventId: string) => Promise<void>
  foldersGet: (identityId: string, accountId: string) => Promise<unknown[]>
  foldersGetSpecial: (identityId: string, accountId: string, type: string) => Promise<unknown | null>
  foldersCreate: (identityId: string, accountId: string, name: string) => Promise<number>
  foldersDelete: (identityId: string, folderId: number) => Promise<void>
  contactsUpsert: (identityId: string, contact: unknown) => Promise<void>
  contactsGet: (identityId: string, accountId: string, pubkey: string) => Promise<unknown | null>
  contactsGetAll: (identityId: string, accountId: string) => Promise<unknown[]>
  contactsRemove: (identityId: string, accountId: string, pubkey: string) => Promise<void>
  subsAdd: (identityId: string, sub: unknown) => Promise<number>
  subsRemove: (identityId: string, id: number) => Promise<void>
  subsGetAll: (identityId: string, accountId: string) => Promise<unknown[]>
  subsSubscribe: (identityId: string, accountId: string, naddr: string) => Promise<SubscriptionRecord>
}

export interface SubscriptionRecord {
  id?: number
  accountId: string
  naddr: string
  displayName?: string | null
  topic: string
  author?: string | null
  relays?: string | null
  since?: number | null
  createdAt: number
}

export interface FileAPI {
  openPemFile: () => Promise<{ canceled: boolean; content: string }>
  saveTextFile: (defaultName: string, content: string) => Promise<{ canceled: boolean; path?: string }>
  openExternal: (url: string) => Promise<void>
}

export interface CertAPI {
  generate: (keySize?: 2048 | 4096) => Promise<{ privateKeyPem: string; publicKeyDerBase64: string }>
  derivePublic: (privateKeyPem: string) => Promise<{ publicKeyDerBase64: string }>
}

export interface BenchmarkAPI {
  runPowBenchmark: () => Promise<{ hashesPerSecond: number; hashesPerMinute: number }>
}

export interface RelayAPI {
  manualScan: (identityId: string) => Promise<{ direct: number; broadcast: number; errors: string[] }>
  startAutoScan: (identityId: string) => Promise<{ started: boolean }>
  stopAutoScan: (identityId: string) => Promise<{ stopped: boolean }>
  stopAllScans: () => Promise<{ stopped: boolean }>
  getScanStatus: () => Promise<Array<{ identityId: string; active: boolean }>>
}

export interface RelayListPublishResult {
  eventId: string
  createdAt: number
  details: Array<{ url: string; ok: boolean; reason?: string }>
}

export interface RelayListAPI {
  resolveImport: (pubkey: string, candidateRelays?: string[]) => Promise<{ relays: string[]; source: 'nip65' | 'kind3' | 'defaults'; createdAt?: number }>
  publish: (identityId: string, pubkey: string) => Promise<RelayListPublishResult>
  getAll: (identityId: string) => Promise<{ relaysPerAccount: Record<string, string[]>; fetched: Record<string, { fetchedAt: number; createdAt?: number }> }>
  setForAccount: (identityId: string, pubkey: string, relays: string[]) => Promise<RelayListPublishResult>
  sync: (identityId: string, force?: boolean) => Promise<{ synced: boolean }>
}

export interface MailListenerAPI {
  onNewMail: (callback: (data: { identityId: string; directCount: number; broadcastCount: number }) => void) => () => void
}

export interface SettingsAPI {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  getAll: () => Promise<Record<string, unknown>>
  setAll: (settings: Record<string, unknown>) => Promise<void>
}

export interface SendAPI {
  queue: (
    identityId: string,
    accountId: string,
    payload: {
      recipients: string[]
      subject: string
      body: string
      format: 'plaintext' | 'markdown' | 'html'
      links?: string[]
      threadId?: string
    },
  ) => Promise<{ innerEventId: string }>
  cancel: (identityId: string, innerEventId: string) => Promise<void>
  retry: (identityId: string, innerEventId: string) => Promise<void>
  saveDraft: (
    identityId: string,
    accountId: string,
    draftId: string | null,
    payload: {
      recipientNpub?: string
      subject?: string
      body?: string
      format?: 'plaintext' | 'markdown' | 'html'
    },
  ) => Promise<{ draftId: string }>
}

export interface OutboxProgress {
  identityId: string
  accountId: string
  innerEventId: string
  phase: 'queued' | 'mining' | 'sent' | 'cancelled' | 'error'
  recipientIndex?: number
  recipientCount?: number
  attempts?: number
  bits?: number
  etaMinutes?: number | null
  error?: string
}

export interface OutboxAPI {
  onProgress: (callback: (data: OutboxProgress) => void) => () => void
}

export interface ProfileAPI {
  publish: (identityId: string, accountId: string, options?: { skipKind0?: boolean; skipPolicy?: boolean }) => Promise<{ certificateEventId?: string; profileEventId?: string; errors: string[] }>
  fetchMetadata: (pubkey: string, relays?: string[]) => Promise<{ name?: string; about?: string; picture?: string; nip05?: string } | null>
  fetchCert: (pubkey: string, relays?: string[]) => Promise<{ certificate: string; createdAt: number } | null>
}

export interface ComposeAPI {
  open: (data: Record<string, unknown>) => Promise<{ ok: boolean }>
}

export interface Nip05API {
  resolve: (identifier: string) => Promise<{ pubkey: string; nip05: string; relays: string[] }>
}

export interface BlossomUploadResult {
  canceled: boolean
  url?: string
  sha256?: string
  size?: number
  mime?: string
  name?: string
}

export interface BlossomAPI {
  upload: (identityId: string, accountId: string, serverHost: string) => Promise<BlossomUploadResult>
}

export interface ContactsWindowAPI {
  open: (data: Record<string, unknown>) => Promise<{ ok: boolean }>
}

export interface ContactsListenerAPI {
  onChanged: (callback: (data: { identityId: string; accountId: string }) => void) => () => void
  onPrefill: (callback: (data: Record<string, unknown>) => void) => () => void
  sync: (identityId: string) => Promise<{ contacts: number; mailEnabled: number }>
  clearCacheAndResync: (identityId: string) => Promise<{ contacts: number; mailEnabled: number }>
  checkCert: (identityId: string, accountId: string, pubkey: string) => Promise<{ mailEnabled: boolean }>
  policyEta: (identityId: string, accountId: string, pubkey: string) => Promise<{ bits: number; etaMinutes: number | null; hashesPerSecond?: number | null; workers?: number; denied?: boolean; reason?: string }>
  refreshProfiles: (identityId: string, accountId: string) => Promise<{ enriched: number }>
  getAvatar: (identityId: string, accountId: string, pubkey: string) => Promise<string | null>
}

export interface AccountData {
  pubkey: string
  nsec: string
  certificatePrivateKeyPem: string
  certificatePublicKeyDerBase64: string
  displayName?: string
  nip05?: string
  picture?: string
  about?: string
}

export interface IdentitySettings {
  benchmarkHashesPerMinute?: number
  lastRetrievedPerAccount?: Record<string, number>
  preferences?: Record<string, unknown>
}

const vaultAPI: VaultAPI = {
  createIdentity: (name, passphrase) => ipcRenderer.invoke('vault:createIdentity', name, passphrase),
  listIdentities: () => ipcRenderer.invoke('vault:listIdentities'),
  unlockIdentity: (identityId, passphrase) => ipcRenderer.invoke('vault:unlockIdentity', identityId, passphrase),
  lockIdentity: (identityId) => ipcRenderer.invoke('vault:lockIdentity', identityId),
  addAccount: (identityId, account) => ipcRenderer.invoke('vault:addAccount', identityId, account),
  deleteAccount: (identityId, pubkey) => ipcRenderer.invoke('vault:deleteAccount', identityId, pubkey),
  updateSettings: (identityId, settings) => ipcRenderer.invoke('vault:updateSettings', identityId, settings),
  resetScanCursor: (identityId) => ipcRenderer.invoke('vault:resetScanCursor', identityId),
  renameIdentity: (identityId, name) => ipcRenderer.invoke('vault:renameIdentity', identityId, name),
  deleteIdentity: (identityId) => ipcRenderer.invoke('vault:deleteIdentity', identityId),
  changePassphrase: (identityId, currentPassphrase, newPassphrase) => ipcRenderer.invoke('vault:changePassphrase', identityId, currentPassphrase, newPassphrase),
  getSettings: (identityId) => ipcRenderer.invoke('vault:getSettings', identityId),
  listAccounts: (identityId) => ipcRenderer.invoke('vault:listAccounts', identityId),
  exportVault: (identityId) => ipcRenderer.invoke('vault:exportVault', identityId),
  importIdentity: () => ipcRenderer.invoke('vault:importIdentity'),
}

const dbAPI: DbAPI = {
  initSchema: (identityId) => ipcRenderer.invoke('db:initSchema', identityId),
  mailInsert: (identityId, mail) => ipcRenderer.invoke('db:mail:insert', identityId, mail),
  mailGetByFolder: (identityId, accountId, folderId) => ipcRenderer.invoke('db:mail:getByFolder', identityId, accountId, folderId),
  mailGetByState: (identityId, accountId, state) => ipcRenderer.invoke('db:mail:getByState', identityId, accountId, state),
  mailGetByThread: (identityId, accountId, threadId) => ipcRenderer.invoke('db:mail:getByThread', identityId, accountId, threadId),
  mailCountUnread: (identityId, accountId, folderId) => ipcRenderer.invoke('db:mail:countUnread', identityId, accountId, folderId),
  mailSearch: (identityId, accountId, query) => ipcRenderer.invoke('db:mail:search', identityId, accountId, query),
  mailMarkRead: (identityId, innerEventId, read) => ipcRenderer.invoke('db:mail:markRead', identityId, innerEventId, read),
  mailToggleMarked: (identityId, innerEventId) => ipcRenderer.invoke('db:mail:toggleMarked', identityId, innerEventId),
  mailMoveToFolder: (identityId, innerEventId, folderId) => ipcRenderer.invoke('db:mail:moveToFolder', identityId, innerEventId, folderId),
  mailSoftDelete: (identityId, innerEventId) => ipcRenderer.invoke('db:mail:softDelete', identityId, innerEventId),
  mailDelete: (identityId, innerEventId) => ipcRenderer.invoke('db:mail:delete', identityId, innerEventId),
  foldersGet: (identityId, accountId) => ipcRenderer.invoke('db:folders:get', identityId, accountId),
  foldersGetSpecial: (identityId, accountId, type) => ipcRenderer.invoke('db:folders:getSpecial', identityId, accountId, type),
  foldersCreate: (identityId, accountId, name) => ipcRenderer.invoke('db:folders:create', identityId, accountId, name),
  foldersDelete: (identityId, folderId) => ipcRenderer.invoke('db:folders:delete', identityId, folderId),
  contactsUpsert: (identityId, contact) => ipcRenderer.invoke('db:contacts:upsert', identityId, contact),
  contactsGet: (identityId, accountId, pubkey) => ipcRenderer.invoke('db:contacts:get', identityId, accountId, pubkey),
  contactsGetAll: (identityId, accountId) => ipcRenderer.invoke('db:contacts:getAll', identityId, accountId),
  contactsRemove: (identityId, accountId, pubkey) => ipcRenderer.invoke('db:contacts:remove', identityId, accountId, pubkey),
  subsAdd: (identityId, sub) => ipcRenderer.invoke('db:subs:add', identityId, sub),
  subsRemove: (identityId, id) => ipcRenderer.invoke('db:subs:remove', identityId, id),
  subsGetAll: (identityId, accountId) => ipcRenderer.invoke('db:subs:getAll', identityId, accountId),
  subsSubscribe: (identityId, accountId, naddr) => ipcRenderer.invoke('subs:subscribe', identityId, accountId, naddr),
}

const fileAPI: FileAPI = {
  openPemFile: () => ipcRenderer.invoke('file:openPemFile'),
  saveTextFile: (defaultName, content) => ipcRenderer.invoke('file:saveTextFile', defaultName, content),
  openExternal: (url) => ipcRenderer.invoke('file:openExternal', url),
}

const certAPI: CertAPI = {
  generate: (keySize) => ipcRenderer.invoke('cert:generate', keySize),
  derivePublic: (privateKeyPem) => ipcRenderer.invoke('cert:derivePublic', privateKeyPem),
}

const benchmarkAPI: BenchmarkAPI = {
  runPowBenchmark: () => ipcRenderer.invoke('benchmark:runPow'),
}

const relayAPI: RelayAPI = {
  manualScan: (identityId) => ipcRenderer.invoke('relay:manualScan', identityId),
  startAutoScan: (identityId) => ipcRenderer.invoke('relay:startAutoScan', identityId),
  stopAutoScan: (identityId) => ipcRenderer.invoke('relay:stopAutoScan', identityId),
  stopAllScans: () => ipcRenderer.invoke('relay:stopAllScans'),
  getScanStatus: () => ipcRenderer.invoke('relay:getScanStatus'),
}

const relayListAPI: RelayListAPI = {
  resolveImport: (pubkey, candidateRelays) => ipcRenderer.invoke('relayList:resolveImport', pubkey, candidateRelays),
  publish: (identityId, pubkey) => ipcRenderer.invoke('relayList:publish', identityId, pubkey),
  getAll: (identityId) => ipcRenderer.invoke('relayList:getAll', identityId),
  setForAccount: (identityId, pubkey, relays) => ipcRenderer.invoke('relayList:setForAccount', identityId, pubkey, relays),
  sync: (identityId, force) => ipcRenderer.invoke('relayList:sync', identityId, force),
}

const mailListenerAPI: MailListenerAPI = {
  onNewMail: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { identityId: string; directCount: number; broadcastCount: number }) => callback(data)
    ipcRenderer.on('mail:new', handler)
    return () => ipcRenderer.removeListener('mail:new', handler)
  },
}

const settingsAPI: SettingsAPI = {
  get: (key) => ipcRenderer.invoke('settings:get', key),
  set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  getAll: () => ipcRenderer.invoke('settings:getAll'),
  setAll: (settings) => ipcRenderer.invoke('settings:setAll', settings),
}

const sendAPI: SendAPI = {
  queue: (identityId, accountId, payload) => ipcRenderer.invoke('send:queue', identityId, accountId, payload),
  cancel: (identityId, innerEventId) => ipcRenderer.invoke('send:cancel', identityId, innerEventId),
  retry: (identityId, innerEventId) => ipcRenderer.invoke('send:retry', identityId, innerEventId),
  saveDraft: (identityId, accountId, draftId, payload) => ipcRenderer.invoke('draft:save', identityId, accountId, draftId, payload),
}

const outboxAPI: OutboxAPI = {
  onProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: OutboxProgress) => callback(data)
    ipcRenderer.on('outbox:progress', handler)
    return () => ipcRenderer.removeListener('outbox:progress', handler)
  },
}

const profileAPI: ProfileAPI = {
  publish: (identityId, accountId, options) => ipcRenderer.invoke('profile:publish', identityId, accountId, options),
  fetchMetadata: (pubkey, relays) => ipcRenderer.invoke('profile:fetchMetadata', pubkey, relays),
  fetchCert: (pubkey, relays) => ipcRenderer.invoke('profile:fetchCert', pubkey, relays),
}

const composeAPI: ComposeAPI = {
  open: (data) => ipcRenderer.invoke('compose:open', data),
}

const nip05API: Nip05API = {
  resolve: (identifier) => ipcRenderer.invoke('nip05:resolve', identifier),
}

const blossomAPI: BlossomAPI = {
  upload: (identityId, accountId, serverHost) => ipcRenderer.invoke('blossom:upload', identityId, accountId, serverHost),
}

const contactsWindowAPI: ContactsWindowAPI = {
  open: (data) => ipcRenderer.invoke('contactsWindow:open', data),
}

const contactsListenerAPI: ContactsListenerAPI = {
  onChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { identityId: string; accountId: string }) => callback(data)
    ipcRenderer.on('contacts:changed', handler)
    return () => ipcRenderer.removeListener('contacts:changed', handler)
  },
  onPrefill: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data)
    ipcRenderer.on('contacts:prefill', handler)
    return () => ipcRenderer.removeListener('contacts:prefill', handler)
  },
  sync: (identityId) => ipcRenderer.invoke('contacts:sync', identityId),
  clearCacheAndResync: (identityId) => ipcRenderer.invoke('contacts:clearCacheAndResync', identityId),
  checkCert: (identityId, accountId, pubkey) => ipcRenderer.invoke('contacts:checkCert', identityId, accountId, pubkey),
  policyEta: (identityId, accountId, pubkey) => ipcRenderer.invoke('contacts:policyEta', identityId, accountId, pubkey),
  refreshProfiles: (identityId, accountId) => ipcRenderer.invoke('contacts:refreshProfiles', identityId, accountId),
  getAvatar: (identityId, accountId, pubkey) => ipcRenderer.invoke('contacts:getAvatar', identityId, accountId, pubkey),
}

contextBridge.exposeInMainWorld('nvelope', { vault: vaultAPI, db: dbAPI, file: fileAPI, cert: certAPI, benchmark: benchmarkAPI, relay: relayAPI, relayList: relayListAPI, mail: mailListenerAPI, settings: settingsAPI, send: sendAPI, outbox: outboxAPI, profile: profileAPI, compose: composeAPI, nip05: nip05API, blossom: blossomAPI, contactsWindow: contactsWindowAPI, contacts: contactsListenerAPI, composeData, windowData })

export type NvelopeAPI = { vault: VaultAPI; db: DbAPI; file: FileAPI; cert: CertAPI; benchmark: BenchmarkAPI; relay: RelayAPI; relayList: RelayListAPI; mail: MailListenerAPI; settings: SettingsAPI; send: SendAPI; outbox: OutboxAPI; profile: ProfileAPI; compose: ComposeAPI; nip05: Nip05API; blossom: BlossomAPI; contactsWindow: ContactsWindowAPI; contacts: ContactsListenerAPI; composeData?: Record<string, unknown>; windowData?: Record<string, unknown> }

declare global {
  interface Window {
    nvelope: NvelopeAPI
  }
}
