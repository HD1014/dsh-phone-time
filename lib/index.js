// dsh-ai-phone — 宿主侧
//
// 只做三件事，不碰 DSH 的任务调度：
//   1. 用火山引擎豆包 TTS（复用 dsh-tts-speak-button 里验证过的那套合成代码）把文字合成为 wav；
//   2. 管自己的配置文件（开关、快捷键、每个模型的声线、每个模型的概念图路径）；
//   3. 给前端一个只监听 127.0.0.1 的小接口，外加把本地概念图读成图片给通话窗口当头像。
//
// 路由：
//   GET  /phone/health            自检
//   GET  /phone/config            开关 / 快捷键 / 声线表 / 头像表
//   POST /phone/config            改上面这些（json 局部覆盖）
//   POST /phone/speak             { text, model } → NDJSON，每合成好一句吐一行，边出字边播
//   POST /phone/stop              让后续分段别再合成
//   GET  /phone/audio/<name>.wav  取合成结果
//   GET  /phone/avatar?model=xx   把概念图读成图片（圆形裁切在前端 CSS 里做）
//   GET  /phone/panel             通话面板页：独立窗口/浮窗都加载这一份
//
// 音频必须请求 format:'pcm'（pcm16 不被认，会回 mp3，拼成 wav 就是沙沙声）。

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PORT = 18770
const ALT_PORT = 18771
const RESOURCE_ID = 'seed-tts-2.0'
const SAMPLE_RATE = 24000
const KEY_NAME = 'VOLCENGINE_TTS_API_KEY'
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const DIR = path.join(os.tmpdir(), 'dsh-ai-phone')
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'dsh-ai-phone.json')
// 用户从小窗里拖进来的概念图就存在这里，路径写进配置，下次开窗直接读
const AVATAR_DIR = path.join(os.homedir(), '.dsh', 'dsh-ai-phone-avatars')
const PATCH_FILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

// 每个模型一条默认声线；用户可以在配置文件里覆盖，键是模型名里的关键字。
const DEFAULT_VOICES = {
  DeepSeek: 'zh_female_tianmeitaozi_uranus_bigtts',
  GPT: 'zh_female_qingxinnvsheng_uranus_bigtts',
  Claude: 'zh_female_gaolengyujie_uranus_bigtts',
  Gemini: 'zh_female_linjianvhai_uranus_bigtts',
  Kimi: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
  GLM: 'zh_female_roumeinvyou_uranus_bigtts',
  Qwen: 'zh_female_shuangkuaisisi_uranus_bigtts',
}
const DEFAULT_VOICE = 'zh_female_tianmeitaozi_uranus_bigtts'

// 第一段短一点，先出声；后面每段长一点，少些接缝。
// 中转站（shanyiapi / datasea 等）前面挂着 Cloudflare。
// 请求头里没有浏览器 UA 时会被直接拦掉，返回 403 "error code: 1010"，
// 在 Node 里看起来就是一个没头没尾的 fetch failed。这里统一带上浏览器头。
// DeepSeek 那家中转的连接握手经常十几秒，undici 默认 10 秒就判连接超时，
// 表现成一句没头没尾的 fetch failed。这里做两件事：
//   1) DeepSeek 系列优先直连官方 api.deepseek.com（同一个模型，快且稳），
//      拿不到官方密钥或官方也失败时，再回落到 DSH 配置里的中转地址；
//   2) 连接级失败（握手超时 / 连接被重置）隔 500ms 自动重试一次；
//      已经拿到 HTTP 状态的失败不重试，避免同一句话被重复计费。
const DIRECT_FALLBACKS = {
  'deepseek-flash': { baseURL: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  'deepseek-v4-pro': { baseURL: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const FIRST_CHARS = 26
const NEXT_CHARS = 160

let counter = 0
let lastError = ''
let cancelToken = 0

function readKey() {
  const fromEnv = process.env[KEY_NAME]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    if (!fs.existsSync(file)) return ''
    const raw = fs.readFileSync(file, 'utf8')
    const match = new RegExp('^\\s*' + KEY_NAME + '\\s*:\\s*(.+)$', 'm').exec(raw)
    if (match === null) return ''
    return match[1].trim().replace(/^["']|["']$/g, '')
  } catch (error) {
    return ''
  }
}

function readConfigRaw() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') return parsed
    }
  } catch (error) {
    /* 配置坏了就当空 */
  }
  return {}
}

function clampRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(-50, Math.min(100, Math.round(n)))
}


// ---------------- DSH 自己的模型清单 ----------------
// 电话要“由当前选中的模型来接”，又不能让闲聊跑到工作台的对话里，
// 所以这里直接读 DSH 的 provider 配置，自己打 chat/completions。
// 配置改了会自动重新读（按文件 mtime）。
let providerCache = { mtime: -1, providers: {}, defProvider: '', defModel: '' }

const TIER_WORDS = ['lite', 'flash', 'high', 'low', 'max', 'medium', 'pro', 'plus', 'mini', 'turbo', 'ultra']

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

