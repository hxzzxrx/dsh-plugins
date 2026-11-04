// dsh-plugins 浏览器端脚本（由 /dsh-plugins/app.js 提供）
window.addEventListener('error', function (e) {
  var box = document.getElementById('list')
  if (box) box.innerHTML = '<div id="empty">页面脚本出错：' + (e.message || e.type) + '</div>'
})
window.addEventListener('unhandledrejection', function (e) {
  var box = document.getElementById('list')
  if (box) box.innerHTML = '<div id="empty">页面脚本出错：' + ((e.reason && e.reason.message) || e.reason) + '</div>'
})

const $ = (s) => document.querySelector(s)
let busy = false

// 让页面一眼能看出脚本到底跑没跑：跑到了这里，这句会覆盖「读取中…」
;(function markBoot() {
  const el = document.querySelector('#profile')
  if (el) el.textContent = '脚本已运行，正在读取插件列表…'
})()

function toast(text, bad) {
  const el = $('#toast')
  el.textContent = text
  el.style.background = bad ? 'var(--danger)' : ''
  el.classList.add('show')
  clearTimeout(el._t)
  el._t = setTimeout(() => el.classList.remove('show'), 2600)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

const CATS = [['all','全部'],['system','系统内置'],['local','本地自制'],['market','市场下载'],['other','其他'],['tools','工具']]
let DATA = null
let CUR = 'all'
let HEALTH = {}
let LOGS = null
let Q = ''
let ONLY_BAD = false
let UPD = {}
let IMP = {}
const OPEN = new Set()

function badOf(p) {
  const h = HEALTH[p.name]
  if (!h) return false
  return h.level !== 'ok' || (h.logErrors || 0) > 0
}

function matchOf(p) {
  if (ONLY_BAD && !badOf(p)) return false
  if (!Q) return true
  const q = Q.toLowerCase()
  return (p.name + ' ' + (p.zh || '') + ' ' + (p.description || '')).toLowerCase().includes(q)
}

function dotOf(p) {
  const h = HEALTH[p.name]
  if (!h) return ''
  const icon = h.level === 'error' ? '🔴' : h.level === 'warn' ? '🟡' : '🟢'
  const tip = (h.issues || []).map((i) => (i.level === 'warn' ? '⚠ ' : '✕ ') + i.text).join('\n') || '正常'
  return '<span class="dot" title="' + esc(tip) + '">' + icon + '</span>'
}

function rowOf(p) {
  const row = document.createElement('div')
  row.className = 'row' + (p.enabled ? '' : ' off')
  row.dataset.name = p.name
  const tags = []
  const h = HEALTH[p.name]
  if (h) tags.push(dotOf(p))
  tags.push('<span class="ver">' + (p.version ? 'v' + esc(p.version) : '无版本') + '</span>')
  if (UPD[p.name] && p.version && UPD[p.name] !== p.version) {
    tags.push('<span class="tag up">可更新 v' + esc(UPD[p.name]) + '</span>')
    tags.push('<button class="tiny" data-up="' + esc(p.name) + '">升级</button>')
  }
  if (p.kind === 'orphan' && !p.builtin) tags.push('<span class="tag lock">异常</span>')
  tags.push(p.enabled ? '<span class="tag ok">已启用</span>' : '<span class="tag off">已停用</span>')
  if (p.protected) tags.push('<span class="tag lock">核心</span>')

  // 详情里的操作：打开目录 / 启用停用 / 删除
  const dops = []
  if (!p.builtin) {
    dops.push('<button data-act="open" data-name="' + esc(p.name) + '">打开文件夹</button>')
  }
  if (!p.protected) {
    dops.push(p.enabled
      ? '<button data-act="disable" data-name="' + esc(p.name) + '">停用</button>'
      : '<button class="primary" data-act="enable" data-name="' + esc(p.name) + '">启用</button>')
    dops.push('<button class="danger" data-act="remove" data-name="' + esc(p.name) + '">删除</button>')
  }
  if (!dops.length) dops.push('<span class="tag">内置插件，只能查看</span>')

  const kindText = p.builtin ? '宿主内置（asar 包内，无独立目录）'
    : p.kind === 'link' ? '本地 link（源码目录）'
    : p.kind === 'orphan' ? '仅在 bundles 中登记'
    : 'npm 安装'

  row.innerHTML =
    '<div class="body">' +
      '<div class="title"><span class="name">' + esc(p.name) + '</span>' + tags.join('') + '</div>' +
      '<div class="desc">' + esc(p.zh || '（暂无简介）') + '</div>' +
    '</div>' +
    '<div class="ops"><button data-act="translate" data-name="' + esc(p.name) + '">AI 翻译</button></div>' +
    '<div class="detail">' +
      '<div class="kv"><b>目录</b><span class="path">' + esc(p.dir || '（无）') + '</span></div>' +
      '<div class="kv"><b>来源</b><span>' + esc(kindText) + '</span></div>' +
      (UPD[p.name] ? '<div class="kv"><b>最新</b><span>v' + esc(UPD[p.name]) + (p.version === UPD[p.name] ? '（已是最新）' : '（可更新）') + '</span></div>' : '') +
      (p.description && p.description !== p.zh
        ? '<div class="kv"><b>原始描述</b><span>' + esc(p.description) + '</span></div>'
        : '') +
      (h && h.issues && h.issues.length
        ? '<div class="kv"><b>体检</b><span>' + h.issues.map((i) =>
            '<span class="issue' + (i.level === 'warn' ? ' warn' : '') + '">' +
            (i.level === 'warn' ? '⚠ ' : '✕ ') + esc(i.text) + '</span>').join('<br>') + '</span></div>'
        : (h ? '<div class="kv"><b>体检</b><span>通过</span></div>' : '')) +
      (h && h.logErrors
        ? '<div class="kv"><b>报错</b><span><button class="tiny" data-act="logjump" data-name="' + esc(p.name) + '">' +
          h.logErrors + ' 条，看日志</button></span></div>'
        : '') +
      (IMP[p.name] && (IMP[p.name].tools.length || IMP[p.name].slots.length || IMP[p.name].inject.length)
        ? '<div class="kv"><b>停用影响</b><span>' +
            (IMP[p.name].tools.length
              ? '工具 ' + IMP[p.name].tools.length + ' 个：' + IMP[p.name].tools.slice(0, 8).join('、') + (IMP[p.name].tools.length > 8 ? ' …' : '')
              : '') +
            (IMP[p.name].slots.length ? '<br>界面：' + IMP[p.name].slots.join('、') : '') +
            (IMP[p.name].inject.length ? '<br>需要宿主服务：' + IMP[p.name].inject.join('、') : '') +
          '</span></div>'
        : '') +
      '<div class="kv"><b>文档</b><span><button class="tiny" data-act="readme" data-name="' + esc(p.name) + '">看 README</button></span></div>' +
      '<pre class="readme" hidden></pre>' +
      '<div class="dops">' + dops.join('') + '</div>' +
    '</div>'
  return row
}

function tabs() {
  const nav = $('#tabs')
  nav.innerHTML = ''
  for (const [key, label] of CATS) {
    const n = key === 'all' ? DATA.items.length
      : key === 'tools' ? Object.values(IMP).reduce((s, im) => s + ((im && im.tools) ? im.tools.length : 0), 0)
      : DATA.items.filter((p) => p.category === key).length
    if (key !== 'all' && !n) continue
    const b = document.createElement('button')
    b.className = 'tab' + (CUR === key ? ' on' : '')
    b.dataset.tab = key
    b.innerHTML = esc(label) + '<span class="n">' + n + '</span>'
    nav.appendChild(b)
  }
  const badN = $('#bad-n')
  if (badN) badN.textContent = String(DATA.items.filter(badOf).length)
}

function showTab(key) {
  CUR = key
  tabs()
  const list = $('#list')
  list.innerHTML = ''
  if (key === 'tools') {
    const rows = []
    for (const [name, im] of Object.entries(IMP)) {
      for (const t of ((im && im.tools) || [])) rows.push({ t, name })
    }
    rows.sort((a, b) => a.t.localeCompare(b.t))
    const cnt0 = $('#q-count')
    if (cnt0) cnt0.textContent = rows.length ? '共 ' + rows.length + ' 个工具' : ''
    if (!rows.length) {
      list.innerHTML = '<div id="empty">还没读到工具信息（新版本要重启后才生效）</div>'
      return
    }
    list.innerHTML = rows.map((r) =>
      '<div class="toolrow"><span class="tname">' + esc(r.t) + '</span><span class="tmeta">来自 ' + esc(r.name) + '</span></div>'
    ).join('')
    return
  }
  const items = DATA.items.filter((p) => (key === 'all' || p.category === key) && matchOf(p))
  const cnt = $('#q-count')
  if (cnt) cnt.textContent = Q || ONLY_BAD ? '筛出 ' + items.length + ' 个' : ''
  if (!items.length) {
    list.innerHTML = '<div id="empty">' + (Q || ONLY_BAD ? '没有匹配的插件' : '这个分类下没有插件') + '</div>'
    return
  }
  for (const p of items) {
    const r = rowOf(p)
    if (OPEN.has(p.name)) r.classList.add('open')
    list.appendChild(r)
  }
}

function render(data) {
  DATA = data
  $('#profile').textContent = '配置目录：' + data.profile
  if (!data.items.length) {
    $('#tabs').innerHTML = ''
    $('#list').innerHTML = '<div id="empty">没有已安装的插件</div>'
    return
  }
  if (!CATS.some(([k]) => k === CUR)) CUR = 'all'
  showTab(CUR)
}

async function loadPendingBar() {
  const box = $('#pending')
  try {
    const r = await fetch('/dsh-plugins/api/pending')
    const data = await r.json()
    const items = Array.isArray(data.items) ? data.items : []
    if (!items.length) {
      box.hidden = true
      box.innerHTML = ''
      return
    }
    box.hidden = false
    box.innerHTML =
      '<span>检测到 <b>' + items.length + '</b> 个新插件还没有中文简介：' +
      items.map((p) =>
        '<span class="pitem">' + esc(p.name) +
        '<button class="ignore" data-dismiss="' + esc(p.name) + '" title="不再提示这个插件">忽略</button></span>'
      ).join('') +
      '</span>' +
      '<span><button class="primary" id="btn-translate-all">让 AI 翻译</button></span>'
    box.querySelectorAll('[data-dismiss]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation()
        const name = btn.dataset.dismiss
        try {
          await fetch('/dsh-plugins/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, action: 'dismiss' }),
          })
          toast('已忽略 ' + name)
          loadPendingBar()
        } catch (err) {
          toast(err.message, true)
        }
      }
    })
    $('#btn-translate-all').onclick = async () => {
      for (const p of items) {
        try {
          await fetch('/dsh-plugins/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: p.name, action: 'translate' }),
          })
        } catch {}
      }
      toast('已发翻译请求，等会话写完后刷新页面')
    }
  } catch {
    box.hidden = true
  }
}

