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
