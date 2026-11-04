/**
 * 任务板数据层。
 *
 * 一个任务长这样：
 *   { id, title, brief, status, lead, assignee, parts[], events[], createdAt, updatedAt }
 *
 * - lead     主管：负责拍板「自己做还是拆」
 * - assignee 执行者：真正动手的会话编号（001/002…），可空
 * - parts    拆分出来的部分：[{ id, name, owner, status }]
 *             追加任务时按 name 匹配，优先交给 owner
 * - status   open（待认领）/ active（进行中）/ done / blocked
 *
 * 数据落在 <DSH_HOME>/dsh-plugins/tasks.json，和 zh-cache 同一个目录。
 */

import fs from 'node:fs'
import path from 'node:path'
import { workDir as defaultWorkDir } from './paths.mjs'
import { loadConfig } from './config.mjs'

const FILE = 'tasks.json'

/** 任务数据放在 work 目录：所有会话都能直接 read，不藏在 .dsh 里。 */
export function workDir() {
  // 配置中心可以覆盖：DSH_WORK_DIR > config.workDir > <DSH_HOME>/work
  try {
    const c = loadConfig()
    if (c.workDir) {
      fs.mkdirSync(c.workDir, { recursive: true })
      return c.workDir
    }
  } catch {}
  return defaultWorkDir()
}

function filePath() {
  return path.join(workDir(), FILE)
}

/** 生成 work\TASKS.md 快照，供不支持工具的会话直接读。 */
function renderSnapshot(data) {
  const groups = { active: [], open: [], done: [], blocked: [] }
  for (const t of data.items) (groups[t.status] || groups.active).push(t)
  const line = (t) => {
    const parts = (t.parts || []).map((p) =>
      '  - ' + p.name + (p.owner ? ' → ' + p.owner : '') + (p.status === 'done' ? ' ✓' : '')).join('\n')
    return '- **' + t.id + '** ' + t.title
      + (t.lead ? ' · 主管 ' + t.lead : '')
      + (t.assignee ? ' · 执行 ' + t.assignee : '')
      + (parts ? '\n' + parts : '')
  }
  const sec = (name, items) => (items.length ? '## ' + name + ' · ' + items.length + '\n' + items.map(line).join('\n') + '\n\n' : '')
  const md = '# 任务板\n\n'
    + '> 自动生成，改它会被覆盖。数据源 `work\\tasks.json`；入口：插件管理 → 任务；AI 工具：task_board / task_claim / task_split / task_done。\n\n'
    + sec('进行中', groups.active)
    + sec('待认领', groups.open)
    + sec('已完成', groups.done)
    + sec('受阻', groups.blocked)
  fs.writeFileSync(path.join(workDir(), 'TASKS.md'), md, 'utf8')
}

function now() {
  return new Date().toISOString()
}

export function loadTasks() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8')
    const data = JSON.parse(raw)
    return { seq: Number(data.seq) || 0, items: Array.isArray(data.items) ? data.items : [] }
  } catch {
    return { seq: 0, items: [] }
  }
}

export function saveTasks(data) {
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2) + '\n', 'utf8')
  try { renderSnapshot(data) } catch {}
}

function nextId(data) {
  data.seq = (Number(data.seq) || 0) + 1
  return 'T-' + String(data.seq).padStart(3, '0')
}

function pushEvent(task, kind, text) {
  task.events = Array.isArray(task.events) ? task.events : []
  task.events.push({ at: now(), kind, text })
  task.updatedAt = now()
}

export function listTasks() {
  return loadTasks().items
}

export function getTask(id) {
  return loadTasks().items.find((t) => t.id === id) || null
}

/** 新建任务。lead / assignee 都是会话编号字符串，可空。 */
export function createTask({ title, brief = '', lead = '', assignee = '', createdBy = 'user' }) {
  const cleanTitle = String(title || '').trim()
  if (!cleanTitle) throw new Error('任务需要一个标题')
  const data = loadTasks()
  const id = nextId(data)
  const task = {
    id,
    title: cleanTitle,
    brief: String(brief || '').trim(),
    status: 'open',
    lead: String(lead || '').trim(),
    assignee: String(assignee || '').trim(),
    parts: [],
    events: [],
    createdBy,
    createdAt: now(),
    updatedAt: now(),
  }
  pushEvent(task, 'create', createdBy === 'user' ? '由人创建' : '由 AI 创建')
  if (task.lead) pushEvent(task, 'lead', '主管指定为 ' + task.lead)
  if (task.assignee) pushEvent(task, 'assign', '执行者指定为 ' + task.assignee)
  data.items.unshift(task)
  saveTasks(data)
  return task
}

/** 认领为主管（或改派主管）。 */
export function claimTask(id, lead, note = '') {
  const data = loadTasks()
  const task = data.items.find((t) => t.id === id)
  if (!task) throw new Error('没有这个任务：' + id)
  task.lead = String(lead || '').trim()
  if (task.status === 'open') task.status = 'active'
  pushEvent(task, 'claim', (task.lead || '?') + ' 认领为主管' + (note ? '：' + note : ''))
  saveTasks(data)
  return task
}

