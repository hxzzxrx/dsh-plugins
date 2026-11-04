// dsh-plugins / catalog：读 profile 的插件清单，提供中文简介与启用/停用/删除操作
import fs from 'node:fs'
import path from 'node:path'

import { dshHome, pnpmJs } from './paths.mjs'
import { spawn } from 'node:child_process'

import { getZh, pluginHome } from './zh.mjs'
import { machineZh } from './machine-zh.mjs'

// ---- profile 定位 ----
const CANDIDATES = [
  process.env.DSH_PROFILE_DIR,
  path.join(dshHome(), 'profiles', 'desktop'),
].filter(Boolean)

export function profileDir() {
  for (const c of CANDIDATES) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return c
    } catch {}
  }
  throw new Error('找不到 profile 目录（可用环境变量 DSH_PROFILE_DIR 指定）')
}

const PKG = () => path.join(profileDir(), 'package.json')
const MODULES = () => path.join(profileDir(), 'node_modules')

// 绝对不能停用/删除的包
const PROTECTED = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugins'])

// 分类：系统内置 / 本地自制 / 市场下载 / 其他
export const CATEGORIES = [
  ['system', '系统内置'],
  ['local', '本地自制'],
  ['market', '市场下载'],
  ['other', '其他'],
]

function categoryOf(name, spec) {
  if (name === '@deepseek-ai/dsh-base' || name === '@deepseek-ai/dsh-web-app') return 'system'
  const s = String(spec || '')
  if (s.startsWith('link:')) return 'local'
  if (s) return 'market'
  return 'other'
}

// ---- 中文简介 ----
const ZH = [
  [/^@deepseek-ai\/dsh-base$/, '核心运行时：会话、工具调用、模型网关都在这里，删了 DSH 起不来。'],
  [/^@deepseek-ai\/dsh-web-app$/, 'Web 界面外壳：渲染聊天界面、设置页与侧栏。'],
  [/^dsh-plugins$/, '插件管理器（就是本页）：查看全部插件，启用/停用/删除。'],
  [/^dsh-collab$/, '跨会话协作：列会话、紧急打断、群聊、任务板自动通知。'],
  [/^dsh-session-archive$/, '会话归档：把聊天记录写进长期记忆库，支持检索与导出。'],
  [/^dsh-bili-scroll$/, '刷 B 站：定时挑视频、读字幕写日报，支持扫码登录与自动评论（默认关）。'],
  [/^billion-context$/, '上下文压缩：长对话自动折叠旧内容，避免上下文爆掉。'],
  [/^dsh-whale-widget$/, '右下角小鲸鱼：显示账户余额、今日用量和峰谷时段。'],
  [/^dsh-pet$/, '桌宠：一只会在桌面或界面里溜达的鱼。'],
  [/^dshmarket$/, '可视化插件市场：浏览、搜索、一键安装社区插件。'],
  [/^dsh-at-file$/, '@ 文件引用：输入 @ 选择工作区文件让模型读取。'],
  [/^dsh-soul-md$/, '人设卡：给 AI 设定身份、口吻与边界。'],
  [/^dsh-token-diet$/, 'Token 统计与预算：显示每轮消耗，超预算自动收手。'],
  [/^dsh-context$/, '上下文洞察面板：查看当前上下文由什么构成。'],
  [/^dsh-genui$/, '卡片式 UI：让 AI 生成表格、表单等交互卡片。'],
  [/^dsh-posterflow-ai$/, '海报流：生成海报与长图。'],
  [/^dsh-onebot-qq$/, 'QQ 消息桥：把 DSH 接到 QQ 上收发消息。'],
  [/^@liustack\/modlens$/, '图片理解桥：让模型看得懂图片。'],
  [/^@smalltailqwq\/dsh-client-ui-skin-deep-whale-manager$/, '皮肤切换器：在「设置 → 皮肤」里切换与微调皮肤。'],
  [/^@smalltailqwq\/dsh-client-ui-skin-maid-atelier$/, '女仆工坊主题：深蓝藏青 + 鲸鱼女仆立绘的界面皮肤。'],
]

