/**
 * dsh-plugins / config：插件自己的设置。
 *
 * 数据放 <DSH_HOME>/dsh-plugins/config.json，不进 profile（改 profile 容易崩宿主）。
 * 都是"可选开关"，缺省值写在这里，读的时候逐项兜底。
 */

import fs from 'node:fs'
import path from 'node:path'

import { pluginHome } from './paths.mjs'

const DEFAULTS = {
  autoNotifyNewPlugin: false,
  autoTranslateMissing: false,
  taskRetentionDays: 30,
  logRetentionDays: 7,
  // 空串 = 用默认推导（<DSH_HOME>/memory、<DSH_HOME>/work）
  memoryDir: '',
  workDir: '',
}

export function configPath() {
  return path.join(pluginHome(), 'config.json')
}

export function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}
  } catch {
    raw = {}
  }
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k]
  }
  return out
}

export function saveConfig(patch) {
  const cur = loadConfig()
  const next = { ...cur }
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] === undefined) continue
    if (typeof patch[k] !== typeof DEFAULTS[k]) continue
    next[k] = patch[k]
  }
  const dir = pluginHome()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

export function resetConfig() {
  try {
    fs.unlinkSync(configPath())
  } catch {}
  return loadConfig()
}

export { DEFAULTS }