async function load() {
  const prof = $('#profile')
  try {
    if (prof) prof.textContent = '正在请求插件列表…'
    const r = await fetch('/dsh-plugins/api/list', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (prof) prof.textContent = '接口返回 ' + r.status + '，解析中…'
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || '读取失败')
    render(data)
    loadPendingBar()
    loadTrash()
    loadUpdates()
    loadImpact()
  } catch (err) {
    if (prof) prof.textContent = '读取失败：' + (err.name || '') + ' ' + (err.message || '')
    $('#list').innerHTML = '<div id="empty">读取失败：' + esc((err.name ? err.name + ' ' : '') + err.message) + '</div>'
  }
}

async function loadHealth() {
  try {
    const r = await fetch('/dsh-plugins/api/health', { signal: AbortSignal.timeout(15000) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || '体检失败')
    HEALTH = {}
    for (const it of data.items || []) HEALTH[it.name] = it
    const c = data.counts || {}
    $('#logs-info').textContent = '体检：🟢 ' + (c.ok || 0) + ' · 🟡 ' + (c.warn || 0) + ' · 🔴 ' + (c.error || 0)
    if (DATA) showTab(CUR)
  } catch (err) {
    $('#logs-info').textContent = '体检失败：' + err.message
  }
}

async function loadUpdates() {
  try {
    const r = await fetch('/dsh-plugins/api/updates', { signal: AbortSignal.timeout(12000) })
    const data = await r.json()
    UPD = data.map || {}
    if (DATA) showTab(CUR)
  } catch {}
}

async function loadImpact() {
  try {
    const r = await fetch('/dsh-plugins/api/impact', { signal: AbortSignal.timeout(10000) })
    const data = await r.json()
    IMP = data.map || {}
    if (DATA) showTab(CUR)
  } catch {}
}

async function loadTrash() {
  const body = $('#trash-body')
  const meta = $('#trash-meta')
  const n = $('#trash-n')
  try {
    const r = await fetch('/dsh-plugins/api/trash', { signal: AbortSignal.timeout(8000) })
    const data = await r.json()
    const items = Array.isArray(data.items) ? data.items : []
    if (n) n.textContent = items.length ? String(items.length) : ''
    if (!items.length) {
      if (meta) meta.textContent = '回收站是空的（删除 npm 插件时会先放到这里，本地 link 只删链接）'
      if (body) body.innerHTML = ''
      return
    }
    if (meta) meta.textContent = '回收站里有 ' + items.length + ' 个包，可以恢复或彻底删除'
    if (body) {
      body.innerHTML = items.map((t) =>
        '<div class="trashrow">' +
          '<span class="tname">' + esc(t.name) +
            (t.version ? ' <span class="ver">v' + esc(t.version) + '</span>' : '') + '</span>' +
          '<span class="tmeta">' + fmt(t.bytes) + ' · ' + new Date(t.at).toLocaleString() + '</span>' +
          '<span class="dops">' +
            '<button data-trb="restore" data-id="' + esc(t.id) + '">恢复</button>' +
            '<button class="danger" data-trb="purge" data-id="' + esc(t.id) + '">彻底删除</button>' +
          '</span>' +
        '</div>').join('')
    }
  } catch (err) {
    if (meta) meta.textContent = '回收站读取失败：' + err.message
  }
}

async function trashAct(id, action) {
  if (action === 'restore' && !confirm('把这个包从回收站恢复回来？会写回依赖并加进 bundles，重启后生效。')) return
  if (action === 'purge' && !confirm('彻底删除这个包？删了就找不回来了。')) return
  try {
    const r = await fetch('/dsh-plugins/api/trash/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || '失败')
    toast(data.message || '完成')
    await loadTrash()
  } catch (err) {
    toast(err.message, true)
  }
}

async function clearTrash() {
  if (!confirm('清空回收站？里面的包会被彻底删除，找不回来。')) return
  try {
    const r = await fetch('/dsh-plugins/api/trash', { signal: AbortSignal.timeout(8000) })
    const data = await r.json()
    const items = Array.isArray(data.items) ? data.items : []
    let n = 0
    for (const t of items) {
      const rr = await fetch('/dsh-plugins/api/trash/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id, action: 'purge' }),
        signal: AbortSignal.timeout(15000),
      })
      if (rr.ok) n++
    }
    toast('已清空 ' + n + ' 个包')
    await loadTrash()
  } catch (err) {
    toast(err.message, true)
  }
}

let VIEW = 'plugins'

function setView(v) {
  VIEW = v
  document.querySelectorAll('#topnav button').forEach(function (b) {
    b.classList.toggle('on', b.dataset.view === v)
  })
  const pluginEls = ['.logsbar', '.searchbar', '#tabs', '#list']
  for (const sel of pluginEls) {
    const el = $(sel)
    if (el) el.hidden = v !== 'plugins'
  }
  const tp = $('#trashpanel')
  if (tp && v !== 'plugins') tp.hidden = true
  const lp = $('#logpanel')
  if (lp && v !== 'plugins') lp.hidden = true
  const sv = $('#view-sessions')
  if (sv) sv.hidden = v !== 'sessions'
  const sy = $('#view-system')
  if (sy) sy.hidden = v !== 'system'
  const vt = $('#view-tasks')
  if (vt) vt.hidden = v !== 'tasks'
  const vc = $('#view-config')
  if (vc) vc.hidden = v !== 'config'
  const vm = $('#view-memory')
  if (vm) vm.hidden = v !== 'memory'
  if (v === 'sessions') loadSessions()
  if (v === 'system') loadSystem()
  if (v === 'tasks') loadTasksBoard()
  if (v === 'memory') loadMemory()
  if (v === 'config') loadConfigView()
}

function fmtUptime(s) {
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟'
  if (s < 86400) return (s / 3600).toFixed(1) + ' 小时'
  return (s / 86400).toFixed(1) + ' 天'
}

let TBOARD = null
let SESS = []

async function ensureSessions() {
  if (SESS.length) return SESS
  try {
    const r = await fetch('/dsh-plugins/api/sessions', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    SESS = (d.items || []).filter((s) => !s.subagent && /^\d{3}$/.test(String(s.title || '')))
  } catch {}
  return SESS
}

async function fillPickers() {
  const lead = $('#t-lead')
  const asg = $('#t-assignee')
  if (!lead || !asg) return
  const list = await ensureSessions()
  await loadPersonas()
  const opts = list.map((s) => {
    const p = PERS[s.title]
    const tag = p && (p.role || p.name) ? ' · ' + (p.role || p.name) : ''
    return '<option value="' + esc(s.title) + '">' + esc(s.title + tag + (s.running ? '（运行中）' : '')) + '</option>'
  }).join('')
  lead.innerHTML = '<option value="">主管：待认领</option>' + opts
  asg.innerHTML = '<option value="">执行者：不指定</option>' + opts
}

function taskCard(t, col) {
  const parts = (t.parts || []).map((p) =>
    '<div class="tpart">· ' + esc(p.name) +
    (p.owner ? ' <span class="who">→ ' + esc(p.owner) + '</span>' : '') +
    (p.status === 'done' ? ' <span class="pd">✓</span>' : '') + '</div>').join('')
  const brief = t.brief ? '<pre class="tbrief">' + esc(t.brief) + '</pre>' : ''
  const add = col === 'done' ? '' :
    '<div class="tadd"><input data-add="' + esc(t.id) + '" placeholder="追加（会按部分负责人路由）">' +
    '<button data-addgo="' + esc(t.id) + '">追加</button>' +
    '<button class="tiny" data-discuss="' + esc(t.id) + '" title="用这个任务开一个群聊讨论">讨论</button></div>'
  return '<div class="tcard" data-id="' + esc(t.id) + '">' +
    '<div class="th"><span class="tid">' + esc(t.id) + '</span><span class="ttl">' + esc(t.title) + '</span></div>' +
    brief +
    '<div class="meta">主管 ' + esc(t.lead || '—') + ' · 执行 ' + esc(t.assignee || '—') + '</div>' +
    parts + add + '</div>'
}

async function discussTask(id) {
  try {
    const r0 = await fetch('/dsh-plugins/api/tasks', { signal: AbortSignal.timeout(8000) })
    const b = await r0.json()
    const all = [].concat(b.columns.open, b.columns.active, b.columns.done, b.columns.blocked || [])
    const t = all.find(function (x) { return x.id === id })
    if (!t) throw new Error('看板上没有 ' + id)
    const members = [t.lead, t.assignee].filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i })
    if (!members.length) throw new Error('这个任务还没有主管，先指定一个再讨论')
    const lim = ($('#t-group-limit') && Number($('#t-group-limit').value)) || 30
    const r = await fetch('/dsh-group/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '讨论 ' + t.id + '：' + t.title, members: members, limit: lim }),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '开群失败')
    toast('已开群：' + members.join('、') + '（上限 ' + lim + ' 轮）')
    const box = $('#tgroup')
    if (box && box.hidden) toggleGroupPanel()
    const f = $('#group-frame')
    if (f) { f.src = '/dsh-group?g=' + encodeURIComponent(d.groupId) }
  } catch (err) {
    toast(err.message, true)
  }
}
function toggleGroupPanel() {
  const box = $('#tgroup')
  const btn = $('#t-group-toggle')
  const hint = $('#t-group-hint')
  if (!box) return
  const open = box.hidden
  box.hidden = !open
  if (btn) btn.classList.toggle('on', open)
  if (hint) hint.textContent = open ? '同一台机器上的会话都在这里；人类发言用输入框' : '看板上的任务可以在这里展开讨论'
  if (open) {
    const f = $('#group-frame')
    if (f && !f.getAttribute('src')) f.setAttribute('src', f.dataset.src || '/dsh-group')
  }
}
async function loadTasksBoard() {
  const box = $('#tboard')
  if (!box) return
  await fillPickers()
  try {
    const r = await fetch('/dsh-plugins/api/tasks', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    TBOARD = d
    const cols = d.columns || {}
    const names = { open: '待认领', active: '进行中', done: '已完成' }
    box.innerHTML = ['open', 'active', 'done'].map((k) => {
      const items = cols[k] || []
      return '<div class="tcol"><h3>' + names[k] + ' · ' + items.length + '</h3>' +
        items.map((t) => taskCard(t, k)).join('') + '</div>'
    }).join('')
  } catch (err) {
    box.innerHTML = '<div id="empty">读取失败：' + esc(err.message) + '</div>'
  }
}

async function createTaskFromForm() {
  const title = $('#t-title')
  if (!title || !title.value.trim()) { toast('先写个任务标题', true); return }
  const body = {
    action: 'create',
    title: title.value.trim(),
    brief: ($('#t-brief') || {}).value || '',
    lead: ($('#t-lead') || {}).value || '',
    assignee: ($('#t-assignee') || {}).value || '',
  }
  try {
    const r = await fetch('/dsh-plugins/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '失败')
    title.value = ''
    if ($('#t-brief')) $('#t-brief').value = ''
    toast('已发布 ' + d.task.id + (d.notified ? '，已通知主管 ' + d.notified : ''))
    await loadTasksBoard()
  } catch (err) {
    toast(err.message, true)
  }
}

async function appendTask(id, input) {
  const text = (input.value || '').trim()
  if (!text) return
  try {
    const r = await fetch('/dsh-plugins/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'append', id, text, by: 'user' }),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '失败')
    input.value = ''
    toast(d.notified ? '已追加，并通知 ' + d.notified : '已追加（看板已记，未找到负责人通知）')
    await loadTasksBoard()
  } catch (err) {
    toast(err.message, true)
  }
}
let PERS = {}

async function loadPersonas() {
  try {
    const r = await fetch('/dsh-plugins/api/personas', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    PERS = d.items || {}
  } catch { PERS = {} }
}

function personaCard(s) {
  const p = PERS[s.title] || {}
  const cls = s.running ? 'run' : ''
  const label = s.running ? '运行中' : s.blank ? '空会话' : s.archived ? '已归档' : '空闲'
  const skills = (p.skills || []).map((k) => '<span class="psk">' + esc(k) + '</span>').join('')
  return '<div class="pcard" data-sid="' + esc(s.title) + '">' +
    '<div class="ph"><span class="pno">' + esc(s.title) + '</span>' +
      '<span class="pn">' + esc(p.name || '未命名') + '</span>' +
      '<span class="st ' + cls + '">' + label + '</span></div>' +
    (p.role ? '<div class="prole">' + esc(p.role) + '</div>' : '') +
    '<div class="pbio">' + (p.bio ? esc(p.bio) : '<span class="muted">还没写人设</span>') + '</div>' +
    (skills ? '<div class="pskills">' + skills + '</div>' : '') +
    '<div class="pf"><span class="path">' + esc(s.cwd || '') + '</span>' +
      '<button class="tiny" data-act-sess="rename" data-sid="' + esc(s.id) + '" data-title="' + esc(s.title) + '">改名</button>' +
      (s.running ? '<button class="tiny" data-act-sess="cancel" data-sid="' + esc(s.id) + '">停止</button>' : '') +
      (s.archived ? '' : '<button class="tiny danger" data-act-sess="archive" data-sid="' + esc(s.id) + '" data-title="' + esc(s.title) + '">归档</button>') +
      '<button class="tiny" data-edit="' + esc(s.title) + '">' + (p.name || p.role ? '编辑人设' : '＋ 人设') + '</button></div>' +
    '</div>'
}

async function sessionAction(btn) {
  const action = btn.dataset.actSess
  const sid = btn.dataset.sid
  const label = btn.dataset.title || sid
  try {
    let body = { action: action, sessionId: sid }
    if (action === 'rename') {
      const next = prompt('新标题：', label)
      if (next == null) return
      body.title = String(next)
    }
    if (action === 'cancel' && !confirm('停止「' + label + '」当前这一回合？')) return
    if (action === 'archive' && !confirm('归档「' + label + '」？\n\n归档后不在侧栏显示，会话数据保留。')) return
    const r = await fetch('/dsh-plugins/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '操作失败')
    toast(d.message || '完成')
    setTimeout(loadSessions, 700)
  } catch (err) {
    toast(err.message, true)
  }
}
function openPersonaEditor(id) {
  const box = $('#persona-editor')
  if (!box) return
  const p = PERS[id] || {}
  box.hidden = false
  box.innerHTML =
    '<div class="pedit-line"><span class="pno">' + esc(id) + '</span>' +
      '<input id="pn-name" placeholder="昵称，如 小前" value="' + esc(p.name || '') + '">' +
      '<input id="pn-role" placeholder="角色，如 前端" value="' + esc(p.role || '') + '">' +
      '<button class="primary" data-psave="' + esc(id) + '">保存</button>' +
      (p.name || p.role || p.bio ? '<button class="danger" data-pdel="' + esc(id) + '">删除</button>' : '') +
      '<button data-pclose="1">关闭</button></div>' +
    '<div class="pedit-line"><input class="wide" id="pn-bio" placeholder="一句话人设：它是谁、怎么干活、在意什么" value="' + esc(p.bio || '') + '">' +
      '<input class="wide" id="pn-skills" placeholder="擅长，逗号分隔，如 CSS,交互" value="' + esc((p.skills || []).join(',')) + '"></div>'
}

async function savePersona(id) {
  try {
    const body = {
      id,
      name: ($('#pn-name') || {}).value || '',
      role: ($('#pn-role') || {}).value || '',
      bio: ($('#pn-bio') || {}).value || '',
      skills: ($('#pn-skills') || {}).value || '',
    }
    const r = await fetch('/dsh-plugins/api/personas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '失败')
    toast('人设已保存')
    if ($('#persona-editor')) $('#persona-editor').hidden = true
    await loadSessions()
  } catch (err) { toast(err.message, true) }
}

async function deletePersona(id) {
  try {
    const r = await fetch('/dsh-plugins/api/personas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'remove' }),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '失败')
    toast('人设已删除')
    if ($('#persona-editor')) $('#persona-editor').hidden = true
    await loadSessions()
  } catch (err) { toast(err.message, true) }
}

async function loadSessions() {
  const box = $('#sessions-body')
  if (!box) return
  box.innerHTML = '<div id="empty">读取中…</div>'
  await loadPersonas()
  try {
    const r = await fetch('/dsh-plugins/api/sessions', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    const items = (d.items || []).filter((s) => !s.subagent && /^\d{3}$/.test(String(s.title || '')))
    items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
    if (!items.length) {
      box.innerHTML = '<div id="empty">没有编号会话（001/002…）' + (d.note ? '：' + esc(d.note) : '') + '</div>'
      return
    }
    box.innerHTML = items.map(personaCard).join('')
  } catch (err) {
    box.innerHTML = '<div id="empty">读取失败：' + esc(err.message) + '</div>'
  }
}
async function loadSystem() {
  const box = $('#system-body')
  if (!box) return
  box.innerHTML = '<div id="empty">读取中…</div>'
  try {
    const r = await fetch('/dsh-plugins/api/system', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    const used = d.memTotal ? d.memTotal - d.memFree : 0
    const pct = d.memTotal ? Math.round((used / d.memTotal) * 100) : 0
    const cards = [
      ['Node', d.node, '宿主进程运行时'],
      ['平台', d.platform, ''],
      ['端口', d.port, '本次 GUI 端口'],
      ['已运行', fmtUptime(d.uptime), ''],
      ['进程内存', fmt(d.rss), 'heap ' + fmt(d.heapUsed)],
      ['系统内存', pct + '% 已用', fmt(used) + ' / ' + fmt(d.memTotal)],
      ['CPU 核心', d.cpus, ''],
      ['插件数', d.plugins, '已登记在 profile'],
      ['DSH 目录', d.dshHome, ''],
      ['profile', d.profile, ''],
    ]
    box.innerHTML = cards.map((it) =>
      '<div class="syscard"><div class="k">' + esc(it[0]) + '</div><div class="v">' + esc(String(it[1])) +
      (it[2] ? '<br><small>' + esc(it[2]) + '</small>' : '') + '</div></div>').join('')
  } catch (err) {
    box.innerHTML = '<div id="empty">读取失败：' + esc(err.message) + '</div>'
  }
}

async function loadConfigView() {
  const box = $('#cfg-form')
  if (!box) return
  box.innerHTML = '<div class="ask-hint">读取中…</div>'
  try {
    const r = await fetch('/dsh-plugins/api/config', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    const c = d.config || {}
    const rows = [
      ['autoNotifyNewPlugin', 'check', '新插件自动通知 AI 翻译', c.autoNotifyNewPlugin, '开一次要消耗一轮对话'],
      ['autoTranslateMissing', 'check', '缺简介时自动起翻译', c.autoTranslateMissing, '同上，默认关'],
      ['taskRetentionDays', 'number', '任务保留天数', c.taskRetentionDays, '0 表示永久保留'],
      ['logRetentionDays', 'number', '日志保留天数', c.logRetentionDays, '归档目录不受影响'],
      ['memoryDir', 'text', '记忆库目录', c.memoryDir, '改了要重启才生效'],
      ['workDir', 'text', '协作目录', c.workDir, '任务板与 PERSONAS.md 都在这里'],
    ]
    box.innerHTML = rows.map(function (it) {
      const key = it[0], type = it[1], label = it[2], val = it[3], hint = it[4]
      const input = type === 'check'
        ? '<input type="checkbox" data-cfg="' + key + '"' + (val ? ' checked' : '') + '>'
        : '<input type="' + (type === 'number' ? 'number' : 'text') + '" data-cfg="' + key + '" value="' + esc(String(val)) + '">'
      return '<div class="cfgrow"><span>' + esc(label) + '</span>' + input +
        '<small style="color:var(--dim)">' + esc(hint) + '</small></div>'
    }).join('') +
      '<div class="cfgrow"><span></span><button class="primary" id="cfg-save">保存</button>' +
      '<button id="cfg-reset">恢复默认</button></div>'
  } catch (err) {
    box.innerHTML = '<div class="ask-hint">读取失败：' + esc(err.message) + '</div>'
  }
}

async function saveConfigForm(reset) {
  const box = $('#cfg-form')
  if (!box) return
  const patch = reset ? { action: 'reset' } : {}
  if (!reset) {
    box.querySelectorAll('[data-cfg]').forEach(function (el) {
      const k = el.dataset.cfg
      patch[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value
    })
  }
  try {
    const r = await fetch('/dsh-plugins/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    toast(reset ? '已恢复默认' : '已保存')
    loadConfigView()
  } catch (err) {
    toast(err.message, true)
  }
}
async function loadMemory() {
  const head = $('#mem-stats')
  const docsBox = $('#mem-docs')
  if (!head) return
  head.textContent = '读取中…'
  try {
    const r = await fetch('/dsh-plugins/api/memory', { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    const c = d.counts || {}
    head.innerHTML =
      '<span>目录 <b>' + esc(d.dir) + '</b></span>' +
      '<span>归档 <b>' + (d.volumes || []).length + '</b> 卷 · ' + fmt(d.totalBytes) + '</span>' +
      '<span>消息 <b>' + (c.messages || 0) + '</b> · 会话 <b>' + (c.sessions || 0) + '</b></span>' +
      '<span>文档 <b>' + (c.docs || 0) + '</b> 段 · 决策 <b>' + (c.decisions || 0) + '</b></span>' +
      '<span>' + (d.hasIndex ? '索引正常' : '⚠ 没有 index.sqlite') + '</span>'
    if (docsBox) {
      const vols = (d.volumes || []).map((v) =>
        '<div class="docitem vol' + (v.current ? ' cur' : '') + '" data-doc="' + esc(v.name) + '">' +
        (v.current ? '● ' : '') + esc(v.name) +
        ' <span style="color:var(--dim)">' + fmt(v.bytes) + '</span></div>').join('')
      docsBox.innerHTML =
        (vols ? '<div class="mgroup"><span class="mgl">归档卷</span>' + vols + '</div>' : '') +
        '<div class="mgroup"><span class="mgl">文档</span>' +
        ((d.docs || []).map((x) =>
          '<div class="docitem" data-doc="' + esc(x.name) + '">' + esc(x.name) +
          ' <span style="color:var(--dim)">' + fmt(x.bytes) + '</span></div>').join('') ||
          '<span class="ask-hint">记忆库里还没有文档</span>') +
        '</div>'
    }
  } catch (err) {
    head.textContent = '读取失败：' + err.message
  }
}

async function memSync(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '归档中…' }
  try {
    const r = await fetch('/dsh-plugins/api/memory/sync', { method: 'POST', signal: AbortSignal.timeout(125000) })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '归档失败')
    toast('已归档：' + String(d.output || '').split('\n')[0])
    await loadMemory()
  } catch (err) {
    toast(err.message, true)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '归档当前对话' }
  }
}
async function memSearch() {
  const box = $('#mem-hits')
  const hint = $('#m-hint')
  const q = ($('#m-q') && $('#m-q').value.trim()) || ''
  if (!box) return
  if (!q) { box.innerHTML = ''; if (hint) hint.textContent = ''; return }
  box.innerHTML = '<div class="ask-hint">搜索中…</div>'
  try {
    const r = await fetch('/dsh-plugins/api/memory/search?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    const hits = d.hits || []
    if (hint) hint.textContent = '命中 ' + hits.length + ' 条 · 按时间倒序'
    box.innerHTML = hits.map((h) => {
      const where = h.kind === 'message'
        ? '消息 · ' + String(h.sessionId || '').slice(-8) + ' #' + h.seq
        : '文档 · ' + h.path + (h.heading ? ' / ' + h.heading : '')
      const when = h.time ? new Date(h.time).toLocaleString() : ''
      return '<div class="hit"><span class="hw">' + esc(where) + '</span>' +
        '<span class="ht">' + esc(when) + '</span><br>' + esc(h.text) + '</div>'
    }).join('') || '<div class="ask-hint">没搜到</div>'
  } catch (err) {
    box.innerHTML = '<div class="ask-hint">搜索失败：' + esc(err.message) + '</div>'
  }
}

async function upgradeOne(name) {
  const ok = confirm('把 ' + name + ' 升级到最新版？\n\n会在后台跑 pnpm，装完需要重启 DSH 才生效。')
  if (!ok) return
  try {
    const r = await fetch('/dsh-plugins/api/upgrade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name }),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || '失败')
    toast(d.message || '已在后台安装')
    setTimeout(() => { UPD = {}; loadUpdates() }, 6000)
  } catch (err) {
    toast(err.message, true)
  }
}
async function openMemDoc(name) {
  const pre = $('#mem-doc')
  if (!pre) return
  pre.hidden = false
  pre.textContent = '读取中…'
  try {
    const r = await fetch('/dsh-plugins/api/memory/doc?name=' + encodeURIComponent(name), { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    pre.textContent = d.text
    pre.scrollIntoView({ block: 'nearest' })
  } catch (err) {
    pre.textContent = '读不到：' + err.message
  }
}
function fmt(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function renderLogs() {
  const body = $('#logs-body')
  if (!LOGS) return
  const groups = Object.entries(LOGS.byPlugin || {})
  const arcs = LOGS.archives || []
  const arcBytes = arcs.reduce((s, a) => s + a.bytes, 0)
  $('#logs-meta').textContent = '最近 ' + (LOGS.files || []).length + ' 个日志文件 · ' +
    (groups.length ? groups.length + ' 个插件有报错记录' : '没有匹配到插件相关的报错') +
    ' · 归档 ' + arcs.length + ' 个（' + fmt(arcBytes) + '）'
  if (!groups.length) {
    body.innerHTML = '<div id="empty">没有找到插件相关的报错行。</div>'
    return
  }
  body.innerHTML = groups.map(([name, lines]) =>
    '<div class="loggrp" data-name="' + esc(name) + '"><b>' + esc(name) + '</b>（' + lines.length + '）' +
    lines.slice(0, 20).map((l) => '<div class="logline"><span class="f">' + esc(l.file) + '</span>' + esc(l.line) + '</div>').join('') +
    '</div>').join('')
}

async function loadLogs() {
  try {
    const r = await fetch('/dsh-plugins/api/logs', { signal: AbortSignal.timeout(8000) })
    LOGS = await r.json()
    renderLogs()
  } catch (err) {
    $('#logs-meta').textContent = '日志读取失败：' + err.message
  }
}

/** 从插件详情跳到日志面板里该插件那一段。 */
async function jumpToLog(name) {
  const panel = $('#logpanel')
  panel.hidden = false
  if (!LOGS) await loadLogs()
  const grp = document.querySelector('.loggrp[data-name="' + CSS.escape(name) + '"]')
  if (!grp) {
    toast('日志里没有「' + name + '」的报错行')
    return
  }
  grp.scrollIntoView({ block: 'center' })
  grp.classList.add('hit')
  setTimeout(() => grp.classList.remove('hit'), 1800)
}

async function toggleReadme(btn) {
  const row = btn.closest('.row')
  const pre = row ? row.querySelector('.readme') : null
  if (!pre) return
  if (!pre.hidden) {
    pre.hidden = true
    btn.textContent = '看 README'
    return
  }
  if (pre.dataset.loaded) {
    pre.hidden = false
    btn.textContent = '收起 README'
    return
  }
  const old = btn.textContent
  btn.textContent = '读取中…'
  btn.disabled = true
  try {
    const r = await fetch('/dsh-plugins/api/readme?name=' + encodeURIComponent(btn.dataset.name), { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || '读取失败')
    pre.textContent = d.text
    pre.dataset.loaded = '1'
    pre.hidden = false
    btn.textContent = '收起 README'
  } catch (err) {
    btn.textContent = old
    toast(err.message, true)
  } finally {
    btn.disabled = false
  }
}

function toggleLogPanel() {
  const p = $('#logpanel')
  if (!p) { toast('找不到日志面板', true); return }
  p.hidden = !p.hidden
  if (!p.hidden) {
    if (!LOGS) loadLogs()
  }
}

async function purgeLogs() {
  if (!confirm('彻底删除所有归档日志目录？删了就找不回来了。')) return
  try {
    const r = await fetch('/dsh-plugins/api/logs/purge', { method: 'POST' })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || '失败')
    toast(data.message || '已删除')
    LOGS = null
    await loadLogs()
  } catch (err) {
    toast(err.message, true)
  }
}

async function archiveLogs() {
  if (!confirm('把日志文件移到归档目录（不会删除，可随时翻）？')) return
  try {
    const r = await fetch('/dsh-plugins/api/logs/archive', { method: 'POST' })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || '失败')
    toast(data.message || '已清理')
    LOGS = null
    await loadLogs()
    await loadHealth()
  } catch (err) {
    toast(err.message, true)
  }
}

function impactHint(name) {
  const im = IMP[name]
  if (!im) return ''
  const bits = []
  if (im.tools && im.tools.length) bits.push(im.tools.length + ' 个工具（' + im.tools.slice(0, 4).join('、') + (im.tools.length > 4 ? '…' : '') + '）')
  if (im.slots && im.slots.length) bits.push('界面 ' + im.slots.join('、'))
  return bits.length ? '停用后会消失：' + bits.join('；') + '。' : ''
}

async function act(name, action) {
  if (busy) return
  if (action === 'remove' && !confirm('确定删除「' + name + '」？' + impactHint(name) + '重启后生效。')) return
  if (action === 'disable' && !confirm('停用「' + name + '」？' + impactHint(name) + '重启后生效。')) return
  busy = true
  try {
    const r = await fetch('/dsh-plugins/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action }),
    })
    const data = await r.json()
    if (!r.ok || data.ok === false) throw new Error(data.error || '操作失败')
    toast(data.message || '完成')
    await load()
    await loadHealth()
  } catch (err) {
    toast(err.message, true)
  } finally {
    busy = false
  }
}

document.addEventListener('click', (e) => {
  const vh = e.target.closest('#topnav button')
  if (vh) { setView(vh.dataset.view); return }
  if (e.target.closest('#t-create')) { createTaskFromForm(); return }
  if (e.target.closest('#t-group-toggle')) { toggleGroupPanel(); return }
  if (e.target.closest('#m-go')) { memSearch(); return }
  if (e.target.closest('#cfg-save')) { saveConfigForm(false); return }
  if (e.target.closest('#cfg-reset')) {
    if (confirm('恢复默认设置？')) saveConfigForm(true)
    return
  }
  const up = e.target.closest('button[data-up]')
  if (up) { upgradeOne(up.dataset.up); return }
  const dc = e.target.closest('.docitem[data-doc]')
  if (dc) { openMemDoc(dc.dataset.doc); return }
  const sa = e.target.closest('button[data-act-sess]')
  if (sa) { sessionAction(sa); return }
  const ed = e.target.closest('button[data-edit]')
  if (ed) { openPersonaEditor(ed.dataset.edit); return }
  const ps = e.target.closest('button[data-psave]')
  if (ps) { savePersona(ps.dataset.psave); return }
  const pd = e.target.closest('button[data-pdel]')
  if (pd) {
    if (confirm('删掉 ' + pd.dataset.pdel + ' 的人设卡？')) deletePersona(pd.dataset.pdel)
    return
  }
  if (e.target.closest('button[data-pclose]')) {
    const pe = document.getElementById('persona-editor')
    if (pe) pe.hidden = true
    return
  }
  const dsc = e.target.closest('button[data-discuss]')
  if (dsc) { discussTask(dsc.dataset.discuss); return }
  const ago = e.target.closest('button[data-addgo]')
  if (ago) {
    const inp = document.querySelector('input[data-add="' + ago.dataset.addgo + '"]')
    if (inp) appendTask(ago.dataset.addgo, inp)
    return
  }
  const t = e.target.closest('button[data-tab]')
  if (t) { showTab(t.dataset.tab); return }
  if (e.target.closest('#only-bad')) {
    ONLY_BAD = !ONLY_BAD
    const chip = $('#only-bad')
    if (chip) chip.classList.toggle('on', ONLY_BAD)
    if (DATA) showTab(CUR)
    return
  }
  if (e.target.closest('#trash-open')) {
    const p = $('#trashpanel')
    if (p) { p.hidden = !p.hidden; if (!p.hidden) loadTrash() }
    return
  }
  if (e.target.closest('#trash-clear')) { clearTrash(); return }
  if (e.target.closest('#export-json')) { location.href = '/dsh-plugins/api/export'; return }
  const tb = e.target.closest('[data-trb]')
  if (tb) { trashAct(tb.dataset.id, tb.dataset.trb); return }
  if (e.target.closest('#logs-toggle')) { toggleLogPanel(); return }
  if (e.target.closest('#logs-purge')) { purgeLogs(); return }
  if (e.target.closest('#logs-clear')) { archiveLogs(); return }
  if (e.target.closest('#open-profile')) {
    fetch('/dsh-plugins/api/open-profile')
      .then((r) => r.json())
      .then((d) => (d.ok ? toast('已打开：' + d.dir) : toast(d.error || '打不开', true)))
      .catch((e) => toast(e.message, true))
    return
  }
  if (e.target.closest('#shutdown-dsh')) {
    const chk = $('#shutdown-clear-login')
    const clear = Boolean(chk && chk.checked)
    const extra = clear ? '\n\n并清除登录记录（API key 保留，只清设备/会话痕迹）。' : ''
    if (!confirm('关闭 DeepSeek Harness？\n\n未保存的会话内容会丢，关闭后需要手动重新打开。' + extra)) return
    fetch('/dsh-plugins/api/shutdown' + (clear ? '?clear=1' : ''), { method: 'POST' })
      .then((r) => r.json())
      .then((d) => toast(d.message || '正在关闭…'))
      .catch((e) => toast(e.message, true))
    return
  }
  const b = e.target.closest('button[data-act]')
  if (b) {
    if (b.dataset.act === 'logjump') {
      jumpToLog(b.dataset.name)
      return
    }
    if (b.dataset.act === 'readme') {
      toggleReadme(b)
      return
    }
    act(b.dataset.name, b.dataset.act)
    return
  }
  const body = e.target.closest('.row > .body')
  if (body) {
    const row = body.closest('.row')
    const name = row.dataset.name
    if (row.classList.contains('open')) {
      row.classList.remove('open')
      OPEN.delete(name)
    } else {
      row.classList.add('open')
      OPEN.add(name)
    }
  }
})

const qEl = $('#q')
if (qEl) {
  qEl.addEventListener('input', () => {
    Q = qEl.value.trim()
    if (DATA) showTab(CUR)
  })
}

const mqEl = $('#m-q')
if (mqEl) {
  mqEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); memSearch() }
  })
}

const askBox = $('#ask')
$('#ask-open').onclick = () => {
  askBox.hidden = !askBox.hidden
  if (!askBox.hidden) $('#ask-input').focus()
}
$('#ask-cancel').onclick = () => { askBox.hidden = true }
$('#ask-go').onclick = async () => {
  const target = $('#ask-input').value.trim()
  if (!target) return toast('先填个路径或链接', true)
  const btn = $('#ask-go')
  btn.disabled = true
  try {
    const r = await fetch('/dsh-plugins/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ask-install', target }),
    })
    const data = await r.json()
    if (!r.ok || data.ok === false) throw new Error(data.error || data.message || '失败')
    toast(data.message || '已交给 AI')
    askBox.hidden = true
    $('#ask-input').value = ''
  } catch (err) {
    toast(err.message, true)
  } finally {
    btn.disabled = false
  }
}

load()
loadHealth()
loadLogs()


// hidden 属性会被 display:flex 等 CSS 覆盖，这里强制生效（视图切换依赖它）
;(function ensureHiddenRule() {
  const st = document.createElement('style')
  st.textContent = '[hidden]{display:none !important}'
  document.head.appendChild(st)
})()