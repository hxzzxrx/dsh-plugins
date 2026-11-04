// dsh-plugins / install：把本地插件目录挂进 DSH（link 安装）
//
// 手工装一个本地插件原本四步：改 dependencies、加 bundles、建 junction、重启。
// 这里把前三步封装起来，给 AI 提供一个工具，也给页面留一个接口。
import fs from 'node:fs'
import path from 'node:path'

import { profileDir } from './catalog.mjs'

const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/
const HOST_BUILTIN = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * 把 dir 这个本地插件源码目录挂进 profile。
 * @param {string} dirInput 插件目录（绝对路径，或相对插件管理器所在工作区）
 */
export function installLocal(dirInput) {
  const raw = String(dirInput || '').trim()
  if (!raw) throw new Error('缺少插件目录')
  const dir = path.resolve(raw)
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir)

  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) throw new Error('这个目录里没有 package.json，不像一个插件包')

  let meta
  try {
    meta = readJson(pkgFile)
  } catch (err) {
    throw new Error('package.json 解析失败：' + String(err?.message || err))
  }

  const name = String(meta.name || '').trim()
  if (!name || !NAME_RE.test(name)) throw new Error('package.json 的 name 不是合法包名：' + JSON.stringify(name))
  if (HOST_BUILTIN.has(name)) throw new Error(name + ' 是宿主内置包，不能 link')
  if (!meta.main && !meta.exports) throw new Error('插件 ' + name + ' 没写 main / exports，宿主找不到入口')

  const profile = profileDir()
  const profilePkgFile = path.join(profile, 'package.json')
  const pkg = readJson(profilePkgFile)
  pkg.dependencies ??= {}
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []

  const existed = Boolean(pkg.dependencies[name])
  pkg.dependencies[name] = 'link:' + dir
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
  writeJson(profilePkgFile, pkg)

  // node_modules 里的 junction（指向源码目录，改代码重启即生效）
  const target = path.join(profile, 'node_modules', name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let replaced = false
  try {
    const st = fs.lstatSync(target)
    if (st.isSymbolicLink() || st.isJunction?.()) {
      fs.unlinkSync(target)
      replaced = true
    } else {
      throw new Error('node_modules 里已存在同名真实目录，先手动删掉：' + target)
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  fs.symlinkSync(dir, target, 'junction')

  return {
    ok: true,
    name,
    dir,
    replacedExisting: existed,
    restartRequired: true,
    message: `已把 ${name} 挂进 profile，重启 DeepSeek Harness 后生效`,
  }
}

/** 校验一个目录，但不改配置（页面上的"预检"）。 */
export function inspectLocal(dirInput) {
  const dir = path.resolve(String(dirInput || '').trim())
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir)
  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) throw new Error('没有 package.json')
  const meta = readJson(pkgFile)
  return {
    dir,
    name: String(meta.name || ''),
    version: String(meta.version || ''),
    description: String(meta.description || ''),
    entry: meta.main || meta.exports ? '有' : '缺',
  }
}
