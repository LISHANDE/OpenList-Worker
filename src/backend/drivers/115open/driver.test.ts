import assert from "node:assert/strict"
import test from "node:test"
import { Pan115Driver } from "./driver"

const addition = {
  access_token: "access",
  refresh_token: "refresh",
  root_id: "0",
  page_size: 200,
}

function apiError(code: number | string): Error & { code: number | string } {
  const error = new Error(`115 error ${code}`) as Error & {
    code: number | string
  }
  error.code = code
  return error
}

const rootListing = {
  files: [
    {
      fid: "folder-jav",
      fn: "JAV",
      fc: "0",
      fs: 0,
      upt: 1,
    },
  ],
  count: 1,
}

test("retries a transient string-coded 20009 parent error once", async () => {
  const driver = new Pan115Driver(addition, {}, "retry-20009")
  let calls = 0
  ;(driver as any).client = {
    getFiles: async () => {
      calls++
      if (calls === 1) throw apiError("20009")
      return rootListing
    },
  }

  const result = await driver.list("/", "/")
  assert.equal(calls, 2)
  assert.equal(result[0]?.name, "JAV")
})

test("reuses a warm-isolate directory listing for the same storage scope", async () => {
  const first = new Pan115Driver(addition, {}, "shared-directory-cache")
  let calls = 0
  ;(first as any).client = {
    getFiles: async () => {
      calls++
      return rootListing
    },
  }
  await first.list("/", "/")

  const second = new Pan115Driver(addition, {}, "shared-directory-cache")
  ;(second as any).client = {
    getFiles: async () => {
      throw new Error("the second request should be served from cache")
    },
  }
  const result = await second.list("/", "/")
  assert.equal(calls, 1)
  assert.equal(result[0]?.name, "JAV")
})

test("reuses a listed child folder id across WebDAV driver instances", async () => {
  const first = new Pan115Driver(addition, {}, "shared-child-folder-id")
  ;(first as any).client = { getFiles: async () => rootListing }
  await first.list("/", "/")

  const second = new Pan115Driver(addition, {}, "shared-child-folder-id")
  let childListings = 0
  ;(second as any).client = {
    getFolderInfoByPath: async () => {
      throw new Error("a listed child must not be resolved a second time")
    },
    getFiles: async (opts: { cid: string }) => {
      assert.equal(opts.cid, "folder-jav")
      childListings++
      return { files: [], count: 0 }
    },
  }
  await second.list("/JAV", "/JAV")
  assert.equal(childListings, 1)
})

test("initializing a non-root mount does not make a redundant API request", async () => {
  const driver = new Pan115Driver(
    { ...addition, root_id: "folder-jav" },
    {},
    "init-without-root-lookup",
  )
  ;(driver as any).client = {
    getFolderInfo: async () => {
      throw new Error("init must not resolve an unused root path")
    },
  }

  await driver.init()
})

test("uses a 1000-item default page to avoid extra directory requests", async () => {
  const driver = new Pan115Driver(
    { access_token: "access", refresh_token: "refresh", root_id: "0" },
    {},
    "default-page-size",
  )
  let requestedLimit = 0
  ;(driver as any).client = {
    getFiles: async (opts: { limit: number }) => {
      requestedLimit = opts.limit
      return rootListing
    },
  }

  await driver.init()
  await driver.list("/", "/")
  assert.equal(requestedLimit, 1000)
})
