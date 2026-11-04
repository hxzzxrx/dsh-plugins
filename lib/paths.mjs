// 路径推导：所有"我这台机器在哪"的判断都集中在这里。
//
// 优先级：环境变量 > DSH 自家目录约定 > 系统默认。
// 这样同一份代码换台机器不用改。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH 的数据根目录，通常 ~/.dsh（本机可能是指到 D 盘的软链或独立目录） */
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.env.DSH_PROFILE_DIR) return path.dirname(path.dirname(process.env.DSH_PROFILE_DIR))
  return path.join(os.homedir(), '.dsh')
}

/** profile 目录：默认 <dsh>/profiles/desktop */
export function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return path.join(dshHome(), 'profiles', 'desktop')
}

/** 插件管理器自己的数据目录：<dsh>/dsh-plugins */
export function pluginHome() {
  const dir = path.join(dshHome(), 'dsh-plugins')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

/** 协作目录（任务板 / 人设卡）：默认 <dsh>/work */
export function workDir() {
  if (process.env.DSH_WORK_DIR) return process.env.DSH_WORK_DIR
  const dir = path.join(dshHome(), 'work')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

/** 记忆库目录：默认 <dsh>/memory */
export function defaultMemoryDir() {
  return path.join(dshHome(), 'memory')
}

/** 宿主自带 pnpm 的入口（升级插件时用）；找不到就退回 PATH 里的 pnpm */
export function pnpmJs() {
  const local = path.join(
    dshHome(),
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'pnpm',
    'bin',
    'pnpm.mjs',
  )
  return fs.existsSync(local) ? local : null
}

/** 凭证文件（"关闭时清登录记录"用） */
export function credentialsFile() {
  return path.join(dshHome(), '.credentials.yaml')
}

export function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
