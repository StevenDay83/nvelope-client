import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'

/**
 * Run a 10-second PoW benchmark: hash as many envelope candidates as possible.
 * Returns hashes per second and per minute.
 *
 * The preimage matches what the mining workers actually hash: a NIP-01
 * commitment for a kind-8500 envelope whose content is a realistic encrypted
 * payload (~4 KB). An earlier version hashed a tiny synthetic event, which
 * overstates the real rate ~12x (pure-JS SHA-256 cost scales with preimage
 * size) and led to policies that mined far harder than intended.
 *
 * Measured single-threaded with node:crypto, matching one mining worker.
 * ETAs for actual sends multiply this rate by the worker count.
 */

// Typical encrypted-envelope content size for a short message (base64 chunks JSON).
const ENVELOPE_CONTENT_CHARS = 4096

export function registerBenchmarkHandlers(): void {
  ipcMain.handle('benchmark:runPow', async () => {
    const durationMs = 10_000
    const pubkey = '00'.repeat(32)
    const content = 'a'.repeat(ENVELOPE_CONTENT_CHARS)
    const createdAt = Math.floor(Date.now() / 1000)
    const start = Date.now()
    let count = 0

    while (Date.now() - start < durationMs) {
      const tags = [['l', 'dm'], ['nonce', String(count)]]
      const preimage = JSON.stringify([0, pubkey, createdAt, 8500, tags, content])
      createHash('sha256').update(preimage, 'utf8').digest('hex')
      count++
    }

    const elapsedSeconds = (Date.now() - start) / 1000
    const hashesPerSecond = Math.round(count / elapsedSeconds)
    const hashesPerMinute = hashesPerSecond * 60

    return { hashesPerSecond, hashesPerMinute }
  })
}
