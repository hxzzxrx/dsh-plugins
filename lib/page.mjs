// dsh-plugins / page：插件管理页面（GET /dsh-plugins）+ API
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { listPlugins, setEnabled, removePlugin, pluginDir, listTrash, restoreTrash, purgeTrash, checkUpdates, impactAll, exportManifest, readmeOf, profileDir, upgradePlugin, upgradeStatus } from './catalog.mjs'
import { loadPending, notifyNow, dismissPending, sendTask, sendTaskTo } from './newp.mjs'
import { healthAll, scanLogs, archiveLogs, archiveStats, purgeArchives } from './health.mjs'
import { board, getTask, createTask, claimTask, splitTask, assignPart, doneTask, commentTask, removeTask, matchOwner } from './tasks.mjs'
import { listPersonas, setPersona, removePersona, personaBrief, personaLabel } from './personas.mjs'
import { memoryStats, memorySearch, memoryReadDoc, syncMemory } from './memory.mjs'
import { loadConfig, saveConfig, resetConfig, DEFAULTS } from './config.mjs'
import { dshHome, credentialsFile } from './paths.mjs'

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

const APP_JS = fileURLToPath(new URL('./app.js', import.meta.url))

export function pluginRoutes(ctx) {
  const html = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(PAGE)
  }

  const appJs = async (req, res) => {
    try {
      const text = await readFile(APP_JS, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(text)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('app.js 读不到：' + String(err?.message || err))
    }
  }

  const list = async (req, res) => {
    try {
      return json(res, 200, listPlugins())
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const pending = async (req, res) => {
    try {
      return json(res, 200, { items: loadPending() })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const action = async (req, res) => {
    const body = await readBody(req)
    const name = String(body.name || '')
    const act = String(body.action || '')
    try {
      if (act === 'ask-install') {
        const target = String(body.target || '').trim()
        if (!target) throw new Error('先填插件目录或 GitHub 链接')
        const r = await sendTask(ctx, installTaskText(target))
        return json(res, 200, { ok: r.ok, message: r.ok ? `已把安装任务发给：${r.target}` : r.reason })
      }
      if (!name) throw new Error('缺少插件名')
      if (act === 'enable') {
        const r = setEnabled(name, true)
        return json(res, 200, { ...r, message: r.changed ? '已启用，重启后生效' : '已经是启用状态' })
      }
      if (act === 'disable') {
        const r = setEnabled(name, false)
        return json(res, 200, { ...r, message: r.changed ? '已停用，重启后生效' : '已经是停用状态' })
      }
      if (act === 'remove') {
        const r = removePlugin(name)
        const msg = r.trashed
          ? '已移入回收站（可恢复），重启后生效'
          : r.removedDir ? '已删除（本地 link 只删了链接，源码还在），重启后生效' : '已从配置移除（文件本来就不在）'
        return json(res, 200, { ...r, message: msg })
      }
      if (act === 'open') {
        const { dir, exists } = pluginDir(name)
        if (!exists) throw new Error('目录不存在：' + dir)
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
        return json(res, 200, { ok: true, message: '已打开：' + dir })
      }
      if (act === 'translate') {
        const r = await notifyNow(ctx, name)
        return json(res, 200, {
          ok: r.ok,
          target: r.target,
          message: r.ok ? `已把翻译任务交给「${r.target}」，等它写完后刷新本页` : r.reason,
        })
      }
      if (act === 'dismiss') {
        dismissPending(name)
        return json(res, 200, { ok: true, message: '已忽略' })
      }
      throw new Error('未知操作：' + act)
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err?.message || err) })
    }
  }

  const health = async (req, res) => {
    try {
      return json(res, 200, healthAll())
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const logs = async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x')
      const name = u.searchParams.get('name')
      if (name) {
        const r = scanLogs([name], 200)
        return json(res, 200, { name, lines: r.byPlugin[name] || [] })
      }
      const r = scanLogs(listPlugins().items.map((p) => p.name), 200)
      return json(res, 200, { ...r, archives: archiveStats() })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const logArchive = async (req, res) => {
    try {
      return json(res, 200, archiveLogs())
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const logPurge = async (req, res) => {
    try {
      return json(res, 200, purgeArchives())
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const trash = async (req, res) => {
    try {
      return json(res, 200, { items: listTrash() })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const readme = async (req, res) => {
    try {
      const u = new URL(req.url, 'http://local')
      const name = u.searchParams.get('name') || ''
      const r = readmeOf(name)
      if (!r) return json(res, 404, { error: '这个插件目录里没有 README' })
      return json(res, 200, { file: r.file, text: r.text })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const openProfile = async (req, res) => {
    try {
      const dir = profileDir()
      const { spawn } = await import('node:child_process')
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
      return json(res, 200, { ok: true, dir })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

function taskBrief(task) {
  const parts = (task.parts || []).map((p) => '- ' + p.name + (p.owner ? ' → ' + p.owner : '')).join('\n')
  return [
    '【任务板】你是 ' + task.id + ' 的主管（' + personaLabel(task.lead) + '）。',
    personaBrief(task.lead),
    '标题：' + task.title,
    task.brief ? '说明：' + task.brief : '',
    parts ? '已经拆出来的部分：\n' + parts : '',
    '请先判断规模：一个人半小时能干完就别拆，直接自己做；要动多个文件、跨好几块功能，就拆成 2–4 个部分。',
    '拆的时候每个部分都要写清楚 name（干什么）和 owner（谁来干），task_split 会立刻把消息发给对应会话。',
    '可用工具：task_board（看板）、task_claim（认领主管）、task_split（拆分，parts=[{name,owner}]）、task_assign（改派某部分）、task_done（完成，part 可指定某部分）、task_comment（留言）。',
    '需要多个人商量时，可以用 group_start 工具开一个群聊（topic 写任务标题，members 写相关编号，limit 默认 30 可调）。',
    '做完务必调用 task_done 标记，别让看板一直挂着。',
  ].filter(Boolean).join('\n')
}

function appendBrief(task, text, match) {
  return [
    '【任务板】' + task.id + ' 收到一条追加。',
    personaBrief((match && match.owner) || task.assignee || task.lead || ''),
    '任务：' + task.title,
    match && match.part ? '相关部分：' + match.part + (match.owner ? '（负责人 ' + match.owner + '）' : '') : '',
    '追加内容：' + text,
    '如果这归你负责，处理完请用 task_done / task_comment 更新看板；不归你就转给对应会话。',
  ].filter(Boolean).join('\n')
}
  const personas = async (req, res) => {
    try {
      if (req.method === 'GET') return json(res, 200, { items: listPersonas() })
      const body = await readBody(req)
      if (String(body.action || '') === 'remove') {
        removePersona(body.id)
        return json(res, 200, { ok: true })
      }
      return json(res, 200, { ok: true, persona: setPersona(body.id, body) })
    } catch (err) {
      return json(res, 400, { error: String(err?.message || err) })
    }
  }
  const tasks = async (req, res) => {
    try {
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://x')
        const q = u.searchParams.get('q')
        if (q) return json(res, 200, { match: matchOwner(q) })
        const id = u.searchParams.get('id')
        if (id) {
          const one = getTask(id)
          if (!one) return json(res, 404, { error: '没有这个任务：' + id })
          return json(res, 200, { task: one })
        }
        return json(res, 200, board())
      }
      const body = await readBody(req)
      const action = String(body.action || '')
      if (action === 'create') {
        const task = createTask(body)
        let notified = ''
        let diag = ''
        if (task.lead) {
          try {
            const r = await sendTaskTo(ctx, task.lead, taskBrief(task))
            notified = r.ok ? (r.target || task.lead) : ''
            if (!r.ok) diag = '发送失败：' + (r.reason || '未知')
          } catch (err) {
            diag = '异常：' + String((err && err.message) || err)
          }
        }
        return json(res, 200, { ok: true, task, notified, diag })
      }
      if (action === 'append') {
        const one = getTask(body.id)
        if (!one) return json(res, 404, { error: '没有这个任务：' + body.id })
        commentTask(body.id, body.text, 'user')
        const m = matchOwner(body.text)
        const owner = (m && m.taskId === body.id && m.owner) || one.assignee || one.lead || ''
        let notified = ''
        if (owner) {
          try { const r = await sendTaskTo(ctx, owner, appendBrief(one, body.text, m)); notified = r.ok ? (r.target || owner) : '' } catch {}
        }
        return json(res, 200, { ok: true, notified })
      }
      if (action === 'claim') return json(res, 200, { ok: true, task: claimTask(body.id, body.lead, body.note) })
      if (action === 'split') {
        const task = splitTask(body.id, body.parts, body.note)
        const targets = []
        try {
          for (const p of (task.parts || []).filter((x) => x.owner)) {
            const msg = [
              '【任务板】' + task.id + ' 拆出一个部分，交给你负责：',
              personaBrief(p.owner),
              '任务：' + task.title,
              task.brief ? '说明：' + task.brief : '',
              '你的部分：' + p.name,
              '做完调用 task_done（part 写「' + p.name + '」）。有疑问用 task_comment 留言，需要商量可以 group_start 开会话群。',
            ].filter(Boolean).join('\n')
            const r = await sendTaskTo(ctx, p.owner, msg)
            if (r && r.ok) targets.push(p.owner + ':' + p.name)
          }
        } catch {}
        return json(res, 200, { ok: true, task, notified: targets.join(' | ') })
      }
      if (action === 'assign') {
        const task = assignPart(body.id, body.part, body.owner)
        let notified = ''
        try {
          if (body.owner) {
            const msg = [
              '【任务板】' + task.id + ' 把「' + body.part + '」改派给你。',
              personaBrief(body.owner),
              '任务：' + task.title,
              task.brief ? '说明：' + task.brief : '',
              '做完调用 task_done（part 写「' + body.part + '」）。',
            ].filter(Boolean).join('\n')
            const r = await sendTaskTo(ctx, body.owner, msg)
            if (r && r.ok) notified = body.owner
          }
        } catch {}
        return json(res, 200, { ok: true, task, notified })
      }
      if (action === 'done') return json(res, 200, { ok: true, task: doneTask(body.id, { part: body.part, note: body.note, by: body.by }) })
      if (action === 'comment') return json(res, 200, { ok: true, task: commentTask(body.id, body.text, body.by) })
      if (action === 'remove') { removeTask(body.id); return json(res, 200, { ok: true }) }
      if (action === 'match') return json(res, 200, { match: matchOwner(body.text) })
      return json(res, 400, { error: '未知 action：' + action })
    } catch (err) {
      return json(res, 400, { error: String(err?.message || err) })
    }
  }
  const sessions = async (req, res) => {
    try {
      const api = typeof ctx.get === 'function' ? ctx.get('sessionController') : ctx.sessionController
      if (!api || typeof api.list !== 'function') return json(res, 200, { items: [], note: '拿不到 sessionController' })
      const r = await api.list({})
      const items = Array.isArray(r?.items) ? r.items : []
      const archived = new Set()
      try {
        const reg = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
        for (const id of reg?.archivedSessionIds ?? []) archived.add(String(id))
      } catch {}
      return json(res, 200, {
        items: items.map((it) => {
          const id = String(it.sessionId)
          let live
          try { live = ctx.agents?.get?.(id) } catch {}
          return {
            id,
            title: typeof it.projections?.values?.title === 'string' ? it.projections.values.title.trim() : '',
            cwd: typeof it.cwd === 'string' ? it.cwd : '',
            running: it.running === true,
            blank: it.blank === true,
            subagent: it.origin === 'subagent',
            archived: archived.has(id),
            status: live?.status ?? (it.running === true ? 'running' : it.blank === true ? 'blank' : 'idle'),
          }
        }),
      })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const sessionAction = async (req, res) => {
    try {
      const body = await readBody(req)
      // 前端发的是 {id}，外部脚本习惯用 {sessionId}，两个都认
      const id = String(body.sessionId || body.id || '')
      const action = String(body.action || '')
      if (!id) return json(res, 400, { error: '缺少 sessionId' })
      const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : ctx.sessionController
      if (!sc) return json(res, 500, { error: '拿不到 sessionController' })
      const names = (() => {
        try {
          const out = new Set()
          let p = Object.getPrototypeOf(sc)
          while (p && p !== Object.prototype) {
            for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') out.add(n)
            p = Object.getPrototypeOf(p)
          }
          return [...out].sort()
        } catch { return [] }
      })()

      // 这些 Remote 方法吃的是单对象命令（rename({sessionId,title})），
      // 先按对象试，失败再退回位置参数。
      const callCmd = async (fn, obj, a, b) => {
        try { return await fn.call(sc, obj) } catch (e1) {
          try { return await fn.call(sc, a, b) } catch { throw e1 }
        }
      }

      if (action === 'rename') {
        const title = String(body.title || '').trim()
        if (!title) return json(res, 400, { error: '标题不能为空' })
        if (typeof sc.rename !== 'function') return json(res, 501, { error: '这个版本没暴露 rename', methods: names })
        await callCmd(sc.rename, { sessionId: id, title }, id, title)
        return json(res, 200, { ok: true, message: '已改名为「' + title + '」' })
      }

      if (action === 'cancel') {
        if (typeof sc.cancel !== 'function') return json(res, 501, { error: '这个版本没暴露 cancel', methods: names })
        await callCmd(sc.cancel, { sessionId: id }, id, {})
        return json(res, 200, { ok: true, message: '已请求停止当前回合' })
      }

      if (action === 'archive') {
        let ws
        try { ws = typeof ctx.get === 'function' ? (ctx.get('workspaceController') || ctx.get('workspace')) : undefined } catch {}
        if (!ws || typeof ws.archiveSession !== 'function') {
          const keys = []
          try { for (const k of ['workspaceController', 'workspace', 'workspaceRegistry']) { try { if (ctx.get(k)) keys.push(k) } catch {} } } catch {}
          return json(res, 501, { error: '拿不到 workspaceController.archiveSession', tried: keys })
        }
        await ws.archiveSession(id, { stopActivity: true })
        return json(res, 200, { ok: true, message: '已归档' })
      }

      return json(res, 400, { error: '未知操作：' + action })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  // 把当前会话增量写进长期记忆：进程内直接调归档引擎（不再 spawn 外部 CLI）
  const memSync = async (req, res) => {
    try {
      const r = await syncMemory()
      const sessions = Number(r?.sessions || 0)
      const messages = Number(r?.messages || 0)
      return json(res, 200, {
        ok: true,
        sessions,
        messages,
        output: sessions || messages
          ? `归档完成：${sessions} 个会话 / ${messages} 条新消息`
          : '没有新消息需要归档（已经是最新的）',
      })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const system = async (req, res) => {
    try {
      const os = await import('node:os')
      const mem = process.memoryUsage()
      return json(res, 200, {
        node: process.version,
        platform: process.platform + ' / ' + process.arch,
        port: req.socket?.localPort || 0,
        uptime: Math.round(process.uptime()),
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        memTotal: os.totalmem(),
        memFree: os.freemem(),
        cpus: os.cpus().length,
        hostname: os.hostname(),
        dshHome: dshHome(),
        profile: profileDir(),
        plugins: listPlugins().items.length,
      })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }
  // 清「登录痕迹」但不碰 API key：
  // .credentials.yaml 的 records 下 client-connection/* 与 deepseek-account-platform/device
  // 是每次登录留下的会话/设备记录；default token 与 refs.DEEPSEEK_API_KEY 必须留着，
  // 否则下次打开连模型都调不了（上次整个文件删掉就把 API key 一起清了）。
  function stripLoginTraces(text) {
    const lines = String(text).split(/\r?\n/)
    const out = []
    const drop = /^\s{2}(client-connection\/[^:]+|deepseek-account-platform\/device):\s*$/
    let skipping = false
    for (const line of lines) {
      if (drop.test(line)) { skipping = true; continue }
      if (skipping) {
        if (/^\s{2}[^\s][^:]*:\s*$/.test(line) || /^[^\s]/.test(line)) skipping = false
        else continue
      }
      out.push(line)
    }
    return out.join('\n')
  }

  const shutdown = async (req, res) => {
    try {
      const { spawn } = await import('node:child_process')
      let clearLogin = false
      try {
        const url = new URL(req.url || '', 'http://127.0.0.1')
        clearLogin = url.searchParams.get('clear') === '1'
      } catch {}
      let cleared = ''
      if (clearLogin) {
        try {
          const fsp = await import('node:fs/promises')
          const file = credentialsFile()
          const original = await fsp.readFile(file, 'utf8')
          const next = stripLoginTraces(original)
          if (next !== original) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            await fsp.writeFile(file + '.bak-login-' + stamp, original, 'utf8')
            await fsp.writeFile(file, next, 'utf8')
            cleared = '，已清掉登录记录（API key 保留）'
          } else {
            cleared = '，没有可清的登录记录'
          }
        } catch (err) {
          cleared = '，清登录记录失败：' + String(err?.message || err)
        }
      }
      json(res, 200, { ok: true, message: '2 秒后关闭 DeepSeek Harness' + cleared + '，需要手动重新打开' })
      setTimeout(() => {
        try {
          spawn('taskkill', ['/F', '/T', '/IM', 'DeepSeek Harness.exe'], { detached: true, stdio: 'ignore' }).unref()
        } catch {}
      }, 2000)
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const impact = async (req, res) => {
    try {
      return json(res, 200, { map: impactAll() })
    } catch (err) {
      return json(res, 200, { map: {}, error: String(err?.message || err) })
    }
  }

  const exportJson = async (req, res) => {
    try {
      const body = JSON.stringify(exportManifest(), null, 2)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dsh-plugins-manifest.json"',
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const updates = async (req, res) => {
    try {
      return json(res, 200, { map: await checkUpdates() })
    } catch (err) {
      return json(res, 200, { map: {}, error: String(err?.message || err) })
    }
  }

  const trashAction = async (req, res) => {
    const body = await readBody(req)
    const id = String(body.id || '')
    const act = String(body.action || '')
    try {
      if (!id) throw new Error('缺少条目 id')
      if (act === 'restore') {
        const r = restoreTrash(id)
        return json(res, 200, { ...r, message: `已恢复 ${r.name}，重启后生效` })
      }
      if (act === 'purge') {
        const r = purgeTrash(id)
        return json(res, 200, { ...r, message: '已彻底删除' })
      }
      throw new Error('未知操作：' + act)
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err?.message || err) })
    }
  }

  const memStats = async (req, res) => {
    try {
      return json(res, 200, await memoryStats())
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const memSearch = async (req, res) => {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams.get('q') || ''
      return json(res, 200, await memorySearch(q, 30))
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const memDoc = async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').searchParams.get('name') || ''
      return json(res, 200, memoryReadDoc(name))
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const upgrade = async (req, res) => {
    const body = await readBody(req)
    try {
      const name = String(body.name || '')
      if (body.action === 'status') return json(res, 200, upgradeStatus(name))
      const r = upgradePlugin(name)
      return json(res, 200, { ok: true, message: '已在后台安装 ' + name + '，日志：' + r.log })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  const config = async (req, res) => {
    try {
      if (req.method === 'GET') return json(res, 200, { config: loadConfig(), defaults: DEFAULTS })
      const body = await readBody(req)
      if (String(body.action || '') === 'reset') return json(res, 200, { ok: true, config: resetConfig() })
      return json(res, 200, { ok: true, config: saveConfig(body) })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  return [
    { kind: 'exact', path: '/dsh-plugins', handler: html },
    { kind: 'exact', path: '/dsh-plugins/app.js', handler: appJs },
    { kind: 'exact', path: '/dsh-plugins/api/list', handler: list },
    { kind: 'exact', path: '/dsh-plugins/api/pending', handler: pending },
    { kind: 'exact', path: '/dsh-plugins/api/health', handler: health },
    { kind: 'exact', path: '/dsh-plugins/api/logs', handler: logs },
    { kind: 'exact', path: '/dsh-plugins/api/logs/archive', handler: logArchive },
    { kind: 'exact', path: '/dsh-plugins/api/logs/purge', handler: logPurge },
    { kind: 'exact', path: '/dsh-plugins/api/trash', handler: trash },
    { kind: 'exact', path: '/dsh-plugins/api/trash/action', handler: trashAction },
    { kind: 'exact', path: '/dsh-plugins/api/updates', handler: updates },
    { kind: 'exact', path: '/dsh-plugins/api/impact', handler: impact },
    { kind: 'exact', path: '/dsh-plugins/api/readme', handler: readme },
    { kind: 'exact', path: '/dsh-plugins/api/open-profile', handler: openProfile },
    { kind: 'exact', path: '/dsh-plugins/api/shutdown', handler: shutdown },
    { kind: 'exact', path: '/dsh-plugins/api/sessions', handler: sessions },
    { kind: 'exact', path: '/dsh-plugins/api/session', handler: sessionAction },
    { kind: 'exact', path: '/dsh-plugins/api/system', handler: system },
    { kind: 'exact', path: '/dsh-plugins/api/tasks', handler: tasks },
    { kind: 'exact', path: '/dsh-plugins/api/personas', handler: personas },
    { kind: 'exact', path: '/dsh-plugins/api/memory', handler: memStats },
    { kind: 'exact', path: '/dsh-plugins/api/memory/search', handler: memSearch },
    { kind: 'exact', path: '/dsh-plugins/api/memory/doc', handler: memDoc },
    { kind: 'exact', path: '/dsh-plugins/api/memory/sync', handler: memSync },
    { kind: 'exact', path: '/dsh-plugins/api/upgrade', handler: upgrade },
    { kind: 'exact', path: '/dsh-plugins/api/config', handler: config },
    { kind: 'exact', path: '/dsh-plugins/api/export', handler: exportJson },
    { kind: 'exact', path: '/dsh-plugins/api/action', handler: action },
  ]
}

function installTaskText(target) {
  const looksLocal = /^[a-zA-Z]:[\\/]|^\//.test(target)
  return [
    '━━━ 插件安装任务 · 来自插件管理器 ━━━',
    '用户从「插件管理」页面把下面这个东西交给 AI 安装：',
    target,
    '',
    '你要做的：',
    looksLocal
      ? '1. 校验这个目录里有 package.json（name / version / main）。'
      : '1. 把链接对应的插件源码取下来：优先 `git clone --depth 1`；不行就下载 zip/tgz 后解压。',
    '2. 放到你的 DSH 工作区 plugins/<包名>（包名取 package.json 的 name，去掉 @scope/ 前缀）。',
    '3. 调用工具 plugin_install({ dir }) —— 它会写 link 依赖、建 junction、加进 bundles。',
    '4. 用 node --check 检查入口文件，并确认 profile 的 package.json 能被 JSON.parse。',
    '5. 告诉用户结果，并提醒「重启 DeepSeek Harness 后生效」。',
    '',
    '限制：只动这一个插件；不要改别的插件的配置；不要跑 pnpm install（link 不需要）。',
    '如果失败，把具体错误贴出来，别猜。',
  ].filter(Boolean).join('\n')
}

const PAGE = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件管理</title>
<style>
:root{
  color-scheme:light;
  --bg:#f6f6f4;--card:#ffffff;--line:#e6e5e0;--ink:#23231f;--muted:#7a7a72;
  --accent:#3a6bd6;--accent-soft:#e8eefc;--ok:#2f7d55;--ok-soft:#e6f4ec;
  --danger:#bf4a40;--danger-soft:#fbeceb;--shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);
}
@media (prefers-color-scheme: dark){
  :root{
    color-scheme:dark;
    --bg:#15161a;--card:#1d1f24;--line:#2d3038;--ink:#e7e7e2;--muted:#9b9b92;
    --accent:#7aa0f2;--accent-soft:#232b40;--ok:#63c18f;--ok-soft:#1d3027;
    --danger:#e7857c;--danger-soft:#3a2220;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.25);
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
header{padding:18px 22px 12px;border-bottom:1px solid var(--line);background:var(--card)}
h1{margin:0;font-size:17px;letter-spacing:.02em}
.sub{margin-top:4px;font-size:12px;color:var(--muted);word-break:break-all}
.note{margin-top:10px;font-size:12px;color:var(--muted);background:var(--accent-soft);
  border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.note b{color:var(--accent)}
.hrow{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ask{margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);display:flex;flex-direction:column;gap:9px}
.ask[hidden]{display:none}
.ask input{font:inherit;font-size:13px;padding:8px 11px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);width:100%}
.ask input:focus{outline:none;border-color:var(--accent)}
.ask-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ask-hint{font-size:11.5px;color:var(--muted)}
.pending{margin-top:10px;display:flex;gap:12px;align-items:center;justify-content:space-between;
  font-size:12.5px;color:#7a5a12;background:#fdf5e0;border:1px solid #ecd9a6;border-radius:8px;padding:8px 12px}
.pending[hidden]{display:none}
.pending b{color:#6b4c08}
.pending button{padding:4px 11px;font-size:12px}
.pitem{display:inline-flex;align-items:center;gap:5px;margin-right:8px}
.ignore{padding:1px 7px;font-size:11px;line-height:1.5;color:var(--muted)}
.ignore:hover{color:var(--accent);border-color:var(--accent)}
.tiny{padding:2px 8px;font-size:11.5px}
.loggrp.hit{background:#fff8dc}
main{padding:16px 22px 40px;display:flex;flex-direction:column;gap:10px;max-width:900px}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:13px 15px;box-shadow:var(--shadow)}
.row.off{opacity:.72}
.row.open{border-color:var(--accent)}
.body{flex:1;min-width:0;cursor:pointer}
.detail{flex-basis:100%;display:none;flex-direction:column;gap:9px;
  border-top:1px dashed var(--line);margin-top:2px;padding-top:11px}
.row.open .detail{display:flex}
.kv{display:flex;gap:10px;font-size:12.5px;color:var(--muted);line-height:1.6;align-items:baseline}
.kv b{color:var(--ink);font-weight:550;min-width:52px;flex-shrink:0}
.path{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--ink);background:var(--bg);
  border:1px solid var(--line);border-radius:6px;padding:4px 8px;word-break:break-all;flex:1}
.dops{display:flex;gap:8px;flex-wrap:wrap}
.title{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.name{font-weight:650;font-size:14px}
.ver,.tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.tag.ok{color:var(--ok);background:var(--ok-soft);border-color:transparent}
.tag.off{color:var(--muted);background:var(--bg)}
.tag.lock{color:var(--danger);background:var(--danger-soft);border-color:transparent}
.desc{margin-top:5px;font-size:12.5px;color:var(--muted);line-height:1.55}
.ops{display:flex;gap:8px;flex-shrink:0;padding-top:2px}
button{font:inherit;font-size:12.5px;padding:6px 13px;border-radius:8px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:var(--ink);transition:all .12s}
button:hover{border-color:var(--accent);color:var(--accent)}
button.danger{color:var(--danger)}
button.danger:hover{border-color:var(--danger);background:var(--danger-soft)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{filter:brightness(1.06);color:#fff}
#toast{position:fixed;right:18px;bottom:18px;background:var(--ink);color:var(--bg);
  font-size:12.5px;padding:9px 14px;border-radius:9px;opacity:0;transform:translateY(6px);
  transition:all .18s;pointer-events:none;max-width:340px}
#toast.show{opacity:1;transform:none}
#empty{color:var(--muted);font-size:13px;padding:20px 4px}
nav{display:flex;flex-wrap:wrap;gap:6px;padding:11px 22px;background:var(--card);
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.tab{font-size:12.5px;padding:5px 13px;border-radius:999px;border:1px solid var(--line);
  background:transparent;color:var(--muted);cursor:pointer;transition:all .12s}
.tab:hover{color:var(--ink);border-color:var(--accent)}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
.tab.on:hover{color:#fff}
.tab .n{font-size:11px;opacity:.75;margin-left:3px}
.dot{font-size:12px;line-height:1;cursor:help}
.readme{white-space:pre-wrap;font-size:12px;line-height:1.55;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;max-height:280px;overflow:auto;margin:2px 0 4px}
.toolrow{display:flex;gap:14px;align-items:center;padding:11px 4px;border-bottom:1px dashed var(--line)}
.toolrow .tname{font-family:ui-monospace,Consolas,monospace;font-weight:600;font-size:13.5px}
.toolrow .tmeta{color:var(--muted);font-size:12.5px}
.logsbar{display:flex;gap:10px;align-items:center;padding:9px 22px;background:var(--card);border-bottom:1px solid var(--line)}
.searchbar{display:flex;gap:10px;align-items:center;padding:9px 22px;background:var(--card);border-bottom:1px solid var(--line)}
.searchbar input{flex:0 1 320px;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:13px;outline:none}
.searchbar input:focus{border-color:var(--accent)}
.chip{padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--muted);font-size:12.5px;cursor:pointer}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.chip .n{margin-left:5px;opacity:.75}
.tag.up{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.hbtns{display:flex;gap:8px;align-items:center;margin-left:auto}
.topnav{display:flex;gap:6px;padding:9px 22px;background:var(--card);border-bottom:1px solid var(--line)}
.topnav button{font-size:13px;padding:6px 16px;border-radius:8px}
.topnav button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.view{padding:16px 22px}
.srow{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;background:var(--card)}
.srow .no{font-family:ui-monospace,Consolas,monospace;font-weight:700;font-size:14px;min-width:36px}
.srow .st{font-size:11.5px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.srow .st.run{color:var(--ok);border-color:transparent;background:var(--ok-soft)}
.srow .path{flex:1;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .sid{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted)}
.sysgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.syscard{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--card)}
.syscard .k{font-size:12px;color:var(--muted);margin-bottom:5px}
.syscard .v{font-size:15px;font-weight:600;word-break:break-all}
.syscard .v small{font-weight:400;color:var(--muted);font-size:12px}
#trash-open .n{margin-left:5px;opacity:.7}
.trashrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:var(--card)}
.trashrow .tname{font-weight:600;font-size:13px}
.trashrow .tmeta{font-size:11.5px;color:var(--muted)}
.trashrow .dops{margin-left:auto}
.logpanel{padding:12px 22px 16px;background:var(--bg);border-bottom:1px solid var(--line);max-height:44vh;overflow:auto}
.logpanel[hidden]{display:none}
.loghead{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:9px;font-size:12.5px;color:var(--muted)}
.loggrp{margin-bottom:11px}
.loggrp b{font-size:12.5px}
.logline{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--ink);
  background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px;margin-top:4px;word-break:break-all}
.logline .f{color:var(--muted);margin-right:6px}
.issue{font-size:12px;color:var(--danger);line-height:1.5}
.issue.warn{color:#a06a12}
.topnav button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.tnew{padding:14px 22px;background:var(--card);border-bottom:1px solid var(--line)}
.tnew-line{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tnew-line input{flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px}
.tnew-line select{padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px}
.tnew textarea{width:100%;margin-top:8px;min-height:54px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-family:inherit;font-size:13px;resize:vertical}
.tboard{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;padding:16px 22px}
.tcol h3{font-size:12.5px;margin:0 0 8px;color:var(--muted);font-weight:600}
.tcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.tcard .th{display:flex;gap:8px;align-items:baseline}
.tcard .tid{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted)}
.tcard .ttl{font-weight:600;font-size:13.5px}
.tcard .meta{font-size:11.5px;color:var(--muted);margin-top:4px}
.tpart{display:flex;gap:6px;align-items:center;font-size:12px;margin-top:5px;flex-wrap:wrap}
.tpart .who{color:var(--accent)}
.tpart .pd{color:var(--ok)}
.tadd{display:flex;gap:6px;margin-top:8px}
.tadd input{flex:1;padding:5px 8px;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
.tcard .tiny{margin-top:7px}
.tcard pre.tbrief{white-space:pre-wrap;font-size:11.5px;color:var(--muted);margin:6px 0 0;max-height:80px;overflow:auto}[hidden]{display:none !important}
.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:16px 22px}
.pcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.pcard .ph{display:flex;gap:8px;align-items:baseline}
.pno{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted)}
.pn{font-weight:600;font-size:14px}
.pcard .st{margin-left:auto}
.prole{font-size:11.5px;color:var(--accent)}
.pbio{font-size:12px;line-height:1.5;color:var(--ink)}
.pbio .muted{color:var(--muted)}
.pskills{display:flex;gap:5px;flex-wrap:wrap}
.psk{font-size:10.5px;padding:1px 7px;border-radius:9px;background:var(--bg);border:1px solid var(--line);color:var(--muted)}
.pcard .pf{display:flex;gap:8px;align-items:center;margin-top:2px}
.pcard .pf .path{flex:1;font-size:10.5px;color:var(--muted);font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pedit{padding:12px 22px;background:var(--card);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.pedit-line{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pedit input{padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px}
.pedit input.wide{flex:1;min-width:240px}.memhead{display:flex;gap:16px;flex-wrap:wrap;padding:12px 22px;background:var(--card);border-bottom:1px solid var(--line);font-size:13px;color:var(--dim)}
.memhead b{color:var(--text);font-weight:600}
.msearch{display:flex;gap:9px;align-items:center;padding:10px 22px;border-bottom:1px solid var(--line)}
.msearch input{flex:1;max-width:520px}
.mlist{padding:6px 22px}
.hit{padding:9px 0;border-bottom:1px dashed var(--line);font-size:13px;line-height:1.55}
.hit .hw{color:var(--accent);font-size:11px;margin-right:8px}
.hit .ht{color:var(--dim);font-size:11px}
.mdocs{display:flex;flex-wrap:wrap;gap:8px;padding:10px 22px 18px}
.docitem{border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;background:var(--card)}
.docitem:hover{border-color:var(--accent);color:var(--accent)}
.view>iframe{width:100%;height:calc(100vh - 250px);border:0;background:#fff;display:block}
.cfgform{padding:14px 22px;display:flex;flex-direction:column;gap:14px;max-width:720px}
.cfgrow{display:flex;align-items:center;gap:12px;font-size:13px}
.cfgrow>span{width:220px;color:var(--dim)}
.cfgrow input[type=number],.cfgrow input[type=text]{width:260px}
.cfgrow input[type=checkbox]{width:16px;height:16px}
.tbar{display:flex;gap:10px;align-items:center;padding:8px 22px;border-bottom:1px solid var(--line)}
.tgroup{padding:0 22px 12px}
.tgroup[hidden]{display:none}
.tgroup iframe{width:100%;height:calc(100vh - 360px);min-height:320px;border:1px solid var(--line);border-radius:8px;background:#fff}
.tgl{font-size:12px;color:var(--dim);display:flex;gap:5px;align-items:center}.tgl input{width:64px}
.mgroup{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 22px}.mgl{font-size:11px;color:var(--dim);min-width:44px}.docitem.vol.cur{border-color:var(--accent);color:var(--accent)}
.chk{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dim);cursor:pointer}
</style></head><body>
<header>
  <div class="hrow">
    <h1>插件管理</h1>
    <span class="hbtns">
      <button id="trash-open">回收站<span class="n" id="trash-n"></span></button>
      <button id="export-json" title="导出当前的依赖与 bundles 清单（JSON）">导出清单</button>
      <button id="open-profile" title="打开 profile 目录（package.json 所在）">配置目录</button>
      <label class="chk" title="只清登录留下的设备/会话记录，不动 API key"><input type="checkbox" id="shutdown-clear-login"> 清登录记录</label>
        <button class="danger" id="shutdown-dsh" title="关闭 DeepSeek Harness（需要手动重新打开）">关闭 DSH</button>
      <button class="primary" id="ask-open">AI 帮我装</button>
    </span>
  </div>
  <div class="sub" id="profile">读取中…</div>
  <div class="note">启用 / 停用 / 删除只改配置文件，<b>重启 DeepSeek Harness 后生效</b>。删除会同时移除 <code>node_modules</code> 里的包（本地 link 插件保留源码目录）。<br>
  「AI 翻译」会消耗一次对话轮次（发给一个打开的会话，约几千 token）；翻译结果写入 <code>zh-cache.json</code>，写完刷新本页即可看到。</div>
  <div class="ask" id="ask" hidden>
    <div class="ask-line"><input id="ask-input" placeholder="插件目录绝对路径，或 GitHub 仓库链接"></div>
    <div class="ask-line">
      <button class="primary" id="ask-go">交给 AI 装</button>
      <button id="ask-cancel">取消</button>
      <span class="ask-hint">会在一个打开的会话里起一轮：下载 → 校验 → 调用 plugin_install</span>
    </div>
  </div>
  <div class="pending" id="pending" hidden></div>
</header>
<nav class="topnav" id="topnav">
  <button data-view="plugins" class="on">插件</button>
  <button data-view="sessions">会话</button>
  <button data-view="system">系统</button>
  <button data-view="tasks">任务</button>
  <button data-view="memory">记忆</button>
  <button data-view="config">设置</button>
</nav>
<div class="logpanel" id="trashpanel" hidden>
  <div class="loghead">
    <span id="trash-meta">回收站</span>
    <span class="dops"><button id="trash-clear">清空回收站</button></span>
  </div>
  <div id="trash-body"></div>
</div>
<div class="logsbar">
  <button id="logs-toggle">报错日志</button>
  <span class="ask-hint" id="logs-info">读取中…</span>
</div>
<div class="searchbar">
  <input id="q" type="search" placeholder="搜索插件名或简介" autocomplete="off">
  <button class="chip" id="only-bad">只看有问题的<span class="n" id="bad-n"></span></button>
  <span class="ask-hint" id="q-count"></span>
</div>
<div class="logpanel" id="logpanel" hidden>
  <div class="loghead">
    <span id="logs-meta"></span>
    <span class="dops">
      <button id="logs-clear">归档日志</button>
      <button class="danger" id="logs-purge">彻底删除归档</button>
    </span>
  </div>
  <div id="logs-body"></div>
</div>
<nav id="tabs"></nav>
<main id="list"><div id="empty">读取中…</div></main>
<div class="view" id="view-sessions" hidden>
  <div class="pedit" id="persona-editor" hidden></div>
  <div class="pgrid" id="sessions-body"></div>
</div>
<div class="view" id="view-system" hidden><div class="sysgrid" id="system-body"></div></div>
<div class="view" id="view-tasks" hidden>
  <div class="tnew">
    <div class="tnew-line">
      <input id="t-title" placeholder="任务标题（一句话说清要做什么）" autocomplete="off">
      <select id="t-lead"><option value="">主管：待认领</option></select>
      <select id="t-assignee"><option value="">执行者：不指定</option></select>
      <button class="primary" id="t-create">发布任务</button>
    </div>
    <textarea id="t-brief" placeholder="说明：验收标准、注意事项、涉及哪些文件（可选）"></textarea>
    <div class="ask-hint" id="t-hint">发布后会通知主管：由它决定自己做，还是拆成几部分交给别的会话；追加任务会按「部分的负责人」路由。</div>
  </div>
  <div class="tbar"><button id="t-group-toggle">群聊讨论</button><label class="tgl">轮数上限 <input id="t-group-limit" type="number" min="1" max="999" value="30"></label><span class="ask-hint" id="t-group-hint">看板上的任务可以在这里展开讨论</span></div>
  <div class="tgroup" id="tgroup" hidden><iframe id="group-frame" title="群聊" data-src="/dsh-group"></iframe></div>
  <div class="tboard" id="tboard"></div>
</div>
<div class="view" id="view-memory" hidden>
  <div class="memhead" id="mem-stats">读取中…</div>
  <div class="msearch">
    <input id="m-q" placeholder="在记忆库里搜一句话（中文直接搜，模糊匹配）" autocomplete="off">
    <button class="primary" id="m-go">搜索</button>
    <button id="m-sync" title="把当前所有会话的增量写进长期记忆">归档当前对话</button>
    <span class="ask-hint" id="m-hint"></span>
  </div>
  <div class="mlist" id="mem-hits"></div>
  <div class="mdocs" id="mem-docs"></div>
  <pre class="readme" id="mem-doc" hidden></pre>
</div>
<div class="view" id="view-config" hidden>
  <div class="cfgform" id="cfg-form"></div>
  <div class="ask-hint" id="cfg-hint">改完点保存，立刻生效（不用重启）。</div>
</div><div id="toast"></div>
<script src="/dsh-plugins/app.js"></script></body></html>`
