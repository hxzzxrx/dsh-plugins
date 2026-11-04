// Token 用量：扫描本地会话文件里的 usage 记录，做聚合与估算。
// 数据源：<DSH_HOME>/sessions/<project>/session-*/session.v4.jsonl.zstd
// 每条 assistant/message 的 data.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { dshHome, pluginHome } from './paths.mjs'
import { loadConfig } from './config.mjs'

/* ---------------- 单价 ---------------- */

// 默认按 2025 年 DeepSeek 官方牌价（人民币/百万 token）。
// 价格会变，页面里标了「可改」：config.json 的 `price` 字段覆盖这里。
const DEFAULT_PRICE = {
  currency: 'CNY',
  perMillion: {
    inputMiss: 2,    // 输入 · 缓存未命中
    inputHit: 0.5,   // 输入 · 缓存命中
    output: 8,       // 输出
  },
  note: '默认是 2025 年 DeepSeek 官方牌价，可在设置里改',
}

export function priceTable() {
  try {
    const cfg = loadConfig()
    if (cfg && cfg.price && cfg.price.perMillion) {
      return { ...DEFAULT_PRICE, ...cfg.price, perMillion: { ...DEFAULT_PRICE.perMillion, ...cfg.price.perMillion } }
    }
  } catch {}
  return DEFAULT_PRICE
}

export function costOf(totals, price = priceTable()) {
  const p = price.perMillion
  const cost =
    ((totals.inputMiss || 0) / 1e6) * p.inputMiss +
    ((totals.inputHit || 0) / 1e6) * p.inputHit +
    ((totals.output || 0) / 1e6) * p.output
  return Math.round(cost * 100) / 100
}

/* ---------------- 扫描 ---------------- */

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

function projectPathOf(dirName) {
  // --D-deepseek-harness-default-workspace-- → D:\deepseek-harness\default-workspace
  const inner = dirName.replace(/^--/, '').replace(/--$/, '')
  if (!inner) return dirName
  const withDrive = inner.replace(/^([A-Za-z])-/, '$1:\\')
  return withDrive.replace(/-/g, '\\')
}

function dayOf(ms) {
  // 北京时间日期
  const d = new Date(ms + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

const cacheFile = () => path.join(pluginHome(), 'token-cache.json')

let memo = null
let memoAt = 0
const MEMO_MS = 60_000

function emptyBucket() {
  return { messages: 0, inputMiss: 0, inputHit: 0, output: 0, cacheWrite: 0 }
}

function addInto(bucket, u) {
  bucket.messages += 1
  bucket.inputMiss += u.inputTokens || 0
  bucket.inputHit += u.cacheReadTokens || 0
  bucket.output += u.outputTokens || 0
  bucket.cacheWrite += u.cacheWriteTokens || 0
}

// 合并两个已经聚合过的 bucket（字段名是 inputMiss/inputHit/output）
function mergeBucket(target, src) {
  target.messages += src.messages || 0
  target.inputMiss += src.inputMiss || 0
  target.inputHit += src.inputHit || 0
  target.output += src.output || 0
  target.cacheWrite += src.cacheWrite || 0
}

function scanFile(file) {
  const out = { msgs: 0, usage: emptyBucket(), byDay: {}, byModel: {}, bySessionDay: [] }
  let text
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const u = o?.data?.usage
    if (!u) continue
    out.msgs += 1
    addInto(out.usage, u)
    const day = dayOf(Number(o.time) || Date.now())
    if (!out.byDay[day]) out.byDay[day] = emptyBucket()
    addInto(out.byDay[day], u)
    const model = String(o?.data?.message?.source?.model || o?.data?.source?.model || 'unknown')
    if (!out.byModel[model]) out.byModel[model] = emptyBucket()
    addInto(out.byModel[model], u)
    out.bySessionDay.push([day, u.inputTokens || 0, u.cacheReadTokens || 0, u.outputTokens || 0])
  }
  return out
}

export function scanTokens({ force = false } = {}) {
  const now = Date.now()
  if (!force && memo && now - memoAt < MEMO_MS) return memo

  const root = sessionsRoot()
  const totals = emptyBucket()
  const byDay = {}
  const byModel = {}
  const bySession = []
  let files = 0
  let bytes = 0

  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    projects = []
  }

  for (const p of projects) {
    const pdir = path.join(root, p.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    } catch {
      continue
    }
    for (const s of sessions) {
      const file = path.join(pdir, s.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      let st
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      files += 1
      bytes += st.size
      const one = scanFile(file)
      if (!one.msgs) continue
      mergeBucket(totals, one.usage)
      for (const [day, b] of Object.entries(one.byDay)) {
        if (!byDay[day]) byDay[day] = emptyBucket()
        byDay[day].messages += b.messages
        byDay[day].inputMiss += b.inputMiss
        byDay[day].inputHit += b.inputHit
        byDay[day].output += b.output
      }
      for (const [model, b] of Object.entries(one.byModel)) {
        if (!byModel[model]) byModel[model] = emptyBucket()
        byModel[model].messages += b.messages
        byModel[model].inputMiss += b.inputMiss
        byModel[model].inputHit += b.inputHit
        byModel[model].output += b.output
      }
      bySession.push({
        id: s.name,
        short: s.name.replace(/^session-/, '').slice(0, 8),
        project: projectPathOf(p.name),
        file: path.join(p.name, s.name),
        sizeMb: Math.round((st.size / 1024 / 1024) * 10) / 10,
        mtime: st.mtimeMs,
        ...one.usage,
      })
    }
  }

  const price = priceTable()
  const total = {
    ...totals,
    all: totals.inputMiss + totals.inputHit + totals.output,
    hitRate: totals.inputMiss + totals.inputHit > 0
      ? Math.round((totals.inputHit / (totals.inputMiss + totals.inputHit)) * 1000) / 10
      : 0,
  }

  const days = Object.entries(byDay)
    .map(([day, b]) => ({ day, ...b, all: b.inputMiss + b.inputHit + b.output, cost: costOf(b, price) }))
    .sort((a, b) => a.day.localeCompare(b.day))

  const result = {
    scannedAt: now,
    root,
    files,
    totalBytes: bytes,
    totals: total,
    cost: costOf(totals, price),
    price,
    days,
    models: Object.entries(byModel).map(([model, b]) => ({ model, ...b, all: b.inputMiss + b.inputHit + b.output })),
    sessions: bySession.sort((a, b) => (b.inputMiss + b.inputHit + b.output) - (a.inputMiss + a.inputHit + a.output)),
  }

  memo = result
  memoAt = now
  try {
    fs.mkdirSync(pluginHome(), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(result), 'utf8')
  } catch {}
  return result
}

/* ---------------- 余额 ---------------- */

function apiKey() {
  const file = path.join(dshHome(), '.credentials.yaml')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const m = raw.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
    if (m) return m[1].replace(/^["']|["']$/g, '')
  } catch {}
  return process.env.DEEPSEEK_API_KEY || ''
}

export async function queryBalance() {
  const key = apiKey()
  if (!key) return { ok: false, error: '没找到 API key（<DSH_HOME>/.credentials.yaml 的 DEEPSEEK_API_KEY）' }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, error: '接口返回 ' + res.status }
    const j = await res.json()
    const info = (j.balance_infos || [])[0] || {}
    return {
      ok: true,
      available: Boolean(j.is_available),
      currency: info.currency || 'CNY',
      total: Number(info.total_balance || 0),
      granted: Number(info.granted_balance || 0),
      toppedUp: Number(info.topped_up_balance || 0),
      at: Date.now(),
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}
