import { ipcMain } from 'electron'
import { queryProfile } from 'nostr-tools/nip05'

export function registerNip05Handlers(): void {
  ipcMain.handle('nip05:resolve', async (_event, identifier: string) => {
    const trimmed = identifier.trim().toLowerCase()
    if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) {
      throw new Error('Invalid NIP-05 identifier (expected user@domain)')
    }
    const profile = await queryProfile(trimmed)
    if (!profile) {
      throw new Error(`No Nostr key published for ${trimmed}`)
    }
    return { pubkey: profile.pubkey, nip05: trimmed, relays: profile.relays ?? [] }
  })
}
