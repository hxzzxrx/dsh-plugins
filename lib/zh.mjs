// dsh-plugins / zh：插件中文简介缓存
//
// 存在 <DSH_HOME>/dsh-plugins/zh-cache.json，格式 { "插件名": "一句中文简介" }。
// 页面每次列清单都会读它，所以写进去立刻生效，不用重启。
import fs from 'node:fs'
import path from 'node:path'

import { pluginHome } from './paths.mjs'

export { pluginHome }

export function cachePath() {
  return path.join(pluginHome(), 'zh-cache.json')
}

export function loadZh() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8').replace(/^\uFEFF/, '')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function saveZh(all) {
  fs.writeFileSync(cachePath(), JSON.stringify(all, null, 2) + '\n', 'utf8')
}

export function getZh(name) {
  const value = loadZh()[name]
  return typeof value === 'string' ? value.trim() : ''
}

export function setZh(name, text) {
  const all = loadZh()
  all[name] = String(text || '').trim()
  saveZh(all)
  return all[name]
}

export function hasZh(name) {
  return Boolean(getZh(name))
}
