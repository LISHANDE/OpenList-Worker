/**
 * Cross-instance coordination for the 115 Open driver on EdgeOne Makers.
 *
 * A module-level limiter only protects one warm function instance. Makers may
 * run many Node function instances at once, so media-library scans can still
 * fan out into a burst. EdgeOne Blob offers a strong-consistency conditional
 * create (`onlyIfNew`); time-slot keys turn that primitive into a small global
 * request gate without relying on a non-atomic read/modify/write lock.
 */

type BlobStoreLike = {
  get(
    key: string,
    options?: { consistency?: "strong" | "eventual" },
  ): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: { onlyIfNew?: boolean; cacheControl?: string | null },
  ): Promise<void>
  delete(key: string): Promise<void>
}

const STORE_NAME = "openlist_db"
const CIRCUIT_BREAKER_MS = 10 * 60 * 1000
// 770004 is an upstream access ceiling. Its reset time is not documented;
// use a longer quiet period to avoid repeated scans consuming more requests.
const ACCESS_LIMIT_BREAKER_MS = 30 * 60 * 1000
const REFRESH_LEASE_MS = 30 * 1000
const MAX_RATE_WAIT_MS = 8 * 1000

let injectedStore: BlobStoreLike | null | undefined
let storePromise: Promise<BlobStoreLike | null> | null = null
let storeWarningPrinted = false

async function getCoordinationStore(): Promise<BlobStoreLike | null> {
  if (injectedStore !== undefined) return injectedStore
  if (!storePromise) {
    storePromise = import("@edgeone/pages-blob")
      .then(
        ({ getStore }) =>
          getStore({
            name: STORE_NAME,
            consistency: "strong",
          } as any) as unknown as BlobStoreLike,
      )
      .catch((error) => {
        storePromise = null
        if (!storeWarningPrinted) {
          storeWarningPrinted = true
          console.warn(
            "[115open] global coordinator unavailable; falling back to " +
              `per-instance protection: ${error?.message || error}`,
          )
        }
        return null
      })
  }
  return storePromise
}

function safeKeyPart(value: string): string {
  const clean = String(value || "default").replace(/[^a-zA-Z0-9_]/g, "_")
  return clean.slice(0, 80) || "default"
}

function isPreconditionFailure(error: any): boolean {
  const code = String(error?.code || "").toLowerCase()
  const name = String(error?.name || "").toLowerCase()
  const message = String(error?.message || "").toLowerCase()
  return (
    code.includes("precondition") ||
    name.includes("precondition") ||
    message.includes("precondition") ||
    message.includes("already exists") ||
    message.includes("onlyifnew")
  )
}

