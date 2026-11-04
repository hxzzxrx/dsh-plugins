// 把会话数据渲染成一个自包含的 HTML 页面：左侧索引 + 全文搜索 + 右侧阅读。
// 不依赖任何外部资源，也不依赖前端框架——插件注入的按钮只是把它装进一个浮层。

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const CSS = `
*{box-sizing:border-box}
:root{
  --bg:#0f1115;--bg2:#151922;--bg3:#1b2029;--fg:#e6e9ef;--dim:#9aa3b2;
  --line:#252b36;--accent:#4f8cff;--user:#2b3a55;--user-fg:#dbe7ff;
  --mark:#7a5c00;--mark-fg:#ffe9a8;
  --font:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,Consolas,"Cascadia Mono",monospace;
}
@media (prefers-color-scheme: light){
  :root{--bg:#fbfbfd;--bg2:#f2f4f8;--bg3:#e8ecf3;--fg:#1b2029;--dim:#5b6472;
    --line:#dde2ea;--accent:#2563eb;--user:#e3edff;--user-fg:#12305f;
    --mark:#ffe9a8;--mark-fg:#4a3a00;}
}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font-family:var(--font);font-size:14px;line-height:1.65}
#app{display:flex;height:100%}
/* 左侧索引 */
aside{width:330px;min-width:330px;border-right:1px solid var(--line);background:var(--bg2);
  display:flex;flex-direction:column}
.aside-head{padding:14px 14px 10px;border-bottom:1px solid var(--line)}
.aside-title{font-size:15px;font-weight:600;margin:0 0 2px}
.aside-sub{color:var(--dim);font-size:12px;margin:0 0 10px}
input[type=search]{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);
  background:var(--bg);color:var(--fg);font-family:var(--font);font-size:13px;outline:none}
input[type=search]:focus{border-color:var(--accent)}
#list{overflow-y:auto;flex:1;padding:8px}
.item{padding:9px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:4px}
.item:hover{background:var(--bg3)}
.item.active{background:var(--bg3);border-color:var(--accent)}
.item-title{font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item-meta{color:var(--dim);font-size:11.5px;margin-top:3px;display:flex;gap:8px;white-space:nowrap;overflow:hidden}
/* 右侧正文 */
main{flex:1;display:flex;flex-direction:column;min-width:0}
.main-head{padding:12px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;
  background:var(--bg2);min-height:56px}
.main-head h1{font-size:15px;margin:0;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:var(--bg3);color:var(--fg);
  font-size:12.5px;cursor:pointer;font-family:var(--font);white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent)}
#doc{overflow-y:auto;flex:1;padding:22px 26px 80px;max-width:900px;width:100%}
.msg{margin-bottom:18px;display:flex;flex-direction:column;gap:5px}
.who{font-size:11.5px;color:var(--dim);font-weight:600;letter-spacing:.02em}
.bubble{padding:11px 14px;border-radius:10px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.user .bubble{background:var(--user);color:var(--user-fg)}
.assistant .bubble{background:var(--bg2);border:1px solid var(--line)}
.bubble code{font-family:var(--mono);font-size:12.5px;background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px}
mark{background:var(--mark);color:var(--mark-fg);border-radius:3px;padding:0 2px}
.empty{padding:40px;color:var(--dim);text-align:center}
.hit{color:var(--dim);font-size:12px;padding:6px 20px;background:var(--bg2);border-bottom:1px solid var(--line)}
`

const CLIENT_JS = String.raw`
const DATA = JSON.parse(document.getElementById('session-data').textContent);
const listEl = document.getElementById('list');
const docEl = document.getElementById('doc');
const titleEl = document.getElementById('doc-title');
const metaEl = document.getElementById('doc-meta');
const searchEl = document.getElementById('search');
let activeId = null;
let query = '';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function highlight(text, q){
  if (!q) return esc(text);
  const lower = text.toLowerCase(), lq = q.toLowerCase();
  let out = '', i = 0;
  while (true) {
    const at = lower.indexOf(lq, i);
    if (at < 0) { out += esc(text.slice(i)); break; }
    out += esc(text.slice(i, at)) + '<mark>' + esc(text.slice(at, at + lq.length)) + '</mark>';
    i = at + lq.length;
  }
  return out;
}

function sessionText(s){ return s.messages.map(m => m.text).join('\n'); }

function matches(s, q){
  if (!q) return true;
  const lq = q.toLowerCase();
  return s.title.toLowerCase().includes(lq) || sessionText(s).toLowerCase().includes(lq);
}

function renderList(){
  const q = query.trim();
  const items = DATA.filter(s => matches(s, q));
  listEl.innerHTML = '';
  if (!items.length) { listEl.innerHTML = '<div class="empty">没有匹配的会话</div>'; return; }
  for (const s of items){
    const el = document.createElement('div');
    el.className = 'item' + (s.id === activeId ? ' active' : '');
    const d = new Date(s.updatedAt);
    const pad = (n) => String(n).padStart(2,'0');
    el.innerHTML = '<div class="item-title">' + esc(s.title) + '</div>'
      + '<div class="item-meta"><span>' + d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
      + '</span><span>' + s.messageCount + ' 条</span></div>';
    el.onclick = () => open(s.id);
    listEl.appendChild(el);
  }
}

function open(id){
  activeId = id;
  renderList();
  const s = DATA.find(x => x.id === id);
  if (!s) return;
  titleEl.textContent = s.title;
  const d = new Date(s.createdAt);
  const pad = (n) => String(n).padStart(2,'0');
  metaEl.textContent = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + s.messageCount + ' 条 · ' + s.cwd;
  const q = query.trim();
  docEl.innerHTML = s.messages.map(m => {
    const who = m.role === 'user' ? '我' : 'DeepSeek';
    return '<div class="msg ' + m.role + '"><div class="who">' + who + '</div>'
      + '<div class="bubble">' + highlight(m.text, q) + '</div></div>';
  }).join('');
  docEl.scrollTop = 0;
}

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  renderList();
  if (activeId) open(activeId);
});

document.getElementById('export-one').onclick = () => {
  if (activeId) location.href = '/dsh-archive/word?id=' + encodeURIComponent(activeId);
};
document.getElementById('export-all').onclick = () => { location.href = '/dsh-archive/word'; };

renderList();
if (DATA.length) open(DATA[0].id);
`

export function renderHtml(sessions) {
  const payload = JSON.stringify(sessions).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>会话存档</title>
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <aside>
    <div class="aside-head">
      <p class="aside-title">会话存档</p>
      <p class="aside-sub">共 ${sessions.length} 个会话</p>
      <input id="search" type="search" placeholder="搜索标题或正文…" autocomplete="off">
    </div>
    <div id="list"></div>
  </aside>
  <main>
    <div class="main-head">
      <h1 id="doc-title">选择一个会话</h1>
      <button class="btn" id="export-one">导出当前为 Word</button>
      <button class="btn" id="export-all">全部导出 Word</button>
    </div>
    <div class="hit" id="doc-meta"></div>
    <div id="doc"><div class="empty">左侧选一个会话开始阅读</div></div>
  </main>
</div>
<script type="application/json" id="session-data">${payload}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`
}

export { fmtTime, esc }
