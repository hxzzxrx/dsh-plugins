# dsh-plugins ｜ DSH 控制台

一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的网页控制台。侧栏「插件管理」进入，地址 `/dsh-plugins`。

它把几件零散的事收进一个页面：

- **插件**：查看、启停、删除、回收站、体检、报错日志、更新检查、中文简介
- **会话**：列出本机所有会话（编号 / 状态 / 目录），可改名、停止、归档
- **系统**：Node 版本、内存、CPU、端口、运行时长
- **任务**：发布任务、指派主管、拆分、追加、群聊讨论
- **记忆**：浏览归档卷、全文检索、一键归档当前对话
- **设置**：保留天数、两个目录、两个自动开关

> 它只改 profile 的 `package.json` 和 `node_modules`。**启用 / 停用 / 删除后都要重启 DSH 才生效**（会话改名不用，立刻生效）。

---

## 安装

没有 npm 发布，手动装。你需要先知道你的 profile 在哪：

```
<DSH_HOME>/profiles/desktop/package.json
```

Windows 上 `DSH_HOME` 通常是 `%USERPROFILE%\.dsh`。

### 1. 放代码

把整个目录放到你的工作区：

```
<你的工作区>/plugins/dsh-plugins/
```

目录名要和 `package.json` 里的 `name` 一致（本包是 `dsh-plugins`）。

### 2. 登记依赖

编辑 profile 的 `package.json`，在 `dependencies` 里加：

```json
"dsh-plugins": "link:D:\\你的工作区\\plugins\\dsh-plugins"
```

### 3. 建链接

在 profile 目录下执行（cmd）：

```bat
mklink /J "node_modules\dsh-plugins" "D:\你的工作区\plugins\dsh-plugins"
```

PowerShell 等价写法：

```powershell
New-Item -ItemType Junction -Path "node_modules\dsh-plugins" -Target "D:\你的工作区\plugins\dsh-plugins"
```

### 4. 加入加载清单

同一个 `package.json`，在 `dsh.profile.bundles` 末尾追加：

```json
"dsh-plugins"
```

### 5. 重启 DSH

侧栏出现「插件管理」就成功了。

> ⚠️ 改 `package.json` 请用编辑器，别用 Windows PowerShell 的 `ConvertTo-Json | Out-File`——它会写入 BOM，DSH 启动时 `JSON.parse` 直接报 `Unexpected token '﻿'`，宿主起不来。

---

## 第一次用：定规矩

这个插件会自动读一份**常驻规则**文件，每次组装提示词都注入（体积有 6000 字符上限）。默认路径：

```
<记忆目录>/rules.md
```

自己新建它，写你想让 AI 一直记住的事，比如「东西放 D 盘」「回答用中文」「先读任务板再动手」。格式随意，markdown 就行。

> 早期版本用的文件名是 `Hello World.md`。如果它存在且 `rules.md` 不存在，会自动读它——不用改名。

**记忆目录**默认 `<DSH_HOME>/memory`，**协作目录**默认 `<DSH_HOME>/work`，都可以在「设置」标签里改，改完立刻生效。

---

## 数据都在哪

| 内容 | 位置 |
|---|---|
| 配置 | `<DSH_HOME>/dsh-plugins/config.json` |
| 中文简介缓存 | `<DSH_HOME>/dsh-plugins/zh-cache.json` |
| 待翻译列表 | `<DSH_HOME>/dsh-plugins/pending.json` |
| 回收站 | `<DSH_HOME>/dsh-plugins/trash/<名字>__<时间>/` |
| 任务板 | `<协作目录>/tasks.json`（同时生成 `TASKS.md` 快照） |
| 人设卡 | `<协作目录>/personas.json`（同时生成 `PERSONAS.md`） |
| 记忆卷 / 索引 | `<记忆目录>/archive-*.md`、`index.sqlite` |

删除插件只会动 profile 的清单和 `node_modules` 里的链接，**不会删你的源码目录**。

---

## 几个需要知道的行为

**停用 ≠ 卸载**。停用只是从 `dsh.profile.bundles` 里摘掉，依赖和链接都还在，随时能开回来；删除才会摘依赖和链接。

**删除 npm 包会先进回收站**，可恢复、可彻底删除；删除 `link:` 包只删链接，源码保留。

**「关闭 DSH」会 taskkill 掉整个进程树**，未保存的会话内容会丢。勾选「清登录记录」时，关闭前会先把 `.credentials.yaml` 备份成 `.bak-login-<时间>`，然后只删 `client-connection/*` 与 `deepseek-account-platform/device` 两段——**API key 会保留**。

**体检的黄/红灯**：绿灯=依赖、入口、语法、日志四项都过；黄灯通常无害（宿主内置包解析不到、optional peer 没装）；红灯才需要处理。

**「工具」标签**列出所有插件注册的 AI 工具，方便排查「这个工具是谁提供的」。

---

## 可选依赖

这些功能在，但需要装对应插件才会真正工作：

| 功能 | 需要 |
|---|---|
| 「任务 → 群聊讨论」按钮 | `dsh-collab`（提供 `/dsh-group` 群聊页与 `group_*` 工具） |
| 「AI 翻译」/「AI 帮我装」 | 至少一个打开的会话（会消耗一轮对话） |

没装 `dsh-collab` 时，群聊按钮点开是空白 iframe，不影响其他功能。

---

## 常见问题

**Q: 重启后侧栏没有「插件管理」？**
A: 检查三处：`dependencies` 里有没有 `link:`、`node_modules` 里有没有 junction、`dsh.profile.bundles` 里有没有加名字。三个缺一个都不加载。

**Q: 页面卡在「读取中…」？**
A: 切换侧栏到别的面板再切回来（重建 iframe）通常就好。还不行就看 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 里的报错。

**Q: 改了插件代码要重启吗？**
A: 要。ESM 模块有缓存，不重启不生效。

**Q: 能不能不重启就改配置？**
A: 「设置」标签里的项改完立刻生效（每次读都重新读文件）；插件清单相关的必须重启。

---

## 开发

```
lib/
  index.js         插件入口：路由 + 工具注册
  client.js        客户端入口（侧栏 + 主面板 iframe）
  page.mjs         页面 HTML/CSS + 全部 HTTP 路由
  app.js           浏览器端逻辑（外链加载，改完刷新即可，不用重启）
  catalog.mjs      插件清单、启停、删除、回收站、更新检查、影响面
  install.mjs      本地插件安装（写 link + 建 junction）
  health.mjs       体检 + 日志扫描/归档
  tasks.mjs        任务板数据层
  personas.mjs     人设卡
  memory.mjs       记忆库读取 + 归档引擎单例
  memory-tools.mjs 5 个 memory_* 工具 + 目录注入 + 定时归档
  retention.mjs    任务/日志的保留期清理
  config.mjs       设置读写
  paths.mjs        所有路径推导（换机器只改这里）
  newp.mjs         新插件检测 + 给会话发消息
  zh.mjs           中文简介缓存
  machine-zh.mjs   离线词典机翻（兜底）
  archive/         归档引擎（store / archive / docs / render / export）
```

改 `app.js` 刷新页面即可；改其他 `.mjs` 需要重启 DSH。

## License

MIT