function stripTier(value) {
  let name = normName(value)
  let again = true
  while (again) {
    again = false
    for (const word of TIER_WORDS) {
      if (name.length > word.length && name.endsWith(word)) {
        name = name.slice(0, name.length - word.length)
        again = true
      }
    }
  }
  return name
}

function readProviders() {
  let mtime = 0
  try {
    mtime = fs.statSync(PATCH_FILE).mtimeMs
  } catch (error) {
    return providerCache
  }
  if (mtime === providerCache.mtime) return providerCache
  let text = ''
  try {
    text = fs.readFileSync(PATCH_FILE, 'utf8')
  } catch (error) {
    return providerCache
  }
  const providers = {}
  let inProviders = false
  let current = null
  let inModels = false
  let pending = null
  let inDefault = false
  let defProvider = ''
  let defModel = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] === '#') continue
    const indent = line.length - line.trimStart().length
    // 顶层 patch 项：0 缩进的 “- id: xxx”
    if (indent <= 2 && trimmed.indexOf('- id:') === 0) {
      inDefault = trimmed.indexOf('agent-default-model') >= 0
      inProviders = false
      current = null
      inModels = false
      continue
    }
    if (trimmed === 'providers:') {
      inProviders = true
      current = null
      inModels = false
      continue
    }
    if (inDefault === true) {
      if (trimmed.indexOf('provider:') === 0) defProvider = trimmed.slice(9).trim()
      else if (trimmed.indexOf('model:') === 0) defModel = trimmed.slice(6).trim()
      continue
    }
    if (indent <= 4) {
      inProviders = false
      current = null
      inModels = false
      continue
    }
    if (inProviders !== true) continue
    if (indent === 6) {
      const hit = /^([a-z0-9-]+):\s*$/.exec(trimmed)
      if (hit !== null) {
        current = hit[1]
        providers[current] = { key: current, displayName: current, apiKeyEnv: '', baseURL: '', models: [] }
        inModels = false
        pending = null
      }
      continue
    }
    if (current === null) continue
    if (trimmed === 'models:') {
      inModels = true
      pending = null
      continue
    }
    if (inModels === true) {
      if (trimmed.indexOf('- id:') === 0) {
        pending = { id: trimmed.slice(5).trim().replace(/^["']|["']$/g, ''), name: '' }
        providers[current].models.push(pending)
        continue
      }
      if (pending !== null && trimmed.indexOf('name:') === 0) {
        pending.name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '')
        pending = null
      }
      continue
    }
    const pair = /^([A-Za-z]+):\s*(.+)$/.exec(trimmed)
    if (pair !== null) {
      const key = pair[1]
      const value = pair[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'apiKeyEnv') providers[current].apiKeyEnv = value
      else if (key === 'baseURL') providers[current].baseURL = value
      else if (key === 'displayName') providers[current].displayName = value
    }
  }
  providerCache = { mtime, providers, defProvider, defModel }
  return providerCache
}

// 面板上的名字（可能带 Low/Lite 之类只是好看的档位后缀）→ provider + 真实模型 id
const PROVIDER_HINTS = [
  { words: ['deepseek'], key: 'deepseek' },
  { words: ['claude'], key: 'claude' },
  { words: ['gemini'], key: 'gemini' },
  { words: ['kimi', 'moonshot'], key: 'kimi' },
  { words: ['glm', '智谱'], key: 'glm' },
  { words: ['qwen', '千问', '通义'], key: 'qwen' },
  { words: ['gpt', 'openai'], key: 'gpt' },
]

function resolveModel(panelName) {
  const cache = readProviders()
  const wanted = stripTier(panelName)
  const wantedRaw = normName(panelName)
  let best = null
  for (const key of Object.keys(cache.providers)) {
    const provider = cache.providers[key]
    for (const model of provider.models) {
      const names = [model.name, model.id]
      for (const candidate of names) {
        const stripped = stripTier(candidate)
        if (stripped === '') continue
        if (stripped === wanted || stripped === wantedRaw) {
          if (best === null || stripped.length > best.score) best = { provider, model, score: stripped.length }
        } else if (wanted.indexOf(stripped) >= 0 || stripped.indexOf(wanted) >= 0) {
          if (best === null || stripped.length > best.score) best = { provider, model, score: stripped.length }
        }
      }
    }
  }
  if (best === null) {
    // 退一步：按厂牌关键字找 provider，用它的第一个模型
    for (const hint of PROVIDER_HINTS) {
      let matched = false
      for (const word of hint.words) {
        if (wantedRaw.indexOf(word) >= 0) {
          matched = true
          break
        }
      }
      if (matched !== true) continue
      for (const key of Object.keys(cache.providers)) {
        if (key.toLowerCase().indexOf(hint.key) < 0) continue
        const provider = cache.providers[key]
        if (provider.models.length > 0) best = { provider, model: provider.models[0], score: 1 }
        break
      }
    }
  }
  if (best === null && cache.defProvider !== '') {
    const provider = cache.providers[cache.defProvider]
    if (provider !== undefined) {
      const model = provider.models.find(item => item.id === cache.defModel) || provider.models[0]
      if (model !== undefined) best = { provider, model, score: 1 }
    }
  }
  return best
}

