// memory 存储层：Markdown 卷（只追加）+ SQLite(FTS5 字符级分词) 索引。
//
// 三条纪律：
//   1. 卷文件只追加，永不重写；写前 fsync，读时容忍尾部残行（崩溃只会丢最后一条）。
//   2. 旧卷只增不删（这就是"没有自动备份"时的天然副本）。
//   3. 所有写入串行化（文件锁），并发会话不会互相踩。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { collectSessions } from './archive.mjs'
import { createDocIndex } from './docs.mjs'

const VOLUME_LIMIT = 300 * 1024 * 1024 // 300MB
const LOCK_WAIT_MS = 4000
// 进程内会话解析缓存：同一进程里重复同步时，未变化的会话不再重新解压解析
const SESSION_CACHE = new Map()

/* ---------------- 中文分词：逐字切开，让 unicode61 能命中子串 ---------------- */
export function segment(s) {
  return String(s)
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, (c) => ` ${c} `)
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 把用户查询转成 FTS5 表达式；含中文走短语，纯 ASCII 走普通词。 */
function ftsQuery(q) {
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(q)
  if (!hasCJK) {
    // 只保留字母数字，避免把用户输入当 FTS 语法
    const words = q.match(/[\p{L}\p{N}_]+/gu) || []
    return words.map((w) => `"${w}"`).join(' AND ')
  }
  // 中文：整串当短语（相邻字符必须连续出现）
  const phrase = segment(q).split(' ').filter(Boolean).join(' ')
  return `"${phrase}"`
}

/* ---------------- 决策识别（第二期） ----------------
 * 目标不是"判定谁对谁错"，而是"把同一主题的先后决定串起来"。
 * 只标注时间顺序，绝不宣称旧的那条是错的——语义判断不可靠时，不假装可靠。
 */
const DECISION_PATTERNS = [
  /(改为|改成|换成|换为|改用|不再用|不再使用|取消掉?|放弃|决定用|就用|不用了|停止使用|以后用)/,
  /\b(switch(?:ing)?\s+to|no longer|instead\s+of|replace(?:\s+\w+){0,4}\s+with|from\s+now\s+on)\b/i,
]

const STOP_TOKENS = new Set([
  '的', '了', '是', '在', '和', '就', '也', '都', '我', '你', '他', '它', '把', '被',
  '要', '不', '这', '那', '有', '个', '用', '吧', '啊', '呢', '吗', '们', '会', '能',
])

/** 判断一段话里有没有「做决定」的语言。命中就记下来，不命中就跳过。 */
export function detectDecision(text) {
  if (!text) return null
  // 决策通常出现在开头；只看前 300 字，避免长文里偶然出现关键词造成误报
  const head = String(text).split('\n').slice(0, 4).join(' ').slice(0, 300)
  for (const re of DECISION_PATTERNS) {
    const m = re.exec(head)
    if (!m) continue
    const at = m.index
    const sentence = head.slice(Math.max(0, at - 40), Math.min(head.length, at + 80)).trim()
    return { trigger: m[0], sentence }
  }
  return null
}

/** 主题特征：中文二元组 + 英文词，剔除高频虚词构成的二元组 */
export function topicTokens(text) {
  const out = new Set()
  for (const run of String(text).match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (!STOP_TOKENS.has(bg[0]) && !STOP_TOKENS.has(bg[1])) out.add(bg)
    }
  }
  for (const w of String(text).match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []) out.add(w.toLowerCase())
  return [...out]
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const B = new Set(b)
  let inter = 0
  for (const x of a) if (B.has(x)) inter++
  return inter / (a.length + b.length - inter)
}

/** 包含度：短句被长句覆盖的比例。短句场景比 jaccard 更宽容。 */
function containment(a, b) {
  if (!a.length || !b.length) return 0
  const B = new Set(b)
  let inter = 0
  for (const x of a) if (B.has(x)) inter++
  return inter / Math.min(a.length, b.length)
}

/** 主题相似度：两种度量取大者。 */
function similarity(a, b) {
  return Math.max(jaccard(a, b), containment(a, b))
}

/* ---------------- 文件锁 ---------------- */
async function withLock(dir, fn) {
  const lock = path.join(dir, '.lock')
  const start = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // 陈旧锁：超过 30 秒认为持有者已死
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          fs.rmdirSync(lock)
          continue
        }
      } catch {}
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('memory 写入锁超时（另一个写入者未释放）')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.rmdirSync(lock)
    } catch {}
  }
}