function zhOf(name) {
  for (const [re, text] of ZH) {
    if (re.test(name)) return text
  }
  return ''
}

/** 中文简介的兜底链：AI 翻译缓存 → 手写表 → 本地词典机翻 → 英文原文。 */
function describe(name, description) {
  const cached = getZh(name)
  if (cached) return { zh: cached, zhFrom: 'cache' }
  const builtin = zhOf(name)
  if (builtin) return { zh: builtin, zhFrom: 'builtin' }
  const machine = description ? machineZh(description) : ''
  if (machine) return { zh: '〔机翻〕' + machine, zhFrom: 'machine' }
  return { zh: description ? description.slice(0, 160) : '（没有写描述）', zhFrom: 'raw' }
}

// ---- 读写 profile ----
export function readProfile() {
  const raw = fs.readFileSync(PKG(), 'utf8').replace(/^\uFEFF/, '')
  const pkg = JSON.parse(raw)
  pkg.dependencies ??= {}
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []
  return pkg
}

function writeProfile(pkg) {
  const text = JSON.stringify(pkg, null, 2) + '\n'
  fs.writeFileSync(PKG(), text, 'utf8')
}

function readInstalledMeta(name) {
  try {
    const dir = path.join(MODULES(), name)
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    const pkg = JSON.parse(raw)
    return { version: String(pkg.version || ''), description: String(pkg.description || ''), dir }
  } catch {
    return { version: '', description: '', dir: '' }
  }
}

export function listPlugins() {
  const pkg = readProfile()
  const bundles = new Set(pkg.dsh.profile.bundles)
  const rows = []
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    const meta = readInstalledMeta(name)
    const builtin = name === '@deepseek-ai/dsh-base' || name === '@deepseek-ai/dsh-web-app'
    const loc = builtin ? { dir: '', exists: false } : dirOf(name, spec)
    rows.push({
      name,
      version: meta.version,
      spec: String(spec),
      dir: loc.dir,
      kind: String(spec).startsWith('link:') ? 'link' : 'npm',
      category: categoryOf(name, spec),
      enabled: bundles.has(name),
      installed: loc.exists || Boolean(meta.dir),
      protected: PROTECTED.has(name),
      builtin,
      description: meta.description,
      ...describe(name, meta.description),
    })
  }
  // 只在 bundles 里、但不在 dependencies 里的（异常情况）也列出来
  for (const name of bundles) {
    if (pkg.dependencies[name]) continue
    rows.push({
      name, version: '', spec: '', dir: '', kind: 'orphan', category: categoryOf(name, ''),
      enabled: true, installed: false,
      protected: PROTECTED.has(name), builtin: true, description: '', ...describe(name, '仅登记在 bundles 中，未在依赖里声明'),
    })
  }
  const order = new Map(CATEGORIES.map(([k], i) => [k, i]))
  rows.sort((a, b) => (order.get(a.category) ?? 9) - (order.get(b.category) ?? 9) || a.name.localeCompare(b.name))
  return { profile: profileDir(), items: rows }
}

/** 插件文件所在目录：link: 包解析到源码目录，npm 包落到 node_modules 下。 */
function dirOf(name, spec) {
  const s = String(spec || '')
  let dir
  if (s.startsWith('link:')) {
    const p = s.slice(5).trim()
    dir = path.isAbsolute(p) ? p : path.resolve(profileDir(), p)
  } else {
    dir = path.join(MODULES(), name)
  }
  // junction / 符号链接解析到真实路径，打开的是源码而不是链接
  try {
    dir = fs.realpathSync(dir)
  } catch {}
  return { dir, spec: s, exists: fs.existsSync(dir) }
}

export function pluginDir(name) {
  const pkg = readProfile()
  return dirOf(name, pkg.dependencies[name])
}

export function setEnabled(name, on) {
  const pkg = readProfile()
  if (!pkg.dependencies[name]) throw new Error(`依赖里没有 ${name}，需要先重新安装`)
  if (PROTECTED.has(name) && !on) throw new Error(`${name} 是核心插件，不能停用`)
  const set = new Set(pkg.dsh.profile.bundles)
  let changed = false
  if (on && !set.has(name)) { pkg.dsh.profile.bundles.push(name); changed = true }
  if (!on && set.has(name)) { pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((n) => n !== name); changed = true }
  if (changed) writeProfile(pkg)
  return { ok: true, changed, restart: changed }
}

