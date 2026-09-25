import { Hono } from "hono"
import { authUserFromReq, getOrInitUsers, verifyUserPassword } from "./auth"
import { can, PermissionBit } from "../pkg/permission"
import {
  listItems,
  getItem,
  putItem,
  makeDirectory,
  removeItems,
  moveItems,
  copyItems,
} from "../internal/op/storage"
import { buildWebDavPropfindResponse } from "../internal/webdav/webdav"
import { safeErrorMessage } from "../pkg/errs"
import { encodeDownloadPath } from "../pkg/path"

/**
 * WebDAV 协议服务（挂载于 /dav/*）。
 *
 * 认证：Basic Auth（用户名/密码）或 Bearer token（全局 token）。
 * 权限：WEBDAV_READ（读/列目录）与 WEBDAV_MANAGE（写/删/移动/复制）按位校验。
 * 支持方法：OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE / COPY。
 */

export const webdavRouter = new Hono()

const getStorageRequestContext = (c: any) => {
  const context: Record<string, any> = {
    env: c.env, // 传递 env 用于请求级 KV 缓存复用
    userAgent: c.req.header("User-Agent") || "",
  }
  try {
    const executionCtx = c.executionCtx
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      context.waitUntil = (p: Promise<unknown>) => executionCtx.waitUntil(p)
    }
  } catch {}
  return context
}

/** Basic Auth 或 Bearer token 认证，返回用户对象（未认证返回 null） */
async function webdavAuth(c: any): Promise<any> {
  const authHeader = c.req.header("Authorization") || ""
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.substring(6).trim())
      const idx = decoded.indexOf(":")
      if (idx < 0) return null
      const username = decoded.substring(0, idx)
      const password = decoded.substring(idx + 1)
      const { users } = await getOrInitUsers(c.env)
      const user = users.find(
        (u: any) => u.username === username && !u.disabled,
      )
      if (!user) return null
      // 空密码用户（guest）：Basic Auth 下若未提供密码则允许（与 AList 一致）
      if (!user.password) {
        return password === "" ? user : null
      }
      if (await verifyUserPassword(user, password)) return user
      return null
    } catch {
      return null
    }
  }
  if (authHeader.startsWith("Bearer ")) {
    const auth = await authUserFromReq(c)
    return auth ? auth.user : null
  }
  return null
}