function readCredential(name) {
  if (typeof name !== 'string' || name === '') return ''
  const fromEnv = process.env[name]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    if (!fs.existsSync(file)) return ''
    const raw = fs.readFileSync(file, 'utf8')
    const match = new RegExp('^\\s*' + name + '\\s*:\\s*(.+)$', 'm').exec(raw)
    if (match === null) return ''
    return match[1].trim().replace(/^["']|["']$/g, '')
  } catch (error) {
    return ''
  }
}

// ---------------- 通话日志 ----------------
function logDirOf(cfg) {
  const dir = typeof cfg.logDir === 'string' && cfg.logDir.trim() !== ''
    ? cfg.logDir.trim()
    : path.join(os.homedir(), 'Documents', 'DSH-AI通话日志')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function appendCallLog(callId, model, userText, replyText) {
  const cfg = readConfig()
  if (cfg.logEnabled === false) return
  try {
    const dir = logDirOf(cfg)
    const safe = String(callId || 'call').replace(/[^A-Za-z0-9._-]/g, '_')
    const file = path.join(dir, '通话-' + safe + '.md')
    const when = new Date()
    const stamp = when.getFullYear() + '-' + String(when.getMonth() + 1).padStart(2, '0') + '-' + String(when.getDate()).padStart(2, '0') + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') + ':' + String(when.getSeconds()).padStart(2, '0')
    const head = fs.existsSync(file) ? '' : '# AI 语音通话记录\n\n- 会话：' + safe + '\n- 模型：' + model + '\n\n'
    const body = '## ' + stamp + '\n\n**你说**\n\n' + String(userText || '') + '\n\n**它说**\n\n' + String(replyText || '') + '\n\n'
    fs.appendFileSync(file, head + body, 'utf8')
  } catch (error) {
    lastError = '日志写入失败: ' + String(error.message || error)
  }
}

function readConfig() {
  const raw = readConfigRaw()
  return {
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    shortcut: typeof raw.shortcut === 'string' && raw.shortcut.trim() !== '' ? raw.shortcut.trim() : 'Alt+Shift+P',
    baseVoice: typeof raw.baseVoice === 'string' && raw.baseVoice.trim() !== '' ? raw.baseVoice.trim() : DEFAULT_VOICE,
    speechRate: clampRate(raw.speechRate),
    voices: raw.voices !== null && typeof raw.voices === 'object' ? Object.assign({}, DEFAULT_VOICES, raw.voices) : Object.assign({}, DEFAULT_VOICES),
    // 概念图：键为模型关键字，值为本地图片绝对路径或 http(s) 地址
    avatars: raw.avatars !== null && typeof raw.avatars === 'object' ? raw.avatars : {},
    isolateSession: raw.isolateSession === undefined ? true : raw.isolateSession === true,
    loudness: clampRate(raw.loudness),
    logEnabled: raw.logEnabled === undefined ? true : raw.logEnabled === true,
    logDir: typeof raw.logDir === 'string' ? raw.logDir : '',
    // 语音密钥和接口地址允许在设置页里直接改；留空就沿用 .credentials.yaml / 默认火山地址
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    endpoint: typeof raw.endpoint === 'string' && raw.endpoint.trim() !== '' ? raw.endpoint.trim() : ENDPOINT,
    avatarPos: raw.avatarPos !== null && typeof raw.avatarPos === 'object' ? raw.avatarPos : {},
  }
}

function writeConfig(patch) {
  const next = Object.assign({}, readConfigRaw())
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (typeof patch.shortcut === 'string' && patch.shortcut.trim() !== '') next.shortcut = patch.shortcut.trim()
  if (typeof patch.baseVoice === 'string' && patch.baseVoice.trim() !== '') next.baseVoice = patch.baseVoice.trim()
  if (patch.speechRate !== undefined) next.speechRate = clampRate(patch.speechRate)
  if (patch.voices !== null && typeof patch.voices === 'object') next.voices = patch.voices
  if (patch.avatars !== null && typeof patch.avatars === 'object') next.avatars = patch.avatars
  if (patch.isolateSession !== undefined) next.isolateSession = patch.isolateSession === true
  if (patch.loudness !== undefined) next.loudness = clampRate(patch.loudness)
  if (patch.logEnabled !== undefined) next.logEnabled = patch.logEnabled === true
  if (typeof patch.logDir === 'string') next.logDir = patch.logDir
  if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim()
  if (typeof patch.endpoint === 'string') next.endpoint = patch.endpoint.trim()
  if (patch.avatarPos !== null && typeof patch.avatarPos === 'object') next.avatarPos = patch.avatarPos
  const text = JSON.stringify(next, null, 2)
  const tmp = CONFIG_FILE + '.tmp'
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    // 每次真正落盘前留一份上一版，配置写坏了还能拿回来
    try {
      fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak-auto')
    } catch (error) {
      /* 第一次保存时旧文件还不存在 */
    }
    fs.renameSync(tmp, CONFIG_FILE)
  } catch (error) {
    // rename 被占用等情况退回直接写，并清掉临时文件
    try {
      fs.unlinkSync(tmp)
    } catch (inner) {
      /* 忽略 */
    }
    fs.writeFileSync(CONFIG_FILE, text, 'utf8')
  }
  return readConfig()
}

function publicConfig() {
  const cfg = readConfig()
  return {
    ok: true,
    enabled: cfg.enabled,
    shortcut: cfg.shortcut,
    baseVoice: cfg.baseVoice,
    speechRate: cfg.speechRate,
    voices: cfg.voices,
    avatars: cfg.avatars,
    isolateSession: cfg.isolateSession,
    loudness: cfg.loudness,
    logEnabled: cfg.logEnabled,
    logDir: cfg.logDir === '' ? path.join(os.homedir(), 'Documents', 'DSH-AI通话日志') : cfg.logDir,
    keyConfigured: cfg.apiKey !== '' || readKey() !== '',
    keyCustom: cfg.apiKey !== '',
    endpoint: cfg.endpoint,
    avatarPos: cfg.avatarPos,
    configFile: CONFIG_FILE,
  }
}

// 按句切段，第一段短一些以便尽快出声。
function splitText(text) {
  const normalized = String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim()
  if (normalized === '') return []
  const pieces = normalized.split(/(?<=[。！？!?；;\n])/).map(piece => piece.trim()).filter(piece => piece !== '')
  const segments = []
  let buffer = ''
  for (const piece of pieces) {
    const limit = segments.length === 0 ? FIRST_CHARS : NEXT_CHARS
    if (piece.length <= limit && buffer.length + piece.length <= limit) {
      buffer += piece
      continue
    }
    if (buffer !== '') segments.push(buffer)
    buffer = ''
    if (piece.length <= limit) {
      buffer = piece
      continue
    }
    for (let index = 0; index < piece.length; index += limit) {
      segments.push(piece.slice(index, index + limit))
    }
  }
  if (buffer !== '') segments.push(buffer)
  return segments
}

// 按模型名挑配置：命中关键字就用自己的，多个关键字同时命中时取最长的那个。
// 这样 DeepSeek-V4.1-Flash / DeepSeek-V4.1-Max / 任何 DeepSeek 档位都落在同一条
// 「DeepSeek」配置上 → 同一个声线、同一张头像，不会因为档位不同而串味。
function matchKey(map, model) {
  const name = String(model || '').toLowerCase()
  let bestKey = ''
  let bestValue = ''
  for (const key of Object.keys(map)) {
    if (key === '') continue
    if (name.indexOf(String(key).toLowerCase()) >= 0 && key.length > bestKey.length) {
      bestKey = key
      bestValue = String(map[key] || '').trim()
    }
  }
  return bestValue
}

function voiceFor(model) {
  const cfg = readConfig()
  if (String(model || '') === '') return cfg.baseVoice
  const matched = matchKey(cfg.voices, model)
  return matched !== '' ? matched : cfg.baseVoice
}

async function synthPcm(text, voice) {
  const cfg = readConfig()
  const key = cfg.apiKey !== '' ? cfg.apiKey : readKey()
  if (key === '') throw new Error('没有找到密钥 ' + KEY_NAME + '（可在「语音通话」设置里直接填）')
  const endpoint = cfg.endpoint !== '' ? cfg.endpoint : ENDPOINT
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-Api-Key': key,
      'X-Api-Resource-Id': RESOURCE_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user: { uid: 'dsh-desktop' },
      req_params: {
        text,
        speaker: voice,
        audio_params: {
          format: 'pcm',
          sample_rate: SAMPLE_RATE,
          speech_rate: cfg.speechRate,
          loudness_rate: cfg.loudness,
        },
      },
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + raw.slice(0, 200))
  const parts = []
  let code = -1
  let message = ''
  for (const line of raw.split(/\r?\n/)) {
    const piece = line.trim()
    if (piece === '' || piece[0] !== '{') continue
    try {
      const json = JSON.parse(piece)
      if (typeof json.code === 'number') code = json.code
      if (typeof json.message === 'string') message = json.message
      if (typeof json.data === 'string' && json.data !== '') parts.push(Buffer.from(json.data, 'base64'))
    } catch (error) {
      /* 噪声行跳过 */
    }
  }
  if (parts.length === 0) throw new Error('合成失败 code=' + code + ' ' + message)
  return Buffer.concat(parts)
}

