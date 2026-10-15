import { ipcMain } from 'electron'
import { getEventHash } from 'nostr-tools/pure'

/**
 * Run a 10-second PoW benchmark: hash as many events as possible.
 * Returns hashes per second and per minute.
 *
 * This measures HASH-ONLY throughput, matching what the miner actually does:
 * minePow hashes unsigned candidates with an incrementing nonce and signs
 * once at the end. (An earlier version signed every iteration with
 * finalizeEvent — Schnorr signing is ~60x slower than hashing, so the
 * stored rate came out far too low and policies mined ~6 bits too easy.)
 */
export function registerBenchmarkHandlers(): void {
  ipcMain.handle('benchmark:runPow', async () => {
    const durationMs = 10_000
    const pubkey = '00'.repeat(32)
    const start = Date.now()
    let count = 0

    while (Date.now() - start < durationMs) {
      getEventHash({
        kind: 8500,
        created_at: Math.floor(Date.now() / 1000),
        pubkey,
        tags: [['nonce', String(count)]],
        content: 'benchmark',
      })
      count++
    }

    const elapsedSeconds = (Date.now() - start) / 1000
    const hashesPerSecond = Math.round(count / elapsedSeconds)
    const hashesPerMinute = hashesPerSecond * 60

    return { hashesPerSecond, hashesPerMinute }
  })
}
