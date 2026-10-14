import { ipcMain } from 'electron'
import { generateMailCertificate, publicKeyDerBase64FromPrivateKeyPem } from 'nvelope-core'

export function registerCertHandlers(): void {
  ipcMain.handle('cert:generate', async (_event, keySize: 2048 | 4096 = 4096) => {
    const cert = generateMailCertificate(keySize)
    return {
      privateKeyPem: cert.privateKeyPem,
      publicKeyDerBase64: cert.publicKeyDerBase64,
    }
  })

  ipcMain.handle('cert:derivePublic', async (_event, privateKeyPem: string) => {
    try {
      const publicKeyDerBase64 = publicKeyDerBase64FromPrivateKeyPem(privateKeyPem)
      return { publicKeyDerBase64 }
    } catch {
      return { publicKeyDerBase64: '' }
    }
  })
}
