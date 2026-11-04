// dsh-plugins / machine-zh：英文 description 的本地"机翻"
//
// 不联网、不调模型、零 token：只做高频技术词替换 + 常见句式收敛。
// 产出质量有限，所以页面会标〔机翻〕，并优先使用人工写的简介。
const DICT = [
  [/\bDeepSeek Harness\b/g, 'DeepSeek Harness'],
  [/\bDeepSeek\b/g, 'DeepSeek'],
  [/\bswitch(es|ing)? between\b/gi, '在……之间切换'],
  [/\bswitch(es|ing)?\b/gi, '切换'],
  [/\bmanage(ment|r|s)?\b/gi, '管理'],
  [/\bconfig(uration|ure)?\b/gi, '配置'],
  [/\bsetting(s)?\b/gi, '设置'],
  [/\bplugin(s)?\b/gi, '插件'],
  [/\bclient\b/gi, '客户端'],
  [/\bskin(s)?\b/gi, '皮肤'],
  [/\btheme(s)?\b/gi, '主题'],
  [/\blayout\b/gi, '布局'],
  [/\bsidebar\b/gi, '侧栏'],
  [/\bpanel(s)?\b/gi, '面板'],
  [/\bwidget(s)?\b/gi, '挂件'],
  [/\bcontext\b/gi, '上下文'],
  [/\bcompress(ion|es|ed)?\b/gi, '压缩'],
  [/\btoken(s)?\b/gi, 'token'],
  [/\bsession(s)?\b/gi, '会话'],
  [/\barchive(s|d)?\b/gi, '归档'],
  [/\bmemory\b/gi, '记忆'],
  [/\bsearch(es|ed)?\b/gi, '搜索'],
  [/\btool(s)?\b/gi, '工具'],
  [/\bagent(s)?\b/gi, '智能体'],
  [/\bmodel(s)?\b/gi, '模型'],
  [/\bprovider(s)?\b/gi, '提供方'],
  [/\bimage(s)?\b/gi, '图片'],
  [/\bvideo(s)?\b/gi, '视频'],
  [/\btranscri(be|ption|pt)\b/gi, '转写'],
  [/\bsubtitle(s)?\b/gi, '字幕'],
  [/\bcomment(s)?\b/gi, '评论'],
  [/\bnotif(y|ication|ications)\b/gi, '通知'],
  [/\bbalance\b/gi, '余额'],
  [/\bquota\b/gi, '配额'],
  [/\busage\b/gi, '用量'],
  [/\bcache(s|d)?\b/gi, '缓存'],
  [/\bprompt(s)?\b/gi, '提示词'],
  [/\bworkspace(s)?\b/gi, '工作区'],
  [/\bfile(s)?\b/gi, '文件'],
  [/\bfolder(s)?\b/gi, '文件夹'],
  [/\brender(s|ed|ing)?\b/gi, '渲染'],
  [/\bdisplay(s|ed)?\b/gi, '显示'],
  [/\binstall(ed|s|ing)?\b/gi, '安装'],
  [/\buninstall(ed|s|ing)?\b/gi, '卸载'],
  [/\benable(s|d)?\b/gi, '启用'],
  [/\bdisable(s|d)?\b/gi, '停用'],
  [/\bautomatically\b/gi, '自动'],
  [/\bschedule(s|d)?\b/gi, '定时'],
  [/\bdaily\b/gi, '每天'],
  [/\bweekly\b/gi, '每周'],
  [/\breport(s)?\b/gi, '报告'],
  [/\bsummary\b/gi, '摘要'],
  [/\banaly(ze|sis|ses)\b/gi, '分析'],
  [/\bdetect(s|ed|ion)?\b/gi, '检测'],
  [/\bsupport(s|ed)?\b/gi, '支持'],
  [/\bcustom(ize|ized|ization)?\b/gi, '自定义'],
  [/\boption(s)?\b/gi, '选项'],
  [/\badd(s|ed|ing)?\b/gi, '添加'],
  [/\bremove(s|d)?\b/gi, '移除'],
  [/\blist(s|ed)?\b/gi, '列表'],
  [/\bview(s|ed)?\b/gi, '查看'],
  [/\bopen(s|ed|ing)?\b/gi, '打开'],
  [/\bexport(s|ed)?\b/gi, '导出'],
  [/\bimport(s|ed)?\b/gi, '导入'],
  [/\bdata\b/gi, '数据'],
  [/\bfind it under\b/gi, '入口位于'],
  [/\bunder Settings\b/gi, '在设置里'],
]

export function machineZh(text) {
  const source = String(text || '').trim()
  if (!source) return ''
  let out = source
  let hits = 0
  for (const [re, zh] of DICT) {
    if (re.test(out)) {
      hits += 1
      out = out.replace(re, zh)
    }
  }
  out = out.replace(/\s+/g, ' ').trim()
  // 命中太少说明这段文本以专有名词为主，翻了也不像中文，不如保留原文
  if (hits < 3) return ''
  return out
}