function pcmToWav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function durationOf(pcm) {
  return Math.round((pcm.length / (SAMPLE_RATE * 2)) * 1000)
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    req.on('data', chunk => parts.push(chunk))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}


// 前端把每一步的判定写过来，出问题时直接看这个文件，不用猜
function appendDebug(line) {
  try {
    ensureDir()
    const day = new Date().toISOString().slice(0, 10)
    const file = path.join(DIR, 'debug-' + day + '.log')
    fs.appendFileSync(file, '[' + new Date().toTimeString().slice(0, 8) + '] ' + String(line).slice(0, 600) + '\n', 'utf8')
  } catch (error) {
    /* 日志失败不影响主流程 */
  }
}

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function sweep() {
  try {
    const now = Date.now()
    for (const name of fs.readdirSync(DIR)) {
      const file = path.join(DIR, name)
      if (now - fs.statSync(file).mtimeMs > 3600000) fs.unlinkSync(file)
    }
  } catch (error) {
    /* 清理失败不影响使用 */
  }
}

// 一句话一句话地合成并吐出，前端收到就播，不用等整段。
async function handleSpeak(req, res) {
  const raw = await readBody(req)
  let text = ''
  let model = ''
  try {
    const body = JSON.parse(raw)
    text = String(body.text || '')
    model = String(body.model || '')
  } catch (error) {
    send(res, 400, { ok: false, error: 'bad json' })
    return
  }
  const segments = splitText(text)
  if (segments.length === 0) {
    send(res, 400, { ok: false, error: '没有可朗读的文字' })
    return
  }
  const voice = voiceFor(model)
  const token = (cancelToken += 1)
  ensureDir()
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'X-Accel-Buffering': 'no',
  })
  try {
    for (const segment of segments) {
      if (token !== cancelToken) break
      const pcm = await synthPcm(segment, voice)
      counter += 1
      const name = 'call-' + Date.now() + '-' + counter + '.wav'
      fs.writeFileSync(path.join(DIR, name), pcmToWav(pcm))
      res.write(JSON.stringify({ url: '/phone/audio/' + name, durationMs: durationOf(pcm), chars: segment.length, voice }) + '\n')
    }
  } catch (error) {
    appendDebug(
      'speak-err | model=' +
        model +
        ' voice=' +
        voice +
        ' | ' +
        String((error && error.message) || error) +
        ' | cause=' +
        String((error && error.cause && (error.cause.code || error.cause.message)) || '-')
    )
    lastError = String(error.message || error)
    res.write(JSON.stringify({ error: lastError }) + '\n')
  }
  res.end()
}