export function removePlugin(name) {
  const pkg = readProfile()
  if (PROTECTED.has(name)) throw new Error(`${name} 是核心插件，不能删除`)
  const spec = pkg.dependencies[name]
  let removedDir = false
  let trashed = null
  if (spec) {
    const dir = path.join(MODULES(), name)
    try {
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink() || st.isJunction?.()) {
        fs.unlinkSync(dir) // junction：只删链接，保留源码目录
      } else {
        trashed = moveToTrash(name, dir) // 真目录：挪进回收站，不直接抹掉
      }
      removedDir = true
    } catch {}
    delete pkg.dependencies[name]
  }
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((n) => n !== name)
  writeProfile(pkg)
  return { ok: true, changed: true, removedDir, trashed, restart: true }
}

/* ---------------- 回收站 ---------------- */

export function trashRoot() {
  return path.join(pluginHome(), 'trash')
}

function moveToTrash(name, dir) {
  const root = trashRoot()
  fs.mkdirSync(root, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const safe = name.replace(/[@/]/g, '_')
  let id = safe + '__' + stamp
  let n = 1
  while (fs.existsSync(path.join(root, id))) id = safe + '__' + stamp + '-' + n++
  fs.renameSync(dir, path.join(root, id))
  return id
}

function dirBytes(dir) {
  let total = 0
  const walk = (d, depth) => {
    if (depth > 4) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      try {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) walk(p, depth + 1)
        else total += fs.statSync(p).size
      } catch {}
    }
  }
  walk(dir, 0)
  return total
}

export function listTrash() {
  const root = trashRoot()
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const out = []
  for (const id of names) {
    const p = path.join(root, id)
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    let name = ''
    let version = ''
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'))
      name = String(meta.name || '')
      version = String(meta.version || '')
    } catch {}
    out.push({ id, name: name || id.split('__')[0], version, bytes: dirBytes(p), at: st.mtimeMs })
  }
  out.sort((a, b) => b.at - a.at)
  return out
}

export function restoreTrash(id) {
  const root = path.resolve(trashRoot())
  const src = path.resolve(path.join(root, String(id)))
  if (path.dirname(src) !== root) throw new Error('非法的回收站条目')
  if (!fs.existsSync(src)) throw new Error('条目不存在')
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) } catch {}
  const name = String(meta.name || '')
  if (!name) throw new Error('回收站条目里没有 package.json 的 name')
  if (PROTECTED.has(name)) throw new Error(`${name} 是核心插件，不能恢复`)
  const dest = path.join(MODULES(), name)
  if (fs.existsSync(dest)) throw new Error(`node_modules 里已经有 ${name}，先删掉再恢复`)
  fs.mkdirSync(MODULES(), { recursive: true })
  fs.renameSync(src, dest)
  const pkg = readProfile()
  pkg.dependencies[name] = meta.version ? '^' + String(meta.version) : '*'
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
  writeProfile(pkg)
  return { ok: true, name, restart: true }
}

export function purgeTrash(id) {
  const root = path.resolve(trashRoot())
  const src = path.resolve(path.join(root, String(id)))
  if (path.dirname(src) !== root) throw new Error('非法的回收站条目')
  if (!fs.existsSync(src)) throw new Error('条目不存在')
  const st = fs.lstatSync(src)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('不是普通目录，拒绝删除')
  const freed = dirBytes(src)
  fs.rmSync(src, { recursive: true, force: true })
  return { ok: true, freed }
}

/* ---------------- 更新检查（npm registry，只读） ---------------- */

let updateCache = { at: 0, map: {} }

