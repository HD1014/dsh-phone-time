// dsh-ai-phone — 前端（主界面侧）
//
// 分工：
//   这里只做“控制器”——找当前模型、驱动 DSH 已装的录音输入插件、把识别结果自动发送、
//   盯着回复边出字边用火山 TTS 合成并播放；以及把状态推给通话窗口。
//   通话窗口是本插件在这一页里自己拼的悬浮小窗（可拖动 / 可缩放 / 最小化 / × 关闭），
//   永远待在 DSH 内部，绝不开到系统浏览器去。
//
// 强制规则（写死在链路里，不是配置项）：
//   · 通话推理模型 = 面板当前选中的模型：消息发在当前会话里，切换模型时窗口立刻换头像换声线；
//     每次发送前还会再读一次模型名，避免切换那一瞬间用错声音。
//   · 同一模型的所有档位共用一条声线、一张头像：宿主按模型名关键字（最长匹配）取配置，
//     DeepSeek-V4.1-Flash / -Flash Lite / -Max 全落到「DeepSeek」这一条。
//
// 音频在 …main 窗口播（同一台机器、同一个扬声器），通话窗口只负责显示与按钮。

window.__ModuleLoader__.load({
  id: 'dsh-ai-phone',
  factory: function (require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var PORTS = [18770, 18771, 18772, 18773]
    var port = null
    var BTN_ATTR = 'data-dsh-phone-entry'
    // DSH 新前端不给麦克风按钮写中文 aria-label，只能认图标：
    // microphone-outline 的 path 里有这段固定曲线，拿来当特征串。
    var MIC_SVG_MARK = '8.675C3.075 11.3'

    var PHONE_ICON =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M3.2 2.4c.5-.5 1.2-.5 1.7 0l1.6 1.6c.5.5.5 1.2 0 1.7l-.7.7c.4 1.1 1 2.1 1.9 3s1.9 1.5 3 1.9l.7-.7c.5-.5 1.2-.5 1.7 0l1.6 1.6c.5.5.5 1.2 0 1.7l-1.1 1.1c-.7.7-1.7.9-2.6.6-1.8-.7-3.4-1.7-4.7-3S3.5 8.8 2.8 7c-.3-.9-.1-1.9.6-2.6z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    // ---------------- 样式 ----------------
    // 通话窗口是独立小页面（宿主 /phone/panel），它的样式在 panel.js 里，一份维护两处复用；
    // 主界面这边只需要“入口按钮”，加上开不出独立窗时的浮窗 iframe。
    var CSS = [
      '/* dsh-ai-phone */',
      '.dsh-phone-entry {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  width: 24px; height: 24px; padding: 0; margin: 0 2px;',
      '  border: none; border-radius: 6px; background: transparent;',
      '  color: var(--dsw-alias-label-tertiary, rgba(0,0,0,.45));',
      '  cursor: pointer; flex: none; line-height: 1;',
      '}',
      '@media (hover: hover) { .dsh-phone-entry:hover { color: var(--dsw-alias-label-primary, #111); background: rgba(0,0,0,.06); } }',
      /* 悬浮通话窗：自己拼的浮层，永远待在 DSH 页面里，不跳出浏览器。
         交互按普通窗口来：标题栏拖动、右下角拖拽缩放、最小化、× 关闭。 */
      /* 悬浮通话窗：浅色玻璃小窗，配色取自 DSH 本体的浅色面板，不另起异色。
         交互按普通窗口做：标题栏拖动、右下角缩放、最小化、最大化、× 关闭。 */
      '.dsh-pw {',
      '  position: fixed; z-index: 2147482100; display: flex; flex-direction: column;',
      '  border-radius: 16px; overflow: hidden; border: 1px solid rgba(255,255,255,.62);',
      '  background: linear-gradient(168deg, rgba(255,255,255,.94) 0%, rgba(247,249,255,.92) 46%, rgba(238,244,255,.94) 100%);',
      '  -webkit-backdrop-filter: blur(30px) saturate(170%); backdrop-filter: blur(30px) saturate(170%);',
      '  box-shadow: 0 28px 70px rgba(20,24,50,.30), 0 2px 10px rgba(20,24,50,.10);',
      '  color: #2c2f3f; font-family: inherit; -webkit-user-select: none; user-select: none;',
  '  transition: opacity .22s ease, transform .22s ease, box-shadow .22s ease;',
      '}',
      '.dsh-pw[data-max="1"] { border-radius: 12px; }',
      '.dsh-pw[data-min="1"] { height: 36px !important; width: 240px !important; }',
      '.dsh-pw-mask { position: fixed; z-index: 9998; pointer-events: none; border-radius: 14px; background: rgba(247,248,251,.68); backdrop-filter: blur(18px) saturate(150%); -webkit-backdrop-filter: blur(18px) saturate(150%); transition: opacity .2s ease; }',
    '.dsh-pw-bar {',
      '  flex: none; height: 36px; display: flex; align-items: center; gap: 7px; padding: 0 6px 0 12px;',
      '  background: rgba(255,255,255,.62); border-bottom: 1px solid rgba(20,24,44,.08); cursor: move; color: #3c3f52;',
      '}',
      '.dsh-pw-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #34c759; animation: dshPwDot 2s ease-out infinite; }',
      '@keyframes dshPwDot { 0% { box-shadow: 0 0 0 0 rgba(52,199,89,.45); } 70% { box-shadow: 0 0 0 7px rgba(52,199,89,0); } 100% { box-shadow: 0 0 0 0 rgba(52,199,89,0); } }',
      '.dsh-pw-title { flex: 1 1 auto; font-size: 12px; font-weight: 500; opacity: .82; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }',
      '.dsh-pw-bar button {',
      '  flex: none; width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px; background: transparent;',
      '  color: #60606f; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;',
      '}',
      '.dsh-pw-bar button:hover { background: rgba(0,0,0,.08); }',
      '.dsh-pw-x:hover { background: #e5484d !important; color: #fff; }',
      '.dsh-pw-x:hover svg { stroke: #fff; }',
      '.dsh-pw-body { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }',
      '.dsh-pw-stage { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 8px 18px 2px; position: relative; min-height: 0; overflow: hidden; }',
      '.dsh-pw-glow { position: absolute; inset: -18% -8% 0; pointer-events: none;',
      '  background: radial-gradient(52% 44% at 50% 26%, rgba(150,170,255,.20), rgba(255,255,255,0) 72%);',
      '  animation: dshPwGlow 6s ease-in-out infinite; }',
      '@keyframes dshPwGlow { 0%,100% { opacity: .5; transform: scale(1); } 50% { opacity: .92; transform: scale(1.07); } }',
      '.dsh-pw-halo { position: relative; display: flex; align-items: center; justify-content: center; width: clamp(104px, 50%, 200px); flex: none; }',
      '.dsh-pw-halo::before { content: ""; position: absolute; left: 50%; top: 50%; width: 118%; aspect-ratio: 1 / 1; transform: translate(-50%,-50%);',
      '  border-radius: 50%; background: radial-gradient(closest-side, rgba(140,160,255,.28), rgba(140,160,255,0) 74%);',
      '  animation: dshPwBreath 3.8s ease-in-out infinite; pointer-events: none; }',
      '@keyframes dshPwBreath { 0%,100% { opacity: .45; transform: translate(-50%,-50%) scale(.93); } 50% { opacity: .9; transform: translate(-50%,-50%) scale(1.05); } }',
      '.dsh-pw-ring {',
      '  width: 100%; aspect-ratio: 1 / 1; border-radius: 50%; overflow: hidden; position: relative;',
      '  display: flex; align-items: center; justify-content: center; font-size: 38px; font-weight: 700; color: #8a91c2;',
      '  background: linear-gradient(150deg,#e7ecff,#edf3ff 52%,#f3ecff);',
      '  box-shadow: 0 12px 32px rgba(92,100,170,.16), inset 0 0 0 1px rgba(255,255,255,.9);',
      '}',
      '.dsh-pw-ring img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; -webkit-user-drag: none; }',
      '.dsh-pw-ring[data-drop="1"] { box-shadow: 0 0 0 3px rgba(96,126,255,.55), 0 12px 32px rgba(92,100,170,.22); }',
      '.dsh-pw-wave { display: flex; align-items: flex-end; justify-content: center; gap: 3px; height: 14px; opacity: .3; flex: none; }',
      '.dsh-pw-wave span { width: 3px; height: 4px; border-radius: 2px; background: #7d8bd8; }',
      '.dsh-pw-wave[data-on="1"] { opacity: 1; }',
      '.dsh-pw-wave[data-on="1"] span { animation: dshPwBar 1.15s ease-in-out infinite; }',
      '.dsh-pw-wave[data-on="1"] span:nth-child(2) { animation-delay: .14s; }',
      '.dsh-pw-wave[data-on="1"] span:nth-child(3) { animation-delay: .28s; }',
      '.dsh-pw-wave[data-on="1"] span:nth-child(4) { animation-delay: .42s; }',
      '.dsh-pw-wave[data-on="1"] span:nth-child(5) { animation-delay: .56s; }',
      '@keyframes dshPwBar { 0%,100% { height: 4px; } 50% { height: 14px; } }',
      '.dsh-pw[data-anim="out"] { opacity: 0; transform: scale(.94) translateY(8px); }',
      '.dsh-av-img { animation: dshAvIn .25s ease; }',
      '@keyframes dshAvIn { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }',
      '.dsh-pw-timer { font-size: 17px; font-weight: 500; letter-spacing: .1em; font-variant-numeric: tabular-nums; opacity: .8; }',
  '.dsh-pw-stats { margin-top: auto; padding: 2px 8px 0; font-size: 11px; line-height: 1.5; letter-spacing: .02em; opacity: .52; font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }',
      '.dsh-pw-status { font-size: 13px; opacity: .72; min-height: 19px; text-align: center; }',
      '.dsh-pw-reply { font-size: 13px; line-height: 1.62; text-align: center; max-width: 100%; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; opacity: .84; padding: 0 2px; }',
      '.dsh-pw-heard { font-size: 12px; opacity: .52; line-height: 1.5; text-align: center; max-width: 100%; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 32px; }',
      '.dsh-pw-notice { position: absolute; left: 12px; right: 12px; bottom: 4px; padding: 7px 12px; border-radius: 10px; background: rgba(24,26,40,.86); color: #fff; font-size: 12px; text-align: center; opacity: 0; transition: opacity .25s; pointer-events: none; }',
      '.dsh-pw-notice[data-on="1"] { opacity: 1; }',
      '.dsh-pw-dock { flex: none; display: flex; align-items: center; justify-content: center; gap: 16px; padding: 4px 16px 20px; }',
      '.dsh-pw-btn { width: 56px; height: 56px; padding: 0; border: 1px solid rgba(255,255,255,.7); border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.8); box-shadow: 0 6px 16px rgba(60,66,110,.13); color: #4a4f63; }',
      '.dsh-pw-btn:hover { background: #fff; }',
      '.dsh-pw-input[data-on="1"] { background: #e5484d !important; color: #fff; border-radius: 14px; border-color: #e5484d; }',
      '.dsh-pw-input[data-on="1"] .dsh-pw-ico { display: none; }',
      '.dsh-pw-input[data-on="1"] .dsh-pw-cube { display: block; }',
      '.dsh-pw-cube { display: none; width: 14px; height: 14px; border-radius: 3px; background: #fff; }',
      '.dsh-pw-mic[data-on="1"] { color: #b3b3c2; }',
      '.dsh-pw-hang { background: #e5484d; color: #fff; border-color: #e5484d; }',
      '.dsh-pw-hang:hover { background: #d13a3f; }',
      '.dsh-pw-hang svg { stroke: #fff; }',
      '.dsh-pw-grip { position: absolute; right: 3px; bottom: 3px; width: 18px; height: 18px; cursor: nwse-resize; background: linear-gradient(135deg, rgba(0,0,0,0) 46%, rgba(120,126,170,.45) 46%, rgba(120,126,170,.45) 54%, rgba(0,0,0,0) 54%); }',
      '.dsh-pw[data-max="1"] .dsh-pw-grip, .dsh-pw[data-min="1"] .dsh-pw-grip { display: none; }',
      /* DSH 切到深色主题时，小窗跟着换成深色玻璃，避免一块白板突兀 */
      '.dsh-pw[data-dark="1"] { background: linear-gradient(168deg, rgba(42,44,54,.94) 0%, rgba(35,37,47,.94) 46%, rgba(30,34,44,.94) 100%); border-color: rgba(255,255,255,.14); color: #e6e8f2; box-shadow: 0 28px 70px rgba(0,0,0,.46), 0 2px 10px rgba(0,0,0,.2); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-bar { background: rgba(255,255,255,.10); border-bottom-color: rgba(255,255,255,.10); color: #dfe2ee; }',
      '.dsh-pw[data-dark="1"] .dsh-pw-bar button { color: #c8cbd8; }',
      '.dsh-pw[data-dark="1"] .dsh-pw-bar button:hover { background: rgba(255,255,255,.14); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-glow { background: radial-gradient(52% 44% at 50% 26%, rgba(110,130,220,.22), rgba(0,0,0,0) 72%); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-halo::before { background: radial-gradient(closest-side, rgba(120,140,240,.30), rgba(120,140,240,0) 74%); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-ring { background: linear-gradient(150deg,#2f3550,#333a58 52%,#3a3350); color: #b9bede; box-shadow: 0 12px 32px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.12); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-btn { background: rgba(255,255,255,.10); border-color: rgba(255,255,255,.16); color: #e2e5f1; box-shadow: 0 6px 16px rgba(0,0,0,.28); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-btn:hover { background: rgba(255,255,255,.18); }',
      '.dsh-pw[data-dark="1"] .dsh-pw-wave span { background: #9aa6e8; }',
      '.dsh-pw[data-dark="1"] .dsh-pw-hang { background: #e5484d; border-color: #e5484d; color: #fff; }',
    ].join('\n')

    function injectCss() {
      var old = document.getElementById('dsh-ai-phone-style')
      if (old !== null) old.remove()
      var style = document.createElement('style')
      style.id = 'dsh-ai-phone-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---------------- 宿主接口 ----------------
    function baseUrl() {
      return 'http://127.0.0.1:' + (port === null ? PORTS[0] : port)
    }

    // 每一步的判定都往宿主日志里写一行，出问题时直接看 debug-日期.log
    function dbg(tag, detail) {
      try {
        fetch(baseUrl() + '/phone/debug', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: String(tag) + ' | ' + String(detail === undefined || detail === null ? '' : detail),
        }).catch(function () {
          /* 日志失败不影响功能 */
        })
      } catch (error) {
        /* 忽略 */
      }
    }

    function probe() {
      if (port !== null) return Promise.resolve(port)
      var chain = Promise.resolve(null)
      PORTS.forEach(function (candidate) {
        chain = chain.then(function (found) {
          if (found !== null) return found
          return fetch('http://127.0.0.1:' + candidate + '/phone/health', { cache: 'no-store' })
            .then(function (res) {
              return res.json()
            })
            .then(function (json) {
              if (json !== null && json.ok === true) {
                port = candidate
                return candidate
              }
              return null
            })
            .catch(function () {
              return null
            })
        })
      })
      return chain
    }

    var cfgCache = null
    function loadCfg() {
      return probe()
        .then(function () {
          return fetch(baseUrl() + '/phone/config', { cache: 'no-store' })
        })
        .then(function (res) {
          return res.json()
        })
        .then(function (json) {
          if (json !== null && json.ok === true) cfgCache = json
          return cfgCache
        })
        .catch(function () {
          return cfgCache
        })
    }
    function saveCfg(patch) {
      return fetch(baseUrl() + '/phone/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (res) {
          return res.json()
        })
        .then(function (json) {
          if (json !== null && json.ok === true) cfgCache = json
          return cfgCache
        })
        .catch(function () {
          return cfgCache
        })
    }

    // ---------------- 找界面元素 ----------------
    // 当前工作区的模型名：输入框附近那段文字，正则抓常见模型前缀。
    function currentModelName() {
      try {
        var area = findDraft()
        var node = area === null ? null : area
        var scope = node === null ? document.body : node
        for (var level = 0; level < 5 && scope !== null; level += 1) {
          var text = String(scope.textContent || '')
          var match = /(DeepSeek|GPT|Claude|Gemini|Kimi|GLM|Qwen|千问)[\w.\- ]{0,26}/.exec(text)
          if (match !== null) return match[0].trim()
          scope = scope.parentElement
        }
      } catch (error) {
        /* 抓不到就用空 */
      }
      return ''
    }

    function isUsableDraft(node) {
      if (node === null || node === undefined) return false
      if (isOurNode(node) === true) return false
      if (node.getBoundingClientRect === undefined) return false
      var rect = node.getBoundingClientRect()
      if (rect.width < 140 || rect.height < 18) return false
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false
      return true
    }

    var draftNodeCache = null
    var draftNodeAt = 0

    // 页面里不止一个可编辑区（隐藏的、设置页搜索框…），只取第一个会挑错，
    // 所以给候选打分：和发送按钮同容器 + 越靠页面底部 + 越宽 = 越像输入栏。
    function findDraft() {
      var now = Date.now()
      if (draftNodeCache !== null && now - draftNodeAt < 1500 && isUsableDraft(draftNodeCache) === true) return draftNodeCache
      var nodes = []
      var areas = document.querySelectorAll('textarea')
      for (var i = 0; i < areas.length; i += 1) nodes.push(areas[i])
      var edits = document.querySelectorAll('[contenteditable="true"]')
      for (var j = 0; j < edits.length; j += 1) nodes.push(edits[j])
      var send = typeof findSendButton === 'function' ? findSendButton() : null
      var best = null
      var bestScore = -1
      for (var k = 0; k < nodes.length; k += 1) {
        var node = nodes[k]
        if (isUsableDraft(node) !== true) continue
        var rect = node.getBoundingClientRect()
        var score = rect.width + (rect.height > 60 ? 2000 : 0) + Math.round(rect.bottom / 20)
        if (send !== null && send !== undefined) {
          var up = node.parentElement
          for (var lv = 0; lv < 6 && up !== null; lv += 1) {
            if (up.contains(send) === true) {
              score += 10000
              break
            }
            up = up.parentElement
          }
        }
        if (score > bestScore) {
          bestScore = score
          best = node
        }
      }
      draftNodeCache = best
      draftNodeAt = now
      return best
    }
    // 这个节点是不是我们通话小窗自己的（小窗里也有可编辑区/按钮，不能当成工作台的）
    function isOurNode(node) {
      try {
        if (node === null || node === undefined) return false
        if (node.closest === undefined) return false
        return node.closest('.dsh-pw') !== null
      } catch (error) {
        return false
      }
    }

    function draftText(node) {
      if (node === null) return ''
      var tag = String(node.tagName || '').toLowerCase()
      if (tag === 'textarea') return String(node.value || '')
      return String(node.textContent || '')
    }
    // 直接写值：textarea 走原生 setter + input/change；contenteditable 用浏览器自己的
    // 全选删除（真编辑命令，框架一定收到），再兜底改 textContent 并补一个 InputEvent。
    // DSH 的输入框是自研富文本（class 形如 GRgSLq_input），
    // 直接写 textContent / execCommand 都只是改了渲染层，编辑器下一帧会把文字恢复回来。
    // 它自己监听 keydown，所以必须走键盘路径（ctrl+A → Backspace）才真的删得掉。
    function hardClear(node) {
      if (node === null || node === undefined) return true
      try {
        if (String(node.tagName || '').toLowerCase() === 'textarea') {
          var desc0 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
          if (desc0 !== undefined && desc0.set !== undefined) desc0.set.call(node, '')
          else node.value = ''
          node.dispatchEvent(new Event('input', { bubbles: true }))
          node.dispatchEvent(new Event('change', { bubbles: true }))
          return String(node.value || '') === ''
        }
        // 先把焦点给编辑器：它只在有焦点时处理编辑操作
        try {
          node.focus({ preventScroll: true })
        } catch (error0) {
          try {
            node.focus()
          } catch (error1) {
            /* 无法聚焦也继续 */
          }
        }
        // 1) 让浏览器自己把编辑区内容全选（这是真 selection，编辑器能认）
        try {
          document.execCommand('selectAll', false, null)
        } catch (error2) {
          /* 老 API */
        }
        // 2) 按一次退格：编辑器监听 keydown，会走自己的删除逻辑
        try {
          node.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true })
          )
        } catch (error3) {
          /* 忽略 */
        }
        // 3) 富文本编辑器（Slate 这类）认的是 beforeinput，补一发
        try {
          node.dispatchEvent(
            new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })
          )
        } catch (error3b) {
          /* 忽略 */
        }
        // 4) 再补一次浏览器级删除
        try {
          document.execCommand('delete', false, null)
        } catch (error4) {
          /* 忽略 */
        }
        try {
          document.execCommand('insertText', false, '')
        } catch (error4b) {
          /* 忽略 */
        }
        // 4) 还不行就走“全选 + 退格”的键盘模拟
        try {
          node.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true, bubbles: true, cancelable: true })
          )
          node.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true })
          )
        } catch (error5) {
          /* 忽略 */
        }
        if (String(node.textContent || '') !== '') node.textContent = ''
        try {
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
        } catch (error6) {
          /* 忽略 */
        }
        var left = String(node.textContent || '').trim()
        if (left !== '') {
          dbg('hard-clear-left', left.slice(0, 30))
          window.setTimeout(function () {
            try {
              if (String(node.textContent || '').trim() === '') return
              try {
                node.focus({ preventScroll: true })
              } catch (error8) {
                /* 忽略 */
              }
              document.execCommand('selectAll', false, null)
              node.dispatchEvent(
                new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })
              )
              document.execCommand('delete', false, null)
              document.execCommand('insertText', false, '')
              if (String(node.textContent || '') !== '') node.textContent = ''
              var after = String(node.textContent || '').trim()
              dbg('hard-clear2', after === '' ? 'ok' : 'left:' + after.slice(0, 24))
            } catch (error9) {
              /* 忽略 */
            }
          }, 90)
        }
        return left === ''
      } catch (error) {
        return false
      }
    }

    function forceSetDraft(node, text) {
      if (node === null || node === undefined) return
      var value = text === undefined || text === null ? '' : String(text)
      try {
        if (value === '') {
          hardClear(node)
          return
        }
        var tag = String(node.tagName || '').toLowerCase()
        if (tag === 'textarea') {
          var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
          if (desc !== undefined && desc.set !== undefined) desc.set.call(node, value)
          else node.value = value
          node.dispatchEvent(new Event('input', { bubbles: true }))
          node.dispatchEvent(new Event('change', { bubbles: true }))
          return
        }
        try {
          node.focus()
          document.execCommand('selectAll', false, null)
          document.execCommand('delete', false, null)
        } catch (error) {
          /* 老 API 不可用就走兜底 */
        }
        if (value === '') {
          if (String(node.textContent || '') !== '') node.textContent = ''
        } else if (String(node.textContent || '') !== value) {
          node.textContent = value
        }
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      } catch (error) {
        /* 写不进去就算了，不影响通话 */
      }
    }

    // 把识别出来的字从输入框里抹掉：电话内容只留在小窗里，不往工作台草稿里堆。
    // keep 是“要保留的内容”（通话开始时用户自己写的草稿）。
    // 受控组件可能在下一帧把文字写回来，所以清完连查三次，回来一次抹一次。
    function clearDraft(node, keep) {
      if (node === null || node === undefined) return
      var rest = keep === undefined || keep === null ? '' : String(keep)
      forceSetDraft(node, rest)
      if (call.open !== true) return
      var delays = [50, 150, 320]
      for (var i = 0; i < delays.length; i += 1) {
        window.setTimeout(function () {
          if (call.open !== true) return
          var now = String(draftText(node) || '')
          if (now.trim() === rest.trim()) return
          dbg('clear-retry', String(now).slice(0, 40))
          forceSetDraft(node, rest)
        }, delays[i])
      }
    }

    // 兜底清扫：通话期间把页面下半部分（输入栏那一片）里冒出来的文字都清掉，
    // 这样就算 findDraft 选错了节点、或识别插件换了个写法，也不会把话留在工作台。
    function sweepDrafts(base) {
      if (call.open !== true) return
      // 只在「正在录你说话」那一小段里清扫。以前通话全程每 400ms 扫一遍页面下半部，
      // 用户开着设置页在别处打字，字会被一起清掉，还会被抢焦点。
      if (call.phase !== 'listening' && call.phase !== 'transcribing') return
      var keep = base === undefined ? String(call.baseDraft || '') : String(base)
      var active = document.activeElement
      if (active !== null && active !== undefined && active !== document.body) {
        var tag = String(active.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || active.isContentEditable === true) {
          // 焦点在别的输入框上：那是用户正在写的东西，不碰
          var areaNow = findDraft()
          if (active !== areaNow) return
        }
      }
      var area = findDraft()
      if (area === null || area === undefined) return
      var nodes = [area]
      var scope = area.parentElement
      for (var up = 0; up < 4 && scope !== null; up += 1) {
        var inner = scope.querySelectorAll('textarea, [contenteditable="true"]')
        for (var x = 0; x < inner.length; x += 1) {
          if (nodes.indexOf(inner[x]) < 0) nodes.push(inner[x])
        }
        scope = scope.parentElement
      }
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i]
        if (isOurNode(node) === true) continue
        var value = String(draftText(node) || '')
        if (value.trim() === '') continue
        if (keep !== '' && value.trim() === keep.trim()) continue
        dbg('sweep', String(value).slice(0, 40))
        forceSetDraft(node, keep)
      }
    }

    function findVoiceButton() {
      var fallback = null
      var svgs = document.querySelectorAll('svg')
      for (var i = 0; i < svgs.length; i += 1) {
        var svg = svgs[i]
        if (isOurNode(svg)) continue
        var svgHtml = String(svg.outerHTML || '')
        if (svgHtml.indexOf(MIC_SVG_MARK) < 0 && svgHtml.indexOf('microphone') < 0) continue
        var host = svg.closest('button') || svg.closest('[role="button"]') || svg.parentElement
        if (host === null || isOurNode(host)) continue
        if (host.hasAttribute !== undefined && host.hasAttribute(BTN_ATTR)) continue
        if (host.offsetParent === null) continue
        if (inComposer(host) === true) return host
        if (fallback === null) fallback = host
      }
      var buttons = document.querySelectorAll('button[aria-label], button[title]')
      for (var j = 0; j < buttons.length; j += 1) {
        if (isOurNode(buttons[j])) continue
        if (buttons[j].hasAttribute !== undefined && buttons[j].hasAttribute(BTN_ATTR)) continue
        var label = String(buttons[j].getAttribute('aria-label') || buttons[j].getAttribute('title') || '')
        if (/语音输入|开始录音|录音|麦克风|dictate|voice|record|mic/i.test(label)) {
          if (inComposer(buttons[j]) === true) return buttons[j]
          if (fallback === null) fallback = buttons[j]
        }
      }
      if (fallback !== null) return fallback
      // 最后兜底：发送键左边那几个图标按钮里挑一个（通常是麦克风）
      var send = findSendButton()
      if (send !== null && send.parentElement !== null) {
        var prev = send.previousElementSibling
        for (var k = 0; prev !== null && k < 3; k += 1) {
          if (isOurNode(prev) !== true) {
            var inner = String(prev.tagName || '').toLowerCase() === 'button' ? prev : prev.querySelector === undefined ? null : prev.querySelector('button')
            if (inner !== null && inner.offsetParent !== null) {
              if (inner.hasAttribute === undefined || inner.hasAttribute(BTN_ATTR) !== true) return inner
            }
          }
          prev = prev.previousElementSibling
        }
      }
      return null
    }
    // 只认明确是「停录音」的按钮：以前按「停止」两个字泛匹配，
    // 会把 DSH 的「停止生成」当成录音按钮点掉，挂电话时顺手掐断别的任务。
    function findMicStopButton() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i += 1) {
        var b = buttons[i]
        if (isOurNode(b)) continue
        if (b.hasAttribute !== undefined && b.hasAttribute(BTN_ATTR)) continue
        var label = String(b.getAttribute('aria-label') || '')
        if (
          label.indexOf('停止录音') < 0 &&
          label.indexOf('结束录音') < 0 &&
          label.indexOf('停止听写') < 0 &&
          label.indexOf('停止语音') < 0
        ) {
          continue
        }
        if (inComposer(b) === true) return b
      }
      return null
    }
    function findEmojiButton() {
      var buttons = document.querySelectorAll('button')
      for (var i = 0; i < buttons.length; i += 1) {
        var b = buttons[i]
        var label = String(b.getAttribute('aria-label') || b.getAttribute('title') || '')
        if (label.indexOf('表情') >= 0 || label.toLowerCase().indexOf('emoji') >= 0) return b
        var text = String(b.textContent || '').trim()
        try {
          if (text !== '' && text.length <= 4 && /^\p{Emoji_Presentation}+$/u.test(text)) return b
        } catch (error) {
          /* 老内核没有 unicode 属性写法 */
        }
      }
      // 兜底：输入栏里表情按钮一定在「图片生成」左边，找不到就取它的前一个按钮
      for (var j = 0; j < buttons.length; j += 1) {
        var genLabel = String(buttons[j].getAttribute('aria-label') || buttons[j].getAttribute('title') || '')
        if (genLabel.indexOf('图片生成') < 0 && genLabel.toLowerCase().indexOf('image gen') < 0) continue
        var prev = buttons[j].previousElementSibling
        if (prev === null) continue
        if (String(prev.tagName || '').toLowerCase() === 'button') return prev
        var inner = prev.querySelector === undefined ? null : prev.querySelector('button')
        if (inner !== null) return inner
      }
      return null
    }
    function findSendButton() {
      var buttons = document.querySelectorAll('button[aria-label], button[title]')
      for (var i = 0; i < buttons.length; i += 1) {
        var b = buttons[i]
        var label = String(b.getAttribute('aria-label') || b.getAttribute('title') || '')
        if (label.indexOf('发送') >= 0 && b.offsetParent !== null) return b
      }
      return null
    }

    // ---------------- 通话状态 ----------------
    // phase: idle（等你说）/ listening（在录）/ transcribing（识别中）/ thinking（等回复）/ speaking（在播报）
    var call = {
      open: false,
      phase: 'idle',
      model: '',
      ui: null,        // 通话小窗的 DOM 引用（标题/头像/计时/按钮都在里面）
      startedAt: 0,    // 开始通话的时间点，窗口按它自己跑计时，不用每帧推
      avatarSrc: '',
      heardText: '',
      notice: '',
      noticeAt: 0,
      muted: false,
      autoListen: true,   // 一段播完自动回到“等你说”
      timer: null,
      sendTimer: null,
      spokenLen: 0,
      lastReply: '',
      queue: [],
      audio: null,
      playing: false,
      replyText: '',   // 这一轮它说的话，显示在小窗里
      chatBuf: '',     // 已收到但还没送去合成的文本
      history: [],     // 这一场通话的上下文，只存在内存里，不进工作台
      callId: '',
      baseDraft: '',
      mask: null,
      heardFull: '',
      consumedText: '',
      lastTextAt: 0,   // 通话开始时输入框里原有的草稿，用来把用户的话和它分开
      busy: false,     // 这一轮还在出字
      seq: 0,          // 轮次编号：开新一轮就把上一轮的残留输出丢掉，避免两轮的话串在一起
      avatarErr: false, // 头像加载失败过：别每 400ms 又把破图显示回来
      sendIdle: 0,      // 识别监听空转计数，超时自己停掉，不在后台一直 30ms 轮询
    }

    var PHASE_TEXT = {
      idle: '你可以开始说话',
      listening: '正在听…',
      transcribing: '识别中…',
      thinking: '它正在想…',
      speaking: '正在回答…',
    }

    var sfxCtx = null
    function playSfx(kind) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext
        if (AC === undefined || AC === null) return
        if (sfxCtx === null) sfxCtx = new AC()
        if (sfxCtx.state === 'suspended') sfxCtx.resume()
        var t0 = sfxCtx.currentTime
        var notes = kind === 'open' ? [659.25, 987.77] : [987.77, 659.25]
        for (var i = 0; i < notes.length; i += 1) {
          var osc = sfxCtx.createOscillator()
          var gain = sfxCtx.createGain()
          osc.type = 'sine'
          osc.frequency.value = notes[i]
          var start = t0 + i * 0.07
          gain.gain.setValueAtTime(0.0001, start)
          gain.gain.exponentialRampToValueAtTime(0.045, start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13)
          osc.connect(gain)
          gain.connect(sfxCtx.destination)
          osc.start(start)
          osc.stop(start + 0.15)
        }
      } catch (error) { /* 音效失败不影响通话 */ }
    }

    function toast(text) {
      call.notice = String(text || '')
      call.noticeAt = Date.now()
      pushState()
      try {
        window.console.log('[dsh-ai-phone] ' + call.notice)
      } catch (error) {
        /* 忽略 */
      }
    }

    // 通话小窗就在当前页面里，状态直接写进 DOM，不走 postMessage、不跨源。
    // 提示语 4.2 秒后自动清掉。
    function pushState() {
      if (call.open !== true) return
      renderWindow()
    }

    // 老代码里到处在调 updateUI()，这里统一成“推一次状态”
    function updateUI() {
      pushState()
    }

    function setHeard(text) {
      call.heardText = String(text || '')
      pushState()
    }

    // ---------------- 头像 ----------------
    // 素材是用户下发的一张概念图，这里只把宿主读取地址交给通话窗口；
    // 圆形裁切在窗口 CSS 里做：object-fit: cover 等比铺满圆框、object-position 居中偏上取人脸，
    // 不拉伸、不变形；没配图时窗口显示模型名首字母占位。
    function paintAvatar() {
      if (call.model === '') {
        call.avatarSrc = ''
        pushState()
        return
      }
      call.avatarErr = false
      call.avatarSrc = baseUrl() + '/phone/avatar?model=' + encodeURIComponent(call.model)
      pushState()
    }

    // ---------------- 播放队列 ----------------
    function enqueue(url) {
      if (call.muted === true) return
      call.queue.push(baseUrl() + url)
      pumpQueue()
    }

    function pumpQueue() {
      if (call.playing === true) return
      if (call.queue.length === 0) {
        if (call.phase === 'speaking') {
          call.phase = 'idle'
          updateUI()
          if (call.autoListen === true && call.open === true) {
            window.setTimeout(function () {
              if (call.open === true && call.phase === 'idle') startListening()
            }, 700)
          }
        }
        return
      }
      var src = call.queue.shift()
      var audio = new Audio(src)
      call.audio = audio
      call.playing = true
      call.phase = 'speaking'
      updateUI()
      audio.onended = function () {
        call.playing = false
        call.audio = null
        pumpQueue()
      }
      audio.onerror = function () {
        call.playing = false
        call.audio = null
        toast('这一段音频没加载成功，继续下一段')
        pumpQueue()
      }
      var promise = audio.play()
      if (promise !== null && typeof promise.catch === 'function') {
        promise.catch(function () {
          call.playing = false
          call.audio = null
          toast('浏览器拦住了自动播放，点一下页面再拨一次')
          pumpQueue()
        })
      }
    }

    function stopPlayback() {
      call.queue.length = 0
      var audio = call.audio
      call.audio = null
      if (audio !== null) {
        try {
          // 先摘掉回调：清空 src 会触发一次 error，不解绑就会误报「音频没加载成功」
          audio.onended = null
          audio.onerror = null
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
        } catch (error) {
          /* 忽略 */
        }
      }
      call.playing = false
      if (port !== null) fetch(baseUrl() + '/phone/stop', { method: 'POST' }).catch(function () {})
    }

    // ---------------- 朗读：边出字边播 ----------------
    // DSH 的回复是流式的，这里每 400ms 读一次“最后一条回复”的文本，
    // 只取在句号/问号/换行处截断的完整句子送去合成，剩下的等下一轮，
    // 所以是边出字边播，而不是等整段结束。
    function lastReplyText() {
      try {
        var tails = document.querySelectorAll('[data-turn-tail]')
        if (tails.length === 0) return ''
        var tail = tails[tails.length - 1]
        var prev = tail.previousElementSibling
        var guard = 0
        while (prev !== null && guard < 12) {
          var text = String(prev.innerText || '').trim()
          if (text.length >= 2) {
            var area = findDraft()
            var typing = area === null ? '' : draftText(area).trim()
            if (typing !== '' && text === typing) return ''
            return text
          }
          prev = prev.previousElementSibling
          guard += 1
        }
      } catch (error) {
        /* 结构变了就这轮跳过 */
      }
      return ''
    }

    function speakChunk(text) {
      return fetch(baseUrl() + '/phone/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, model: call.model }),
      })
        .then(function (res) {
          if (res.ok !== true) throw new Error('HTTP ' + res.status)
          var reader = res.body === null || res.body === undefined ? null : res.body.getReader()
          if (reader === null) throw new Error('流式响应不可用')
          var decoder = new TextDecoder('utf-8')
          var buffer = ''
          function handleLine(line) {
            var piece = String(line).trim()
            if (piece === '') return
            var json = null
            try {
              json = JSON.parse(piece)
            } catch (error) {
              return /* 半行继续等 */
            }
            if (json === null || typeof json !== 'object') return
            if (typeof json.url === 'string') enqueue(json.url)
            else if (typeof json.error === 'string') toast('合成失败：' + json.error.slice(0, 80))
          }
          function step() {
            return reader.read().then(function (chunk) {
              if (chunk.done === true) {
                if (buffer !== '') handleLine(buffer)
                buffer = ''
                return null
              }
              buffer += decoder.decode(chunk.value, { stream: true })
              var lines = buffer.split('\n')
              buffer = lines.pop()
              lines.forEach(handleLine)
              return step()
            })
          }
          return step()
        })
        .catch(function (error) {
          toast('语音合成请求失败：' + String(error.message || error).slice(0, 80))
        })
    }

    function pollReply() {
      if (call.open !== true) return
      if (call.phase !== 'thinking' && call.phase !== 'speaking') return
      var text = lastReplyText()
      if (text === '' || text.length <= call.spokenLen) return
      if (text.indexOf(call.lastReply) === 0 || call.lastReply === '') call.lastReply = text
      var fresh = text.slice(call.spokenLen)
      var cut = -1
      for (var i = 0; i < fresh.length; i += 1) {
        if ('。！？!?；;\n'.indexOf(fresh[i]) >= 0) {
          cut = i
          break
        }
      }
      if (cut < 0) {
        // 没有完整的句子就先攒着；太长了就按逗号切，免得长时间没声音
        if (fresh.length < 40) return
        cut = fresh.lastIndexOf('，') >= 0 ? fresh.lastIndexOf('，') : fresh.length - 1
      }
      var chunk = fresh.slice(0, cut + 1).trim()
      call.spokenLen += cut + 1
      if (chunk === '') return
      call.phase = 'speaking'
      updateUI()
      speakChunk(chunk)
    }

    // ---------------- 电话专用推理（不进工作台的会话） ----------------
    // 认出来的话直接发给本机 18770 的 /phone/chat：宿主按“面板当前模型”
    // 找到 DSH 自己的 provider 和模型 id，直连模型推理。
    // 所以这通电话的内容只在小窗里，不会写进任何工作台对话。
    function askModel(text) {
      call.seq += 1
      var mySeq = call.seq
      dbg('ask', String(call.model) + ' | ' + String(text).slice(0, 60))
      // 新一轮统计清零：速度按最近 1.2 秒的增量算，用量以服务端 usage 为准
      call.stats = { startAt: Date.now(), tokens: 0, speed: 0, usage: null, marks: [] }
      call.phase = 'thinking'
      call.busy = true
      call.replyText = ''
      call.chatBuf = ''
      call.spokenLen = 0
      call.lastReply = ''
      updateUI()
      var body = {
        model: call.model,
        callId: call.callId,
        text: text,
        history: call.history.slice(-8),
      }
      fetch(baseUrl() + '/phone/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          if (res.ok !== true) {
            return res.text().then(function (raw) {
              var msg = raw
              try {
                var parsed = JSON.parse(raw)
                if (parsed !== null && typeof parsed.error === 'string') msg = parsed.error
              } catch (error) {
                /* 原样用 */
              }
              throw new Error(String(msg).slice(0, 120))
            })
          }
          var reader = res.body === null || res.body === undefined ? null : res.body.getReader()
          if (reader === null) throw new Error('流式响应不可用')
          var decoder = new TextDecoder('utf-8')
          var buffer = ''
          function handleLine(line) {
            var piece = String(line).trim()
            if (piece === '') return
            var json = null
            try {
              json = JSON.parse(piece)
            } catch (error) {
              return /* 半行继续等 */
            }
            if (json === null || typeof json !== 'object') return
            // usage 和 delta 分开判：有的中转把两者塞在同一行，用 else if 会把 usage 吞掉
            if (json.usage !== null && typeof json.usage === 'object') applyUsage(json.usage)
            if (typeof json.delta === 'string' && json.delta !== '') appendDelta(json.delta)
            else if (typeof json.error === 'string') toast('模型没接起来：' + json.error.slice(0, 90))
          }
          function step() {
            return reader.read().then(function (chunk) {
              if (chunk.done === true) {
                // 最后一行常常没有换行符，补处理一次，不然回复末尾会少字
                if (buffer !== '') handleLine(buffer)
                buffer = ''
                return null
              }
              // 已经开了下一轮：这一轮迟到的字直接丢掉，两轮的话不会串在一起
              if (call.seq !== mySeq) {
                try {
                  reader.cancel()
                } catch (error) {
                  /* 忽略 */
                }
                return null
              }
              buffer += decoder.decode(chunk.value, { stream: true })
              var lines = buffer.split('\n')
              buffer = lines.pop()
              lines.forEach(handleLine)
              return step()
            })
          }
          return step()
        })
        .then(function () {
          if (call.seq !== mySeq) return
          finishAnswer(text)
        })
        .catch(function (error) {
          if (call.seq !== mySeq) return
          call.busy = false
          toast('通话推理失败：' + String(error.message || error).slice(0, 100))
          call.phase = 'idle'
          updateUI()
        })
    }

    function appendDelta(delta) {
      call.replyText += delta
      call.chatBuf += delta
      if (call.stats !== null && call.stats !== undefined) {
        var tk = guessTokens(delta)
        var now = Date.now()
        call.stats.tokens += tk
        call.stats.marks.push({ t: now, n: tk })
        while (call.stats.marks.length > 0 && now - call.stats.marks[0].t > 1200) call.stats.marks.shift()
        var sum = 0
        for (var mi = 0; mi < call.stats.marks.length; mi += 1) sum += call.stats.marks[mi].n
        var span = call.stats.marks.length > 0 ? Math.max(0.6, (now - call.stats.marks[0].t) / 1000) : 1
        call.stats.speed = sum / span
      }
      flushSpeech()
      renderWindow()
    }

    // 没有 usage 的模型只能估：中文按 1 字 1 token，英文按 4 字符 1 token
    function guessTokens(text) {
      var cjk = 0
      var other = 0
      for (var i = 0; i < text.length; i += 1) {
        var code = text.charCodeAt(i)
        if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
        else other += 1
      }
      // 中文 1 字实际大约 1.2~1.6 个 token（DeepSeek / GPT 分词都差不多），英文 4 字符 1 个。
      // 以前按 0.6 估，小窗里的「本步」会只有实际的一半左右，看着像只有十几 token。
      return cjk * 1.5 + other / 4
    }

    function applyUsage(usage) {
      if (call.stats === null || call.stats === undefined) return
      call.stats.usage = usage
      if (typeof usage.completionTokens === 'number' && usage.completionTokens > 0) call.stats.tokens = usage.completionTokens
      renderWindow()
    }

    // 各家的上下文窗口不一样，只用来算“还剩多少”
    function contextWindow(name) {
      var low = String(name || '').toLowerCase()
      if (low.indexOf('claude') >= 0) return 200000
      if (low.indexOf('gemini') >= 0) return 1000000
      return 131072
    }

    function fmtTok(n) {
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
      return String(Math.max(0, Math.round(n)))
    }

    function statsLine() {
      var st = call.stats
      if (st === null || st === undefined || st.tokens <= 0) return ''
      var parts = []
      var sp = st.speed
      parts.push((sp >= 1000 ? (sp / 1000).toFixed(1) + 'k' : String(Math.round(sp))) + ' tok/s')
      parts.push('本步 ' + fmtTok(st.tokens))
      if (st.usage !== null && st.usage.cacheHitRate >= 0) parts.push('缓存 ' + Math.round(st.usage.cacheHitRate * 100) + '%')
      var used = 0
      if (st.usage !== null) {
        used = Number(st.usage.promptTokens || 0) + Number(st.usage.completionTokens || 0)
      }
      parts.push('余 ' + fmtTok(Math.max(0, contextWindow(call.model) - used)))
      return parts.join(' · ')
    }

    // 按完整句子送去合成，边出字边播。电话里每一句都要念出来，不受口令限制。
    function flushSpeech() {
      // 一次 delta 里可能已经有好几句：以前只切第一句，
      // 剩下的要等下一次出字才轮到，流一结束就被当成一大段连读。这里逐句切完。
      var guard = 0
      while (guard < 40) {
        guard += 1
        var text = call.chatBuf
        if (text.length <= call.spokenLen) return
        var fresh = text.slice(call.spokenLen)
        var cut = -1
        for (var i = 0; i < fresh.length; i += 1) {
          if ('。！？!?；;\n'.indexOf(fresh[i]) >= 0) {
            cut = i
            break
          }
        }
        if (cut < 0) {
          if (fresh.length < 24) return
          cut = fresh.lastIndexOf('，') >= 0 ? fresh.lastIndexOf('，') : fresh.length - 1
        }
        var chunk = fresh.slice(0, cut + 1).trim()
        call.spokenLen += cut + 1
        if (chunk === '') continue
        if (call.muted === true) continue
        call.phase = 'speaking'
        updateUI()
        speakChunk(chunk)
      }
    }

    function finishAnswer(userText) {
      // 收尾时用服务端给的真实 completion_tokens 校准一下平均速度
      if (call.stats !== null && call.stats !== undefined && call.stats.usage !== null && call.stats.usage.completionTokens > 0) {
        var spent = (Date.now() - call.stats.startAt) / 1000
        if (spent > 0.2) call.stats.speed = call.stats.usage.completionTokens / spent
      }
      // 尾巴上没断句的那半句也念掉
      if (call.spokenLen < call.chatBuf.length) {
        var tail = call.chatBuf.slice(call.spokenLen).trim()
        call.spokenLen = call.chatBuf.length
        if (tail !== '' && call.muted !== true) speakChunk(tail)
      }
      var finish = call.replyText.trim()
      if (finish !== '') {
        call.history.push({ role: 'user', content: userText })
        call.history.push({ role: 'assistant', content: finish })
        if (call.history.length > 40) call.history = call.history.slice(-40)
      }
      call.busy = false
      if (call.playing !== true) call.phase = 'idle'
      renderWindow()
      // 不在这里自动再听：等这次播报真的播完，pumpQueue 会按 autoListen 回到“等你说”
    }

    // ---------------- 语音：借「录音输入」插件完成识别 ----------------
    function startListening() {
      if (call.open !== true) return
      // 已经在听了就别重复点，否则会把刚开的麦又点关
      if (call.phase === 'listening' || call.phase === 'transcribing') return
      if (call.muted === true) {
        toast('先取消静音再说话')
        return
      }
      var button = findVoiceButton()
      if (button === null) {
        var dump = []
        var list = document.querySelectorAll('button')
        for (var bi = 0; bi < list.length && dump.length < 12; bi += 1) {
          if (inComposer(list[bi]) !== true) continue
          if (list[bi].hasAttribute !== undefined && list[bi].hasAttribute(BTN_ATTR)) continue
          var svg0 = list[bi].querySelector === undefined ? null : list[bi].querySelector('svg')
          dump.push(
            '[' + String(list[bi].getAttribute('aria-label') || list[bi].getAttribute('title') || '') + '|' + String(list[bi].className || '').slice(0, 14) + '|' +
            (svg0 === null || svg0 === undefined ? 'nosvg' : String(svg0.outerHTML || '').slice(0, 90)) + ']'
          )
        }
        dbg('mic-miss', 'svg=' + document.querySelectorAll('svg').length + ' ' + dump.join(' '))
        toast('没找到输入栏里的话筒按钮，确认 DSH 的语音输入没被关掉')
        call.phase = 'idle'
        updateUI()
        return
      }
      // 按钮还停在“停止录音”上，说明上次录音没收干净：先把它按停，再重新开
      var label = String(button.getAttribute('aria-label') || '')
      if (label.indexOf('停止') >= 0 || label.indexOf('结束') >= 0) {
        try {
          button.click()
        } catch (error) {
          /* 忽略 */
        }
        call.phase = 'idle'
        updateUI()
        window.setTimeout(function () {
          if (call.open === true && call.phase === 'idle') startListening()
        }, 500)
        return
      }
      stopPlayback()
      call.phase = 'listening'
      call.spokenLen = 0
      call.lastReply = ''
      updateUI()
      dbg('mic', String(button.tagName || '') + ' aria=' + String(button.getAttribute('aria-label') || '') + ' cls=' + String(button.className || '').slice(0, 40))
      try {
        button.click()
      } catch (error) {
        toast('话筒没点开：' + String(error.message || error))
      }
      watchDraft()
    }

    function stopListening() {
      if (call.phase !== 'listening') return
      var stop = findMicStopButton()
      if (stop === null) {
        // 有的界面没有单独的“停止并识别”，同一个话筒按钮再点一下就是结束
        var same = findVoiceButton()
        if (same !== null) stop = same
      }
      if (stop === null) {
        var all = document.querySelectorAll('button[aria-label]')
        for (var i = 0; i < all.length; i += 1) {
          if (all[i].closest !== undefined && all[i].closest('.dsh-pw') !== null) continue
          var text = String(all[i].getAttribute('aria-label') || '')
          if (text.indexOf('停止') >= 0) {
            stop = all[i]
            break
          }
        }
      }
      call.phase = 'transcribing'
      updateUI()
      if (stop === null) {
        toast('没找到结束录音的按钮，稍等一下再点一次')
        return
      }
      try {
        stop.click()
      } catch (error) {
        toast('停止录音失败：' + String(error.message || error))
      }
    }

    // 识别结果会被插件填进输入框。这里读到就把字取走、把输入框清空，
    // 然后直接交给「电话专用推理」，不再按 Enter、不再点发送 ——
    // 所以这通电话不会在工作台的对话里留下任何东西。
    // 识别监听。
    // DSH 的语音插件是流式往输入框里写整句的，所以不能拿“输入框静止”当定稿条件
    // ——我们清空输入框之后它永远不会静止。改成看“最后一次读到新字”的时间：
    // 超过 1 秒没有新字，就认为这句话说完了，直接把这句话交给通话模型。
    // 识别监听。
    // DSH 的语音插件是流式往输入框里写整句的。这里不拿“输入框静止”当定稿条件
    // （我们会把输入框清掉，清完就永远静止不了），而是记“最后一次读到新字”的时间：
    // 超过 1 秒没有新字 → 认为这句说完了 → 直接把这句话交给通话模型。
    function watchDraft() {
      if (call.sendTimer !== null) return
      call.heardFull = ''
      call.consumedText = ''
      call.lastTextAt = 0
      call.sendTimer = window.setInterval(function () {
        if (call.open !== true) {
          window.clearInterval(call.sendTimer)
          call.sendTimer = null
          return
        }
        if (call.phase !== 'listening' && call.phase !== 'transcribing') {
          // 停在识别以外超过 6 秒就自己停掉，不在后台一直 30ms 轮询
          call.sendIdle += 1
          if (call.sendIdle > 200) {
            window.clearInterval(call.sendTimer)
            call.sendTimer = null
          }
          return
        }
        call.sendIdle = 0
        var area = null
        try {
          area = findDraft()
        } catch (error) {
          return
        }
        if (area === null || area === undefined) return
        var value = String(draftText(area) || '').trim()
        if (value !== '') {
          // 开窗头 1.2 秒里出现的字，一律当上一通没发出去的残留，清掉不算数
          if (Date.now() - call.startedAt < 1200) {
            hardClear(area)
            sweepDrafts('')
            return
          }
          if (value !== call.heardFull) {
            call.heardFull = value
            call.lastTextAt = Date.now()
            dbg('thread-read', 'len=' + value.length + ' ' + value.slice(0, 40))
          }
        }
        // 关键：输入框空着（被我们清掉了）也要继续往下判时间，不能直接 return
        if (call.heardFull === '' || call.lastTextAt === 0) return
        if (Date.now() - call.lastTextAt < 1000) return
        // ---- 定稿：这句话说完了 ----
        var base = String(call.baseDraft || '').trim()
        var full = call.heardFull
        // 开窗时工作台里原来那半句草稿不算“我说的”
        if (base !== '' && full.indexOf(base) >= 0) full = full.replace(base, '').trim()
        var said = full
        var prev = String(call.consumedText || '')
        // 插件是把整段重写进来的，已经交给模型的部分剪掉，只留新说的那一截
        if (prev !== '' && full.indexOf(prev) === 0) said = full.slice(prev.length).trim()
        if (said === '') {
          call.lastTextAt = Date.now()
          return
        }
        call.consumedText = full
        // 强制规则：这一句必须交给面板上当前选中的模型
        var liveModel = currentModelName()
        if (liveModel !== '') call.model = liveModel
        // 先停录音，不然插件还会把整段再写回输入框
        try {
          stopListening()
        } catch (error) {
          /* 已经不在录就跳过 */
        }
        try {
          hardClear(area)
        } catch (error) {
          /* 忽略 */
        }
        window.clearTimeout(call.flushTimer)
        call.flushTimer = window.setTimeout(function () {
          if (call.open === true) {
            var again = findDraft()
            if (again !== null && again !== undefined) hardClear(again)
            sweepDrafts('')
          }
        }, 600)
        window.clearInterval(call.sendTimer)
        call.sendTimer = null
        dbg('final', 'said=' + said.slice(0, 40))
        setHeard(said)
        askModel(said)
      }, 30)
    }

    // ---------------- 通话窗口 ----------------
    // ---------------- 通话小窗（永远待在 DSH 里） ----------------
    // 之前那版用 window.open 开新窗口，宿主会把这个窗口丢给系统浏览器/独立空白页，
    // 电话就跑到 DSH 外面去了、还是白的。现在改成自己在这一页里拼一个浮层：
    // 圆角浅色底板、阴影、标题栏——像 QQ 登录窗那样的小窗，但它在 DSH 页面内部。
    // 交互按普通窗口做：拖标题栏移动、拖右下角缩放、最小化折叠、× 关闭，位置尺寸会记住。
    var GEOM_KEY = 'dsh-ai-phone-geom'

    function readGeom() {
      try {
        var raw = window.localStorage.getItem(GEOM_KEY)
        if (raw === null || raw === undefined) return null
        var obj = JSON.parse(raw)
        if (obj === null || typeof obj !== 'object') return null
        return obj
      } catch (error) {
        return null
      }
    }

    function writeGeom(obj) {
      try {
        window.localStorage.setItem(GEOM_KEY, JSON.stringify(obj))
      } catch (error) {
        /* 忽略 */
      }
    }

    function clampNum(value, min, max) {
      if (value < min) return min
      if (value > max) return max
      return value
    }

    // ---------------- 头像：拖入替换 + 取景 + 正圆 ----------------
    // 概念图处理链路：用户把图拖到头像框 → FileReader 转 dataURL → POST /phone/avatar
    // → 宿主落盘并把路径写进配置 → 前端带时间戳重新拉图，避免旧图缓存。
    // 圆形裁切：容器固定正方形 + border-radius/clip-path 都是 50%，图片 object-fit:cover
    // 等比铺满后按 object-position 取景，多出来的边被圆框裁掉，不拉伸、不变形。
    var AVATAR_POS_KEY = 'dsh-ai-phone-avatar-pos'

    function avatarKeyOf(model) {
      var matched = /^[A-Za-z\u4e00-\u9fa5]+/.exec(String(model || ''))
      return matched === null ? 'default' : matched[0]
    }

    function readAvatarPos() {
      try {
        var raw = window.localStorage.getItem(AVATAR_POS_KEY)
        var obj = raw === null || raw === undefined ? null : JSON.parse(raw)
        return obj !== null && typeof obj === 'object' ? obj : {}
      } catch (error) {
        return {}
      }
    }

    function avatarPosOf(model) {
      var all = readAvatarPos()
      var pos = all[avatarKeyOf(model)]
      if (pos === undefined || pos === null || typeof pos !== 'object') return { x: 50, y: 22 }
      return { x: clampNum(Number(pos.x), 0, 100), y: clampNum(Number(pos.y), 0, 100) }
    }

    function setAvatarPos(model, x, y) {
      var all = readAvatarPos()
      all[avatarKeyOf(model)] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
      try {
        window.localStorage.setItem(AVATAR_POS_KEY, JSON.stringify(all))
      } catch (error) {
        /* 存不下就算了，本次通话内还有效果 */
      }
      renderWindow()
    }

    function uploadAvatar(file) {
      if (file === null || file === undefined) return
      if (String(file.type || '').indexOf('image/') !== 0) {
        toast('这不是图片文件')
        return
      }
      if (file.size > 12 * 1024 * 1024) {
        toast('图片太大，换一张小于 12MB 的')
        return
      }
      var reader = new FileReader()
      reader.onload = function () {
        toast('正在换头像…')
        fetch(baseUrl() + '/phone/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: call.model, dataUrl: String(reader.result || '') }),
        })
          .then(function (res) {
            return res.json()
          })
          .then(function (json) {
            if (json !== null && json.ok === true) {
              call.avatarErr = false
              call.avatarSrc = baseUrl() + '/phone/avatar?model=' + encodeURIComponent(call.model) + '&t=' + Date.now()
              renderWindow()
              toast('头像换好了：' + String(json.model || call.model))
            } else {
              toast('换头像失败：' + (json === null ? '未知错误' : String(json.error || '')))
            }
          })
          .catch(function (error) {
            toast('换头像失败：' + String(error.message || error))
          })
      }
      reader.onerror = function () {
        toast('这张图读不出来，换一张试试')
      }
      reader.readAsDataURL(file)
    }

    function pickAvatar() {
      var input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.style.display = 'none'
      document.body.appendChild(input)
      var drop = function () {
        window.removeEventListener('focus', drop)
        window.setTimeout(function () {
          try {
            input.remove()
          } catch (error) {
            /* 已经没了 */
          }
        }, 600)
      }
      window.addEventListener('focus', drop)
      input.addEventListener('change', function () {
        window.removeEventListener('focus', drop)
        var file = input.files !== null && input.files.length > 0 ? input.files[0] : null
        uploadAvatar(file)
        input.remove()
      })
      input.click()
    }

    function iconMic() {
      return '<svg class="dsh-pw-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="9.4" y="4.2" width="5.2" height="9.4" rx="2.6"/><path d="M5.6 11a6.4 6.4 0 0 0 12.8 0"/><path d="M12 17.4v3"/></svg>'
    }

    function iconMicOff() {
      return '<svg class="dsh-pw-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="9.4" y="4.2" width="5.2" height="9.4" rx="2.6"/><path d="M5.6 11a6.4 6.4 0 0 0 12.8 0"/><path d="M12 17.4v3"/><path d="M4.6 4.2l14.8 15.2"/></svg>'
    }

    function iconInput() {
      return '<svg class="dsh-pw-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.5 9.5v5"/><path d="M12 6v12"/><path d="M17.5 9.5v5"/></svg>'
    }

    // 窗口控件图标：最小化 / 最大化 / 关闭，用 SVG 免得字体缺字
    function iconMinimize() {
      return '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.4" width="8" height="1.2" fill="currentColor"/></svg>'
    }

    function iconMaximize() {
      return '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.4"/></svg>'
    }

    function iconRestore() {
      return '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.6" y="3.6" width="6.8" height="6.8" rx="1.2"/><path d="M3.8 3.6V1.8h6.4v6.4h-1.8"/></svg>'
    }

    function iconClose() {
      return '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.4 2.4l7.2 7.2M9.6 2.4L2.4 9.6"/></svg>'
    }

    function iconHang() {
      return '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.6 2.9c.5-.5 1.3-.5 1.8 0l1.8 1.8c.5.5.5 1.3 0 1.8l-.8.8c.4 1.2 1.1 2.4 2.1 3.4s2.2 1.7 3.4 2.1l.8-.8c.5-.5 1.3-.5 1.8 0l1.8 1.8c.5.5.5 1.3 0 1.8l-1.2 1.2c-.8.8-1.9 1-2.9.7-2-.8-3.8-1.9-5.3-3.4S5.2 9.9 4.4 7.9c-.3-1-.1-2.1.7-2.9z"/></svg>'
    }

    // DSH 深色/浅色主题判断：只为让这块玻璃跟本体同色系，判不出来就当浅色
    function isDarkTheme() {
      try {
        var root = document.documentElement
        var attr = (root.getAttribute('data-theme') || '') + ' ' + (root.getAttribute('class') || '') + ' ' + (root.style.colorScheme || '')
        if (/dark/i.test(attr)) return true
        if (/light/i.test(attr)) return false
        if (document.body === null) return false
        var col = getComputedStyle(document.body).color
        var nums = col.match(/[0-9.]+/g)
        if (nums !== null && nums.length >= 3) {
          return (Number(nums[0]) + Number(nums[1]) + Number(nums[2])) / 3 > 150
        }
      } catch (error) {
        /* 忽略 */
      }
      return false
    }

    function elapsedText() {
      var ms = call.startedAt > 0 ? Date.now() - call.startedAt : 0
      var sec = Math.max(0, Math.floor(ms / 1000))
      var mm = Math.floor(sec / 60)
      var ss = sec - mm * 60
      var left = mm < 10 ? '0' + mm : String(mm)
      var right = ss < 10 ? '0' + ss : String(ss)
      return left + ':' + right
    }

    function destroyWindow() {
      if (call.ui === null) return
      try {
        call.ui.wrap.remove()
      } catch (error) {
        /* 忽略 */
      }
      call.ui = null
    }

    // 小窗 DOM：标题栏（可拖） / 舞台（头像+计时+状态+两行听到的话） / 底部三颗按钮 / 右下角缩放角
    function buildWindow() {
      destroyWindow()
      var vw = window.innerWidth > 0 ? window.innerWidth : 1280
      var vh = window.innerHeight > 0 ? window.innerHeight : 800
      var saved = readGeom() || {}
      var maxW = Math.max(340, Math.round(vw * 0.92))
      var maxH = Math.max(460, Math.round(vh * 0.90))
      var w = clampNum(Math.round(saved.w || 440), 340, maxW)
      var h = clampNum(Math.round(saved.h || 740), 460, maxH)
      var left = typeof saved.left === 'number' ? saved.left : Math.round((vw - w) / 2 + vw * 0.06)
      var top = typeof saved.top === 'number' ? saved.top : Math.round((vh - h) / 2)
      left = clampNum(left, 6, Math.max(6, vw - w - 6))
      top = clampNum(top, 6, Math.max(6, vh - h - 6))

      var wrap = document.createElement('div')
      wrap.className = 'dsh-pw'
      wrap.setAttribute('data-min', '0')
      wrap.setAttribute('data-max', '0')
      wrap.setAttribute('data-dark', isDarkTheme() === true ? '1' : '0')
      wrap.style.left = left + 'px'
      wrap.style.top = top + 'px'
      wrap.style.width = w + 'px'
      wrap.style.height = h + 'px'

      var bar = document.createElement('div')
      bar.className = 'dsh-pw-bar'
      var dot = document.createElement('span')
      dot.className = 'dsh-pw-dot'
      var title = document.createElement('div')
      title.className = 'dsh-pw-title'
      title.textContent = 'AI 通话 · 当前模型'
      bar.appendChild(dot)
      bar.appendChild(title)

      // 三个窗口控件，顺序照 Windows：最小化 / 最大化 / 关闭
      var minBtn = document.createElement('button')
      minBtn.type = 'button'
      minBtn.setAttribute('aria-label', '最小化')
      minBtn.title = '最小化'
      minBtn.innerHTML = iconMinimize()
      var maxBtn = document.createElement('button')
      maxBtn.type = 'button'
      maxBtn.setAttribute('aria-label', '最大化')
      maxBtn.title = '最大化'
      maxBtn.innerHTML = iconMaximize()
      var xBtn = document.createElement('button')
      xBtn.type = 'button'
      xBtn.className = 'dsh-pw-x'
      xBtn.setAttribute('aria-label', '关闭并挂断')
      xBtn.title = '关闭并挂断'
      xBtn.innerHTML = iconClose()
      bar.appendChild(minBtn)
      bar.appendChild(maxBtn)
      bar.appendChild(xBtn)

      var body = document.createElement('div')
      body.className = 'dsh-pw-body'
      var stage = document.createElement('div')
      stage.className = 'dsh-pw-stage'

      // 背景光斑：整窗有一点“通话中”的呼吸氛围，不刺眼
      var glow = document.createElement('div')
      glow.className = 'dsh-pw-glow'

      // 头像位：外层 halo 负责呼吸光晕，内层 ring 负责圆形裁切
      var halo = document.createElement('div')
      halo.className = 'dsh-pw-halo'
      var ring = document.createElement('div')
      ring.className = 'dsh-pw-ring'
      var letter = document.createElement('span')
      letter.className = 'dsh-pw-letter'
      var img = document.createElement('img')
      img.alt = ''
      img.style.display = 'none'
      img.addEventListener('error', function () {
        call.avatarErr = true
        img.style.display = 'none'
        letter.style.display = ''
      })
      ring.appendChild(img)
      ring.appendChild(letter)
      halo.appendChild(ring)

      // 头像框就是换图入口：把概念图拖进来即换；空头像点一下打开文件选择；
      // 按住拖动能改取景（object-position），松手记住，同一厂牌所有档位共用。
      ring.style.cursor = 'pointer'
      ring.title = '拖一张图片进来换头像；按住拖动可调取景'
      ring.addEventListener('dragover', function (event) {
        event.preventDefault()
        event.stopPropagation()
        ring.setAttribute('data-drop', '1')
      })
      ring.addEventListener('dragleave', function () {
        ring.setAttribute('data-drop', '0')
      })
      ring.addEventListener('drop', function (event) {
        event.preventDefault()
        event.stopPropagation()
        ring.setAttribute('data-drop', '0')
        var dt = event.dataTransfer
        var file = dt !== null && dt.files !== null && dt.files.length > 0 ? dt.files[0] : null
        uploadAvatar(file)
      })
      ring.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        if (call.open !== true) return
        event.stopPropagation()
        var box = ring.getBoundingClientRect()
        var start = avatarPosOf(call.model)
        var sx = event.clientX
        var sy = event.clientY
        var moved = false
        function move(e) {
          if (moved !== true) {
            if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 5) return
            moved = true
          }
          var dx = box.width > 0 ? ((e.clientX - sx) / box.width) * 100 : 0
          var dy = box.height > 0 ? ((e.clientY - sy) / box.height) * 100 : 0
          setAvatarPos(call.model, clampNum(start.x - dx, 0, 100), clampNum(start.y - dy, 0, 100))
        }
        function up() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          if (moved !== true && call.avatarSrc === '') pickAvatar()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })

      var timer = document.createElement('div')
      timer.className = 'dsh-pw-timer'
      timer.textContent = '00:00'
      // 声波：聆听 / 播报时五根竖条动起来，平时是静止的小点
      var wave = document.createElement('div')
      wave.className = 'dsh-pw-wave'
      wave.setAttribute('data-on', '0')
      for (var wi = 0; wi < 5; wi += 1) wave.appendChild(document.createElement('span'))
      var status = document.createElement('div')
      status.className = 'dsh-pw-status'
      status.textContent = '正在接通…'
      // 它说的话：整句显示在这里，同时逐句念出来
      var reply = document.createElement('div')
      reply.className = 'dsh-pw-reply'
      var heard = document.createElement('div')
      heard.className = 'dsh-pw-heard'
      var notice = document.createElement('div')
      notice.className = 'dsh-pw-notice'
      notice.setAttribute('data-on', '0')
      // 每轮消耗：出字速度、本步 token、缓存命中率、上下文余量
      var stats = document.createElement('div')
      stats.className = 'dsh-pw-stats'
      stats.textContent = ''

      stage.appendChild(glow)
      stage.appendChild(halo)
      stage.appendChild(timer)
      stage.appendChild(wave)
      stage.appendChild(status)
      stage.appendChild(reply)
      stage.appendChild(heard)
      stage.appendChild(notice)
      stage.appendChild(stats)

      var dock = document.createElement('div')
      dock.className = 'dsh-pw-dock'
      var micBtn = document.createElement('button')
      micBtn.type = 'button'
      micBtn.className = 'dsh-pw-btn dsh-pw-mic'
      micBtn.setAttribute('aria-label', '通话静音')
      micBtn.title = '通话静音'
      micBtn.innerHTML = iconMic()
      var inputBtn = document.createElement('button')
      inputBtn.type = 'button'
      inputBtn.className = 'dsh-pw-btn dsh-pw-input'
      inputBtn.setAttribute('aria-label', '通话输入')
      inputBtn.title = '通话输入'
      inputBtn.setAttribute('data-on', '0')
      inputBtn.innerHTML = iconInput() + '<span class="dsh-pw-cube"></span>'
      var hangBtn = document.createElement('button')
      hangBtn.type = 'button'
      hangBtn.className = 'dsh-pw-btn dsh-pw-hang'
      hangBtn.setAttribute('aria-label', '挂断')
      hangBtn.title = '挂断'
      hangBtn.innerHTML = iconHang()
      dock.appendChild(micBtn)
      dock.appendChild(inputBtn)
      dock.appendChild(hangBtn)

      body.appendChild(stage)
      body.appendChild(dock)

      var grip = document.createElement('div')
      grip.className = 'dsh-pw-grip'
      grip.title = '拖动改变大小'

      wrap.appendChild(bar)
      wrap.appendChild(body)
      wrap.appendChild(grip)
      document.body.appendChild(wrap)
      // 进场：先落在缩小透明态，下一帧回到正常态，走一段很轻的淡入缩放
      wrap.style.opacity = '0'
      wrap.style.transform = 'scale(.94) translateY(8px)'
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          wrap.style.opacity = ''
          wrap.style.transform = ''
        })
      })

      call.ui = { wrap: wrap, bar: bar, title: title, ring: ring, halo: halo, img: img, letter: letter, timer: timer, wave: wave, status: status, reply: reply, heard: heard, notice: notice, stats: stats, mic: micBtn, input: inputBtn, hang: hangBtn, grip: grip, max: maxBtn, min: minBtn }

      // 挂断 / 最小化 / 关闭
      hangBtn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        closeCall()
      })
      xBtn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        closeCall()
      })
      // 最小化 / 最大化 / 关闭
      var preMin = null
      var preMax = null
      minBtn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var now = wrap.getAttribute('data-min') === '1'
        if (now) {
          wrap.setAttribute('data-min', '0')
          if (preMin !== null) {
            wrap.style.left = preMin.left + 'px'
            wrap.style.top = preMin.top + 'px'
            wrap.style.width = preMin.w + 'px'
            wrap.style.height = preMin.h + 'px'
          }
          minBtn.innerHTML = iconMinimize()
          minBtn.title = '最小化'
        } else {
          var r0 = wrap.getBoundingClientRect()
          preMin = { left: Math.round(r0.left), top: Math.round(r0.top), w: Math.round(r0.width), h: Math.round(r0.height) }
          wrap.setAttribute('data-min', '1')
          minBtn.innerHTML = iconRestore()
          minBtn.title = '还原'
        }
        minBtn.setAttribute('aria-label', minBtn.title)
      })
      maxBtn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (wrap.getAttribute('data-min') === '1') {
          wrap.setAttribute('data-min', '0')
          if (preMin !== null) {
            wrap.style.left = preMin.left + 'px'
            wrap.style.top = preMin.top + 'px'
            wrap.style.width = preMin.w + 'px'
            wrap.style.height = preMin.h + 'px'
          }
          minBtn.innerHTML = iconMinimize()
          minBtn.title = '最小化'
        }
        var on = wrap.getAttribute('data-max') === '1'
        if (on) {
          wrap.setAttribute('data-max', '0')
          if (preMax !== null) {
            wrap.style.left = preMax.left + 'px'
            wrap.style.top = preMax.top + 'px'
            wrap.style.width = preMax.w + 'px'
            wrap.style.height = preMax.h + 'px'
          }
          maxBtn.innerHTML = iconMaximize()
          maxBtn.title = '最大化'
        } else {
          var r1 = wrap.getBoundingClientRect()
          preMax = { left: Math.round(r1.left), top: Math.round(r1.top), w: Math.round(r1.width), h: Math.round(r1.height) }
          wrap.setAttribute('data-max', '1')
          var vw2 = window.innerWidth > 0 ? window.innerWidth : 1280
          var vh2 = window.innerHeight > 0 ? window.innerHeight : 800
          wrap.style.left = '12px'
          wrap.style.top = '12px'
          wrap.style.width = Math.max(340, vw2 - 24) + 'px'
          wrap.style.height = Math.max(460, vh2 - 24) + 'px'
          maxBtn.innerHTML = iconRestore()
          maxBtn.title = '还原'
        }
        maxBtn.setAttribute('aria-label', maxBtn.title)
      })
      micBtn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggleMute()
      })
      inputBtn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggleInput()
      })

      // 拖标题栏移动窗口（缩放后位置会记到 localStorage，下次还是这个大小和位置）
      bar.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        if (event.target !== bar && event.target !== title) return
        if (wrap.getAttribute('data-max') === '1') return
        event.preventDefault()
        var rect = wrap.getBoundingClientRect()
        var sx = event.clientX
        var sy = event.clientY
        var sl = rect.left
        var st = rect.top
        function move(e) {
          var nx = clampNum(sl + (e.clientX - sx), 6, Math.max(6, window.innerWidth - rect.width - 6))
          var ny = clampNum(st + (e.clientY - sy), 6, Math.max(6, window.innerHeight - rect.height - 6))
          wrap.style.left = nx + 'px'
          wrap.style.top = ny + 'px'
        }
        function up() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          var r = wrap.getBoundingClientRect()
          writeGeom({ w: Math.round(r.width), h: Math.round(r.height), left: parseFloat(wrap.style.left), top: parseFloat(wrap.style.top) })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })

      // 拖右下角改变大小
      grip.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        if (wrap.getAttribute('data-max') === '1') return
        event.preventDefault()
        event.stopPropagation()
        var rect = wrap.getBoundingClientRect()
        var sx = event.clientX
        var sy = event.clientY
        var sw = rect.width
        var sh = rect.height
        function move(e) {
          var nw = clampNum(sw + (e.clientX - sx), 340, Math.round(window.innerWidth * 0.92))
          var nh = clampNum(sh + (e.clientY - sy), 460, Math.round(window.innerHeight * 0.90))
          wrap.style.width = nw + 'px'
          wrap.style.height = nh + 'px'
        }
        function up() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          var r = wrap.getBoundingClientRect()
          writeGeom({ w: Math.round(r.width), h: Math.round(r.height), left: parseFloat(wrap.style.left), top: parseFloat(wrap.style.top) })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })

      renderWindow()
    }

    // 头像圆形裁切：整张概念图等比铺满圆框、居中偏上取人脸（见 CSS object-fit / object-position），
    // 不拉伸不变形；没配到图就用模型名首字母占位。
    function renderWindow() {
      var ui = call.ui
      if (ui === null) return
      if (call.notice !== '' && Date.now() - call.noticeAt > 4200) call.notice = ''
      ui.title.textContent = 'AI 通话 · ' + (call.model === '' ? '当前模型' : call.model)
      ui.status.textContent = PHASE_TEXT[call.phase] || ''
      ui.heard.textContent = call.heardText
      // 它说的那句：只在小窗里显示
      ui.reply.textContent = call.replyText
      ui.reply.style.display = call.replyText === '' ? 'none' : ''
      ui.notice.textContent = call.notice
      ui.notice.setAttribute('data-on', call.notice !== '' ? '1' : '0')
      if (ui.stats !== null && ui.stats !== undefined) {
        var line = statsLine()
        ui.stats.textContent = line
        ui.stats.style.display = line === '' ? 'none' : ''
      }
      var letter = (call.model.replace(/[^A-Za-z0-9]/g, '') || 'AI').slice(0, 2).toUpperCase()
      ui.letter.textContent = letter
      // 头像框必须是正圆：inline 兜一层，别被宿主或外部样式改回圆角矩形
      ui.ring.style.borderRadius = '50%'
      ui.ring.style.clipPath = 'circle(50% at 50% 50%)'
      if (call.avatarSrc === '' || call.avatarErr === true) {
        // 图挂了就老实显示首字母占位，别每帧重设 src 造成破图闪烁
        ui.img.style.display = 'none'
        ui.letter.style.display = ''
      } else {
        var pos = avatarPosOf(call.model)
        ui.img.style.objectPosition = pos.x + '% ' + pos.y + '%'
        if (ui.img.getAttribute('src') !== call.avatarSrc) {
          ui.img.setAttribute('src', call.avatarSrc)
          ui.letter.style.display = 'none'
        }
        ui.img.style.display = ''
      }
      ui.mic.setAttribute('data-on', call.muted === true ? '1' : '0')
      ui.mic.innerHTML = call.muted === true ? iconMicOff() : iconMic()
      ui.input.setAttribute('data-on', call.phase === 'listening' || call.phase === 'transcribing' ? '1' : '0')
      ui.timer.textContent = elapsedText()
      var active = call.phase === 'listening' || call.phase === 'transcribing' || call.phase === 'speaking'
      ui.wave.setAttribute('data-on', active ? '1' : '0')
      // 最大化时窗口跟着浏览器窗口走，别的状态不动
      if (ui.wrap.getAttribute('data-max') === '1') {
        var vw3 = window.innerWidth > 0 ? window.innerWidth : 1280
        var vh3 = window.innerHeight > 0 ? window.innerHeight : 800
        ui.wrap.style.width = Math.max(340, vw3 - 24) + 'px'
        ui.wrap.style.height = Math.max(460, vh3 - 24) + 'px'
      }
      // 头像框必须是正圆：按窗口实际宽度算死像素，不依赖 aspect-ratio 推算
      var wNow = ui.wrap.clientWidth > 0 ? ui.wrap.clientWidth : 420
      var ringSize = Math.round(Math.min(Math.max(wNow - 40, 180), 560) * 0.5)
      ringSize = Math.max(96, Math.min(268, ringSize))
      ui.halo.style.width = ringSize + 'px'
      ui.ring.style.width = ringSize + 'px'
      ui.ring.style.height = ringSize + 'px'
    }

    // 麦克风开关：静音之后不听也不播

    // DSH 的输入框是富文本，识别文字写进去后清空会被它自己恢复。
    // 兜底办法：通话期间在这块区域盖一层毛玻璃，文字还在但看不见；
    // 挂断时移除遮罩并再清一次。位置每 400ms 跟着输入框走，缩放/滚动都不会错位。
    function maskComposer() {
      if (call.mask !== null) return
      var area = findDraft()
      if (area === null || area === undefined) return
      var rect = area.getBoundingClientRect()
      if (rect.width < 120 || rect.height < 18) return
      var div = document.createElement('div')
      div.className = 'dsh-pw-mask'
      div.style.left = Math.round(rect.left) + 'px'
      div.style.top = Math.round(rect.top) + 'px'
      div.style.width = Math.round(rect.width) + 'px'
      div.style.height = Math.round(rect.height) + 'px'
      document.body.appendChild(div)
      call.mask = div
      dbg('mask', 'on ' + Math.round(rect.width) + 'x' + Math.round(rect.height))
    }

    function syncMask() {
      if (call.mask === null) return
      var area = findDraft()
      if (area === null || area === undefined) {
        unmaskComposer()
        return
      }
      var rect = area.getBoundingClientRect()
      call.mask.style.left = Math.round(rect.left) + 'px'
      call.mask.style.top = Math.round(rect.top) + 'px'
      call.mask.style.width = Math.round(rect.width) + 'px'
      call.mask.style.height = Math.round(rect.height) + 'px'
    }

    function unmaskComposer() {
      if (call.mask === null) return
      try {
        if (call.mask.parentElement !== null) call.mask.parentElement.removeChild(call.mask)
      } catch (error) {
        /* 忽略 */
      }
      call.mask = null
      dbg('mask', 'off')
    }

    function toggleMute() {
      call.muted = call.muted !== true
      if (call.muted === true) stopPlayback()
      updateUI()
      toast(call.muted === true ? '已静音，再点一次恢复' : '已取消静音')
    }

    // 输入启停：开着就是“我说话 → 识别 → 自动发送”，关掉就停手
    function toggleInput() {
      if (call.phase === 'listening') {
        stopListening()
        updateUI()
        return
      }
      if (call.phase === 'transcribing' || call.phase === 'thinking') {
        toast('这一轮还没走完，等一下')
        return
      }
      startListening()
    }

    // 通话要在独立会话里进行，不污染正在干活的对话
    function switchToNewSession() {
      try {
        var buttons = document.querySelectorAll('button, [role="button"], a')
        for (var i = 0; i < buttons.length; i += 1) {
          var text = String(buttons[i].textContent || '').trim()
          if (text === '新会话' || text === '新建会话' || text.indexOf('新会话') === 0) {
            buttons[i].click()
            return true
          }
        }
      } catch (error) {
        /* 忽略 */
      }
      return false
    }

    function openCall() {
      if (call.open === true) return
      if (cfgCache !== null && cfgCache.enabled === false) return
      call.open = true
      call.model = currentModelName()
      call.phase = 'idle'
      call.spokenLen = 0
      call.lastReply = ''
      call.heardText = ''
      // 每一通电话都是一场独立的记录：只在小窗和日志里，不进工作台会话
      call.replyText = ''
      call.chatBuf = ''
      call.history = []
      call.busy = false
      var born = new Date()
      var two = function (value) {
        return value < 10 ? '0' + value : String(value)
      }
      call.callId = String(born.getFullYear()) + two(born.getMonth() + 1) + two(born.getDate()) + '-' + two(born.getHours()) + two(born.getMinutes()) + two(born.getSeconds()) + '-' + (String(call.model).replace(/[^A-Za-z0-9]/g, '') || 'AI')
      call.avatarSrc = ''
      call.notice = ''
      call.noticeAt = 0
      call.muted = false
      call.queue.length = 0
      // 开窗这一刻输入框里已有的内容，是用户自己的草稿，不是这通电话的指令：
      // 记下来 → 立刻清空（草稿暂存），等挂断再原样还回去。
      // 这样通话过程中输入框始终是空的，识别出来的字不可能和草稿搅在一起。
      var seedDraft = null
      try {
        seedDraft = findDraft()
        call.baseDraft = seedDraft === null || seedDraft === undefined ? '' : String(draftText(seedDraft) || '').trim()
      } catch (error) {
        call.baseDraft = ''
        dbg('stash-error', String(error && error.message))
      }
      if (call.baseDraft !== '' && seedDraft !== null) {
        forceSetDraft(seedDraft, '')
        dbg('stash', 'len=' + call.baseDraft.length + ' node=' + String(seedDraft.tagName || '') + ' cls=' + String(seedDraft.className || '').slice(0, 40))
      } else {
        dbg('stash', 'empty; node=' + (seedDraft === null || seedDraft === undefined ? 'null' : String(seedDraft.tagName || '') + ' cls=' + String(seedDraft.className || '').slice(0, 40)))
      }
      call.startedAt = Date.now()
      window.setTimeout(maskComposer, 300)
      // 小窗始终待在 DSH 页面里，不会跳去浏览器
      buildWindow()
      playSfx('open')
      paintAvatar()

      if (call.model === '') toast('没认出面板上的模型名，这次先用默认声线和占位头像')

      // 注意：这里不再新建会话、也不往输入框里发消息。
      // 这一轮的话由 /phone/chat 直接交给当前模型，工作台保持原样。

      // 强制规则：跟着面板上的模型走，切了就换头像换声线
      call.timer = window.setInterval(function () {
        if (call.open !== true) return
        var model = currentModelName()
        if (model !== '' && model !== call.model) {
          call.model = model
          paintAvatar()
          toast('换成了 ' + model + ' 接电话')
        }
        if (call.phase !== 'listening') sweepDrafts('')
        syncMask()
        renderWindow()
      }, 400)

      window.setTimeout(function () {
        if (call.open === true && call.phase === 'idle') startListening()
      }, 900)
    }

    function closeCall() {
      if (call.open !== true) return
      playSfx('close')
      call.open = false
      call.phase = 'idle'
      call.muted = false
      if (call.timer !== null) {
        window.clearInterval(call.timer)
        call.timer = null
      }
      if (call.sendTimer !== null) {
        window.clearInterval(call.sendTimer)
        call.sendTimer = null
      }
      stopPlayback()
      var stop = findMicStopButton()
      if (stop !== null) {
        try {
          stop.click()
        } catch (error) {
          /* 忽略 */
        }
      }
      unmaskComposer()
      var closingWrap = call.ui !== null && call.ui.wrap !== null ? call.ui.wrap : null
      if (closingWrap !== null) {
        closingWrap.setAttribute('data-anim', 'out')
        window.setTimeout(function () {
          try { closingWrap.remove() } catch (error) { /* 忽略 */ }
        }, 170)
      }
      call.ui = null
      // 挂断后把开窗时暂存的草稿原样写回输入框
      if (String(call.baseDraft || '') !== '') {
        var back = findDraft()
        if (back !== null && back !== undefined) forceSetDraft(back, call.baseDraft)
      }
      call.baseDraft = ''
      call.avatarSrc = ''
      call.heardText = ''
      call.replyText = ''
      call.chatBuf = ''
      call.history = []
      call.notice = ''
    }

    // ---------------- 入口按钮 ----------------
    // 位置必须稳定。之前的做法是“有表情按钮就贴表情右、没有就贴麦克风左”，
    // 结果不同界面版本下会一会儿左一会儿右。现在统一钉在「麦克风/录音」按钮左边
    // （没有麦克风按钮就贴发送按钮左边），并且每次 ensure 都核对，被重排搬走就搬回来。
    function inComposer(btn) {
      var area = findDraft()
      if (area === null) return true
      var node = area.parentElement
      for (var i = 0; i < 6 && node !== null; i += 1) {
        if (node.contains(btn)) return true
        node = node.parentElement
      }
      return false
    }

    function findEntryAnchor() {
      var nodes = document.querySelectorAll('button[aria-label], button[title]')
      var mic = null
      var send = null
      for (var i = 0; i < nodes.length; i += 1) {
        var b = nodes[i]
        if (b.offsetParent === null) continue
        if (inComposer(b) !== true) continue
        var label = String(b.getAttribute('aria-label') || b.getAttribute('title') || '')
        var lower = label.toLowerCase()
        if (
          mic === null &&
          (label.indexOf('开始录音') >= 0 ||
            label.indexOf('语音输入') >= 0 ||
            label.indexOf('录音') >= 0 ||
            label.indexOf('麦克风') >= 0 ||
            lower.indexOf('dictate') >= 0)
        ) {
          mic = b
        }
        if (send === null && label.indexOf('发送') >= 0) send = b
      }
      return mic !== null ? mic : send
    }

    var entryPending = false
    function scheduleEntry() {
      if (entryPending === true) return
      entryPending = true
      var raf = window.requestAnimationFrame
      var run = function () {
        entryPending = false
        try {
          ensureEntry()
        } catch (error) {
          /* 插不进去不影响别的 */
        }
      }
      if (typeof raf === 'function') raf(run)
      else window.setTimeout(run, 16)
    }

    function ensureEntry() {
      if (document.body === null) return
      var old = document.body.querySelector('[' + BTN_ATTR + ']')
      if (cfgCache !== null && cfgCache.enabled === false) {
        if (old !== null) old.remove()
        return
      }
      var anchor = findEntryAnchor()
      if (anchor === null || anchor.parentElement === null) {
        if (old !== null) old.remove()
        return
      }
      var button = old
      if (button === null) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-phone-entry'
        button.setAttribute(BTN_ATTR, '1')
        button.setAttribute('aria-label', '和 AI 打电话')
        button.title = '和 AI 打电话'
        button.innerHTML = PHONE_ICON
        button.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          openCall()
        })
      }
      // 已经正好在锚点左侧就不动，避免 DOM 一变就反复插入、看着像在飘
      if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) {
        anchor.parentElement.insertBefore(button, anchor)
      }
    }

    function matchesShortcut(event, spec) {
      if (typeof spec !== 'string' || spec === '') return false
      var parts = spec.toLowerCase().split('+').map(function (p) {
        return p.trim()
      })
      var needAlt = parts.indexOf('alt') >= 0
      var needCtrl = parts.indexOf('ctrl') >= 0 || parts.indexOf('control') >= 0
      var needShift = parts.indexOf('shift') >= 0
      var key = ''
      parts.forEach(function (p) {
        if (p !== 'alt' && p !== 'ctrl' && p !== 'control' && p !== 'shift' && p !== '') key = p
      })
      if (key === '') return false
      if (needAlt !== (event.altKey === true)) return false
      if (needCtrl !== (event.ctrlKey === true)) return false
      if (needShift !== (event.shiftKey === true)) return false
      return String(event.key || '').toLowerCase() === key
    }

    var started = false
    function start() {
      if (started === true) return
      started = true
      // 每次加载都写一行版本号：确认新代码有没有真的跑起来
      dbg('boot', 'v=20261116-0920 用量显示版')
      injectCss()
      loadCfg().then(function () {
        ensureEntry()
        watchDom()
      })
      document.addEventListener('keydown', function (event) {
        if (call.open === true) {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeCall()
          }
          return
        }
        if (cfgCache === null || cfgCache.enabled === false) return
        if (matchesShortcut(event, cfgCache.shortcut) === true) {
          event.preventDefault()
          openCall()
        }
      })
    }

    function watchDom() {
      if (document.body === null) return
      var mo = new MutationObserver(function () {
        scheduleEntry()
      })
      mo.observe(document.body, { childList: true, subtree: true })
    }

    // ---------------- 设置页 ----------------
    // 音色清单与「文本声音」那个插件保持一致，下拉里能直接选
    var VOICE_GROUPS = [
      {
        g: '女声',
        items: [
          ['zh_female_tianmeitaozi_uranus_bigtts', '甜美桃子'],
          ['zh_female_qingxinnvsheng_uranus_bigtts', '清新女声'],
          ['zh_female_tianmeixiaoyuan_uranus_bigtts', '甜美小源'],
          ['zh_female_shuangkuaisisi_uranus_bigtts', '爽快思思'],
          ['zh_female_gaolengyujie_uranus_bigtts', '冷酷御姐'],
          ['zh_female_linjianvhai_uranus_bigtts', '邻家女孩'],
          ['zh_female_meilinvyou_uranus_bigtts', '魅力女友'],
          ['zh_female_roumeinvyou_uranus_bigtts', '柔美女友'],
          ['zh_female_wenroushunv_uranus_bigtts', '温柔顺女'],
          ['zh_female_xiaoxue_uranus_bigtts', '小雪'],
          ['zh_female_xiaoai_uranus_bigtts', 'Alina'],
          ['zh_female_cancan_uranus_bigtts', '灿灿'],
          ['zh_female_liuchangnv_uranus_bigtts', '流畅女声'],
          ['zh_female_jitangnv_uranus_bigtts', '鸡汤女'],
          ['zh_female_kefunvsheng_uranus_bigtts', '客服女声'],
          ['zh_female_vv_uranus_bigtts', 'Vivi'],
          ['zh_female_xiaohe_uranus_bigtts', '小何'],
        ],
      },
      {
        g: '男声',
        items: [
          ['zh_male_taocheng_uranus_bigtts', '小天 2.0'],
          ['zh_male_m191_uranus_bigtts', '云舟 2.0'],
          ['zh_male_shaonianzixin_uranus_bigtts', '少年梓辛 2.0'],
          ['zh_male_ruyayichen_uranus_bigtts', '儒雅逸辰 2.0'],
          ['zh_male_linjiananhai_uranus_bigtts', '邻家男孩 2.0'],
          ['zh_male_liufei_uranus_bigtts', '刘飞 2.0'],
          ['zh_male_youyoujunzi_uranus_bigtts', '悠悠君子 2.0'],
          ['zh_male_jieshuoxiaoming_uranus_bigtts', '解说小明 2.0'],
          ['zh_male_dayi_uranus_bigtts', '大壹 2.0'],
          ['zh_male_wennuanahu_uranus_bigtts', '温暖阿虎 2.0'],
          ['zh_male_yizhipiannan_uranus_bigtts', '译制片男 2.0'],
          ['zh_male_qingcang_uranus_bigtts', '擎苍 2.0'],
          ['zh_male_silang_uranus_bigtts', '四郎 2.0'],
        ],
      },
    ]

    var SET_STYLE = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px', color: 'inherit' },
      title: { margin: '0', fontSize: '15px', fontWeight: '600' },
      desc: { margin: '6px 0 0', opacity: 0.6, fontSize: '12px', lineHeight: 1.6 },
      card: {
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: '10px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      cardTitle: { fontSize: '12px', fontWeight: '600', opacity: 0.75 },
      row: { display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' },
      rowLabel: { flex: '0 0 84px', opacity: 0.75, fontSize: '12px' },
      input: {
        flex: '1 1 auto',
        minWidth: '0',
        padding: '6px 10px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,.28)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        outline: 'none',
        transition: 'border-color .15s ease, background .15s ease',
      },
      select: {
        flex: '1 1 auto',
        padding: '6px 8px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,.28)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        transition: 'border-color .15s ease, background .15s ease',
      },
      slider: { flex: '1 1 auto', accentColor: 'currentColor' },
      value: { flex: '0 0 44px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.7, fontSize: '12px' },
      hint: { fontSize: '11px', opacity: 0.55, margin: 0, lineHeight: 1.5 },
    }

    function PhoneSection() {
      var state = react.useState(null)
      var cfg = state[0]
      var setCfg = state[1]
      var msg = react.useState('')
      var setMsg = msg[1]
      var curState = react.useState(0)
      var setCur = curState[1]
      var errState = react.useState(false)
      var setErr = errState[1]
      // 滑块要本地即时跟手，不能每次 onChange 都往服务器写一遍再等值回来
      var rateState = react.useState({ speechRate: 0, loudness: 0 })
      var setRates = rateState[1]
      var rateTimer = react.useRef(null)

      react.useEffect(function () {
        loadCfg().then(function (value) {
          if (value !== null) {
            setCfg(value)
            setRates({ speechRate: Number(value.speechRate || 0), loudness: Number(value.loudness || 0) })
          }
        })
      }, [])

      function save(patch) {
        saveCfg(patch).then(function (value) {
          if (value !== null) setCfg(value)
          // 改完配置立刻让通话小窗吃上：头像、声线、语速都不用重开窗
          if (call.open === true) {
            paintAvatar()
            renderWindow()
          }
          setMsg('已保存')
          window.setTimeout(function () {
            setMsg('')
          }, 1500)
        })
      }

      if (cfg === null) {
        return h('div', { style: SET_STYLE.root }, h('h2', { style: SET_STYLE.title }, '语音通话'), h('p', { style: SET_STYLE.desc }, '读取中…'))
      }

      var voices = cfg.voices || {}
      var avatars = cfg.avatars || {}

      var voiceOptions = VOICE_GROUPS.map(function (group) {
        return h(
          'optgroup',
          { key: group.g, label: group.g },
          group.items.map(function (item) {
            return h('option', { key: item[0], value: item[0] }, item[1] + '　' + item[0].replace('zh_female_', '').replace('zh_male_', '').replace('_uranus_bigtts', ''))
          }),
        )
      })

      function setVoice(key, value) {
        var next = {}
        Object.keys(voices).forEach(function (name) {
          next[name] = voices[name]
        })
        next[key] = value
        save({ voices: next })
      }

      function voiceRow(key) {
        return h(
          'label',
          { key: 'v-' + key, style: SET_STYLE.row },
          h('span', { style: SET_STYLE.rowLabel }, key),
          h(
            'select',
            {
              style: SET_STYLE.select,
              value: String(voices[key] || ''),
              onChange: function (event) {
                setVoice(key, event.target.value)
              },
            },
            voiceOptions,
          ),
        )
      }

      // 头像选择器：一次只看当前这一个模型，左右箭头切下一个；
      // 顶部虚线框传本地图，中间大圆自动裁成正圆，底部圆点标位置。
      var AVATAR_STYLE = {
        dashed: {
          border: '1.5px dashed rgba(127,127,127,.4)', borderRadius: '10px', padding: '16px',
          width: '100%', textAlign: 'center', cursor: 'pointer', boxSizing: 'border-box',
        },
        ringWrap: {
          width: '150px', height: '150px', borderRadius: '50%', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(127,127,127,.12)', border: '2px solid rgba(127,127,127,.18)',
        },
        ringImg: { width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 30%' },
        ringLetter: { fontSize: '34px', fontWeight: '600', opacity: 0.5 },
        arrowBtn: {
          width: '42px', height: '42px', borderRadius: '50%', border: '1px solid rgba(127,127,127,.2)',
          background: 'rgba(127,127,127,.08)', cursor: 'pointer', fontSize: '20px', lineHeight: '1', color: 'inherit',
        },
      }

      function renderAvatarPicker() {
        var models = Object.keys(voices)
        if (models.length === 0) models = ['默认']
        var cur = curState[0] % models.length
        var err = errState[0]
        var current = models[cur]

        function go(delta) {
          setErr(false)
          setCur(function (c) {
            return (c + delta + models.length) % models.length
          })
        }

        function chooseFile() {
          var input = document.createElement('input')
          input.type = 'file'
          input.accept = 'image/*'
          input.style.display = 'none'
          document.body.appendChild(input)
          var drop = function () {
            window.removeEventListener('focus', drop)
            window.setTimeout(function () {
              try {
                input.remove()
              } catch (error) {
                /* 已经没了 */
              }
            }, 600)
          }
          window.addEventListener('focus', drop)
          input.addEventListener('change', function () {
            window.removeEventListener('focus', drop)
            var file = input.files !== null && input.files.length > 0 ? input.files[0] : null
            input.remove()
            if (file === null || file === undefined) return
            if (String(file.type || '').indexOf('image/') !== 0) {
              toast('这不是图片文件')
              return
            }
            if (file.size > 12 * 1024 * 1024) {
              toast('图片太大，换一张小于 12MB 的')
              return
            }
            var reader = new FileReader()
            reader.onload = function () {
              toast('正在换头像…')
              fetch(baseUrl() + '/phone/avatar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: current, dataUrl: String(reader.result || '') }),
              })
                .then(function (r) {
                  return r.json()
                })
                .then(function (json) {
                  if (json !== null && json.ok === true) {
                    var next = {}
                    Object.keys(avatars).forEach(function (name) {
                      next[name] = avatars[name]
                    })
                    var target = String(json.model || current)
                    next[target] = String(json.path || next[target] || '')
                    save({ avatars: next })
                    setErr(false)
                    toast('头像换好了：' + target)
                  } else {
                    toast('换头像失败：' + (json === null ? '未知错误' : String(json.error || '')))
                  }
                })
                .catch(function (e) {
                  toast('换头像失败：' + String(e.message || e))
                })
            }
            reader.readAsDataURL(file)
          })
          input.click()
        }

        var letter = (current.replace(/[^A-Za-z0-9]/g, '') || 'AI').slice(0, 2).toUpperCase()
        var preview = baseUrl() + '/phone/avatar?model=' + encodeURIComponent(current) + '&t=' + Date.now()

        return h(
          'div',
          { key: 'avatar-' + current, style: { display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center' } },
          h(
            'div',
            { onClick: chooseFile, role: 'button', style: AVATAR_STYLE.dashed, title: '点击选择本地图片' },
            h('div', { style: { fontSize: '13px', fontWeight: '600' } }, '上传图片'),
            h('div', { style: { fontSize: '11px', opacity: 0.55, marginTop: '2px' } }, '支持图片文件，自动裁成圆形头像'),
          ),
          h(
            'div',
            { style: AVATAR_STYLE.ringWrap },
            err
              ? h('div', { style: AVATAR_STYLE.ringLetter }, letter)
              : h('img', { key: current, className: 'dsh-av-img', src: preview, onError: function () { setErr(true) }, style: AVATAR_STYLE.ringImg, alt: current }),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '18px' } },
            h('button', { onClick: function () { go(-1) }, style: AVATAR_STYLE.arrowBtn, 'aria-label': '上一个模型' }, '‹'),
            h('div', { style: { fontSize: '13px', fontWeight: '600', minWidth: '120px', textAlign: 'center' } }, current),
            h('button', { onClick: function () { go(1) }, style: AVATAR_STYLE.arrowBtn, 'aria-label': '下一个模型' }, '›'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            models.map(function (_, i) {
              return h('span', {
                key: i,
                style: {
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: i === cur ? 'currentColor' : 'rgba(127,127,127,.35)',
                  opacity: i === cur ? 1 : 0.6,
                },
              })
            }),
          ),
          h('input', {
            style: SET_STYLE.input,
            defaultValue: String(avatars[current] || ''),
            placeholder: '或填本地路径 / 网址，留空用首字母',
            spellCheck: false,
            onBlur: function (event) {
              var next = {}
              Object.keys(avatars).forEach(function (name) {
                next[name] = avatars[name]
              })
              var value = event.target.value.trim()
              if (value === '') delete next[current]
              else next[current] = value
              save({ avatars: next })
            },
          }),
        )
      }

      function rateRow(label, field) {
        var value = Number((rateState[0] && rateState[0][field]) || 0)
        function change(next) {
          var patch = {}
          patch[field] = next
          var merged = {}
          Object.keys(rateState[0] || {}).forEach(function (name) {
            merged[name] = rateState[0][name]
          })
          merged[field] = next
          setRates(merged)
          // 拖一次写一次太频繁，停手 260ms 再落盘，拖动过程里滑块完全跟手
          if (rateTimer.current !== null) window.clearTimeout(rateTimer.current)
          rateTimer.current = window.setTimeout(function () {
            rateTimer.current = null
            save(patch)
          }, 260)
        }
        return h(
          'label',
          { key: field, style: SET_STYLE.row },
          h('span', { style: SET_STYLE.rowLabel }, label),
          h('input', {
            style: SET_STYLE.slider,
            type: 'range',
            min: -50,
            max: 100,
            step: 5,
            value: value,
            onChange: function (event) {
              change(Number(event.target.value))
            },
          }),
          h('span', { style: SET_STYLE.value }, (value > 0 ? '+' : '') + value),
        )
      }

      return h(
        'div',
        { style: SET_STYLE.root },
        h(
          'div',
          { key: 'head' },
          h('h2', { style: SET_STYLE.title }, '语音通话'),
          h('p', { style: SET_STYLE.desc }, '电话里它说的每一句都会念出来；通话内容只显示在通话小窗，不写进工作台。'),
        ),
        h(
          'div',
          { key: 'api', style: SET_STYLE.card },
          h('div', { style: SET_STYLE.cardTitle }, '语音模型 API'),
          h(
            'label',
            { style: SET_STYLE.row },
            h('span', { style: SET_STYLE.rowLabel }, '接口地址'),
            h('input', {
              style: SET_STYLE.input,
              defaultValue: String(cfg.endpoint || ''),
              spellCheck: false,
              placeholder: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
              onBlur: function (event) {
                save({ endpoint: event.target.value.trim() })
              },
            }),
          ),
          h(
            'label',
            { style: SET_STYLE.row },
            h('span', { style: SET_STYLE.rowLabel }, '访问密钥'),
            h('input', {
              style: SET_STYLE.input,
              type: 'password',
              defaultValue: '',
              spellCheck: false,
              placeholder: cfg.keyCustom === true ? '已填自定义密钥，留空不改' : '用 .credentials.yaml 里的 VOLCENGINE_TTS_API_KEY',
              onBlur: function (event) {
                save({ apiKey: event.target.value.trim() })
              },
            }),
          ),
          h('p', { style: SET_STYLE.hint }, '模型固定为豆包语音合成 2.0（seed-tts-2.0）· 24kHz · 音色以 uranus_bigtts 结尾才可用。密钥与地址都能随时换，填完立即生效。'),
        ),
        h(
          'div',
          { key: 'content', style: SET_STYLE.card },
          h('div', { style: SET_STYLE.cardTitle }, '通话内容与日志'),
          h(
            'label',
            { style: SET_STYLE.row },
            h('span', { style: SET_STYLE.rowLabel }, '每句都念'),
            h('span', { style: { flex: '1 1 auto', fontSize: '12px', opacity: .6 } }, '电话模式固定开启（工作台不受影响）'),
          ),
          h(
            'label',
            { style: SET_STYLE.row },
            h('span', { style: SET_STYLE.rowLabel }, '推理模型'),
            h('span', { style: { flex: '1 1 auto', fontSize: '12px', opacity: .6 } }, '跟随面板当前选中的模型'),
          ),
          h(
            'label',
            { style: SET_STYLE.row },
            h('span', { style: SET_STYLE.rowLabel }, '保存通话记录'),
            h('input', {
              type: 'checkbox',
              checked: cfg.logEnabled !== false,
              onChange: function (event) {
                save({ logEnabled: event.target.checked })
              },
            }),
          ),
          h(
            'label',
            { style: SET_STYLE.row },
            h('span', { style: SET_STYLE.rowLabel }, '保存目录'),
            h('input', {
              style: SET_STYLE.input,
              defaultValue: String(cfg.logDir || ''),
              spellCheck: false,
              onBlur: function (event) {
                save({ logDir: event.target.value.trim() })
              },
            }),
          ),
          h('p', { style: SET_STYLE.hint }, '每通电话一个 md 文件，只记「你说的话 / 它说的话」和各自时间。'),
        ),
        h(
          'div',
          { key: 'voice', style: SET_STYLE.card },
          h('div', { style: SET_STYLE.cardTitle }, '音色（每个模型一条）'),
          Object.keys(voices).map(voiceRow),
          h('p', { style: SET_STYLE.hint }, '同一个模型的所有档位共用一个音色。'),
        ),
        h(
          'div',
          { key: 'tune', style: SET_STYLE.card },
          h('div', { style: SET_STYLE.cardTitle }, '语速与音量'),
          rateRow('语速', 'speechRate'),
          rateRow('音量', 'loudness'),
          h('p', { style: SET_STYLE.hint }, '范围 -50 到 100，0 为默认；改完立即生效，不用重启。'),
        ),
        h(
          'div',
          { key: 'avatar', style: SET_STYLE.card },
          h('div', { style: SET_STYLE.cardTitle }, '每个模型的头像'),
          renderAvatarPicker(),
          h('p', { style: SET_STYLE.hint }, '左右箭头切换模型；上传本地图后自动居中裁成正圆，同一厂牌档位共用一张头像。'),
        ),
        h('p', { key: 'msg', style: SET_STYLE.hint }, msg[0] || ''),
      )
    }

    exports.apply = function (ctx) {
      try {
        start()
      } catch (error) {
        /* 注入失败不影响主界面 */
      }
      try {
        if (ctx !== null && ctx !== undefined && ctx.slots !== undefined) {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'ai-phone',
                order: 61,
                label: function () {
                  return '语音通话'
                },
              },
              PhoneSection,
            )
          })
        }
      } catch (error) {
        /* 设置页注册失败不影响通话 */
      }
    }
    exports.inject = ['slots']
    return module.exports
  },
})
