// dsh-plugins / health：插件体检（四项静态检查 + 启动日志里的报错）
//
// 目的一：装完插件、重启之前先看一眼，红灯就别重启。
// 目的二：运行中炸过的插件，在页面上标红，并且能直接看/清日志。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

import { listPlugins, pluginDir } from './catalog.mjs'

const IMPORT_RE = /(?:import\s+[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
const SKIP_SPEC = /^(?:node:|\.{0,2}\/|[a-zA-Z]:[\\/])/

function walkJs(dir, out, depth) {
  if (depth > 2 || out.length > 40) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length > 40) return
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    // 浏览器端代码由宿主打包（react 等由宿主提供），不参与 node 侧解析检查
    if (e.isDirectory() && /^(client|ui|web|assets)$/i.test(e.name)) continue
    if (!e.isDirectory() && /^client\.(m?js|cjs)$/i.test(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkJs(p, out, depth + 1)
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p)
  }
}

function entryOf(meta) {
  const dot = meta.exports?.['.']
  const rel = typeof dot === 'string' ? dot : dot?.import || dot?.default || meta.module || meta.main
  return typeof rel === 'string' ? rel.replace(/^\.\//, '') : null
}

function scanSpecs(files) {
  const specs = new Set()
  for (const f of files) {
    let text
    try {
      text = fs.readFileSync(f, { encoding: 'utf8', flag: 'r' })
    } catch {
      continue
    }
    if (text.length > 400_000) text = text.slice(0, 400_000)
    IMPORT_RE.lastIndex = 0
    let m
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1]
      if (!spec || SKIP_SPEC.test(spec)) continue
      specs.add(spec.split('/')[0].startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
  return [...specs]
}

/** 体检单个插件（静态部分）。 */
function checkPlugin(p) {
  const issues = []
  const dir = p.dir
  if (!dir || !fs.existsSync(dir)) {
    issues.push({ level: 'error', code: 'dir', text: '源码目录不存在：' + (dir || '（无）') })
    return { name: p.name, level: 'error', issues }
  }

  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    issues.push({ level: 'error', code: 'pkg', text: 'package.json 读不了：' + String(err?.message || err) })
    return { name: p.name, level: 'error', issues }
  }

  const rel = entryOf(meta)
  const entry = rel ? path.join(dir, rel) : null
  if (!entry) {
    issues.push({ level: 'error', code: 'entry', text: 'package.json 没写 main / exports，宿主找不到入口' })
  } else if (!fs.existsSync(entry)) {
    issues.push({ level: 'error', code: 'entry', text: '入口文件不存在：' + entry })
  } else {
    const r = spawnSync(process.execPath, ['--check', entry], { timeout: 8000, encoding: 'utf8' })
    if (r.status !== 0) {
      const msg = String(r.stderr || '').split('\n').filter((l) => l.trim()).slice(0, 3).join(' ')
      issues.push({ level: 'error', code: 'syntax', text: '入口语法错误：' + msg })
    }
  }

  // 依赖：扫源码里的裸 import，逐个从插件目录解析
  const files = []
  if (entry && fs.existsSync(entry)) files.push(entry)
  walkJs(path.join(dir, 'lib'), files, 0)
  const req = createRequire(path.join(dir, 'package.json'))
  const optionalPeers = meta.peerDependenciesMeta || {}
  for (const spec of scanSpecs(files)) {
    try {
      req.resolve(spec)
    } catch {
      const opt = optionalPeers[spec]?.optional === true
      const hostPkg = spec.startsWith('@deepseek-ai/')
      const declared = Boolean(meta.dependencies?.[spec] || meta.peerDependencies?.[spec])
      // 宿主内部包由宿主进程提供，插件目录里解析不到是常态，不算问题。
      if (hostPkg) continue
      // 明确标了 optional 的 peer，本来就可以不装。
      if (opt) continue
      // 没在 package.json 声明过的裸 import：多为可选能力（自带兜底），只作信息。
      if (!declared) {
        issues.push({ level: 'info', code: 'dep', text: '可选依赖未声明：' + spec })
        continue
      }
      issues.push({ level: 'error', code: 'dep', text: '依赖找不到：' + spec })
    }
  }

  const level = issues.some((i) => i.level === 'error')
    ? 'error'
    : issues.some((i) => i.level === 'warn')
      ? 'warn'
      : 'ok'
  return { name: p.name, level, issues }
}

/* ─────────────── 日志 ─────────────── */

export function logDirs() {
  const out = []
  const appdata = process.env.APPDATA
  if (appdata) out.push(path.join(appdata, '@deepseek-ai', 'dsh-desktop', 'logs'))
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  out.push(path.join(home, 'logs'))
  return out.filter((d) => fs.existsSync(d))
}

export function listLogFiles() {
  const files = []
  for (const d of logDirs()) {
    let names
    try {
      names = fs.readdirSync(d)
    } catch {
      continue
    }
    for (const n of names) {
      if (!/\.log$/i.test(n)) continue
      const p = path.join(d, n)
      try {
        const st = fs.statSync(p)
        files.push({ path: p, name: n, dir: d, mtime: st.mtimeMs, size: st.size })
      } catch {}
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

const ERROR_LINE = /(uncaught exception|did not activate|failed to import|挂载失败|CordisError|INACTIVE_EFFECT|Unhandled|TypeError|ReferenceError|SyntaxError)/i

/** 读最近日志里的报错行，按插件名分组。 */
export function scanLogs(names, limit = 120) {
  const files = listLogFiles().slice(0, 6)
  const byPlugin = new Map()
  const all = []
  for (const f of files) {
    let text = ''
    try {
      const fd = fs.openSync(f.path, 'r')
      const start = Math.max(0, f.size - 400_000)
      const buf = Buffer.alloc(Math.min(f.size, 400_000))
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      text = buf.toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (!ERROR_LINE.test(line)) continue
      all.push({ file: f.name, line: line.trim().slice(0, 500) })
      for (const n of names) {
        const short = n.includes('/') ? n.split('/')[1] : n
        if (short.length >= 4 && line.includes(short)) {
          if (!byPlugin.has(n)) byPlugin.set(n, [])
          const arr = byPlugin.get(n)
          if (arr.length < limit) arr.push({ file: f.name, line: line.trim().slice(0, 500) })
        }
      }
    }
  }
  const out = {}
  for (const [k, v] of byPlugin) out[k] = v
  return { byPlugin: out, files: files.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime })), recent: all.slice(-limit) }
}

/** 把日志移进归档目录（不删，随时可翻）。当前进程占用的文件会跳过。 */
export function archiveLogs() {  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let moved = 0
  const skipped = []
  for (const d of logDirs()) {
    const target = path.join(d, '_archive_' + stamp)
    for (const f of listLogFiles().filter((x) => x.dir === d)) {
      try {
        fs.mkdirSync(target, { recursive: true })
        fs.renameSync(f.path, path.join(target, f.name))
        moved++
      } catch {
        skipped.push(f.name)
      }
    }
  }
  return { ok: true, moved, skipped, message: moved ? `已归档 ${moved} 个日志文件` + (skipped.length ? `（${skipped.length} 个被占用跳过）` : '') : '没有可归档的日志' }
}

function dirSize(p) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(p, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const f = path.join(p, e.name)
    try {
      total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size
    } catch {}
  }
  return total
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** 归档目录清单（logs/_archive_*）。 */
export function archiveStats() {
  const out = []
  for (const d of logDirs()) {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('_archive_')) continue
      const p = path.join(d, e.name)
      out.push({ path: p, name: e.name, bytes: dirSize(p) })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 彻底删除归档目录，释放磁盘。 */
export function purgeArchives() {
  const roots = new Set(logDirs())
  let removed = 0
  let freed = 0
  const failed = []
  const skipped = []
  for (const a of archiveStats()) {
    // 三重保险：父目录必须是已知的日志目录；名字必须以 _archive_ 开头；必须是真目录（junction/symlink 跳过）
    const parent = path.dirname(a.path)
    if (!roots.has(parent) || !path.basename(a.path).startsWith('_archive_')) {
      skipped.push(a.name)
      continue
    }
    try {
      const st = fs.lstatSync(a.path)
      if (!st.isDirectory() || st.isSymbolicLink()) {
        skipped.push(a.name)
        continue
      }
      fs.rmSync(a.path, { recursive: true, force: true })
      removed++
      freed += a.bytes
    } catch {
      failed.push(a.name)
    }
  }
  return {
    ok: true,
    removed,
    freed,
    failed,
    skipped,
    message: removed
      ? `已彻底删除 ${removed} 个归档，释放 ${fmtBytes(freed)}` + (failed.length ? `（${failed.length} 个被占用，跳过）` : '')
      : '没有归档可删',
  }
}

/** 全量体检。 */
export function healthAll() {
  const data = listPlugins()
  const items = []
  for (const p of data.items) {
    if (p.builtin || !p.dir) continue
    const r = checkPlugin(p)
    items.push(r)
  }
  const names = data.items.map((p) => p.name)
  const logs = scanLogs(names)
  for (const it of items) {
    const hits = logs.byPlugin[it.name] || []
    it.logErrors = hits.length
    if (hits.length) {
      it.level = it.level === 'ok' ? 'warn' : it.level
      it.issues.push({ level: 'warn', code: 'log', text: `启动日志里有 ${hits.length} 条相关报错` })
    }
  }
  const counts = { ok: 0, warn: 0, error: 0 }
  for (const it of items) counts[it.level]++
  return { items, counts, logFiles: logs.files, logDir: logDirs()[0] || '' }
}
