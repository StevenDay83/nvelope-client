import { ipcMain, app, dialog } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getPublicKey } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'

const VAULT_DIR = path.join(app.getPath('userData'), 'vaults')
const IDENTITIES_FILE = path.join(app.getPath('userData'), 'identities.json')

export interface VaultPayload {
  accounts: Array<{
    pubkey: string
    nsec: string
    certificatePrivateKeyPem: string
    certificatePublicKeyDerBase64: string
    displayName?: string
    nip05?: string
    picture?: string
    about?: string
  }>
  settings: {
    benchmarkHashesPerMinute?: number
    lastRetrievedPerAccount?: Record<string, number>
    lastBroadcastRetrievedPerAccount?: Record<string, number>
    preferences?: Record<string, unknown>
  }
}

interface IdentityMeta {
  id: string
  name: string
  createdAt: number
}

// In-memory session: decrypted payload + the passphrase used to unlock it.
// The passphrase is needed for re-encryption after mutations. Storing it in
// main-process memory is acceptable: if an attacker can read this memory they
// already have the decrypted secrets. The passphrase is cleared on lock.
const unlockedSessions = new Map<string, { payload: VaultPayload; passphrase: string }>()

function ensureVaultDir(): void {
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true })
}

function getIdentities(): IdentityMeta[] {
  if (!fs.existsSync(IDENTITIES_FILE)) return []
  return JSON.parse(fs.readFileSync(IDENTITIES_FILE, 'utf-8')) as IdentityMeta[]
}

function saveIdentities(identities: IdentityMeta[]): void {
  fs.writeFileSync(IDENTITIES_FILE, JSON.stringify(identities, null, 2))
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256')
}

function encryptVault(payload: VaultPayload, passphrase: string): { salt: string; iv: string; ciphertext: string; tag: string } {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = JSON.stringify(payload)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  }
}

function decryptVault(envelope: { salt: string; iv: string; ciphertext: string; tag: string }, passphrase: string): VaultPayload {
  const salt = Buffer.from(envelope.salt, 'hex')
  const iv = Buffer.from(envelope.iv, 'hex')
  const key = deriveKey(passphrase, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()])
  return JSON.parse(decrypted.toString('utf-8')) as VaultPayload
}

function persistVault(identityId: string, payload: VaultPayload, passphrase: string): void {
  const vaultPath = path.join(VAULT_DIR, `${identityId}.vault`)
  const envelope = encryptVault(payload, passphrase)
  fs.writeFileSync(vaultPath, JSON.stringify(envelope, null, 2))
}

export function getUnlockedSession(identityId: string): { payload: VaultPayload; passphrase: string } | undefined {
  return unlockedSessions.get(identityId)
}

export function getAllUnlockedSessions(): Array<{ identityId: string; payload: VaultPayload; passphrase: string }> {
  return Array.from(unlockedSessions.entries()).map(([identityId, session]) => ({ identityId, ...session }))
}

/** Persist the current in-memory session payload (e.g. after the scanner
 *  updates settings.lastRetrievedPerAccount) so cursors survive restarts. */
export function persistUnlockedSession(identityId: string): void {
  const session = unlockedSessions.get(identityId)
  if (!session) return
  persistVault(identityId, session.payload, session.passphrase)
}

