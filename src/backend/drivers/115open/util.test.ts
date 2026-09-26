import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import {
  Pan115GlobalCoordinator,
  __setPan115CoordinatorStoreForTest,
} from "./coordinator"
import { Pan115Driver } from "./driver"
import { Pan115Client } from "./util"

const originalFetch = globalThis.fetch
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  __setPan115CoordinatorStoreForTest(undefined)
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeBlobStore {
  readonly values = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async set(
    key: string,
    value: string,
    options?: { onlyIfNew?: boolean },
  ): Promise<void> {
    if (options?.onlyIfNew && this.values.has(key)) {
      const error: any = new Error("precondition failed: key already exists")
      error.name = "PreconditionFailedError"
      throw error
    }
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

test("local rate limiter serializes concurrent callers", async () => {
  const starts: number[] = []
  globalThis.fetch = (async () => {
    starts.push(Date.now())
    return jsonResponse({ state: true, code: 0, data: {} })
  }) as typeof fetch

  const client = new Pan115Client({
    access_token: "access",
    refresh_token: "refresh",
    limit_rate: 50,
  })
  await Promise.all([client.userInfo(), client.userInfo(), client.userInfo()])

  assert.equal(starts.length, 3)
  assert.ok(starts[1] - starts[0] >= 15)
  assert.ok(starts[2] - starts[1] >= 15)
})

test("cross-instance limiter hook replaces the per-client limiter", () => {
  const client = new Pan115Client(
    {
      access_token: "access",
      refresh_token: "refresh",
      limit_rate: 0.2,
    },
    { beforeRequest: async () => {} },
  )

  assert.equal((client as any).rateLimitMs, 0)
})

test("concurrent auth failures share one refresh and await token persistence", async () => {
  let refreshCalls = 0
  let persisted = false
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.includes("passportapi.115.com/open/refreshToken")) {
      refreshCalls++
      await sleep(20)
      return jsonResponse({
        state: true,
        code: 0,
        data: { access_token: "access-new", refresh_token: "refresh-new" },
      })
    }
    const auth = new Headers(init?.headers).get("Authorization")
    if (auth === "Bearer access-new") {
      return jsonResponse({ state: true, code: 0, data: { user_id: 1 } })
    }
    return jsonResponse({
      state: false,
      code: 40140101,
      message: "expired",
      data: null,
    })
  }) as typeof fetch

  const client = new Pan115Client(
    { access_token: "access-old", refresh_token: "refresh-old" },
    {
      onTokenUpdate: async () => {
        await sleep(20)
        persisted = true
      },
    },
  )

  await Promise.all([client.userInfo(), client.userInfo()])
  assert.equal(refreshCalls, 1)
  assert.equal(persisted, true)
  assert.equal(client.refreshTokenValue, "refresh-new")
})

test("a stale instance adopts the token already rotated by another instance", async () => {
  let refreshCalls = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.includes("passportapi.115.com/open/refreshToken")) {
      refreshCalls++
      throw new Error("stale refresh token must not be used")
    }
    const auth = new Headers(init?.headers).get("Authorization")
    if (auth === "Bearer access-new") {
      return jsonResponse({ state: true, code: 0, data: { user_id: 1 } })
    }
    return jsonResponse({
      state: false,
      code: 40140101,
      message: "expired",
      data: null,
    })
  }) as typeof fetch

  const client = new Pan115Client(
    { access_token: "access-old", refresh_token: "refresh-old" },
    {
      syncLatestTokens: async () => ({
        access_token: "access-new",
        refresh_token: "refresh-new",
      }),
    },
  )

  await client.userInfo()
  assert.equal(refreshCalls, 0)
  assert.equal(client.refreshTokenValue, "refresh-new")
})

test("global time slots serialize separate function coordinators", async () => {
  const store = new FakeBlobStore()
  __setPan115CoordinatorStoreForTest(store)
  const first = new Pan115GlobalCoordinator("storage-1", 100)
  const second = new Pan115GlobalCoordinator("storage-1", 100)

  const starts: number[] = []
  await Promise.all([
    first.beforeRequest().then(() => starts.push(Date.now())),
    second.beforeRequest().then(() => starts.push(Date.now())),
  ])
  starts.sort((a, b) => a - b)

  assert.equal(starts.length, 2)
  // Coordinator clamps the global interval to 50 ms.
  assert.ok(starts[1] - starts[0] >= 35)
})

test("refresh lease and circuit breaker are shared across instances", async () => {
  const store = new FakeBlobStore()
  __setPan115CoordinatorStoreForTest(store)
  const first = new Pan115GlobalCoordinator("storage-1", 0)
  const second = new Pan115GlobalCoordinator("storage-1", 0)

  assert.equal(await first.tryAcquireRefreshLease(), true)
  assert.equal(await second.tryAcquireRefreshLease(), false)

  await first.reportApiError(405)
  await assert.rejects(
    () => second.beforeRequest(),
    (error: any) => error?.code === 405 && error?.retryAfter > 0,
  )
})

test("refresh lease remains exclusive across a time-slot boundary", async () => {
  const store = new FakeBlobStore()
  __setPan115CoordinatorStoreForTest(store)
  const first = new Pan115GlobalCoordinator("storage-1", 0)
  const second = new Pan115GlobalCoordinator("storage-1", 0)

  Date.now = () => 29_999
  assert.equal(await first.tryAcquireRefreshLease(), true)

  Date.now = () => 30_001
  assert.equal(await second.tryAcquireRefreshLease(), false)
})

test("concurrent directory listings are coalesced inside one instance", async () => {
  let listCalls = 0
  globalThis.fetch = (async () => {
    listCalls++
    await sleep(20)
    return jsonResponse({
      state: true,
      code: 0,
      count: 1,
      data: [
        {
          fid: "1",
          aid: "1",
          pid: "0",
          fc: "0",
          fn: "Movie",
          fco: "",
          pc: "",
          upt: 1,
          uet: 1,
          uppt: 1,
          sha1: "",
          fs: 0,
          ico: "",
          thumbnail: "",
        },
      ],
    })
  }) as typeof fetch

  const driver = new Pan115Driver({
    access_token: "access",
    refresh_token: "refresh",
    root_id: "0",
  })
  const [a, b] = await Promise.all([
    driver.list("/", "/"),
    driver.list("/", "/"),
  ])

  assert.equal(listCalls, 1)
  assert.equal(a[0]?.name, "Movie")
  assert.deepEqual(a, b)
})