// ---------------- 电话专用推理：不进工作台的会话 ----------------
// 前端把这一轮说的话发过来，这里按“面板当前模型”找到 DSH 配置里对应的
// provider + 模型 id，直连 OpenAI 兼容端点，边出字边吐给前端。
// 把各家不一样的 usage 字段归一成小窗要的三样东西：
// 本步 token、缓存命中率、这一轮一共吃了多少 prompt token
function usageSummary(usage, messages, full) {
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    const guessPrompt = Math.round(JSON.stringify(messages).length / 2)
    const guessOut = Math.round(String(full || '').length / 2)
    return { promptTokens: guessPrompt, completionTokens: guessOut, totalTokens: guessPrompt + guessOut, cacheHitRate: -1, estimated: true }
  }
  const prompt =
    Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0) || 0
  const completion =
    Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0) || 0
  const total = Number(usage.total_tokens ?? 0) || prompt + completion
  // DeepSeek / 部分中转会明确给缓存命中的 token 数
  const hit = Number(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? -1)
  const miss = Number(usage.prompt_cache_miss_tokens ?? -1)
  let rate = -1
  if (hit >= 0) {
    const base = hit + (miss >= 0 ? miss : Math.max(prompt - hit, 0))
    if (base > 0) rate = hit / base
  } else if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    const cached = Number(usage.prompt_tokens_details.cached_tokens ?? -1)
    if (cached >= 0 && prompt > 0) rate = cached / prompt
  }
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total, cacheHitRate: rate, estimated: false }
}

