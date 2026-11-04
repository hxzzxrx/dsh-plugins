// 定期清理：任务保留天数 / 日志保留天数
//
// 配置中心里这两项之前是"死开关"（改了没效果），这里接上：
//   taskRetentionDays  已完成的任务超过 N 天自动删
//   logRetentionDays   日志文件超过 N 天自动移进 _archive_<时间> 目录

import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { loadTasks, saveTasks } from './tasks.mjs'
import { logDirs } from './health.mjs'

const DAY = 24 * 60 * 60 * 1000
const INTERVAL = 6 * 60 * 60 * 1000 // 每 6 小时

/** 删掉「已完成且最后更新超过 N 天」的任务，返回删了几条。 */
export function purgeOldTasks(days) {
  const keep = Number(days)
  if (!Number.isFinite(keep) || keep <= 0) return { removed: 0, kept: 0 }
  const data = loadTasks()
  const cutoff = Date.now() - keep * DAY
  const before = data.items.length
  data.items = data.items.filter((t) => {
    if (t.status !== 'done') return true
    const at = Date.parse(t.updatedAt || t.createdAt || '')
    if (!Number.isFinite(at)) return true
    return at >= cutoff
  })
  const removed = before - data.items.length
  if (removed > 0) saveTasks(data)
  return { removed, kept: data.items.length }
}

/** 把超过 N 天的 *.log 移到 _archive_<ISO> 目录，返回移了几个。 */
export function archiveOldLogs(days) {
  const keep = Number(days)
  if (!Number.isFinite(keep) || keep <= 0) return { moved: 0 }
  const cutoff = Date.now() - keep * DAY
  let moved = 0
  for (const dir of logDirs()) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const stale = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.log'))
      .map((e) => ({ name: e.name, full: path.join(dir, e.name) }))
      .filter((e) => {
        try {
          return fs.statSync(e.full).mtimeMs < cutoff
        } catch {
          return false
        }
      })
    if (!stale.length) continue
    const target = path.join(dir, `_archive_${new Date().toISOString().replace(/[:.]/g, '-')}`)
    try {
      fs.mkdirSync(target, { recursive: true })
    } catch {
      continue
    }
    for (const f of stale) {
      try {
        fs.renameSync(f.full, path.join(target, f.name))
        moved += 1
      } catch {}
    }
  }
  return { moved }
}

/** 启动时跑一次，之后每 6 小时跑一次。 */
export function startRetention(ctx) {
  const run = () => {
    let cfg
    try {
      cfg = loadConfig()
    } catch {
      return
    }
    try {
      const r = purgeOldTasks(cfg.taskRetentionDays)
      if (r.removed > 0) ctx.logger?.info?.(`[plugins] 清理过期任务 ${r.removed} 条`)
    } catch (err) {
      ctx.logger?.warn?.(`[plugins] 任务清理失败: ${err?.message || err}`)
    }
    try {
      const r = archiveOldLogs(cfg.logRetentionDays)
      if (r.moved > 0) ctx.logger?.info?.(`[plugins] 归档旧日志 ${r.moved} 个`)
    } catch (err) {
      ctx.logger?.warn?.(`[plugins] 日志归档失败: ${err?.message || err}`)
    }
  }

  const id = setInterval(run, INTERVAL)
  const warm = setTimeout(run, 30_000)
  return () => {
    clearInterval(id)
    clearTimeout(warm)
  }
}
