// dsh-plugins / newp：新插件检测器
//
// 每 15 秒看一眼 profile 的 dependencies，发现"上次没见过"的插件，
// 记进 pending.json（页面顶部显示"待汉化"横幅）。
//
// 注意：默认**不自动发消息**。给会话发消息 = 让它起一整轮对话，
// 成本很高；翻译只在用户点页面上的「AI 翻译」按钮时才触发。
// 配置中心打开 autoNotifyNewPlugin / autoTranslateMissing 后才会自动发。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { readProfile, listPlugins } from './catalog.mjs'
import { pluginHome, hasZh, cachePath } from './zh.mjs'
import { loadConfig } from './config.mjs'

const INTERVAL = 15_000
const SETTLE = 20_000
const PROTECT = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugins'])

const knownFile = () => path.join(pluginHome(), 'known.json')
const pendingFile = () => path.join(pluginHome(), 'pending.json')

function loadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function loadPending() {
  const value = loadJson(pendingFile(), [])
  return Array.isArray(value) ? value.filter((p) => p && typeof p.name === 'string') : []
}

export function savePending(list) {
  saveJson(pendingFile(), list)
}

export function pendingNames() {
  return loadPending().map((p) => p.name)
}

/** 手动触发一次翻译（页面按钮用）。任何已安装插件都能点，不要求在 pending 里。 */
export async function notifyNow(ctx, name) {
  let entry = loadPending().find((p) => p.name === name)
  if (!entry) {
    let item
    try {
      item = listPlugins().items.find((i) => i.name === name)
    } catch {}
    entry = { name, version: item?.version || '', description: item?.description || '' }
  }
  const r = await notify(ctx, entry)
  if (r.ok) {
    const pending = loadPending()
    const hit = pending.find((p) => p.name === name)
    if (hit) {
      hit.notified = true
      savePending(pending)
    }
  }
  return r.ok
    ? { ok: true, target: r.target, targets: r.target }
    : { ok: false, reason: '没有可用的会话：先随便打开一个对话再点' }
}

/** 从待汉化队列里移除（忽略）。 */
export function dismissPending(name) {
  const pending = loadPending().filter((p) => p.name !== name)
  savePending(pending)
  return { ok: true }
}

/** 把一段自由文本任务交给一个打开的会话（页面「AI 帮我装」用）。 */
export async function sendTask(ctx, text) {
  const sessions = (await sessionsOf(ctx)).filter((s) => !s.subagent && !s.blank)
  const target = pickTarget(sessions)
  if (!target) return { ok: false, reason: '没有可用的会话：先在 DSH 里打开一个对话' }
  const ok = await deliver(ctx, target.sessionId, text)
  return ok ? { ok: true, target: target.title || target.sessionId } : { ok: false, reason: '消息发送失败' }
}

function controllerOf(ctx) {
  try {
    if (typeof ctx.get === 'function') return ctx.get('sessionController')
  } catch {}
  try {
    return ctx.sessionController
  } catch {
    return undefined
  }
}

async function sessionsOf(ctx) {
  const api = controllerOf(ctx)
  if (!api || typeof api.list !== 'function') return []
  try {
    const res = await api.list({})
    const items = Array.isArray(res?.items) ? res.items : []
    return items.map((it) => ({
      sessionId: String(it.sessionId),
      title: String(it.projections?.values?.title || ''),
      running: it.running === true,
      blank: it.blank === true,
      subagent: it.origin === 'subagent',
    }))
  } catch {
    return []
  }
}

async function deliver(ctx, sessionId, text) {
  const api = controllerOf(ctx)
  if (!api || typeof api.prompt !== 'function') return false
  // 注意：不能在请求时裸访问 ctx.agents —— 路由回调里的 ctx 可能已经 inactive，
  // cordis 会抛 `cannot get required service "agents" in inactive context`。
  let agent = null
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
  } catch {}
  if (!agent && typeof api.resolveAgent === 'function') {
    try {
      await api.resolveAgent(sessionId)
    } catch {}
  }
  try {
    await api.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(15000),
    )
    return true
  } catch {
    return false
  }
}

function taskText(entry) {
  return [
    '━━━━━━ 插件汉化任务 · 来自插件管理器 ━━━━━━',
    '插件管理器检测到一个新安装的插件，它还没有中文简介。',
    '',
    `插件：${entry.name}`,
    entry.version ? `版本：${entry.version}` : null,
    entry.description ? `原始描述：${entry.description}` : null,
    '',
    '请完成一件事：给这个插件写一句中文简介。',
    '要求：一句话，说清它为 DSH 增加了什么能力、有没有副作用（比如会改配置、会发消息、会联网）。',
    '成本提示：只需要读这个插件的 package.json 的 description 和 README 开头几行，不要通读源码、不要做别的调查。',
    '写法：用 write/edit 工具修改这个 JSON 文件，追加一个键（不要动别的键）：',
    cachePath(),
    `格式：{ "${entry.name}": "中文简介" }`,
    '',
    '写完后用户刷新「插件管理」页面就能看到中文，不需要重启 DSH。',
    '如果你判断这个插件确实不需要简介，可以忽略本条消息。',
  ]
    .filter(Boolean)
    .join('\n')
}

