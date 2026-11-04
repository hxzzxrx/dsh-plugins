// 会话存档提取器：读 .dsh/sessions 下的 session.v4.jsonl.zstd，抽成结构化对话。
// 只保留「人说的话」和「助手说的话」——系统提示词、工具调用与结果、运行时上下文全部丢弃。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const SESSION_FLAT = 'session.v4.jsonl'

/** DSH 数据根：优先环境变量，其次 ~/.dsh */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot(home) {
  return path.join(home, 'sessions')
}

/** 递归找所有会话文件，返回 [{file, dir, id}] */
export function listSessionFiles(home = dshHome()) {
  const root = sessionsRoot(home)
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === SESSION_FILE || e.name === SESSION_FLAT) {
        const id = path.basename(dir)
        out.push({ file: p, dir, id })
      }
    }
  }
  walk(root)
  // 同一目录若两种文件并存，优先压缩版
  const byDir = new Map()
  for (const f of out) {
    const prev = byDir.get(f.dir)
    if (!prev || f.file.endsWith('.zstd')) byDir.set(f.dir, f)
  }
  return [...byDir.values()]
}

function readLines(file) {
  const raw = fs.readFileSync(file)
  const buf = file.endsWith('.zstd') ? zlib.zstdDecompressSync(raw) : raw
  return buf.toString('utf8').split('\n').filter((l) => l.length > 0)
}

/** 从一条 assistant/message 里取纯文本（丢弃 reasoning 和 tool-call） */
function assistantText(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

/** 从一条 user/message 里取纯文本；只认真人输入 */
function userText(data) {
  if (data?.source?.kind !== 'user') return ''
  const content = data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

/** 解析一个会话文件 → { header, messages, title } */
export function parseSession(file) {
  const lines = readLines(file)
  let header = null
  let title = ''
  const messages = []
  // 一个 turn 内的消息先缓冲，只在 turn 真正结束后才提交。
  // 原因：同一 turn 里 assistant/message 的 seq 会随后续步骤不断变化，
  // 若在 turn 未结束时归档，同一条内容会以不同 seq 重复写入（实测出现过 518 与 598 同文）。
  const buffered = []
  let turnOpen = false

  const commitTurn = () => {
    let merged = null
    for (const m of buffered) {
      if (m.role === 'assistant') {
        if (merged) {
          merged.text += '\n\n' + m.text
          merged.seq = m.seq
        } else {
          merged = { role: 'assistant', time: m.time, text: m.text, seq: m.seq }
          messages.push(merged)
        }
      } else {
        merged = null
        messages.push(m)
      }
    }
    buffered.length = 0
  }

  for (const line of lines) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'session') {
      header = ev
      continue
    }
    if (ev.type === 'session/title') {
      if (ev.data?.title) title = String(ev.data.title)
      continue
    }
    if (ev.type === 'turn/start') {
      turnOpen = true
      buffered.length = 0
      continue
    }
    if (ev.type === 'turn/end') {
      if (turnOpen) {
        commitTurn()
        turnOpen = false
      }
      continue
    }
    if (ev.type === 'user/message') {
      const text = userText(ev.data)
      if (!text) continue
      const item = { role: 'user', time: ev.time, seq: ev.seq, text }
      if (turnOpen) buffered.push(item)
      else messages.push(item)
      continue
    }
    if (ev.type === 'assistant/message') {
      const text = assistantText(ev.data)
      if (!text) continue
      const item = { role: 'assistant', time: ev.time, text, seq: ev.seq }
      if (turnOpen) buffered.push(item)
      else messages.push(item)
      continue
    }
  }
  // 未结束的 turn 一律不提交：宁可晚一条，也不要重复或错序。

  return { header, title, messages }
}

/** 汇总全部会话。cache 以文件 size+mtime 为键，避免重复解压。 */
export function collectSessions({ home = dshHome(), cache = new Map() } = {}) {
  const files = listSessionFiles(home)
  const sessions = []
  for (const f of files) {
    let st
    try {
      st = fs.statSync(f.file)
    } catch {
      continue
    }
    const key = f.file
    const stamp = `${st.size}:${st.mtimeMs}`
    let parsed = cache.get(key)
    if (!parsed || parsed.stamp !== stamp) {
      try {
        parsed = { stamp, value: parseSession(f.file) }
      } catch (err) {
        parsed = { stamp, value: { header: null, title: '', messages: [], error: String(err?.message || err) } }
      }
      cache.set(key, parsed)
    }
    const v = parsed.value
    sessions.push({
      id: f.id,
      file: f.file,
      title: v.title || firstUserLine(v.messages) || f.id,
      cwd: v.header?.cwd || '',
      createdAt: v.header?.createdAt || st.mtimeMs,
      updatedAt: st.mtimeMs,
      preset: v.header?.agentPreset || '',
      messageCount: v.messages.length,
      error: v.error || null,
      messages: v.messages,
    })
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

function firstUserLine(messages) {
  const u = messages.find((m) => m.role === 'user')
  if (!u) return ''
  const line = u.text.split('\n').find((l) => l.trim()) || ''
  return line.slice(0, 40)
}

/** 全量纯文本（用于搜索索引与导出） */
export function sessionToText(s) {
  const pad = (n) => String(n).padStart(2, '0')
  const d = new Date(s.createdAt)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const out = [`# ${s.title}`, '', `- 时间：${stamp}`, `- 工作区：${s.cwd}`, `- 消息数：${s.messageCount}`, '']
  for (const m of s.messages) {
    out.push(m.role === 'user' ? '## 我' : '## DeepSeek', '', m.text, '')
  }
  return out.join('\n')
}
