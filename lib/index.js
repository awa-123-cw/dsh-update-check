// dsh-update-check Node half：为设置页「关于」栏位提供数据服务。
//
// 功能：
//   1. 探测本地 DSH 版本与环境信息（版本来源 = 本进程启动入口 bin.js 的
//      上级包 package.json，即 @deepseek-ai/dsh 部署本体；多路径兜底）；
//   2. 注册同源端点：
//        GET  /dsh-update-check/info        —— 本地版本/环境信息（JSON）
//        GET  /dsh-update-check/check       —— 代理 npm registry dist-tags，
//              返回 latest / next 版本（10s 超时，失败返回 { ok:false, error }）
//        GET  /dsh-update-check/last-check  —— 读取上次检测结果（JSON 文件）
//        POST /dsh-update-check/last-check  —— 写入上次检测结果（JSON 文件）
//      （client 只 fetch 同源端点，规避 CORS 与 registry 直连的不确定性；
//        持久化不走 settings 服务——官方 WEB_SETTINGS_NAMESPACES 白名单
//        需改官方包并重启才生效，这里用独立 JSON 文件，热装配即可用）；
//   3. 上次检测结果持久化在 <DSH_HOME>/data/dsh-update-check.json。
//
// 安全：所有端点只读或仅写本插件自己的 JSON 文件（原子写）；
// 不执行任何更新/写盘操作——本插件只“检测”并给出指引，
// 升级动作始终由用户手动完成。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, sep, resolve, basename } from 'node:path'
import { createRequire } from 'node:module'

export const name = 'dsh-update-check'
// 硬依赖 webServer（路由注册）。
export const inject = ['webServer']

const NS = 'dsh-update-check'
const DSH_PKG = '@deepseek-ai/dsh'
const NPM_REGISTRY = 'https://registry.npmjs.org'
const DIST_TAGS_URL = `${NPM_REGISTRY}/-/package/${DSH_PKG}/dist-tags`
const NPM_PAGE_URL = `https://www.npmjs.com/package/${DSH_PKG}`
const CHECK_TIMEOUT_MS = 10000
const MAX_BODY_BYTES = 65536

/** 持久化文件：<DSH_HOME>/data/dsh-update-check.json（DSH_HOME 缺省用用户目录）。 */
const DATA_FILE = (() => {
  const home = process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME
  return join(home || '.', 'data', 'dsh-update-check.json')
})()