export function registerVaultHandlers(): void {
  ipcMain.handle('vault:createIdentity', async (_event, name: string, passphrase: string) => {
    ensureVaultDir()
    const id = crypto.randomUUID()
    const payload: VaultPayload = { accounts: [], settings: { preferences: {} } }
    const envelope = encryptVault(payload, passphrase)
    fs.writeFileSync(path.join(VAULT_DIR, `${id}.vault`), JSON.stringify(envelope, null, 2))

    const identities = getIdentities()
    identities.push({ id, name, createdAt: Date.now() })
    saveIdentities(identities)

    // Auto-unlock so subsequent operations (addAccount, updateSettings) work immediately
    unlockedSessions.set(id, { payload, passphrase })

    return { id, name }
  })

  ipcMain.handle('vault:listIdentities', async () => {
    return getIdentities()
  })

  ipcMain.handle('vault:unlockIdentity', async (_event, identityId: string, passphrase: string) => {
    const vaultPath = path.join(VAULT_DIR, `${identityId}.vault`)
    if (!fs.existsSync(vaultPath)) throw new Error('Identity not found')
    const envelope = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'))
    const payload = decryptVault(envelope, passphrase)
    unlockedSessions.set(identityId, { payload, passphrase })
    return { accounts: payload.accounts, settings: payload.settings }
  })

  ipcMain.handle('vault:lockIdentity', async (_event, identityId: string) => {
    unlockedSessions.delete(identityId)
  })

  ipcMain.handle('vault:addAccount', async (_event, identityId: string, account: VaultPayload['accounts'][number]) => {
    const session = unlockedSessions.get(identityId)
    if (!session) throw new Error('Identity is locked')
    const { payload, passphrase } = session

    // Verify nsec derives to the claimed pubkey — catch wizard/vault mismatches
    if (account.nsec) {
      try {
        const decoded = decode(account.nsec)
        if (decoded.type === 'nsec') {
          const sk = decoded.data as Uint8Array
          const derivedPubkey = getPublicKey(sk)
          if (derivedPubkey !== account.pubkey) {
            console.error(`[vault:addAccount] PUBKEY MISMATCH! stored=${account.pubkey} derived=${derivedPubkey}`)
            throw new Error(`Account pubkey does not match nsec. Stored: ${account.pubkey}, Derived: ${derivedPubkey}`)
          }
          console.log(`[vault:addAccount] Verified nsec derives to pubkey ${derivedPubkey}`)
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Account pubkey does not match')) throw e
        console.warn('[vault:addAccount] nsec verification error:', e)
      }
    }

    console.log('[vault:addAccount] Storing account:', { pubkey: account.pubkey, hasNsec: !!account.nsec, hasCert: !!account.certificatePublicKeyDerBase64 })
    const existing = payload.accounts.findIndex((a) => a.pubkey === account.pubkey)
    if (existing >= 0) payload.accounts[existing] = account
    else payload.accounts.push(account)
    persistVault(identityId, payload, passphrase)
    console.log('[vault:addAccount] Vault persisted for', identityId)
  })

  ipcMain.handle('vault:deleteAccount', async (_event, identityId: string, pubkey: string) => {
    const session = unlockedSessions.get(identityId)
    if (!session) throw new Error('Identity is locked')
    const { payload, passphrase } = session
    payload.accounts = payload.accounts.filter((a) => a.pubkey !== pubkey)
    persistVault(identityId, payload, passphrase)
  })

  ipcMain.handle('vault:updateSettings', async (_event, identityId: string, settings: VaultPayload['settings']) => {
    const session = unlockedSessions.get(identityId)
    if (!session) throw new Error('Identity is locked')
    const { payload, passphrase } = session
    payload.settings = { ...payload.settings, ...settings }
    persistVault(identityId, payload, passphrase)
  })

  // Forget the scan watermark — the next check re-fetches every envelope on the relays.
  ipcMain.handle('vault:resetScanCursor', async (_event, identityId: string) => {
    const session = unlockedSessions.get(identityId)
    if (!session) throw new Error('Identity is locked')
    const { payload, passphrase } = session
    payload.settings.lastRetrievedPerAccount = {}
    payload.settings.lastBroadcastRetrievedPerAccount = {}
    persistVault(identityId, payload, passphrase)
  })

  ipcMain.handle('vault:renameIdentity', async (_event, identityId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Name cannot be empty')
    const identities = getIdentities()
    const meta = identities.find((i) => i.id === identityId)
    if (!meta) throw new Error('Identity not found')
    meta.name = trimmed
    saveIdentities(identities)
    return { id: identityId, name: trimmed }
  })

  ipcMain.handle('vault:changePassphrase', async (_event, identityId: string, currentPassphrase: string, newPassphrase: string) => {
    if (!newPassphrase) throw new Error('New passphrase cannot be empty')
    const vaultPath = path.join(VAULT_DIR, `${identityId}.vault`)
    if (!fs.existsSync(vaultPath)) throw new Error('Identity not found')
    // Verifying against the on-disk vault proves the caller knows the current
    // passphrase, even if the in-memory session was unlocked differently.
    const envelope = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'))
    let payload: VaultPayload
    try {
      payload = decryptVault(envelope, currentPassphrase)
    } catch {
      throw new Error('Current passphrase is incorrect')
    }
    persistVault(identityId, payload, newPassphrase)
    const session = unlockedSessions.get(identityId)
    if (session) {
      session.payload = payload
      session.passphrase = newPassphrase
    }
  })

  ipcMain.handle('vault:getSettings', async (_event, identityId: string) => {
    const session = unlockedSessions.get(identityId)
    if (!session) throw new Error('Identity is locked')
    return session.payload.settings
  })

  ipcMain.handle('vault:listAccounts', async (_event, identityId: string) => {
    const session = unlockedSessions.get(identityId)
    if (!session) throw new Error('Identity is locked')
    return session.payload.accounts
  })

  ipcMain.handle('vault:exportVault', async (_event, identityId: string) => {
    if (!unlockedSessions.has(identityId)) throw new Error('Identity is locked')
    const vaultPath = path.join(VAULT_DIR, `${identityId}.vault`)
    if (!fs.existsSync(vaultPath)) throw new Error('Identity not found')
    const meta = getIdentities().find((i) => i.id === identityId)
    const safeName = (meta?.name ?? 'identity').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
    const result = await dialog.showSaveDialog({
      defaultPath: `nvelope-${safeName}.vault`,
      filters: [
        { name: 'nVelope vault', extensions: ['vault'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    fs.copyFileSync(vaultPath, result.filePath)
    return { canceled: false, path: result.filePath }
  })
}
