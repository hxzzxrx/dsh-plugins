/**
 * 会话人设卡：给每个会话编号配一张「它是谁、擅长什么、负责什么」的小卡。
 *
 * 数据落在 work\personas.json（和 tasks.json 同目录，所有会话都能 read），
 * 每次变更同时刷新 work\PERSONAS.md 快照。
 *
 * 用途：
 *   1. 会话视图里显示，别只有一串 id；
 *   2. 发布任务时下拉框显示「002 · 前端」，知道派给谁；
 *   3. 通知主管/执行者时，把人设带上，让它知道自己的角色。
 */

import fs from 'node:fs'
import path from 'node:path'
import { workDir } from './tasks.mjs'

const FILE = 'personas.json'

function filePath() {
  return path.join(workDir(), FILE)
}

function now() {
  return new Date().toISOString()
}

export function loadPersonas() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function renderSnapshot(all) {
  const ids = Object.keys(all).sort()
  const lines = ['# 会话人设卡', '', '> 自动生成，改它会被覆盖。数据源 `work\\personas.json`；入口：插件管理 → 会话。', '']
  if (!ids.length) lines.push('（还没配置）')
  for (const id of ids) {
    const p = all[id] || {}
    lines.push('## ' + id + (p.name ? ' · ' + p.name : ''))
    if (p.role) lines.push('- 角色：' + p.role)
    if (p.bio) lines.push('- 人设：' + p.bio)
    if (Array.isArray(p.skills) && p.skills.length) lines.push('- 擅长：' + p.skills.join('、'))
    lines.push('')
  }
  fs.writeFileSync(path.join(workDir(), 'PERSONAS.md'), lines.join('\n'), 'utf8')
}

export function savePersonas(all) {
  fs.writeFileSync(filePath(), JSON.stringify(all, null, 2) + '\n', 'utf8')
  try { renderSnapshot(all) } catch {}
}

export function listPersonas() {
  return loadPersonas()
}

export function getPersona(id) {
  return loadPersonas()[String(id || '').trim()] || null
}

/** name/role/bio/skills 都可省略；传空字符串就是清掉那个字段。 */
export function setPersona(id, patch = {}) {
  const key = String(id || '').trim()
  if (!/^\d{3}$/.test(key)) throw new Error('人设卡要挂在三位编号的会话上（001/002…）')
  const all = loadPersonas()
  const cur = all[key] || {}
  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : (cur.name || ''),
    role: patch.role !== undefined ? String(patch.role).trim() : (cur.role || ''),
    bio: patch.bio !== undefined ? String(patch.bio).trim() : (cur.bio || ''),
    skills: patch.skills !== undefined
      ? (Array.isArray(patch.skills) ? patch.skills.map((s) => String(s).trim()).filter(Boolean) : String(patch.skills).split(/[，,、\s]+/).filter(Boolean))
      : (cur.skills || []),
    updatedAt: now(),
  }
  if (!next.name && !next.role && !next.bio && !next.skills.length) delete all[key]
  else all[key] = next
  savePersonas(all)
  return all[key] || null
}

export function removePersona(id) {
  const key = String(id || '').trim()
  const all = loadPersonas()
  delete all[key]
  savePersonas(all)
  return true
}

/** 通知文案用：002（前端 · 小前） */
export function personaLabel(id) {
  const p = getPersona(id)
  if (!p) return String(id || '')
  const bits = [p.role, p.name].filter(Boolean)
  return bits.length ? String(id) + '（' + bits.join(' · ') + '）' : String(id)
}

/** 通知文案用：一段人能读的人设描述，没有就返回空串。 */
export function personaBrief(id) {
  const p = getPersona(id)
  if (!p) return ''
  const lines = []
  if (p.name) lines.push('名字：' + p.name)
  if (p.role) lines.push('角色：' + p.role)
  if (p.bio) lines.push('人设：' + p.bio)
  if (Array.isArray(p.skills) && p.skills.length) lines.push('擅长：' + p.skills.join('、'))
  return lines.length ? '【你的人设卡】\n' + lines.join('\n') : ''
}