/** 从 URL pathname 中剥离 /dav 前缀，得到虚拟文件路径 */
function davPathOf(c: any): string {
  const pathname = new URL(c.req.url).pathname
  let p = pathname.replace(/^\/dav/, "")
  if (!p) p = "/"
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

/** 拆分虚拟路径为 { dir, name } */
function splitPath(p: string): { dir: string; name: string } {
  const clean = p.startsWith("/") ? p : "/" + p
  const parts = clean.split("/").filter(Boolean)
  const name = parts.pop() || ""
  const dir = "/" + parts.join("/")
  return { dir, name }
}

webdavRouter.all("/*", async (c) => {
  const requestStarted = Date.now()
  const authStarted = Date.now()
  const user = await webdavAuth(c)
  const authMs = Date.now() - authStarted
  const recordTiming = (operation: string, operationStarted?: number) => {
    const operationMs =
      operationStarted === undefined ? 0 : Date.now() - operationStarted
    const totalMs = Date.now() - requestStarted
    const parts = [`auth;dur=${authMs}`]
    if (operationStarted !== undefined) {
      parts.push(`storage;dur=${operationMs}`)
    }
    parts.push(`total;dur=${totalMs}`)
    c.header("Server-Timing", parts.join(", "))
    if (totalMs >= 500) {
      console.info(
        `[perf][webdav] method=${c.req.method} operation=${operation} ` +
          `path=${new URL(c.req.url).pathname} auth_ms=${authMs} ` +
          `storage_ms=${operationMs} total_ms=${totalMs}`,
      )
    }
  }

  if (!user) {
    recordTiming("unauthorized")
    return c.text("Unauthorized", 401, {
      "WWW-Authenticate": 'Basic realm="OpenList"',
    })
  }
  const canRead = can(user, PermissionBit.WEBDAV_READ)
  const canManage = can(user, PermissionBit.WEBDAV_MANAGE)
  if (!canRead && !canManage) {
    return c.text("Forbidden", 403)
  }

  const method = c.req.method.toUpperCase()
  const davPath = davPathOf(c)
  const ctx = getStorageRequestContext(c)

  try {
    switch (method) {
      case "OPTIONS": {
        c.header("DAV", "1, 2")
        c.header(
          "Allow",
          "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY",
        )
        c.header("MS-Author-Via", "DAV")
        return c.body(null, 200)
      }

      case "PROPFIND": {
        if (!canRead) return c.text("Forbidden", 403)
        const operationStarted = Date.now()
        const depth = c.req.header("Depth") || "1"
        const res = await listItems(davPath, ctx)
        const items = (res.content || []).map((it: any) => ({
          name: it.name,
          size: it.size || 0,
          isFolder: !!it.is_dir,
          modified: it.modified || new Date().toISOString(),
        }))
        const virtualHref =
          davPath === "/"
            ? "/"
            : davPath.endsWith("/")
              ? davPath
              : davPath + "/"
        // WebDAV href values are absolute URL paths. davPathOf() strips the
        // route prefix for storage lookup, so add it back before returning XML.
        // Without /dav, clients follow /115/... into the SPA route and GET
        // returns 404 even though PROPFIND/login succeeded.
        const href = virtualHref === "/" ? "/dav/" : `/dav${virtualHref}`
        const xml = buildWebDavPropfindResponse(href, items)
        recordTiming("propfind", operationStarted)
        return c.body(xml, depth === "0" ? 207 : 207, {
          "Content-Type": "application/xml; charset=utf-8",
        })
      }

      case "GET":
      case "HEAD": {
        if (!canRead) return c.text("Forbidden", 403)
        const operationStarted = Date.now()
        const { item, rawUrl, provider } = await getItem(davPath, ctx)
        if (!item) return c.text("Not found", 404)
        if (item.is_dir) return c.text("Is a directory", 400)

        // 115 Open 的直链已按当前 WebDAV 客户端 UA 生成。直接把播放器重定向
        // 到 115 CDN，省掉 /api/d 的第二次文件解析；短时缓存重定向，播放器
        // 在拖动进度条反复发 Range 请求时可复用同一条临时直链。
        const normalizedProvider = String(provider || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
        if (normalizedProvider === "115open" && item.raw_url) {
          try {
            const direct = new URL(item.raw_url)
            if (direct.protocol === "https:") {
              // 307 keeps GET + Range semantics across the redirect. The short
              // private cache lets capable clients reuse the UA-bound 115 link.
              c.header("Cache-Control", "private, max-age=600")
              c.header(
                "Expires",
                new Date(Date.now() + 10 * 60 * 1000).toUTCString(),
              )
              c.header("Vary", "Authorization, User-Agent")
              recordTiming("direct_redirect", operationStarted)
              return c.redirect(direct.toString(), 307)
            }
          } catch {}
        }

        // 其他驱动仍重定向到 rawRouter；它会按存储策略处理
        // proxy/redirect/stream、Range、签名与 SSRF 防护。
        recordTiming("raw_redirect", operationStarted)
        return c.redirect(
          rawUrl || `/api/d${encodeDownloadPath(davPath)}`,
          302,
        )
      }

      case "PUT": {
        if (!canManage) return c.text("Forbidden", 403)
        const buffer = Buffer.from(await c.req.arrayBuffer())
        await putItem(davPath, buffer, ctx)
        return c.body(null, 201)
      }

      case "MKCOL": {
        if (!canManage) return c.text("Forbidden", 403)
        await makeDirectory(davPath, ctx)
        return c.body(null, 201)
      }

      case "DELETE": {
        if (!canManage) return c.text("Forbidden", 403)
        const { dir, name } = splitPath(davPath)
        await removeItems(dir, [name], ctx)
        return c.body(null, 204)
      }

      case "MOVE": {
        if (!canManage) return c.text("Forbidden", 403)
        const destRaw = c.req.header("Destination") || ""
        let dest = destRaw
        try {
          dest = decodeURIComponent(
            new URL(destRaw, c.req.url).pathname,
          ).replace(/^\/dav/, "")
        } catch {}
        const src = splitPath(davPath)
        const dst = splitPath(dest)
        await moveItems(src.dir, dst.dir, [src.name], ctx)
        return c.body(null, 201)
      }

      case "COPY": {
        if (!canManage) return c.text("Forbidden", 403)
        const destRaw = c.req.header("Destination") || ""
        let dest = destRaw
        try {
          dest = decodeURIComponent(
            new URL(destRaw, c.req.url).pathname,
          ).replace(/^\/dav/, "")
        } catch {}
        const src = splitPath(davPath)
        const dst = splitPath(dest)
        await copyItems(src.dir, dst.dir, [src.name], ctx)
        return c.body(null, 201)
      }

      case "LOCK":
      case "UNLOCK":
        // 简化实现：声明不支持锁，客户端通常可继续无锁操作
        return c.text("Locking not supported", 405)

      default:
        return c.text("Method Not Allowed", 405)
    }
  } catch (e: any) {
    recordTiming("error")
    const msg = safeErrorMessage(e)
    if (msg.includes("not found") || msg.includes("storage not found")) {
      return c.text("Not Found", 404)
    }
    return c.text(msg, 500)
  }
})
