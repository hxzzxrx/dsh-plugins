// 文档收录：把用户丢进 memory\ 的 Markdown/文本切成块，建独立 FTS 索引。
//
// 纪律：
//   1. 只读，绝不改写用户文件。
//   2. 与对话归档完全分开：自己的表、自己的 FTS，搜索结果带 source 标记。
//   3. 增量：按 mtime+size 判断是否变化，未变不重切。
import fs from 'node:fs'
import path from 'node:path'

const CHUNK_MAX = 1000
const SKIP_NAMES = new Set(['index.sqlite', 'meta.json', 'edits.log'])
const SKIP_PREFIX = ['archive-', 'memory-export-', '.']
const SKIP_SUFFIX = ['.broken', '.zip', '.tmp', '.lock', '.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm']
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.json', '.yml', '.yaml'])

/** 与 store.mjs 同一套逻辑：中文逐字切开，让 unicode61 能命中子串 */
function segment(s) {
  return String(s)
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, (c) => ` ${c} `)
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function ftsExpr(q) {
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(q)
  if (!hasCJK) {
    const words = String(q).match(/[\p{L}\p{N}_]+/gu) || []
    return words.map((w) => `"${w}"`).join(' AND ')
  }
  return `"${segment(q).split(' ').filter(Boolean).join(' ')}"`
}

/** 按 Markdown 标题与空行切段，再合并到不超过 CHUNK_MAX 的块 */
function chunkText(body, name) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n')
  const sections = []
  let heading = name
  let buf = []
  const push = () => {
    if (buf.some((l) => l.trim())) sections.push({ heading, text: buf.join('\n').trim() })
    buf = []
  }
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      push()
      heading = h[2].trim() || heading
      continue
    }
    buf.push(line)
    if (line.trim() === '' && buf.join('').length > CHUNK_MAX) push()
  }
  push()

  // 合并小段，避免碎片过多
  const out = []
  let acc = null
  for (const s of sections) {
    if (!acc) {
      acc = { ...s }
      continue
    }
    if ((acc.text + '\n\n' + s.text).length <= CHUNK_MAX) acc.text += '\n\n' + s.text
    else {
      out.push(acc)
      acc = { ...s }
    }
  }
  if (acc) out.push(acc)
  return out.slice(0, 500) // 单文件最多 500 块，防止异常大文件撑爆
}

export function createDocIndex(db, dir, { rulesName = 'Hello World.md' } = {}) {
  db.exec(`
    create table if not exists doc_files (
      path text primary key,
      mtime integer not null,
      size integer not null,
      chunks integer not null default 0,
      indexed_at integer not null default 0
    );
    create table if not exists docs (
      rowid integer primary key,
      path text not null,
      chunk integer not null,
      heading text not null default '',
      body text not null
    );
    create index if not exists ix_docs_path on docs(path);
    create virtual table if not exists docs_fts using fts5(body);
  `)

  const q = {
    fileRow: db.prepare('select * from doc_files where path = ?'),
    upsertFile: db.prepare(`
      insert into doc_files (path, mtime, size, chunks, indexed_at) values (?, ?, ?, ?, ?)
      on conflict(path) do update set mtime = excluded.mtime, size = excluded.size,
        chunks = excluded.chunks, indexed_at = excluded.indexed_at
    `),
    allFiles: db.prepare('select path from doc_files'),
    delFile: db.prepare('delete from doc_files where path = ?'),
    chunksOf: db.prepare('select rowid from docs where path = ?'),
    delChunk: db.prepare('delete from docs where rowid = ?'),
    delFts: db.prepare('delete from docs_fts where rowid = ?'),
    insChunk: db.prepare('insert into docs (path, chunk, heading, body) values (?, ?, ?, ?)'),
    insFts: db.prepare('insert into docs_fts (rowid, body) values (?, ?)'),
    search: db.prepare(`
      select d.rowid as rid, d.path, d.chunk, d.heading, d.body, bm25(docs_fts) as score
      from docs_fts f join docs d on d.rowid = f.rowid
      where docs_fts match ?
      order by score limit ?
    `),
    countDocs: db.prepare('select count(*) c from docs'),
    countFiles: db.prepare('select count(*) c from doc_files'),
    listFiles: db.prepare('select path, chunks, indexed_at from doc_files order by path'),
  }

  function skipped(name) {
    if (SKIP_NAMES.has(name)) return true
    if (name === rulesName) return true // 规则文档单独注入，不进检索
    if (SKIP_PREFIX.some((p) => name.startsWith(p))) return true
    if (SKIP_SUFFIX.some((s) => name.endsWith(s))) return true
    return false
  }

  function collect() {
    const out = []
    const walk = (d) => {
      let entries
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) {
          walk(full)
          continue
        }
        if (skipped(e.name)) continue
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue
        out.push(full)
      }
    }
    walk(dir)
    return out
  }

  /** 增量重建：新增/改动的文件重切，消失的文件清掉 */
  function reindex() {
    let added = 0
    let updated = 0
    let removed = 0
    let chunks = 0
    const seen = new Set()

    for (const file of collect()) {
      const rel = path.relative(dir, file).replace(/\\/g, '/')
      seen.add(rel)
      let st
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      const prev = q.fileRow.get(rel)
      if (prev && prev.mtime === Math.round(st.mtimeMs) && prev.size === st.size) continue

      // 清掉该文件旧块
      for (const row of q.chunksOf.all(rel)) {
        q.delFts.run(row.rowid)
        q.delChunk.run(row.rowid)
      }

      let body = ''
      try {
        body = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const parts = chunkText(body, path.basename(file))
      parts.forEach((p, i) => {
        const info = q.insChunk.run(rel, i, p.heading, p.text)
        // 标题也进索引：只出现在标题里的词也能搜到
        q.insFts.run(info.lastInsertRowid, segment(`${p.heading}\n${p.text}`))
        chunks++
      })
      q.upsertFile.run(rel, Math.round(st.mtimeMs), st.size, parts.length, Date.now())
      if (prev) updated++
      else added++
    }

    // 删掉已不存在的文件
    for (const row of q.allFiles.all()) {
      if (seen.has(row.path)) continue
      for (const c of q.chunksOf.all(row.path)) {
        q.delFts.run(c.rowid)
        q.delChunk.run(c.rowid)
      }
      q.delFile.run(row.path)
      removed++
    }

    return { added, updated, removed, chunks, files: q.countFiles.get().c, totalChunks: q.countDocs.get().c }
  }

  function snippetOf(body, term, radius = 60) {
    const at = body.toLowerCase().indexOf(term.toLowerCase())
    if (at < 0) return body.slice(0, radius * 2)
    const start = Math.max(0, at - radius)
    const end = Math.min(body.length, at + term.length + radius)
    return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
  }

  function search(term, limit = 5) {
    const expr = ftsExpr(term)
    if (!expr) return { items: [] }
    let rows
    try {
      rows = q.search.all(expr, limit)
    } catch (err) {
      return { items: [], error: String(err.message || err) }
    }
    return {
      items: rows.map((r) => ({
        source: 'doc',
        path: r.path,
        chunk: r.chunk,
        heading: r.heading,
        citation: `${r.path}#chunk${r.chunk}`,
        snippet: snippetOf(r.body, term),
        score: r.score,
      })),
    }
  }

  function stats() {
    return { files: q.countFiles.get().c, chunks: q.countDocs.get().c, list: q.listFiles.all() }
  }

  function reset() {
    db.exec('delete from docs_fts')
    db.exec('delete from docs')
    db.exec('delete from doc_files')
  }

  return { reindex, search, stats, reset, chunkText }
}