/**
 * 拆分：parts = [{ name, owner }]，owner 是会话编号。
 * 会覆盖已有同名部分的所有者，其余部分保留。
 */
export function splitTask(id, parts = [], note = '') {
  const data = loadTasks()
  const task = data.items.find((t) => t.id === id)
  if (!task) throw new Error('没有这个任务：' + id)
  task.parts = Array.isArray(task.parts) ? task.parts : []
  for (const raw of parts) {
    const name = String(raw.name || raw.part || '').trim()
    if (!name) continue
    const owner = String(raw.owner || '').trim()
    const exist = task.parts.find((p) => p.name === name)
    if (exist) {
      if (owner) exist.owner = owner
    } else {
      task.parts.push({ id: 'p' + (task.parts.length + 1), name, owner, status: 'todo' })
    }
  }
  if (task.status === 'open') task.status = 'active'
  pushEvent(task, 'split', '拆成 ' + task.parts.length + ' 部分' + (note ? '：' + note : ''))
  saveTasks(data)
  return task
}

/** 把某个部分改派给别的会话。 */
export function assignPart(id, partName, owner) {
  const data = loadTasks()
  const task = data.items.find((t) => t.id === id)
  if (!task) throw new Error('没有这个任务：' + id)
  const part = (task.parts || []).find((p) => p.name === partName || p.id === partName)
  if (!part) throw new Error('没有这个部分：' + partName)
  part.owner = String(owner || '').trim()
  pushEvent(task, 'assign', '「' + part.name + '」改派给 ' + (part.owner || '未指定'))
  saveTasks(data)
  return task
}

/** 标完成（整单或某一部分）。 */
export function doneTask(id, { part = '', note = '', by = '' } = {}) {
  const data = loadTasks()
  const task = data.items.find((t) => t.id === id)
  if (!task) throw new Error('没有这个任务：' + id)
  if (part) {
    const p = (task.parts || []).find((x) => x.name === part || x.id === part)
    if (!p) throw new Error('没有这个部分：' + part)
    p.status = 'done'
    pushEvent(task, 'done', '「' + p.name + '」完成' + (by ? '（' + by + '）' : '') + (note ? '：' + note : ''))
    if (task.parts.every((x) => x.status === 'done')) task.status = 'done'
  } else {
    task.status = 'done'
    pushEvent(task, 'done', '整单完成' + (by ? '（' + by + '）' : '') + (note ? '：' + note : ''))
  }
  saveTasks(data)
  return task
}

export function commentTask(id, text, by = 'user') {
  const data = loadTasks()
  const task = data.items.find((t) => t.id === id)
  if (!task) throw new Error('没有这个任务：' + id)
  pushEvent(task, 'comment', (by === 'user' ? '人' : by) + '：' + String(text || '').trim())
  saveTasks(data)
  return task
}

export function removeTask(id) {
  const data = loadTasks()
  const i = data.items.findIndex((t) => t.id === id)
  if (i < 0) throw new Error('没有这个任务：' + id)
  const [gone] = data.items.splice(i, 1)
  saveTasks(data)
  return gone
}

/** 看板：按状态分组。 */
export function board() {
  const items = listTasks()
  const cols = { open: [], active: [], done: [], blocked: [] }
  for (const t of items) {
    const k = cols[t.status] ? t.status : 'active'
    cols[k].push(t)
  }
  return { columns: cols, total: items.length }
}

/**
 * 追加任务时找「负责这部分的」归属。
 * 规则：把 parts 的名字和任务标题切词，与追加文本做重叠计分，取最高分；
 * 没有 parts 就落到整单的执行者/主管。
 */
export function matchOwner(text) {
  const q = String(text || '')
  if (!q.trim()) return null
  const tokens = (s) => {
    const out = new Set()
    const small = String(s || '').toLowerCase()
    for (const w of small.split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 2) out.add(w)
    }
    // 中文没有空格，按 2 字滑窗补一些
    const han = small.replace(/[^\p{Script=Han}]+/gu, '')
    for (let i = 0; i + 2 <= han.length; i += 1) out.add(han.slice(i, i + 2))
    return out
  }
  const qTokens = tokens(q)
  let best = null
  for (const task of listTasks()) {
    const taskTokens = tokens(task.title)
    for (const part of task.parts || []) {
      const partTokens = tokens(part.name)
      let score = 0
      for (const t of qTokens) {
        if (partTokens.has(t)) score += 2
        if (taskTokens.has(t)) score += 1
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { score, taskId: task.id, taskTitle: task.title, part: part.name, owner: part.owner || '' }
      }
    }
    if (!task.parts?.length) {
      const taskScore = [...qTokens].filter((t) => taskTokens.has(t)).length
      if (taskScore > 0 && (!best || taskScore > best.score)) {
        best = { score: taskScore, taskId: task.id, taskTitle: task.title, part: '', owner: task.assignee || task.lead || '' }
      }
    }
  }
  return best
}