/** 读 package.json（失败返回 null）。 */
function readPkg(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 从包文件路径推导部署根（node_modules 之前的目录）。 */
function deployRoot(pkgFile) {
  const parts = pkgFile.split(sep)
  const idx = parts.lastIndexOf('node_modules')
  if (idx >= 1) return parts.slice(0, idx).join(sep)
  return dirname(dirname(dirname(pkgFile)))
}

/** 从入口文件（bin.js 等）向上逐级找 package.json（lib/ → 包根）。 */
function pkgJsonAt(file) {
  if (basename(file) === 'package.json') return existsSync(file) ? file : null
  let dir = dirname(file)
  for (let i = 0; i < 4; i++) {
    const cand = join(dir, 'package.json')
    if (existsSync(cand)) return cand
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 探测本地 DSH 版本与安装目录。
 * 来源优先级：
 *   1. 本进程启动入口（node <dsh>/lib/bin.js web → argv[1] 即 bin.js）；
 *   2. createRequire 解析 @deepseek-ai/dsh/package.json（内联部署时）；
 *   3. $DSH_CHECKOUT 环境变量。
 * 全部失败返回 version: null（UI 显示「未知」）。
 */
function detectDsh() {
  const attempts = []
  if (typeof process.argv[1] === 'string' && process.argv[1]) {
    attempts.push(resolve(process.argv[1]))
  }
  try {
    attempts.push(createRequire(import.meta.url).resolve(`${DSH_PKG}/package.json`))
  } catch {
    /* 解析失败则跳过 */
  }
  if (process.env.DSH_CHECKOUT) {
    attempts.push(join(process.env.DSH_CHECKOUT, 'package.json'))
  }
  for (const file of attempts) {
    try {
      const pkgFile = pkgJsonAt(file)
      if (pkgFile === null) continue
      const pkg = readPkg(pkgFile)
      if (pkg && pkg.name === DSH_PKG && typeof pkg.version === 'string') {
        return { version: pkg.version, installDir: deployRoot(pkgFile) }
      }
    } catch {
      /* 继续下一个来源 */
    }
  }
  return { version: null, installDir: null }
}

/** 生成升级命令（Windows cd /d 语法；其他平台 cd）。 */
function buildUpdateCommand(installDir) {
  if (installDir) {
    const quote = /^[a-zA-Z]:[\\/]/.test(installDir) ? `cd /d "${installDir}" && ` : `cd "${installDir}" && `
    return `${quote}pnpm add ${DSH_PKG}@latest`
  }
  return `npm install -g ${DSH_PKG}@latest`
}

/** 组装本地信息 JSON。 */
function buildInfo(probe) {
  return {
    ok: true,
    package: DSH_PKG,
    version: probe.version,
    installDir: probe.installDir,
    dshHome: process.env.DSH_HOME || null,
    dataFile: DATA_FILE,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    registry: NPM_REGISTRY,
    distTagsUrl: DIST_TAGS_URL,
    npmPageUrl: NPM_PAGE_URL,
    updateCommand: buildUpdateCommand(probe.installDir),
    autoUpdate: false, // DSH 无自动更新机制（检测与升级均手动）
    updatedAt: Date.now(),
  }
}

/** 同源 JSON 响应小助手。 */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读取上次检测结果。 */
function readLastCheck() {
  try {
    if (!existsSync(DATA_FILE)) return { ok: true, lastCheck: null }
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    return { ok: true, lastCheck: raw && typeof raw === 'object' ? raw : null }
  } catch (e) {
    return { ok: false, error: `读取上次检测失败：${e && e.message ? e.message : String(e)}` }
  }
}

/** 写入上次检测结果（原子写：临时文件 + rename）。 */
function writeLastCheck(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: '无效的请求体' }
    }
    const payload = {
      lastCheckAt: typeof body.lastCheckAt === 'number' ? body.lastCheckAt : 0,
      lastLatest: typeof body.lastLatest === 'string' ? body.lastLatest : '',
      lastNext: typeof body.lastNext === 'string' ? body.lastNext : '',
      lastHasUpdate: body.lastHasUpdate === true,
      lastError: typeof body.lastError === 'string' ? body.lastError : '',
    }
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    const tmp = `${DATA_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, DATA_FILE)
    return { ok: true, lastCheck: payload }
  } catch (e) {
    return { ok: false, error: `写入上次检测失败：${e && e.message ? e.message : String(e)}` }
  }
}

/** 收集请求体（限长）。 */
function collectBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** 代理 npm dist-tags：latest / next。 */
async function checkRemote() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const resp = await fetch(DIST_TAGS_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!resp.ok) {
      throw new Error(`npm registry 响应异常（HTTP ${resp.status}）`)
    }
    const tags = await resp.json()
    if (!tags || typeof tags !== 'object' || typeof tags.latest !== 'string') {
      throw new Error('npm registry 返回的数据格式异常')
    }
    return {
      ok: true,
      latest: tags.latest,
      next: typeof tags.next === 'string' ? tags.next : null,
      checkedAt: Date.now(),
    }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError')
    return {
      ok: false,
      error: aborted
        ? `请求 npm registry 超时（${CHECK_TIMEOUT_MS / 1000}s）`
        : `无法连接 npm registry：${err && err.message ? err.message : String(err)}`,
      checkedAt: Date.now(),
    }
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined || typeof webServer.register !== 'function') return

  const probe = detectDsh()

  ctx.effect(() => {
    const disposers = []

    // 本地信息端点
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-update-check/info',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        json(res, 200, buildInfo(probe))
      },
    }))

    // 版本检测端点（代理 npm registry）
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-update-check/check',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const result = await checkRemote()
        json(res, result.ok ? 200 : 502, result)
      },
    }))

    // 上次检测结果持久化（GET 读 / POST 写，原子写 JSON 文件）
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-update-check/last-check',
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          json(res, 200, readLastCheck())
          return
        }
        if (req.method === 'POST') {
          let raw
          try {
            raw = await collectBody(req)
          } catch (e) {
            json(res, 400, { ok: false, error: `请求体异常：${e && e.message ? e.message : String(e)}` })
            return
          }
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          const result = writeLastCheck(body)
          json(res, result.ok ? 200 : 500, result)
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST' })
        res.end()
      },
    }))

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载时尽力清理 */
        }
      }
    }
  }, 'dsh-update-check: http routes')
}