function pickTarget(sessions) {
  // 优先空闲的编号协作会话，避免塞进正在跑的长上下文会话
  const idle = sessions.filter((s) => !s.running)
  return (
    idle.find((s) => /^\d{3}$/.test(s.title)) ||
    idle[0] ||
    sessions.find((s) => s.running) ||
    sessions[0] ||
    null
  )
}

async function notify(ctx, entry) {
  const sessions = (await sessionsOf(ctx)).filter((s) => !s.subagent && !s.blank)
  const target = pickTarget(sessions)
  if (!target) return { ok: false, target: '' }
  const ok = await deliver(ctx, target.sessionId, taskText(entry))
  return { ok, target: target.title || target.sessionId }
}

function readKnown() {
  const value = loadJson(knownFile(), null)
  return Array.isArray(value) ? new Set(value) : null
}

export function startNewPluginWatch(ctx) {
  const state = { known: readKnown(), timer: null, stopped: false }

  if (!state.known) {
    // 第一次运行：用当前清单做基线，不把存量插件当成"新安装"
    try {
      state.known = new Set(Object.keys(readProfile().dependencies))
    } catch {
      state.known = new Set()
    }
    saveJson(knownFile(), [...state.known])
  }

  const scan = () => {
    if (state.stopped) return
    let pkg
    try {
      pkg = readProfile()
    } catch {
      return
    }
    const names = Object.keys(pkg.dependencies)
    const fresh = names.filter((n) => !state.known.has(n) && !PROTECT.has(n))
    if (!fresh.length) return

    for (const n of fresh) state.known.add(n)
    saveJson(knownFile(), [...state.known])

    let meta = []
    try {
      meta = listPlugins().items
    } catch {}
    const byName = new Map(meta.map((i) => [i.name, i]))
    const pending = loadPending()
    for (const n of fresh) {
      if (pending.some((p) => p.name === n) || hasZh(n)) continue
      const item = byName.get(n)
      pending.push({
        name: n,
        version: item?.version || '',
        description: item?.description || '',
        at: new Date().toISOString(),
        notified: false,
      })
    }
    savePending(pending)

    // 配置中心的两个开关（默认都关）
    let cfg = {}
    try {
      cfg = loadConfig()
    } catch {}

    // 1) 存量插件缺中文简介：放进横幅，让用户决定要不要翻译
    if (cfg.autoTranslateMissing) {
      try {
        const more = []
        for (const it of listPlugins().items) {
          if (!it.installed || it.zhFrom !== 'raw') continue
          if (pending.some((p) => p.name === it.name) || hasZh(it.name)) continue
          more.push({
            name: it.name,
            version: it.version || '',
            description: it.description || '',
            at: new Date().toISOString(),
            notified: false,
          })
        }
        if (more.length) {
          savePending(pending.concat(more))
        }
      } catch {}
    }

    // 2) 新插件自动交给 AI 翻译（一次只发一个，避免同时起好几轮）
    if (cfg.autoNotifyNewPlugin) {
      const target = loadPending().find((p) => !p.notified)
      if (target) {
        notify(ctx, target).catch((err) =>
          ctx.logger?.warn?.(`[plugins] 自动翻译通知失败: ${err?.message || err}`),
        )
      }
    }
  }

  const id = setInterval(scan, INTERVAL)
  const warm = setTimeout(scan, 8000)

  return () => {
    state.stopped = true
    clearInterval(id)
    clearTimeout(warm)
  }
}

/** 把任务定向发给某个会话（按编号 001 或 sessionId 匹配）。找不到再退回任意会话。 */
export async function sendTaskTo(ctx, who, text) {
  const key = String(who || '').trim()
  if (!key) return sendTask(ctx, text)
  const sessions = (await sessionsOf(ctx)).filter((s) => !s.subagent && !s.blank)
  const hit = sessions.find((s) => s.title === key || s.sessionId === key)
  if (!hit) {
    const fallback = await sendTask(ctx, text)
    return fallback.ok ? { ok: true, target: fallback.target, fallback: true } : fallback
  }
  const ok = await deliver(ctx, hit.sessionId, text)
  return ok ? { ok: true, target: hit.title || hit.sessionId } : { ok: false, reason: '消息发送失败' }
}