/* ---------------- 存储 ---------------- */
export function openStore(dir, { rulesName = 'Hello World.md' } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'index.sqlite')
  const metaPath = path.join(dir, 'meta.json')
  const db = new DatabaseSync(dbPath)
  // 插件进程可能同时持有连接，给足忙等待，避免 SQLITE_BUSY
  db.exec('pragma busy_timeout = 5000')
  // 文档收录索引（用户丢进 memory\ 的笔记等），与对话索引各自独立
  const docIndex = createDocIndex(db, dir, { rulesName })

  db.exec(`
    create table if not exists sessions (
      id text primary key,
      title text not null default '',
      cwd text not null default '',
      created_at integer not null default 0,
      updated_at integer not null default 0,
      last_seq integer not null default -1,
      volume text not null default ''
    );
    create table if not exists messages (
      rowid integer primary key,
      session_id text not null,
      seq integer not null,
      role text not null,
      time integer not null,
      body text not null
    );
    create unique index if not exists ux_msg on messages(session_id, seq, role);
    create index if not exists ix_msg_session on messages(session_id);
    create virtual table if not exists messages_fts using fts5(body);
    create table if not exists decisions (
      id integer primary key,
      session_id text not null,
      seq integer not null,
      time integer not null,
      trigger text not null default '',
      text text not null,
      tokens text not null default '[]'
    );
    create index if not exists ix_dec_seq on decisions(seq);
    create table if not exists meta (k text primary key, v text not null);
  `)

  const q = {
    getSession: db.prepare('select * from sessions where id = ?'),
    upsertSession: db.prepare(`
      insert into sessions (id, title, cwd, created_at, updated_at, last_seq, volume)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        title = excluded.title, cwd = excluded.cwd,
        updated_at = excluded.updated_at, last_seq = excluded.last_seq,
        volume = excluded.volume
    `),
    insertMessage: db.prepare(
      'insert or ignore into messages (session_id, seq, role, time, body) values (?, ?, ?, ?, ?)',
    ),
    insertFts: db.prepare('insert into messages_fts (rowid, body) values (?, ?)'),
    search: db.prepare(`
      select m.rowid as rid, m.session_id, m.seq, m.role, m.time, m.body,
             s.title as title, bm25(messages_fts) as score
      from messages_fts f
      join messages m on m.rowid = f.rowid
      join sessions s on s.id = m.session_id
      where messages_fts match ?
      order by score
      limit ?
    `),
    count: db.prepare('select count(*) c from messages'),
    insertDecision: db.prepare(
      'insert into decisions (session_id, seq, time, trigger, text, tokens) values (?, ?, ?, ?, ?, ?)',
    ),
    allDecisions: db.prepare('select * from decisions order by time, seq'),
    decisionAt: db.prepare('select * from decisions where session_id = ? and seq = ?'),
    userMsgsAfter: db.prepare(
      "select session_id, seq, time, body from messages where role = 'user' and seq > ? order by seq",
    ),
    metaGet: db.prepare('select v from meta where k = ?'),
    metaSet: db.prepare('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v'),
    decisionCount: db.prepare('select count(*) c from decisions'),
    sessionCount: db.prepare('select count(*) c from sessions'),
    bySession: db.prepare(`
      select m.session_id, s.title, count(*) hits, min(m.time) first_time, max(m.time) last_time
      from messages_fts f
      join messages m on m.rowid = f.rowid
      join sessions s on s.id = m.session_id
      where messages_fts match ?
      group by m.session_id
      order by hits desc
      limit ?
    `),
  }

  /* ---------- meta.json ---------- */
  // Windows 上杀毒软件/其它进程可能在某瞬间持有文件句柄，导致 rename 报 EPERM。
  // 读和写都做退避重试；写失败到最后直接覆盖（少了原子性，但好过整个同步失败）。
  const sleepSync = (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 短忙等：这里没有异步上下文可用 */
    }
  }

  function readMeta() {
    for (let i = 0; i < 5; i++) {
      try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      } catch (err) {
        if (err.code === 'ENOENT') return { volumes: [], current: null, createdAt: Date.now() }
        sleepSync(20)
      }
    }
    return { volumes: [], current: null, createdAt: Date.now() }
  }

  function writeMeta(meta) {
    const body = JSON.stringify(meta, null, 2)
    const tmp = metaPath + '.tmp'
    for (let i = 0; i < 8; i++) {
      try {
        fs.writeFileSync(tmp, body)
        fs.renameSync(tmp, metaPath) // 原子替换
        return
      } catch (err) {
        const retryable = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES'
        if (!retryable) throw err
        if (i < 7) {
          sleepSync(30)
          continue
        }
        // 兜底：直接覆盖目标文件（牺牲原子性，保证不丢这次更新）
        fs.writeFileSync(metaPath, body)
        try {
          fs.rmSync(tmp, { force: true })
        } catch {}
        return
      }
    }
  }
  function sha256(file) {
    const h = crypto.createHash('sha256')
    h.update(fs.readFileSync(file))
    return h.digest('hex')
  }
  function volumePath(meta) {
    return path.join(dir, meta.current || 'archive-001.md')
  }
  function ensureVolume(meta) {
    if (!meta.current) {
      meta.current = 'archive-001.md'
      meta.volumes = meta.volumes || []
    }
    const p = volumePath(meta)
    if (!fs.existsSync(p)) {
      const header = `# 会话存档 · ${meta.current}\n\n> 由 dsh-session-archive 维护，只追加，请勿手动重写。\n\n`
      fs.writeFileSync(p, header)
      meta.volumes = meta.volumes.filter((v) => v.name !== meta.current)
      meta.volumes.push({ name: meta.current, createdAt: Date.now(), bytes: header.length })
      writeMeta(meta)
    }
    return p
  }
  function rotateIfNeeded(meta, incomingBytes) {
    const p = volumePath(meta)
    let size = 0
    try {
      size = fs.statSync(p).size
    } catch {}
    if (size + incomingBytes <= VOLUME_LIMIT) return { rotated: false, file: p }
    // 冻结当前卷：记账 + 换新卷名（旧卷原样保留 = 天然副本）
    const n = meta.volumes.length + 1
    meta.current = `archive-${String(n).padStart(3, '0')}.md`
    meta.volumes.push({ name: meta.current, createdAt: Date.now(), bytes: 0 })
    meta.previous = meta.volumes[meta.volumes.length - 2]?.name || null
    writeMeta(meta)
    const fresh = ensureVolume(meta)
    return { rotated: true, file: fresh, from: p }
  }

  /* ---------- 写入一条消息 ---------- */
  function appendMessage(meta, msg, session) {
    const pad = (n) => String(n).padStart(2, '0')
    const d = new Date(msg.time)
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    const who = msg.role === 'user' ? '我' : 'DeepSeek'
    const block = `## ${who} · ${stamp} · #${msg.seq}\n\n${msg.text}\n\n`
    const bytes = Buffer.byteLength(block, 'utf8')

    // 只在真的要写的时候才建卷文件，避免没有内容时留下一个空壳
    ensureVolume(meta)
    const { file, rotated } = rotateIfNeeded(meta, bytes)
    const fd = fs.openSync(file, 'a')
    try {
      fs.writeSync(fd, block)
      fs.fsyncSync(fd) // 落盘，防断电丢块
    } finally {
      fs.closeSync(fd)
    }
    // 记账：volumes[].bytes 是卷的真实大小，不更新就会一直停在初始 header 长度（65）
    const entry = (meta.volumes || []).find((v) => v.name === path.basename(file))
    if (entry) {
      try {
        entry.bytes = fs.statSync(file).size
      } catch {
        entry.bytes = (entry.bytes || 0) + bytes
      }
    }
    return { bytes, file: path.basename(file), rotated, sessionId: session.id }
  }

  /* ---------- 同步：把新消息增量写入 ---------- */
  async function sync({ home } = {}) {
    return withLock(dir, async () => {
      const meta = readMeta()
      // 清空记忆时写入的起点：比它更早的消息永久跳过，避免"刚清完又被写回去"
      const since = Number(meta.archiveSince || 0)
      const sessions = collectSessions({ home, cache: SESSION_CACHE })
      const report = { sessions: 0, messages: 0, volumes: [], errors: [] }

      db.exec('begin')
      try {
        for (const s of sessions) {
          // 扫描游标与会话行分开：即使一条都没归档（比如还早于起点），
          // 也要记住扫到哪了，否则每轮都把整段会话重新解析一遍。
          const scanKey = 'scan:' + s.id
          const scan = Number(q.metaGet.get(scanKey)?.v ?? -1)
          // 起点按「轮次」生效：提问早于起点，则整轮（含回答）一起跳过，
          // 避免出现"有回答但找不到对应问题"的孤立记录。
          const fresh = []
          let keepTurn = false
          for (const m of s.messages) {
            if (m.role === 'user') keepTurn = (m.time || 0) >= since
            if (!keepTurn) continue
            if (m.seq == null || m.seq <= scan) continue
            fresh.push(m)
          }
          const diskSeq = s.messages.length ? s.messages[s.messages.length - 1].seq : scan

          if (!fresh.length) {
            // 没有可归档的消息：不建空会话行，只推进扫描游标
            if (diskSeq > scan) q.metaSet.run(scanKey, String(diskSeq))
            continue
          }

          const prev = q.getSession.get(s.id)
          // 确有内容要写，此时才创建卷文件（并确保 meta.current 有值）
          ensureVolume(meta)
          q.upsertSession.run(
            s.id, s.title, s.cwd, s.createdAt, s.updatedAt,
            fresh[fresh.length - 1].seq, meta.current,
          )
          if (!prev) report.sessions++

          for (const m of fresh) {
            const info = db
              .prepare('insert or ignore into messages (session_id, seq, role, time, body) values (?, ?, ?, ?, ?)')
              .run(s.id, m.seq, m.role, m.time, m.text)
            if (info.changes > 0) {
              q.insertFts.run(info.lastInsertRowid, segment(m.text))
              const w = appendMessage(meta, m, s)
              if (w.rotated) report.volumes.push(w.file)
              report.messages++
            }
          }
          q.metaSet.run(scanKey, String(Math.max(diskSeq, fresh[fresh.length - 1].seq)))
        }

        // 决策识别：只扫新增的用户消息，游标记录已处理到哪一条
        const cursor = Number(q.metaGet.get('decisions_cursor')?.v ?? -1)
        let maxSeq = cursor
        for (const row of q.userMsgsAfter.all(cursor)) {
          const d = detectDecision(row.body)
          if (d) {
            q.insertDecision.run(
              row.session_id, row.seq, row.time, d.trigger, d.sentence,
              JSON.stringify(topicTokens(d.sentence)),
            )
          }
          if (row.seq > maxSeq) maxSeq = row.seq
        }
        if (maxSeq > cursor) q.metaSet.run('decisions_cursor', String(maxSeq))

        db.exec('commit')
      } catch (err) {
        try {
          db.exec('rollback')
        } catch {}
        report.errors.push(String(err?.message || err))
      }
      writeMeta(meta)
      // 顺带增量收录 memory\ 里的用户文档（只读，不改写）
      try {
        report.docs = docIndex.reindex()
      } catch (err) {
        // 留成 null 而不是 undefined：工具输出要过宿主无损 JSON 校验
        report.docs = null
        report.errors.push('docs: ' + String(err?.message || err))
      }
      report.total = q.count.get().c
      report.sessionTotal = q.sessionCount.get().c
      return report
    })
  }

  /* ---------- 检索（带引用） ---------- */
  function snippetOf(body, term, radius = 60) {
    const at = body.toLowerCase().indexOf(term.toLowerCase())
    if (at < 0) return body.slice(0, radius * 2)
    const start = Math.max(0, at - radius)
    const end = Math.min(body.length, at + term.length + radius)
    return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
  }

  function search(term, limit = 10) {
    const expr = ftsQuery(term)
    if (!expr) return { items: [], error: '查询为空' }
    let rows
    try {
      rows = q.search.all(expr, limit)
    } catch (err) {
      return { items: [], error: String(err.message || err) }
    }
    const items = rows.map((r) => {
      const d = q.decisionAt.get(r.session_id, r.seq)
      return {
        sessionId: r.session_id,
        title: r.title,
        seq: r.seq,
        role: r.role,
        time: r.time,
        citation: `${r.session_id} #${r.seq}`,
        snippet: snippetOf(r.body, term),
        score: r.score,
        isDecision: !!d,
      }
    })
    annotateSupersede(items)
    // 文档收录的结果单独返回，带 source='doc'，不与对话混淆
    let docs = []
    let docsError
    try {
      const r = docIndex.search(term, Math.min(3, limit))
      docs = r.items || []
      docsError = r.error
    } catch (err) {
      docsError = String(err?.message || err)
    }
    // 只有真的有错误时才带 docsError：宿主对工具输出做无损 JSON 校验，
    // 值为 undefined 的属性会被判为非法输出（JSON.stringify 看不出这个问题）。
    return docsError === void 0 ? { items, docs } : { items, docs, docsError }
  }

  function decisionRows() {
    return q.allDecisions.all().map((r) => {
      let tokens = []
      try {
        tokens = JSON.parse(r.tokens || '[]')
      } catch {}
      return { ...r, tokens }
    })
  }

  /** 对命中结果里的决策句，找更晚的同主题决策，标注「已被后来的决定覆盖」 */
  function annotateSupersede(items) {
    const rows = decisionRows()
    if (!rows.length) return
    for (const it of items) {
      if (!it.isDecision) continue
      const self = rows.find((r) => r.seq === it.seq && r.session_id === it.sessionId)
      if (!self) continue
      const later = rows
        .filter((r) => r.time > self.time || (r.time === self.time && r.seq > self.seq))
        .filter((r) => similarity(r.tokens, self.tokens) >= 0.5)
      if (later.length) {
        const last = later[later.length - 1]
        it.supersededBy = { seq: last.seq, time: last.time, text: last.text }
      }
    }
  }

  /** "我们聊过这个"：按会话聚合命中数 */
  function relate(term, limit = 5) {
    const expr = ftsQuery(term)
    if (!expr) return { items: [] }
    try {
      const rows = q.bySession.all(expr, limit)
      return {
        items: rows.map((r) => ({
          sessionId: r.session_id,
          title: r.title,
          hits: r.hits,
          firstTime: r.first_time,
          lastTime: r.last_time,
        })),
      }
    } catch (err) {
      return { items: [], error: String(err.message || err) }
    }
  }

  /**
   * 决策链：把同一主题的先后决定按时间串起来。
   * 只标「这条后面还有一条同主题的决定」，不判断谁对谁错。
   */
  function decisions({ topic, limit = 20 } = {}) {
    const rows = decisionRows()
    const t = topic ? topicTokens(topic) : null
    const items = []
    for (const r of rows) {
      if (t && similarity(r.tokens, t) < 0.3) continue
      const later = rows
        .filter((o) => o.time > r.time || (o.time === r.time && o.seq > r.seq))
        .filter((o) => similarity(o.tokens, r.tokens) >= 0.5)
      const last = later[later.length - 1]
      // 同为「改用/换成」但用词不重合的后续决定：只作同类型提示，不声称同主题
      const sameVerb = rows.filter(
        (o) => o.id !== r.id && o.trigger === r.trigger &&
          (o.time > r.time || (o.time === r.time && o.seq > r.seq)),
      )
      items.push({
        sessionId: r.session_id,
        seq: r.seq,
        time: r.time,
        trigger: r.trigger,
        text: r.text,
        later: last
          ? { seq: last.seq, time: last.time, text: last.text, basis: '用词重合' }
          : null,
        sameVerbLater: sameVerb.slice(-3).map((o) => ({ seq: o.seq, time: o.time, text: o.text })),
      })
    }
    return { total: rows.length, matched: items.length, items: items.slice(-limit) }
  }

  function stats() {
    const meta = readMeta()
    let docs = { files: 0, chunks: 0, list: [] }
    try {
      docs = docIndex.stats()
    } catch {}
    return {
      dir,
      messages: q.count.get().c,
      sessions: q.sessionCount.get().c,
      currentVolume: meta.current,
      docs,
      volumes: (meta.volumes || []).map((v) => {
        const p = path.join(dir, v.name)
        let bytes = 0
        let hash = null
        try {
          bytes = fs.statSync(p).size
          hash = sha256(p)
        } catch {}
        return { ...v, bytes, sha256: hash }
      }),
    }
  }

  /** 对账：逐会话比较磁盘解析结果与索引，报告缺失与多余。
   *  必须尊重 archiveSince——被起点故意跳过的历史不算缺失，否则清空后永远在报假警。 */
  function check({ home } = {}) {
    const meta = readMeta()
    const since = Number(meta.archiveSince || 0)
    const sessions = collectSessions({ home })
    const report = { scanned: sessions.length, ok: true, skippedBySince: 0, drifted: [] }

    // 与 sync 同样的轮次级过滤：提问早于起点，则整轮（含回答）都算跳过
    const expected = (messages) => {
      const out = []
      let keepTurn = false
      for (const m of messages) {
        if (m.role === 'user') keepTurn = (m.time || 0) >= since
        if (!keepTurn) {
          report.skippedBySince++
          continue
        }
        out.push(`${m.seq}:${m.role}`)
      }
      return out
    }

    for (const s of sessions) {
      const rows = db.prepare('select seq, role from messages where session_id = ? order by seq').all(s.id)
      const disk = expected(s.messages)
      const have = rows.map((r) => `${r.seq}:${r.role}`)
      // 缺失 = 尚未同步（正常滞后，下一轮会补上）
      // 多余 = 索引里有、磁盘上找不到（这才是真不一致）
      const missing = disk.filter((x) => !have.includes(x))
      const extra = have.filter((x) => !disk.includes(x))
      if (!missing.length && !extra.length) continue
      if (extra.length) report.ok = false
      report.drifted.push({
        id: s.id,
        title: s.title,
        disk: disk.length,
        db: have.length,
        missing,
        extra,
        severity: extra.length ? 'inconsistent' : 'pending',
      })
    }
    return report
  }

  /**
   * 清空：真删除全部对话记忆（索引 + 卷文件），并记下起点时间。
   * 起点之后的消息才会被归档——否则下一次自动同步会把刚清掉的内容写回去。
   * 只保留：插件代码（在插件目录）、meta.json、用户文档索引、rules.md（兼容旧名 Hello World.md）。
   */
  async function purge() {
    return withLock(dir, async () => {
      const removed = []
      db.exec('begin')
      try {
        db.exec('delete from messages_fts')
        db.exec('delete from messages')
        db.exec('delete from sessions')
        db.exec('delete from decisions')
        db.exec("delete from meta where k = 'decisions_cursor'")
        db.exec("delete from meta where k like 'scan:%'")
        db.exec('commit')
      } catch (err) {
        try {
          db.exec('rollback')
        } catch {}
        throw err
      }

      // 删掉所有归档卷（含 .broken 留档），这些文件里就是对话正文
      let entries = []
      try {
        entries = fs.readdirSync(dir)
      } catch {}
      for (const name of entries) {
        if (!/^archive-\d+\.md(\.broken-.*)?$/.test(name)) continue
        const p = path.join(dir, name)
        try {
          fs.rmSync(p)
          removed.push(name)
        } catch {}
      }

      // 真正擦掉索引文件里的残留页（删除只是标记，内容还留在空闲页里）
      try {
        db.exec('vacuum')
      } catch {}

      const now = Date.now()
      writeMeta({ volumes: [], current: null, createdAt: now, purgedAt: now, archiveSince: now })
      return { purged: true, removed }
    })
  }

  /** 重建：清空索引、把旧卷改名留档（不删除），随后由 sync 重新归档 */
  async function rebuild() {
    return withLock(dir, async () => {
      db.exec('begin')
      try {
        db.exec('delete from messages_fts')
        db.exec('delete from messages')
        db.exec('delete from sessions')
        db.exec('delete from decisions')
        db.exec("delete from meta where k = 'decisions_cursor'")
        db.exec("delete from meta where k like 'scan:%'")
        db.exec('commit')
      } catch (err) {
        try {
          db.exec('rollback')
        } catch {}
        throw err
      }
      const meta = readMeta()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const names = new Set([...(meta.volumes || []).map((v) => v.name), meta.current].filter(Boolean))
      const saved = []
      for (const name of names) {
        const p = path.join(dir, name)
        if (!fs.existsSync(p)) continue
        const to = `${p}.broken-${stamp}`
        fs.renameSync(p, to)
        saved.push(path.basename(to))
      }
      // 清空是单向的：重建必须继承归档起点，否则 purge 掉的历史会借重建"复活"
      // （会话日志在 .dsh/sessions 里仍然存在，不继承起点就会重新归档回去）。
      const carried = { volumes: [], current: null, createdAt: Date.now(), rebuiltAt: Date.now() }
      if (meta.archiveSince) {
        carried.archiveSince = meta.archiveSince
        if (meta.archiveSinceReason) carried.archiveSinceReason = meta.archiveSinceReason
        if (meta.purgedAt) carried.purgedAt = meta.purgedAt
      }
      writeMeta(carried)
      try {
        docIndex.reset()
      } catch {}
      return { rebuilt: true, saved }
    })
  }

  function close() {
    try {
      db.close()
    } catch {}
  }

  return { db, dir, sync, search, relate, decisions, stats, check, rebuild, purge, docs: docIndex, readMeta, writeMeta, volumePath, close }
}

export { VOLUME_LIMIT, ftsQuery }