export async function checkUpdates() {
  if (Date.now() - updateCache.at < 5 * 60 * 1000) return updateCache.map
  const items = listPlugins().items.filter((p) => !p.builtin && p.kind !== 'link' && p.name !== 'dsh-plugins')
  const map = {}
  await Promise.all(items.map(async (p) => {
    try {
      const r = await fetch('https://registry.npmmirror.com/' + encodeURIComponent(p.name) + '/latest', { signal: AbortSignal.timeout(4000) })
      if (!r.ok) return
      const j = await r.json()
      // 远端版本和本地一样就别记了，否则前端还得自己再比一遍
      if (j && j.version && j.version !== p.version) map[p.name] = String(j.version)
    } catch {}
  }))
  updateCache = { at: Date.now(), map }
  return map
}
/* ---------------- 停用影响面 / 清单导出 ---------------- */

export function impactOf(name) {
  const { dir, exists } = pluginDir(name)
  if (!exists) return null
  const files = []
  const walk = (d, depth) => {
    if (depth > 2) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.m?js$/.test(e.name)) files.push(p)
    }
  }
  walk(dir, 0)
  const tools = new Set()
  const slots = new Set()
  const inject = new Set()
  for (const f of files.slice(0, 40)) {
    let src = ''
    try { src = fs.readFileSync(f, 'utf8') } catch { continue }
    if (src.length > 400000) continue
    for (const m of src.matchAll(/(?:defineTool|tools?\.register|\btool)\(\s*\{[\s\S]{0,400}?name:\s*['"]([A-Za-z0-9_]+)['"]/g)) tools.add(m[1])
    for (const m of src.matchAll(/slot:\s*['"]([a-z0-9_.]+)['"]/g)) slots.add(m[1])
    for (const m of src.matchAll(/inject\s*=\s*\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) inject.add(s[1])
    }
  }
  return { tools: [...tools], slots: [...slots], inject: [...inject] }
}

export function impactAll() {
  const map = {}
  for (const p of listPlugins().items) {
    if (p.builtin) continue
    try { map[p.name] = impactOf(p.name) } catch {}
  }
  return map
}

export function exportManifest() {
  const pkg = readProfile()
  return {
    exportedAt: new Date().toISOString(),
    profile: profileDir(),
    dependencies: pkg.dependencies || {},
    bundles: pkg.dsh?.profile?.bundles || [],
  }
}
export function readmeOf(name) {
  const { dir, exists } = pluginDir(name)
  if (!exists) return null
  const names = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README.txt', 'README']
  for (const n of names) {
    const p = path.join(dir, n)
    try {
      if (!fs.statSync(p).isFile()) continue
      const txt = fs.readFileSync(p, 'utf8')
      return { file: p, text: txt.length > 4000 ? txt.slice(0, 4000) + '\n…（后面还有 ' + (txt.length - 4000) + ' 字）' : txt }
    } catch {}
  }
  return null
}

// ---- 升级：后台跑 pnpm add <name>@latest，日志落盘 ----
const PNPM_JS = pnpmJs()

function upgradeLog(name) {
  const dir = pluginHome()
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'upgrade-' + String(name).replace(/[^a-z0-9@._-]+/gi, '_') + '.log')
}

export function upgradePlugin(name) {
  const pkg = readProfile()
  const spec = String((pkg.dependencies || {})[name] || '')
  if (!spec) throw new Error('profile 里没有这个插件')
  if (spec.startsWith('link:')) throw new Error('本地自制插件没有可升级的版本')
  if (PROTECTED.has(name)) throw new Error('内置插件不能这样升级')
  const log = upgradeLog(name)
  const fd = fs.openSync(log, 'w')
  fs.writeSync(fd, '[upgrade] ' + name + '  ' + new Date().toISOString() + '\n')
  const child = spawn(process.execPath, [PNPM_JS, 'add', name + '@latest', '--dir', profileDir(), '--registry=https://registry.npmmirror.com'], {
    cwd: profileDir(),
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  try { fs.closeSync(fd) } catch {}
  // 升级后旧缓存还挂着"可更新"标记，清掉让前端立刻重新比对
  updateCache = { at: 0, map: {} }
  return { ok: true, pid: child.pid, log, name }
}

export function upgradeStatus(name) {
  const log = upgradeLog(name)
  let text = ''
  try { text = fs.readFileSync(log, 'utf8') } catch {}
  const done = /Done in|Already up to date|ERR_PNPM|ERR_|error/i.test(text)
  return { log, done, text: text.slice(-3000) }
}

