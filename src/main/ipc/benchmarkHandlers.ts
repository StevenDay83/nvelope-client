import { ipcMain } from 'electron'
import { getEventHash, generateSecretKey, finalizeEvent } from 'nostr-tools/pure'

/**
 * Run a 10-second PoW benchmark: hash as many events as possible.
 * Returns hashes per second and per minute.
 */
export function registerBenchmarkHandlers(): void {
  ipcMain.handle('benchmark:runPow', async () => {
    const durationMs = 10_000
    const sk = generateSecretKey()
    const start = Date.now()
    let count = 0

    while (Date.now() - start < durationMs) {
      const event = finalizeEvent(
        {
          kind: 8500,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: `benchmark-${count}`,
        },
        sk,
      )
      getEventHash(event)
      count++
    }

    const elapsedSeconds = (Date.now() - start) / 1000
    const hashesPerSecond = Math.round(count / elapsedSeconds)
    const hashesPerMinute = hashesPerSecond * 60

    return { hashesPerSecond, hashesPerMinute }
  })
}