async function handleChat(req, res) {
  const raw = await readBody(req)
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch (error) {
    send(res, 400, { ok: false, error: 'bad json' })
    return
  }
  const panelModel = String(body.model || '')
  const callId = String(body.callId || '')
  const history = Array.isArray(body.history) ? body.history : []
  const text = String(body.text || '').trim()
  if (text === '') {
    send(res, 400, { ok: false, error: '没有输入内容' })
    return
  }
  const picked = resolveModel(panelModel)
  if (picked === null) {
    send(res, 400, { ok: false, error: '在 DSH 的 provider 配置里没找到这个模型：' + (panelModel || '(空)') })
    return
  }
  const key = readCredential(picked.provider.apiKeyEnv)
  if (key === '') {
    send(res, 400, { ok: false, error: '缺少密钥 ' + picked.provider.apiKeyEnv })
    return
  }
  const base = String(picked.provider.baseURL || '').replace(/\/+$/, '')
  if (base === '') {
    send(res, 400, { ok: false, error: 'provider 没配 baseURL' })
    return
  }
  const messages = [
    { role: 'system', content: '你在电话通话里跟用户闲聊，说话要短、口语化、自然，像真人聊天，不要列清单、不要写代码、不要长篇。' },
  ]
  for (const item of history) {
    if (item === null || typeof item !== 'object') continue
    const role = item.role === 'user' ? 'user' : 'assistant'
    const content = String(item.content || '')
    if (content !== '') messages.push({ role, content })
  }
  messages.push({ role: 'user', content: text })

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'X-Accel-Buffering': 'no',
  })
  let full = ''
  // usage 必须是这一轮自己的：以前没声明，等于挂在全局上，
  // 下一轮会读到上一轮的数字，小窗里显示的速度/缓存就是别人的。
  let lastUsage = null
  const endpointUrl = base + '/chat/completions'
  appendDebug(
    'chat-up | ' +
      endpointUrl +
      ' | model=' +
      picked.model.id +
      ' | provider=' +
      String(picked.provider.id || picked.provider.name || '?') +
      ' | keyLen=' +
      key.length
  )
  // 先直连官方，再走中转，谁先成功用谁
  const attempts = []
  const direct = DIRECT_FALLBACKS[picked.model.id]
  if (direct !== undefined) {
    const directKey = readCredential(direct.keyEnv)
    if (directKey !== '') {
      attempts.push({
        url: String(direct.baseURL).replace(/\/+$/, '') + '/chat/completions',
        key: directKey,
        model: direct.model,
        tag: '官方直连',
      })
    }
  }
  attempts.push({ url: endpointUrl, key, model: picked.model.id, tag: '中转' })

  try {
    let upstream = null
    let usedUrl = ''
    let usedModel = ''
    let reader = null
    let closed = false
    // 前端挂断 / 刷新页面时把这个请求掐掉，别让上游继续烧 token
    res.on('close', () => {
      closed = true
      if (reader !== null) {
        try {
          reader.cancel()
        } catch (error) {
          /* 已经读完 */
        }
      }
    })
    for (const attempt of attempts) {
      try {
        const payloadOf = withUsage => {
          const payload = {
            model: attempt.model,
            messages,
            stream: true,
            max_tokens: 700,
            temperature: 0.8,
          }
          // 小窗要显示本步 token / 缓存命中率 / 上下文余量，所以先要服务端回 usage。
          // 个别 OpenAI 兼容端点不认 stream_options 会直接 400，那种情况去掉它重发一次。
          if (withUsage === true) payload.stream_options = { include_usage: true }
          return JSON.stringify(payload)
        }
        const callOnce = withUsage =>
          fetch(attempt.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + attempt.key,
              'User-Agent': BROWSER_UA,
              Accept: 'text/event-stream',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            body: payloadOf(withUsage),
          })
        // 中转站前面挂着 Cloudflare，连接握手经常超过 undici 默认的 10 秒，
        // 请求还没发出去就被判失败，前端只看到一句 fetch failed、完全没有回话。
        // 这种「连接级」失败没有产生任何计费，隔 500ms 重试一次能救回大部分。
        let response = null
        let failText = ''
        let netError = null
        for (let round = 0; round < 2; round += 1) {
          try {
            response = await callOnce(true)
            break
          } catch (error) {
            netError = error
            const code = String((error && error.cause && (error.cause.code || error.cause.message)) || '')
            const retriable = /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|abort|timeout/i.test(
              String((error && error.message) || '') + ' ' + code
            )
            appendDebug(
              'chat-net | ' + attempt.tag + ' 第' + (round + 1) + '次 ' + code + ' | ' + String((error && error.message) || error)
            )
            if (retriable !== true || round === 1) break
            await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
        if (response === null) {
          const reason = String((netError && netError.message) || 'fetch failed')
          const code = String((netError && netError.cause && (netError.cause.code || netError.cause.message)) || '')
          lastError = '连不上' + attempt.tag + '（' + reason + (code === '' ? '' : ' / ' + code) + '）'
          continue
        }
        if (response.ok !== true) {
          failText = String(await response.text()).slice(0, 300)
          if ((response.status === 400 || response.status === 422) && failText.indexOf('stream_options') >= 0) {
            appendDebug('chat-retry | ' + attempt.tag + ' 服务端不认 stream_options，去掉重发')
            response = await callOnce(false)
            failText = ''
          }
        }
        if (response.ok !== true) {
          if (failText === '') failText = String(await response.text()).slice(0, 300)
          lastError = 'HTTP ' + response.status + ' ' + failText.slice(0, 160)
          appendDebug('chat-http | ' + attempt.tag + ' ' + attempt.url + ' -> ' + lastError)
          continue
        }
        upstream = response
        usedUrl = attempt.url
        usedModel = attempt.model
        appendDebug('chat-ok | ' + attempt.tag + ' ' + attempt.url + ' model=' + attempt.model)
        break
      } catch (error) {
        lastError = String((error && error.message) || error)
        appendDebug(
          'chat-err | ' +
            attempt.tag +
            ' ' +
            attempt.url +
            ' -> ' +
            lastError +
            ' | cause=' +
            String((error && error.cause && (error.cause.code || error.cause.message)) || '-')
        )
      }
    }
    if (upstream === null) {
      // 两条路都走不通时，把最后一条错误说清楚，别只丢一个 fetch failed
      if (closed !== true) {
        res.write(JSON.stringify({ error: lastError, tried: attempts.map(a => a.tag + ' ' + a.url) }) + '\n')
        res.end()
      }
      appendCallLog(callId, panelModel, text, '（失败：' + lastError + '）')
      return
    }
    if (upstream.body === null || upstream.body === undefined) {
      const whole = await upstream.json()
      if (whole !== null && typeof whole === 'object' && whole.usage !== null && typeof whole.usage === 'object') {
        lastUsage = whole.usage
      }
      const content = String(whole?.choices?.[0]?.message?.content || '')
      full = content
      if (closed !== true) res.write(JSON.stringify({ delta: content }) + '\n')
    } else {
      reader = upstream.body.getReader()
      const decoder = new TextDecoder('utf-8')
      const consumeLine = line => {
        const raw = String(line).trim()
        if (raw.indexOf('data:') !== 0) return
        const payload = raw.slice(5).trim()
        if (payload === '' || payload === '[DONE]') return
        try {
          const json = JSON.parse(payload)
          if (json !== null && typeof json === 'object' && json.usage !== null && typeof json.usage === 'object') {
            lastUsage = json.usage
          }
          const delta = json?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta !== '') {
            full += delta
            if (closed !== true) res.write(JSON.stringify({ delta }) + '\n')
          }
        } catch (error) {
          /* 半行 / 心跳忽略 */
        }
      }
      let buffer = ''
      let chunks = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done === true) break
        if (closed === true) break
        chunks += 1
        if (chunks === 1) appendDebug('chat-first | ' + attempt.tag + ' 首块到达')
        buffer += decoder.decode(chunk.value, { stream: true })
        const rows = buffer.split('\n')
        buffer = rows.pop()
        for (const row of rows) consumeLine(row)
      }
      appendDebug('chat-stream-end | ' + attempt.tag + ' 块=' + chunks + ' 字=' + full.length + ' 客户端已断=' + closed)
      // 流结束时最后一行常常没有换行符，补处理一次，否则回复末尾会少几个字
      if (buffer !== '') consumeLine(buffer)
      reader = null
    }
    if (closed !== true) {
      res.write(
        JSON.stringify({
          done: true,
          model: usedModel || picked.model.id,
          provider: String(picked.provider.key || picked.provider.id || ''),
          endpoint: usedUrl,
          usage: usageSummary(lastUsage, messages, full),
        }) + '\n'
      )
    }
  } catch (error) {
    lastError = String(error.message || error)
    try {
      res.write(JSON.stringify({ error: lastError }) + '\n')
    } catch (inner) {
      /* 已断开 */
    }
  }
  if (closed !== true) res.end()
  appendCallLog(callId, panelModel, text, full)
}