async function claimSlot(
  store: BlobStoreLike,
  key: string,
  value: string,
): Promise<boolean> {
  try {
    await store.set(key, value, { onlyIfNew: true, cacheControl: null })
    return true
  } catch (error) {
    if (isPreconditionFailure(error)) return false
    throw error
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class Pan115GlobalCoordinator {
  private readonly storageKey: string
  private readonly rate: number
  private localCircuitUntil = 0
  private localCircuitCode = 405

  constructor(storageKey: string, rate: number) {
    this.storageKey = safeKeyPart(storageKey)
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 0
  }

  private circuitKey(): string {
    return `openlist_115_circuit_${this.storageKey}`
  }

  private throwCircuitOpen(until: number, code: number): never {
    const waitSeconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
    const error: any = new Error(
      `115 网盘已因上游限流进入保护期，请约 ${waitSeconds} 秒后再试`,
    )
    error.code = code
    error.retryAfter = waitSeconds
    throw error
  }

  private async assertCircuitClosed(
    store: BlobStoreLike | null,
  ): Promise<void> {
    if (this.localCircuitUntil > Date.now()) {
      this.throwCircuitOpen(this.localCircuitUntil, this.localCircuitCode)
    }
    if (!store) return
    try {
      const raw = await store.get(this.circuitKey(), { consistency: "strong" })
      if (!raw) return
      const parsed = JSON.parse(raw)
      const until = Number(parsed?.until || 0)
      if (until > Date.now()) {
        this.localCircuitUntil = until
        this.localCircuitCode = Number(parsed?.code || 405)
        this.throwCircuitOpen(until, this.localCircuitCode)
      }
    } catch (error: any) {
      if (Number(error?.retryAfter) > 0) throw error
      console.warn(
        `[115open] failed to read circuit state: ${error?.message || error}`,
      )
    }
  }

  /** Called before every 115 API request. */
  async beforeRequest(): Promise<void> {
    const store = await getCoordinationStore()
    await this.assertCircuitClosed(store)
    if (!store || this.rate <= 0) return

    const intervalMs = Math.max(50, Math.ceil(1000 / this.rate))
    const deadline = Date.now() + MAX_RATE_WAIT_MS
    while (Date.now() <= deadline) {
      const now = Date.now()
      const slot = Math.floor(now / intervalMs)
      const key = `openlist_115_rate_${this.storageKey}_${slot}`
      const owner = `${now}_${Math.random().toString(36).slice(2)}`
      if (await claimSlot(store, key, owner)) {
        // Release requests at deterministic slot boundaries. Merely allowing
        // one request inside each wall-clock slot is insufficient: one request
        // at the very end of slot N and another at the start of N+1 would still
        // form a burst. Scheduling winners at the end of their claimed slot
        // guarantees adjacent winners are separated by the full interval.
        const scheduledAt = (slot + 1) * intervalMs
        const delay = scheduledAt - Date.now()
        if (delay > 0) await sleep(delay)
        await this.assertCircuitClosed(store)
        // Best-effort bounded cleanup. The exact old slot can no longer be used,
        // so deleting it cannot interfere with the current limiter window.
        const oldKey = `openlist_115_rate_${this.storageKey}_${slot - 120}`
        store.delete(oldKey).catch(() => {})
        return
      }
      const nextSlotAt = (slot + 1) * intervalMs
      await sleep(
        Math.max(20, nextSlotAt - Date.now() + Math.floor(Math.random() * 40)),
      )
      await this.assertCircuitClosed(store)
    }

    const error: any = new Error("115 网盘全局请求队列繁忙，请稍后重试")
    error.code = 429
    error.retryAfter = 3
    throw error
  }

  /** Only one function instance may rotate a refresh token in each lease window. */
  async tryAcquireRefreshLease(): Promise<boolean> {
    const store = await getCoordinationStore()
    if (!store) return true
    const slot = Math.floor(Date.now() / REFRESH_LEASE_MS)
    const key = `openlist_115_refresh_${this.storageKey}_${slot}`
    const acquired = await claimSlot(
      store,
      key,
      `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    )
    if (!acquired) return false

    // Also honor the previous slot. Without this check, one refresher could
    // acquire slot N at 29.9s and another acquire N+1 at 30.1s, allowing two
    // consumers of a one-time refresh token only milliseconds apart.
    const previousKey = `openlist_115_refresh_${this.storageKey}_${slot - 1}`
    const previous = await store.get(previousKey, { consistency: "strong" })
    if (previous) {
      // This invocation owns the just-created current key, so removing it is
      // safe and lets a later retry proceed after the previous lease ages out.
      await store.delete(key).catch(() => {})
      return false
    }

    store
      .delete(`openlist_115_refresh_${this.storageKey}_${slot - 4}`)
      .catch(() => {})
    return true
  }

  async reportApiError(code: number): Promise<void> {
    if (code !== 405 && code !== 429 && code !== 770004) return
    const until = Date.now() +
      (code === 770004 ? ACCESS_LIMIT_BREAKER_MS : CIRCUIT_BREAKER_MS)
    this.localCircuitUntil = until
    this.localCircuitCode = code
    const store = await getCoordinationStore()
    if (!store) return
    try {
      await store.set(
        this.circuitKey(),
        JSON.stringify({ until, code, createdAt: Date.now() }),
        { cacheControl: null },
      )
    } catch (error: any) {
      console.warn(
        `[115open] failed to persist circuit state: ${error?.message || error}`,
      )
    }
  }
}

/** Test-only store injection. */
export function __setPan115CoordinatorStoreForTest(
  store: BlobStoreLike | null | undefined,
): void {
  injectedStore = store
  storePromise = null
  storeWarningPrinted = false
}
