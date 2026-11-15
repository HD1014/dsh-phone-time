// dsh-ai-phone —— 通话面板页
// 由插件宿主自己的 18770 端口直接吐出来（/phone/panel），所以：
//   · 独立窗口模式：window.open 打开这个小页面 → 真是另一个窗口，尺寸比主窗口小
//   · 浮窗模式：主界面里插一个 iframe 装载同一个页面 → 页面被拦截时的兜底，外观一致
// 两种模式都是这个页面，样式与状态渲染只维护一份。
// 页面和主窗口跨源，所以通信一律 postMessage，收消息时校验 __dshPhone 标记。

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>和 AI 打电话</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #2b2b33;
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }
  /* 窗口底板：柔和圆角浅色，粉→紫→蓝的雾面渐变，和主界面留一点边 */
  .win {
    box-sizing: border-box;
    height: 100%;
    margin: 0;
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background:
      radial-gradient(120% 70% at 10% 0%, rgba(255,214,228,.92), rgba(255,214,228,0) 58%),
      radial-gradient(110% 65% at 92% 6%, rgba(226,214,255,.92), rgba(226,214,255,0) 60%),
      radial-gradient(130% 80% at 50% 102%, rgba(206,230,255,.96), rgba(206,230,255,0) 68%),
      linear-gradient(180deg, #fdf4f8 0%, #f7f2ff 46%, #eef5ff 100%);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.6);
  }

  /* 上半区：头像 + 计时 + 状态 */
  .stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 18px 16px 6px;
  }

  /* 正中间的大圆形头像位：素材进来等比铺满、居中偏上裁切，不拉伸 */
  .ring {
    width: min(56vw, 34vh, 208px);
    height: min(56vw, 34vh, 208px);
    border-radius: 50%;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(140deg, #f7cfe6 0%, #dcd3ff 42%, #bfe3ff 100%);
    box-shadow: 0 14px 34px rgba(120,110,180,.2);
    transition: transform .35s ease, box-shadow .35s ease;
  }
  .ring[data-live="1"] {
    transform: scale(1.03);
    box-shadow: 0 18px 42px rgba(120,110,180,.3);
  }
  #avatar {
    width: 100%; height: 100%;
    object-fit: cover;
    object-position: center 22%;
    display: none;
  }
  #ring[data-has-img="1"] #avatar { display: block; }
  #letter {
    font-size: 44px;
    font-weight: 600;
    color: #fff;
    letter-spacing: 1px;
    text-shadow: 0 2px 6px rgba(120,110,180,.25);
  }
  #ring[data-has-img="1"] #letter { display: none; }
  .ring::after {
    content: "";
    position: absolute; inset: 0; border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.45);
    pointer-events: none;
  }

  /* 通话计时：原来黑长条的位置，改成一直滚动的时长 */
  .timer {
    font-size: 17px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 1px;
    color: rgba(43,43,51,.72);
  }

  .status {
    font-size: 14px;
    color: rgba(43,43,51,.62);
    min-height: 18px;
  }

  .heard {
    font-size: 13px;
    color: rgba(43,43,51,.5);
    max-width: 88%;
    text-align: center;
    line-height: 1.5;
    min-height: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .notice {
    position: absolute;
    left: 50%;
    bottom: 104px;
    transform: translateX(-50%);
    max-width: 86%;
    padding: 8px 14px;
    border-radius: 12px;
    background: rgba(43,43,51,.82);
    color: #fff;
    font-size: 12.5px;
    line-height: 1.45;
    text-align: center;
    opacity: 0;
    transition: opacity .25s ease;
    pointer-events: none;
  }
  .notice[data-on="1"] { opacity: 1; }

  /* 底部按钮组：麦克风 + 输入启停 放一起，最右是挂断 */
  .dock {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 8px 0 20px;
  }
  .btn {
    width: 58px; height: 58px;
    border-radius: 50%;
    border: 1px solid rgba(0,0,0,.06);
    background: rgba(255,255,255,.86);
    color: #3a3a44;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    box-shadow: 0 3px 10px rgba(120,110,180,.14);
    transition: background .18s ease, color .18s ease, transform .12s ease;
  }
  .btn:active { transform: scale(.95); }
  .btn[data-on="1"] { color: #fff; background: #e8474a; border-color: rgba(232,71,74,.6); }
  .btn[data-muted="1"] { color: #b0b0ba; background: rgba(255,255,255,.7); }
  .btn-hang { color: #e8474a; border-color: rgba(232,71,74,.35); }
  .btn-hang:hover { background: #ffe9e9; }
  .btn svg { display: block; }

  /* 输入启停：关闭时是一个白色圆钮（话筒+播放的复合小图标），
     开启交互时整颗变成红色方块，一眼能看出“正在收你的话” */
  #input[data-on="1"] { border-radius: 14px; }
  #input[data-on="1"] svg { display: none; }
  #input[data-on="1"] .cube { display: block; }
  .cube { display: none; width: 18px; height: 18px; background: #fff; border-radius: 4px; }

  @media (max-height: 420px) {
    .ring { width: min(50vw, 30vh, 150px); height: min(50vw, 30vh, 150px); }
    .dock { padding-bottom: 12px; }
  }
</style>
</head>
<body>
<div class="win">
  <div class="stage">
    <div class="ring" id="ring" data-has-img="0" data-live="0">
      <img id="avatar" alt="">
      <span id="letter">AI</span>
    </div>
    <div class="timer" id="timer">00:00</div>
    <div class="status" id="status">正在接通…</div>
    <div class="heard" id="heard"></div>
  </div>
  <div class="dock">
    <button class="btn" id="mic" type="button" aria-label="麦克风" data-muted="0">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/>
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path class="slash" d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:none"/>
      </svg>
    </button>
    <button class="btn" id="input" type="button" aria-label="开始输入" data-on="0">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path d="M8 6.5v11l9-5.5z" fill="currentColor"/>
      </svg>
      <span class="cube"></span>
    </button>
    <button class="btn btn-hang" id="hang" type="button" aria-label="挂断">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
    </button>
  </div>
  <div class="notice" id="notice"></div>
</div>
<script>
(function () {
  var state = {
    model: '',
    avatar: '',
    phase: 'idle',
    status: '正在接通…',
    heard: '',
    muted: false,
    inputOn: false,
    startedAt: 0,
    notice: ''
  }
  var noticeTimer = null

  function post(msg) {
    // 独立窗口走 opener，浮窗走 parent；两边都试一次，失败就算了
    try { if (window.opener) window.opener.postMessage(msg, '*') } catch (e) {}
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*') } catch (e) {}
  }

  var el = {
    ring: document.getElementById('ring'),
    avatar: document.getElementById('avatar'),
    letter: document.getElementById('letter'),
    timer: document.getElementById('timer'),
    status: document.getElementById('status'),
    heard: document.getElementById('heard'),
    notice: document.getElementById('notice'),
    mic: document.getElementById('mic'),
    input: document.getElementById('input'),
    hang: document.getElementById('hang')
  }

  function pad(n) { return n < 10 ? '0' + n : String(n) }

  function tickTimer() {
    if (!state.startedAt) { el.timer.textContent = '00:00'; return }
    var sec = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))
    var m = Math.floor(sec / 60)
    var s = sec % 60
    el.timer.textContent = pad(m) + ':' + pad(s)
  }

  function showNotice(text) {
    if (!text) return
    el.notice.textContent = text
    el.notice.setAttribute('data-on', '1')
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(function () {
      el.notice.setAttribute('data-on', '0')
    }, 4200)
  }

  function apply(next) {
    if (!next || typeof next !== 'object') return
    var prevNotice = state.notice
    state = next
    // 头像：有图就铺满圆框，没图就用首字母占位
    if (state.avatar) {
      if (el.avatar.getAttribute('src') !== state.avatar) el.avatar.setAttribute('src', state.avatar)
      el.ring.setAttribute('data-has-img', '1')
    } else {
      el.ring.setAttribute('data-has-img', '0')
      var raw = String(state.model || '').replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '')
      el.letter.textContent = raw === '' ? 'AI' : raw.slice(0, 1).toUpperCase()
    }
    el.avatar.onerror = function () {
      el.ring.setAttribute('data-has-img', '0')
    }
    // 状态 / 识别文字
    el.status.textContent = state.status || ''
    el.heard.textContent = state.heard || ''
    // 按钮状态
    el.mic.setAttribute('data-muted', state.muted ? '1' : '0')
    var slash = el.mic.querySelector('.slash')
    if (slash) slash.style.display = state.muted ? 'block' : 'none'
    el.input.setAttribute('data-on', state.inputOn ? '1' : '0')
    el.input.setAttribute('aria-label', state.inputOn ? '停止输入' : '开始输入')
    // 头像呼吸感：在听或在说的时候轻轻放大
    el.ring.setAttribute('data-live', state.phase === 'listening' || state.phase === 'speaking' ? '1' : '0')
    // 播报新提示
    if (state.notice && state.notice !== prevNotice) showNotice(state.notice)
    tickTimer()
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.__dshPhone !== 'state') return
    apply(data.state)
  })

  el.mic.addEventListener('click', function () { post({ __dshPhone: 'cmd', cmd: 'mute' }) })
  el.input.addEventListener('click', function () { post({ __dshPhone: 'cmd', cmd: 'input' }) })
  el.hang.addEventListener('click', function () { post({ __dshPhone: 'cmd', cmd: 'hangup' }) })

  // 键盘：Esc 也能挂断，省得去点
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') post({ __dshPhone: 'cmd', cmd: 'hangup' })
  })

  // 看门狗：8 秒还没收到主界面的任何状态，说明这个页面没被 DSH 接住
  // （常见于被系统浏览器打开、或窗口被拦住），直接提示，别一直停在“正在接通……”
  var gotState = false
  var applyInner = apply
  apply = function (next) {
    gotState = true
    applyInner(next)
  }
  setTimeout(function () {
    if (gotState !== true) {
      el.status.textContent = '没连上 DSH，请回到 DSH 窗口里再点一次电话'
      el.input.setAttribute('data-on', '0')
    }
  }, 8000)

  setInterval(tickTimer, 1000)
  tickTimer()
  post({ __dshPhone: 'ready' })
})()
</script>
</body>
</html>`

module.exports = PANEL_HTML
