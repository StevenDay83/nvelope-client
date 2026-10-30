import { Worker } from 'node:worker_threads'
import { createHash, randomBytes } from 'node:crypto'
import { availableParallelism } from 'node:os'

/**
 * Parallel PoW mining for kind-8500 envelope templates.
 *
 * The library's built-in miner hashes with nostr-tools' pure-JS SHA-256,
 * single-threaded, on the main-process event loop — roughly 12x slower than
 * the native benchmark on a real (~3.5 KB) envelope preimage and blocking
 * the event loop for the whole mine. Here each worker hashes the identical
 * NIP-01 commitment with node:crypto (native) on its own thread, and workers
 * partition the nonce space by stride so no candidate is hashed twice.
 *
 * Runs are serialized through a queue: mining saturates every core, so two
 * concurrent runs would only halve each other's throughput.
 */

export interface PowTemplate {
  kind: number
  created_at: number
  pubkey: string
  tags: string[][]
  content: string
}

export function getMiningWorkerCount(): number {
  return Math.max(1, availableParallelism() - 1)
}

/** Target as 64-char lowercase hex; equal-length lowercase hex compares numerically as plain strings. */
function normalizeTargetHex(targetHex: string): string {
  return targetHex.toLowerCase().padStart(64, '0')
}

function hashWithNonce(template: PowTemplate, nonce: string): string {
  const tags = [...template.tags, ['nonce', nonce]]
  const preimage = JSON.stringify([0, template.pubkey, template.created_at, template.kind, tags, template.content])
  return createHash('sha256').update(preimage, 'utf8').digest('hex')
}

// Self-contained worker source (eval: true) so there is no extra file to
// resolve inside the packaged app's bundle.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const target = workerData.targetHex
const template = workerData.template
const stride = BigInt(workerData.stride)
let nonce = BigInt(workerData.base)
const REPORT_EVERY = 1 << 16
let attempts = 0
for (;;) {
  const tags = template.tags.concat([['nonce', nonce.toString(10)]])
  const preimage = JSON.stringify([0, template.pubkey, template.created_at, template.kind, tags, template.content])
  const hash = createHash('sha256').update(preimage, 'utf8').digest('hex')
  attempts++
  if (hash < target) {
    parentPort.postMessage({ type: 'found', nonce: nonce.toString(10), attempts })
    break
  }
  nonce += stride
  if (attempts % REPORT_EVERY === 0) parentPort.postMessage({ type: 'progress', attempts })
}
`

interface MineRequest {
  template: PowTemplate
  targetHex: string
  onProgress?: (attempts: number) => void
  signal?: AbortSignal
  resolve: (mined: PowTemplate) => void
  reject: (err: unknown) => void
  onQueuedAbort?: () => void
}

const queue: MineRequest[] = []
let running = false

export function mineEnvelopePow(
  template: PowTemplate,
  targetHex: string,
  options: { signal?: AbortSignal; onProgress?: (attempts: number) => void } = {},
): Promise<PowTemplate> {
  return new Promise((resolve, reject) => {
    const request: MineRequest = {
      template,
      targetHex: normalizeTargetHex(targetHex),
      onProgress: options.onProgress,
      signal: options.signal,
      resolve,
      reject,
    }
    if (request.signal?.aborted) {
      reject(abortError())
      return
    }
    // Allow cancellation while still waiting in the queue.
    request.onQueuedAbort = () => {
      const idx = queue.indexOf(request)
      if (idx >= 0) {
        queue.splice(idx, 1)
        reject(abortError())
      }
    }
    request.signal?.addEventListener('abort', request.onQueuedAbort, { once: true })
    queue.push(request)
    void pumpQueue()
  })
}

function abortError(): Error {
  const err = new Error('Proof-of-work mining aborted')
  err.name = 'AbortError'
  return err
}

async function pumpQueue(): Promise<void> {
  if (running) return
  const request = queue.shift()
  if (!request) return
  running = true
  if (request.onQueuedAbort) request.signal?.removeEventListener('abort', request.onQueuedAbort)
  try {
    request.resolve(await runMine(request))
  } catch (err) {
    request.reject(err)
  } finally {
    running = false
    void pumpQueue()
  }
}

function runMine(request: MineRequest): Promise<PowTemplate> {
  return new Promise((resolve, reject) => {
    const { template, targetHex, signal } = request
    const workerCount = getMiningWorkerCount()
    const base = randomBytes(8).readBigUInt64LE()
    const latestAttempts = new Array<number>(workerCount).fill(0)
    const workers: Worker[] = []
    let settled = false

    const onAbort = () => settle(() => reject(abortError()))
    const cleanup = () => {
      for (const w of workers) void w.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    for (let i = 0; i < workerCount; i++) {
      // Worker i covers nonces base+i, base+i+stride, base+i+2*stride, ...
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { template, targetHex, base: (base + BigInt(i)).toString(), stride: workerCount },
      })
      worker.unref()
      workers.push(worker)

      worker.on('message', (msg: { type: string; nonce?: string; attempts?: number }) => {
        if (msg.type === 'progress' && typeof msg.attempts === 'number') {
          latestAttempts[i] = msg.attempts
          let total = 0
          for (const a of latestAttempts) total += a
          request.onProgress?.(total)
          return
        }
        if (msg.type === 'found' && typeof msg.nonce === 'string') {
          // Cheap one-shot verification before trusting the result.
          if (hashWithNonce(template, msg.nonce) >= targetHex) {
            settle(() => reject(new Error('PoW worker returned an invalid nonce')))
            return
          }
          const mined: PowTemplate = { ...template, tags: [...template.tags, ['nonce', msg.nonce]] }
          settle(() => resolve(mined))
        }
      })
      worker.on('error', (err) => settle(() => reject(err)))
      worker.on('exit', (code) => {
        if (code !== 0) settle(() => reject(new Error(`PoW worker exited with code ${code}`)))
      })
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
