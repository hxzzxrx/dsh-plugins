# 给 AI 的安装单

把下面整段复制发给对方的 DSH 会话（或任何能跑命令的 AI），它会自己装。

---

## 复制这段

```
帮我在本机安装 DSH 插件 dsh-plugins，装完验证。

仓库：https://github.com/hxzzxrx/dsh-plugins

步骤：

1) 先确定三个路径，打印出来确认：
   - DSH_HOME：环境变量 DSH_HOME，没设就默认 %USERPROFILE%\.dsh
   - profile 目录：<DSH_HOME>\profiles\desktop（里面有 package.json）
   - 你的工作区：当前会话的工作目录

2) 拿代码到 <工作区>\plugins\dsh-plugins：
   git clone https://github.com/hxzzxrx/dsh-plugins.git <工作区>\plugins\dsh-plugins
   没有 git 就用 GitHub 的 Download ZIP 解压后改名成 dsh-plugins。
   注意：目录名必须正好是 dsh-plugins（和 package.json 的 name 一致）。

3) 改 profile 的 package.json（<DSH_HOME>\profiles\desktop\package.json）：
   a. dependencies 里加： "dsh-plugins": "link:<工作区>\\plugins\\dsh-plugins"
   b. dsh.profile.bundles 数组末尾加字符串 "dsh-plugins"
   改完用 node -e "JSON.parse(require('fs').readFileSync(路径,'utf8'))" 验证能解析，
   并确认文件前三个字节不是 EF BB BF（不能有 BOM）。
   警告：不要用 PowerShell 的 ConvertTo-Json | Out-File 改这个文件，它会写 BOM，
   DSH 启动时 JSON.parse 会报 Unexpected token '﻿'，宿主起不来。

4) 在 profile 目录下建 junction（Windows 管理员或开发者模式）：
   cmd /c mklink /J "<profile>\node_modules\dsh-plugins" "<工作区>\plugins\dsh-plugins"

5) 重启 DSH（必须，ESM 模块有缓存），然后验证：
   - 侧栏出现「插件管理」
   - 打开 http://127.0.0.1:<端口>/dsh-plugins 返回 200
   - /dsh-plugins/api/list 返回 10 个左右的插件条目

如果哪一步失败，先告诉我具体报错，不要自己猜着跳过。
```

---

## 她自己会遇到的坑（可以先提醒她）

| 现象 | 原因 |
|---|---|
| 启动报 `Unexpected token '﻿'`，宿主起不来 | package.json 被写成 UTF-8 BOM，用编辑器改或 Node 写 `UTF8Encoding(false)` |
| 侧栏没出现「插件管理」 | 三处缺一：`dependencies` 的 `link:`、`node_modules` 的 junction、`bundles` 里的名字 |
| `mklink` 报「已存在」 | 先删旧链接：`[System.IO.Directory]::Delete($path,$false)`（`Remove-Item` 对 junction 会交互确认失败） |
| 页面一直「读取中…」 | 切换侧栏到别的面板再切回来重建 iframe |
| 插件列表里所有插件都是英文 | 中文简介是本地缓存，第一次要自己点「AI 翻译」，或者用内置词典机翻兜底 |

## 装完她能立刻做什么

- 「插件」标签：看她自己装了哪些、启停、体检、清日志
- 「会话」标签：给她自己的会话改名/停止/归档
- 「任务」标签：发布任务、指派主管、拆分、开群聊讨论
- 「记忆」标签：建 `rules.md` 定她自己的规矩，之后每次组装提示词都会读

## 一句提醒

这个插件会读写 `<DSH_HOME>/profiles/desktop/package.json`、`node_modules`，以及 `<DSH_HOME>/dsh-plugins/` 下的数据。装之前建议先备份 profile 的 package.json：

```
copy "<profile>\package.json" "<profile>\package.json.bak"
```
