/**
 * 记忆库视图的数据层。
 *
 * 记忆目录默认 <DSH_HOME>\memory（可以在「设置」里改）：
 *   - archive-001.md  滚动归档卷
 *   - meta.json       卷清单 / 归档起点
 *   - index.sqlite    检索索引（sessions / messages / docs / decisions）
 *   - 各种 .md        用户文档与说明
 *
 * 检索走 sqlite 的 LIKE（几百条消息直接扫足够快），
 * 不依赖 FTS 分词——中文在默认分词器下查不出来。
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { openStore } from './archive/store.mjs'
import { defaultMemoryDir } from './paths.mjs'

export function memoryDir() {
  if (process.env.DSH_MEMORY_DIR) return process.env.DSH_MEMORY_DIR
  try {
    const c = loadConfig()
    if (c.memoryDir) return c.memoryDir
  } catch {}
  return defaultMemoryDir()
}

/**
 * 常驻规则文件名（用户手写，每次组装都读）。
 *
 * 新用户默认 rules.md；兼容早期版本留下的 Hello World.md。
 */
export function rulesName() {
  if (process.env.DSH_MEMORY_RULES) return process.env.DSH_MEMORY_RULES
  const dir = memoryDir()
  for (const name of ['rules.md', 'Hello World.md']) {
    try {
      if (fs.existsSync(path.join(dir, name))) return name
    } catch {}
  }
  return 'rules.md'
}

/**
 * 归档引擎单例。
 *
 * 原来这一坨在 dsh-session-archive 里，通过 spawn 它的 CLI 来 sync；搬过来之后
 * 进程内共用同一个 store 实例，避免「两个插件同时开同一个 sqlite」的锁冲突。
 */
let _store = null
export function getStore() {
  if (!_store) _store = openStore(memoryDir(), { rulesName: rulesName() })
  return _store
}

export function closeStore() {
  try {
    _store?.close?.()
  } catch {}
  _store = null
}

/** 把新消息增量写进长期记忆 */
export async function syncMemory() {
  return getStore().sync()
}


function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function statOf(file) {
  try {
    const s = fs.statSync(file)
    return { bytes: s.size, mtime: s.mtimeMs }
  } catch {
    return { bytes: 0, mtime: 0 }
  }
}

let dbCache = null

async function openDb() {
  if (dbCache) return dbCache
  const file = path.join(memoryDir(), 'index.sqlite')
  if (!fs.existsSync(file)) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    dbCache = new DatabaseSync(file, { readOnly: true })
    return dbCache
  } catch {
    return null
  }
}

export async function memoryStats() {
  const dir = memoryDir()
  let exists = true
  try {
    fs.accessSync(dir)
  } catch {
    exists = false
  }
  const meta = exists ? readJson(path.join(dir, 'meta.json')) : null
  const volumes = ((meta && meta.volumes) || []).map((v) => {
    const st = statOf(path.join(dir, v.name))
    return { name: v.name, bytes: st.bytes || v.bytes || 0, createdAt: v.createdAt || 0, mtime: st.mtime, current: meta.current === v.name }
  })
  const docs = []
  if (exists) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const st = statOf(path.join(dir, name))
      docs.push({ name, bytes: st.bytes, mtime: st.mtime })
    }
    docs.sort((a, b) => b.mtime - a.mtime)
  }
  const counts = { sessions: 0, messages: 0, docs: 0, decisions: 0 }
  const db = await openDb()
  if (db) {
    for (const [key, table] of [['sessions', 'sessions'], ['messages', 'messages'], ['docs', 'docs'], ['decisions', 'decisions']]) {
      try {
        counts[key] = db.prepare('select count(*) n from ' + table).get().n
      } catch {}
    }
  }
  const totalBytes = volumes.reduce((n, v) => n + v.bytes, 0)
  return {
    dir,
    exists,
    hasIndex: Boolean(db),
    meta: meta ? { current: meta.current || '', archiveSince: meta.archiveSince || 0, reason: meta.archiveSinceReason || '' } : null,
    volumes,
    docs,
    counts,
    totalBytes,
  }
}

function snippet(body, q, width = 90) {
  const i = body.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return body.slice(0, width * 2).replace(/\s+/g, ' ')
  const start = Math.max(0, i - width / 2)
  return (start > 0 ? '…' : '') + body.slice(start, start + width * 2).replace(/\s+/g, ' ') + '…'
}

export async function memorySearch(query, limit = 20) {
  const q = String(query || '').trim()
  if (!q) return { query: '', hits: [], scanned: false }
  const db = await openDb()
  const hits = []
  if (db) {
    try {
      const rows = db
        .prepare('select session_id, seq, time, body from messages where body like ? order by time desc limit ?')
        .all('%' + q + '%', limit)
      for (const r of rows) {
        hits.push({
          kind: 'message',
          sessionId: r.session_id,
          seq: r.seq,
          time: r.time,
          text: snippet(String(r.body), q),
        })
      }
    } catch {}
    try {
      const rows = db
        .prepare('select path, chunk, heading, body from docs where body like ? limit ?')
        .all('%' + q + '%', Math.max(4, Math.floor(limit / 2)))
      for (const r of rows) {
        hits.push({
          kind: 'doc',
          path: r.path,
          chunk: r.chunk,
          heading: r.heading,
          text: snippet(String(r.body), q),
        })
      }
    } catch {}
  }
  // 索引缺失时退回扫卷文件
  if (!hits.length) {
    try {
      for (const name of fs.readdirSync(memoryDir())) {
        if (!name.endsWith('.md')) continue
        const body = fs.readFileSync(path.join(memoryDir(), name), 'utf8')
        if (!body.toLowerCase().includes(q.toLowerCase())) continue
        hits.push({ kind: 'doc', path: name, chunk: 0, heading: '', text: snippet(body, q) })
        if (hits.length >= limit) break
      }
    } catch {}
  }
  return { query: q, hits, scanned: Boolean(db) }
}

export function memoryReadDoc(name) {
  const safe = String(name || '').replace(/[\\/]/g, '')
  if (!safe.endsWith('.md')) throw new Error('只能读 .md')
  const file = path.join(memoryDir(), safe)
  const text = fs.readFileSync(file, 'utf8')
  return { name: safe, bytes: Buffer.byteLength(text), text: text.length > 200000 ? text.slice(0, 200000) + '\n\n…（超长截断）' : text }
}
