// dsh-plugins：插件管理器（侧栏入口 + GET /dsh-plugins + 安装工具）
import { pluginRoutes, withGuard } from './page.mjs'
import { startNewPluginWatch } from './newp.mjs'
import { installLocal } from './install.mjs'
import { loadHostDeps } from './hostdeps.mjs'
import { board, createTask, claimTask, splitTask, assignPart, doneTask, commentTask, getTask } from './tasks.mjs'
import { registerMemoryTools } from './memory-tools.mjs'
import { startRetention } from './retention.mjs'

export const name = 'plugins'
// 访问未 inject 的服务会抛错，必须在 inject 里声明
export const inject = ['webServer', 'agents', 'tools', 'systemPrompt', 'timer']

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

export function apply(ctx) {
  // 每条路由先过宿主的 Host/Origin 栅栏与登录鉴权（防 DNS rebinding / 跨站调用）
  const disposers = pluginRoutes(ctx).map((r) =>
    ctx.webServer.register({ ...r, handler: withGuard(ctx, r.handler) }),
  )
  const stopWatch = startNewPluginWatch(ctx)

  // 记忆引擎（从 dsh-session-archive 并入）：工具 + 目录注入 + 常驻规则 + 定时归档
  try {
    registerMemoryTools(ctx)
  } catch (err) {
    ctx.logger?.warn?.(`[plugins] 记忆引擎挂载失败: ${err?.message || err}`)
  }

  // 配置中心里两个"保留天数"开关的实际执行者
  try {
    const stopRetention = startRetention(ctx)
    disposers.push(stopRetention)
  } catch (err) {
    ctx.logger?.warn?.(`[plugins] 定期清理挂载失败: ${err?.message || err}`)
  }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const tool = (spec) =>
      ctx.tools.register(
        defineTool({
          ...spec,
          output: textOutput,
          async execute(args) {
            return safe(await spec.execute(args))
          },
        }),
      )

    tool({
      name: 'plugin_install',
      description:
        '把本地插件源码目录挂进 DSH：写 link 依赖、建 node_modules junction、加入 bundles 加载清单。\n'
        + '写好自己的插件、或把下载的插件解压到 plugins/<名字> 之后调用它，就不用手工改 profile。\n'
        + '装完需要用户重启 DSH 才生效（返回里会说）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: {
            type: 'string',
            description: '插件源码目录的绝对路径，比如 <你的工作区>\\plugins\\dsh-xxx',
          },
        },
        required: ['dir'],
      },
      execute(args) {
        return installLocal(args.dir)
      },
    })

    const taskList = () => {
      const b = board()
      const one = (t) =>
        t.id + ' [' + t.status + '] ' + t.title
        + (t.lead ? ' · 主管 ' + t.lead : '')
        + (t.assignee ? ' · 执行 ' + t.assignee : '')
        + (t.parts?.length ? '\n    ' + t.parts.map((p) => p.name + (p.owner ? '→' + p.owner : '') + (p.status === 'done' ? '✓' : '')).join(' | ') : '')
      const lines = []
      for (const k of ['open', 'active', 'done', 'blocked']) {
        const items = b.columns[k] || []
        if (!items.length) continue
        lines.push('## ' + k + ' (' + items.length + ')')
        lines.push(...items.map(one))
      }
      return lines.length ? lines.join('\n') : '任务板是空的。'
    }

    tool({
      name: 'task_board',
      description: '看任务板：所有任务的编号、状态、主管、执行者、拆分出来的部分。先看板再动手。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute() { return taskList() },
    })

    tool({
      name: 'task_claim',
      description: '认领任务成为主管（或改派主管）。认领后由你决定自己做还是拆分。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '任务编号，如 T-001' },
          lead: { type: 'string', description: '主管会话编号，如 001' },
          note: { type: 'string', description: '备注（可选）' },
        },
        required: ['id', 'lead'],
      },
      execute(args) { return claimTask(args.id, args.lead, args.note || '') },
    })

    tool({
      name: 'task_split',
      description: '把任务拆成几个部分，每部分指定一个负责的会话编号。拆完各部分独立推进。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '任务编号' },
          parts: {
            type: 'array',
            description: '部分列表，每项 {name, owner}，owner 是会话编号',
            items: {
              type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, owner: { type: 'string' } },
              required: ['name'],
            },
          },
          note: { type: 'string' },
        },
        required: ['id', 'parts'],
      },
      execute(args) { return splitTask(args.id, args.parts, args.note || '') },
    })

    tool({
      name: 'task_assign',
      description: '把某个已拆分的部分改派给另一个会话。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          part: { type: 'string', description: '部分名字（或 p1/p2）' },
          owner: { type: 'string', description: '新的负责会话编号' },
        },
        required: ['id', 'part', 'owner'],
      },
      execute(args) { return assignPart(args.id, args.part, args.owner) },
    })

    tool({
      name: 'task_done',
      description: '标记任务（或某个部分）完成。整单完成时不要传 part。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          part: { type: 'string', description: '只完成了某部分时填它的名字' },
          note: { type: 'string', description: '结果摘要' },
          by: { type: 'string', description: '你的会话编号' },
        },
        required: ['id'],
      },
      execute(args) { return doneTask(args.id, { part: args.part || '', note: args.note || '', by: args.by || '' }) },
    })

    tool({
      name: 'task_comment',
      description: '给任务留一句进展/发现（不改变状态）。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          by: { type: 'string', description: '你的会话编号' },
        },
        required: ['id', 'text'],
      },
      execute(args) { return commentTask(args.id, args.text, args.by || 'ai') },
    })

    tool({
      name: 'task_create',
      description: '自己往任务板发一条任务（也可指定主管/执行者）。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          brief: { type: 'string' },
          lead: { type: 'string' },
          assignee: { type: 'string' },
        },
        required: ['title'],
      },
      execute(args) { return createTask({ ...args, createdBy: 'ai' }) },
    })
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
    try {
      stopWatch()
    } catch {}
  })
}
