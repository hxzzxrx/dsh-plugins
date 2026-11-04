# Changelog

## 0.2.6

- 新增「Token」视图：用量统计（输入未命中 / 缓存命中 / 输出 / 命中率）、估算成本、账户余额、按天条形图、按模型与会话聚合。
  数据来自本地 sessions/**/session.v4.jsonl.zstd 里的 usage 记录，全量扫描约 0.5 秒，结果缓存 60 秒。
- 余额走 GET https://api.deepseek.com/user/balance（用 .credentials.yaml 里的 API Key，不联网除了这一次请求）。
- 成本按 2025 牌价估算（输入未命中 ¥2 / 缓存命中 ¥0.5 / 输出 ¥8 每百万），实际以官方账单为准。

## 0.2.5 — 2026-11-04

两处小修，都是真机验证时暴露的。

- **修：`task_board` 等返回字符串的工具被宿主校验打回。**
  `textOutput.schema` 写的是 `{ type: 'object' }`，但 `task_board` 返回的是纯文本，于是宿主报
  `tool "task_board" returned invalid output: "value" must be an object`。
  现在 schema 放开成 `{}`（任意值），`render` 里对字符串走原样、对对象走 `JSON.stringify`。
  影响面：所有走 `textOutput` 的工具（plugin_install + 7 个 task_*）。
- **修：停用后再启用，插件被追加到 bundles 末尾，加载顺序变了。**
  现在停用时把原位置记进 `<DSH_HOME>/dsh-plugins/disabled-order.json`，启用时 `splice` 插回原位；位置失效（比如中间删了别的插件）才退回追加。
  实测往返：`a,b,c` → 停用 b → `a,c` → 启用 b → `a,b,c`。

## 0.2.4 — 2026-11-04

修一个致命 bug + 一个安全问题，两个都是别人实际安装时发现的。

- **修（严重）：`lib/index.js` 大括号错位，7 个 `task_*` 工具根本没注册上。**
  `if (ctx.tools…) {` 的闭合大括号提前落在了 `plugin_install` 之后，导致下面 `tool()` 全在作用域外调用，`apply()` 抛 `ReferenceError: tool is not defined` 后中断。
  表现：页面、路由都正常（它们在抛错之前就注册完了），但 AI 侧看不到 `task_board` / `task_claim` / `task_split` / `task_assign` / `task_done` / `task_comment` / `task_create`，任务板「让 AI 分工」那条链路等于没接上。
  修完实测：`apply()` 成功，注册 **13 个工具**（5 个 memory_* + plugin_install + 7 个 task_*）、28 条路由、3 个清理函数。
- **修（安全）：所有路由现在先过宿主的 `connection.requestRejection(req)`。**
  之前 28 条路由一条都没做检查，`/dsh-plugins/api/shutdown` 这类能结束进程、停用/删除插件的接口，本机任意进程都能调；浏览器里的任意网页用简单请求（`<img src="http://127.0.0.1:端口/dsh-plugins/api/shutdown">`）也能触发。
  现在每条路由都先问 DSH 的 Host/Origin 栅栏与登录 cookie，`undefined` 放行、`401/403` 直接结束响应且不进入 handler。拿不到 `connection` 服务时放行（避免宿主没这个服务时整页打不开）。
  实测四种情况：拒绝 → 403 且 handler 不执行；放行 → 正常；无服务 → 放行；`ctx.get` 抛错 → 放行。

## 0.2.3 — 2026-11-04

- 修：`/api/updates` 不再返回「远端版本 == 本地版本」的插件。之前升级过的包会一直挂在返回里（前端比一遍后不显示，但接口数据是脏的）。
- 实测：过滤前返回 4 项，过滤后只剩 2 个真正落后的皮肤包。

## 0.2.2 — 2026-11-04

- 修：点「升级」成功后，列表里仍显示「可更新 vX」——`upgradePlugin()` 现在会清掉更新检查缓存，让前端重新比对。
- 机制说明：更新检查有 5 分钟缓存，升级是后台跑 pnpm，两者原本互不相干；现在升级动作会主动作废缓存。

## 0.2.1 — 2026-11-04

三条之前「写了但没真跑过」的链路，这次在真实环境里各跑了一遍，结论是都能用，代码没改。

- **任务板自动流转**：发一个「必须拆」的任务，主管真的调了 `task_split`，拆成 2 个部分（各带 name 和 owner），拆完 003、004 立刻被叫醒（`running: true`）。另发一个「纯链路测试」的任务，主管判断「不需要拆」后直接 `task_done`，说明它也懂得不拆。
- **升级按钮**：对本机一个落后一个补丁版本的插件点了升级，`pnpm add <name>@latest --dir <profile>` 在后台跑完（21.6 秒，`Done`），`dependencies` 从 `0.1.211` 变成 `^0.1.212`；其余插件目录与链接没被破坏。
- **人设回归**：清空全部人设后，`personaLabel()` 退回纯编号、`personaBrief()` 返回空串，任务通知里不会再带出旧的人设。

## 0.2.0 — 2026-11-04

首个公开版本。相对最初「插件管理器」的形态，扩展成 6 个视图的控制台：

- **插件**：列表 / 启停 / 删除（进回收站）/ 体检 / 报错日志归档 / 更新检查 / 中文简介（缓存 + 机翻兜底）/ README 就地查看
- **会话**：编号、状态、目录；改名 / 停止 / 归档
- **系统**：Node、内存、CPU、端口、运行时长
- **任务**：发布、指定主管、主管拆分、改派、追加、群聊讨论（需 `dsh-collab`）
- **记忆**：归档卷浏览、全文检索、一键归档当前对话（内置归档引擎，无需额外插件）
- **设置**：保留天数、记忆/协作目录、两个自动化开关

路径全部改为按 `DSH_HOME` 推导，换机器不改代码。