function serveAudio(req, res, name) {
  if (!/^[A-Za-z0-9._-]+\.wav$/.test(name)) {
    send(res, 400, { ok: false, error: 'bad name' })
    return
  }
  const file = path.join(DIR, name)
  if (!fs.existsSync(file)) {
    send(res, 404, { ok: false, error: 'not found' })
    return
  }
  const data = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

// 小窗里把图片拖到头像框 → 前端读成 dataURL 发过来，这里落盘并把路径写回配置。
// 只做存储，不裁不缩：圆形裁切在前端用 object-fit:cover + 圆形容器完成。
async function saveAvatar(req, res) {
  try {
    const raw = await readBody(req)
    const body = JSON.parse(raw)
    const model = String(body.model || '').trim()
    const dataUrl = String(body.dataUrl || '')
    if (model === '') throw new Error('缺少模型名')
    const matched = /^data:image\/([A-Za-z+]+);base64,(.*)$/.exec(dataUrl)
    if (matched === null) throw new Error('这不是图片文件')
    let ext = matched[1].toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (['png', 'jpg', 'webp', 'gif'].indexOf(ext) < 0) ext = 'png'
    const buf = Buffer.from(matched[2], 'base64')
    if (buf.length === 0) throw new Error('图片是空的')
    if (buf.length > 16 * 1024 * 1024) throw new Error('图片太大（限 16MB）')
    fs.mkdirSync(AVATAR_DIR, { recursive: true })
    const cfg = readConfig()
    // 复用同一套匹配规则：已经给「DeepSeek」配过头像，就把新图落到 DeepSeek 上，
    // 这样同一厂牌的所有档位共用一张图。
    let targetKey = ''
    for (const key of Object.keys(cfg.avatars)) {
      if (key !== '' && model.toLowerCase().indexOf(key.toLowerCase()) >= 0 && key.length > targetKey.length) targetKey = key
    }
    if (targetKey === '') targetKey = model
    const safe = String(targetKey).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'model'
    const file = path.join(AVATAR_DIR, safe + '-' + Date.now() + '.' + ext)
    fs.writeFileSync(file, buf)
    const avatars = Object.assign({}, cfg.avatars)
    avatars[targetKey] = file
    writeConfig({ avatars })
    send(res, 200, { ok: true, model: targetKey, path: file })
  } catch (error) {
    lastError = String(error.message || error)
    send(res, 400, { ok: false, error: lastError })
  }
}

// 概念图 → 圆形头像：
//   收到的是用户给的原始素材（本地文件或网址），这里只负责把本地文件读出来给前端；
//   真正的“自动适配裁切”由前端做：图片以 object-fit:cover 铺满圆形容器并居中，
//   等比裁掉多出来的边，不拉伸变形。找不到图返回 404，前端用渐变占位头像。
function serveAvatar(req, res, model) {
  const cfg = readConfig()
  const target = matchKey(cfg.avatars, model)
  if (target === '') {
    send(res, 404, { ok: false, error: 'no avatar for ' + (model || '') })
    return
  }
  if (/^https?:\/\//i.test(target)) {
    res.writeHead(302, { Location: target, 'Access-Control-Allow-Origin': '*' })
    res.end()
    return
  }
  const file = path.isAbsolute(target) ? target : path.join(os.homedir(), '.dsh', 'avatars', target)
  if (!fs.existsSync(file)) {
    send(res, 404, { ok: false, error: 'file not found: ' + file })
    return
  }
  const ext = path.extname(file).toLowerCase()
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
  const data = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function serve(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }
  const full = req.url || '/'
  const url = full.split('?')[0]
  const query = new URLSearchParams(full.indexOf('?') >= 0 ? full.slice(full.indexOf('?')) : '')

  if (url === '/phone/panel') {
    // 通话面板页：独立窗口（window.open）和浮窗（iframe）加载的都是这一份，
    // 页面自己带样式和脚本，不受主界面 CSP 影响，也不用往主文档塞 HTML。
    try {
      const page = require('./panel')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'ALLOWALL',
        'Content-Security-Policy': "frame-ancestors *",
      })
      res.end(String(page))
    } catch (error) {
      lastError = String(error.message || error)
      send(res, 500, { ok: false, error: 'panel 读取失败: ' + lastError })
    }
    return
  }
  if (url === '/phone/health') {
    send(res, 200, { ok: true, port: livePort || PORT, key: readKey() !== '', lastError })
    return
  }
  if (url === '/phone/config') {
    if (req.method === 'GET') {
      send(res, 200, publicConfig())
      return
    }
    readBody(req)
      .then(raw => {
        const patch = JSON.parse(raw)
        if (patch === null || typeof patch !== 'object') throw new Error('bad json')
        writeConfig(patch)
        send(res, 200, publicConfig())
      })
      .catch(error => {
        const msg = String((error && error.message) || error)
        lastError = msg
        if (msg === 'bad json' || msg.indexOf('JSON') >= 0) {
          send(res, 400, { ok: false, error: 'bad json' })
          return
        }
        // 写盘失败要如实告诉前端，不能让它显示「已保存」
        appendDebug('config-write-fail | ' + msg)
        try {
          send(res, 500, { ok: false, error: '配置没写进去：' + msg.slice(0, 160) })
        } catch (inner) {
          /* 已开始响应 */
        }
      })
    return
  }
  if (url === '/phone/debug') {
    readBody(req)
      .then(raw => {
        appendDebug(raw)
        send(res, 200, { ok: true })
      })
      .catch(() => {
        send(res, 400, { ok: false, error: 'debug write failed' })
      })
    return
  }
  if (url === '/phone/stop') {
    cancelToken += 1
    send(res, 200, { ok: true })
    return
  }
  if (url === '/phone/chat') {
    handleChat(req, res).catch(error => {
      lastError = String(error.message || error)
      try {
        send(res, 500, { ok: false, error: lastError })
      } catch (inner) {
        /* 已开始响应 */
      }
    })
    return
  }
  if (url === '/phone/models') {
    const cache = readProviders()
    send(res, 200, { ok: true, providers: Object.keys(cache.providers).map(key => ({ key, displayName: cache.providers[key].displayName, models: cache.providers[key].models.map(m => m.name || m.id) })) })
    return
  }
  if (url === '/phone/speak') {
    handleSpeak(req, res).catch(error => {
      lastError = String(error.message || error)
      try {
        send(res, 500, { ok: false, error: lastError })
      } catch (inner) {
        /* 响应可能已开始 */
      }
    })
    return
  }
  if (url === '/phone/avatar') {
    if (req.method === 'POST') {
      saveAvatar(req, res)
      return
    }
    serveAvatar(req, res, query.get('model') || '')
    return
  }
  if (url.startsWith('/phone/audio/')) {
    serveAudio(req, res, url.slice('/phone/audio/'.length))
    return
  }
  send(res, 404, { ok: false, error: 'not found' })
}

// 前端会按同样的顺序挨个探，所以这里加两个备用口，避免被别的插件占了端口就彻底不工作
const PORT_CHAIN = [PORT, ALT_PORT, 18772, 18773]
let livePort = 0

function listenAt(index) {
  if (index >= PORT_CHAIN.length) {
    appendDebug('listen-fail | 端口全被占用：' + PORT_CHAIN.join(','))
    lastError = '端口全被占用：' + PORT_CHAIN.join(',')
    return
  }
  const port = PORT_CHAIN[index]
  const server = http.createServer(serve)
  server.once('error', error => {
    const code = String((error && error.code) || '')
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      appendDebug('listen-busy | ' + port + ' ' + code)
      listenAt(index + 1)
      return
    }
    appendDebug('listen-err | ' + port + ' ' + String((error && error.message) || error))
    lastError = String((error && error.message) || error)
  })
  server.listen(port, '127.0.0.1', () => {
    livePort = port
    sweep()
    appendDebug('listen-ok | ' + port)
  })
}

listenAt(0)

// 临时 wav 原来只在启动时清一次，连跑几天会把盘塞满；改成每小时扫一遍
const sweepTimer = setInterval(sweep, 3600000)
if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

module.exports = { inject: [], apply() {} }
