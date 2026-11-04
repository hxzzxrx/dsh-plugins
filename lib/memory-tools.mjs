// 记忆引擎的 AI 侧接线：从 dsh-session-archive 搬进来。
//
// 提供：
//   工具  memory_search / memory_relate / memory_decisions / memory_sync / memory_export
//   提示词 每次组装注入一段归档目录（≈200 token）
//   提示词 常驻规则（memory\rules.md）
//   定时  每 3 分钟把新消息增量归档一次

import fs from 'node:fs'
import path from 'node:path'

import { memoryDir, rulesName, getStore, syncMemory } from './memory.mjs'
import { zipDirectory } from './archive/export.mjs'

const RULES_MAX = 6000

function textOut(schema) {
  return {
    schema,
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }
}

function readRules() {
  const file = path.join(memoryDir(), rulesName())
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return { file, body: '' }
    if (raw.length <= RULES_MAX) return { file, body: raw }
    return {
      file,
      body:
        raw.slice(0, RULES_MAX) +
        `\n\n（规则文档超过 ${RULES_MAX} 字符，后续内容已截断；完整内容请用 read 或 memory_search 查看。）`,
    }
  } catch {
    return { file, body: '' }
  }
}

function renderRulesBlock() {
  const { file, body } = readRules()
  if (!body) return ''
  return [
    '以下是用户为本机指定的常驻规则（长期有效，优先于一般偏好）：',
    '',
    body,
    '',
    '（以上规则来自 memory\\' + path.basename(file) + '，由用户维护。）',
  ].join('\n')
}

function catalogText() {
  let s
  try {
    s = getStore().stats()
  } catch {
    return ''
  }
  if (!s.messages) {
    return '【长期记忆】memory 已启用但尚无归档（只从本次之后积累）。可调用 memory_sync 归档当前会话。'
  }
  const docLine =
    s.docs && s.docs.files
      ? `- 另有 ${s.docs.files} 份用户文档（${s.docs.chunks} 段）已收录，memory_search 会一并返回，标 source=doc。`
      : '- 用户尚未在 memory\\ 放入文档。'
  return [
    '【长期记忆】以下历史会话已归档，可按需检索（不要把它们当作当前对话的上下文）：',
    `- 归档规模：${s.sessions} 个会话 / ${s.messages} 条消息 / 当前卷 ${s.currentVolume}`,
    docLine,
    '- 用法：需要历史细节时调用 memory_search（关键词）或 memory_relate（查有没有聊过）；',
    '  问「这事以前怎么定的」用 memory_decisions，它会给出先后顺序；',
    '  引用历史结论时必须写明出处（会话 id + #seq + 时间），无法检索到时不要臆测。',
  ].join('\n')
}

/**
 * 在插件 apply 里调用。ctx 需要 inject 了 tools / systemPrompt / timer。
 * 返回清理函数（一般不用，插件卸载时 cordis 自己收）。
 */
export function registerMemoryTools(ctx) {
  const store = getStore()
  const disposers = []

  const reg = (spec) => {
    try {
      disposers.push(ctx.tools.register(spec))
    } catch (err) {
      ctx.logger?.warn?.(`[memory] 注册工具 ${spec.name} 失败: ${err?.message || err}`)
    }
  }

  reg({
    name: 'memory_search',
    description:
      '在长期记忆（历史会话存档）中检索关键词，返回带出处的原文片段。每条结果包含会话 id、事件序号 seq、时间和标题，可用于引用溯源。适合回答"上次说过什么""之前的结论是什么"。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或短语；中文按连续子串匹配' },
        limit: { type: 'integer', description: '最多返回条数，默认 8', minimum: 1, maximum: 30 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOut({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        docs: { type: 'array', items: { type: 'object' } },
        error: { type: 'string' },
      },
    }),
    execute: async (args) => {
      const q = String(args?.query ?? '').trim()
      if (!q) return { items: [], error: 'query 为空' }
      return store.search(q, Math.min(Number(args?.limit) || 8, 30))
    },
  })

  reg({
    name: 'memory_relate',
    description:
      '"我们聊过这个吗"：按会话聚合检索命中，返回聊过相关话题的会话列表（命中次数、时间、标题）。适合用户提出新问题时先判断有没有历史上下文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '话题关键词' },
        limit: { type: 'integer', description: '最多返回会话数，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOut({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } }, error: { type: 'string' } },
    }),
    execute: async (args) => {
      const q = String(args?.query ?? '').trim()
      if (!q) return { items: [], error: 'query 为空' }
      return store.relate(q, Math.min(Number(args?.limit) || 5, 20))
    },
  })

  reg({
    name: 'memory_decisions',
    description:
      '查看「决定链」：把同一主题先后做出的决定按时间串起来，并标注较早的那条后面是否还有更新的同主题决定。只呈现时间顺序，不判定哪条正确——引用时请把两条的时间和出处都写出来，让用户自己裁决。局限：只对用词相近的决定可靠；若换成不同专有名词（如 SQLite→PostgreSQL），只能给出「同类型」弱提示，需人工判断。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '可选：只看与该主题相关的决定' },
        limit: { type: 'integer', description: '最多返回条数，默认 10' },
      },
      additionalProperties: false,
    },
    output: textOut({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } },
    }),
    execute: async (args) =>
      store.decisions({ topic: args?.topic, limit: Math.min(Number(args?.limit) || 10, 50) }),
  })

  reg({
    name: 'memory_sync',
    description:
      '把尚未归档的会话消息增量写入长期记忆（串行化 + 原子追加）。通常在会话结束或需要前手动调用一次。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOut({ type: 'object', properties: { sessions: { type: 'integer' }, messages: { type: 'integer' } } }),
    timeoutMs: 120000,
    execute: async () => syncMemory(),
  })

  reg({
    name: 'memory_export',
    description: '把整个长期记忆目录（卷文件 + 索引 + 元数据）打包成一个 zip，用于迁移或备份到别处。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '输出 zip 的绝对路径；省略则写到 memory 目录内' } },
      additionalProperties: false,
    },
    output: textOut({ type: 'object', properties: { file: { type: 'string' }, bytes: { type: 'integer' } } }),
    timeoutMs: 120000,
    execute: async (args) => {
      const out = args?.path || path.join(memoryDir(), `memory-export-${Date.now()}.zip`)
      return zipDirectory(memoryDir(), out)
    },
  })

  // 开场目录（每次组装都读一遍 stats，降级为空）
  if (ctx.systemPrompt?.context) {
    ctx.effect(() =>
      ctx.systemPrompt.context({ name: 'memory_catalog', order: 150, text: () => catalogText() }),
    )
  }

  // 常驻规则：用户改完保存即生效，不需要重启
  if (ctx.systemPrompt?.section) {
    ctx.effect(() =>
      ctx.systemPrompt.section({ name: 'memory_rules', order: 850, text: () => renderRulesBlock() }),
    )
  }

  // 每 3 分钟自动归档一次；写入层自带文件锁，多会话并行也安全
  if (ctx.timer?.interval) {
    let syncing = false
    ctx.effect(() =>
      ctx.timer.interval(async () => {
        if (syncing) return
        syncing = true
        try {
          const r = await syncMemory()
          if (r.messages > 0) ctx.logger?.info?.(`[memory] 归档 ${r.messages} 条消息`)
        } catch (err) {
          ctx.logger?.warn?.(`[memory] 自动归档失败: ${err?.message || err}`)
        } finally {
          syncing = false
        }
      }, 180_000),
    )
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
  })
}
