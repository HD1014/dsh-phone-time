# 源码说明

> 面向要改它的人：结构、接口、协议、扩展点。

## 1. 整体结构

```
lib/index.js   宿主侧（Node，跑在 DSH 进程里）
lib/client.js  前端侧（浏览器，注入 DSH Web UI）
lib/panel.js   历史独立面板页（前端已不再使用，只保留 /phone/panel 路由，属死代码）
```

宿主只做三件事：**合成语音**、**管自己的配置**、**给前端一个本机接口**。它不碰 DSH 的任务调度、不写 DSH 的会话存储。

## 2. 路由表

全部只监听 `127.0.0.1`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/phone/health` | 自检：`ok` / `port` / `key` / `lastError` |
| GET | `/phone/config` | 读配置（`publicConfig()`，不返回密钥明文） |
| POST | `/phone/config` | 局部覆盖写配置（原子写 + `.bak-auto`） |
| GET | `/phone/models` | 列出从 `cordis.patch.yml` 解析出的 provider 与模型 |
| POST | `/phone/chat` | 电话推理，NDJSON 流式 |
| POST | `/phone/speak` | 文本转语音，NDJSON 逐句吐结果 |
| POST | `/phone/stop` | 让后续分段别再合成 |
| GET | `/phone/audio/<name>.wav` | 取合成结果 |
| GET | `/phone/avatar?model=<名字>` | 返回该模型的头像图片；配的是 http 地址则 302 跳转 |
| GET | `/phone/debug` | 读当天调试日志尾部 |
| GET | `/phone/panel` | 历史面板页（死代码） |

## 3. NDJSON 协议

### `/phone/chat`

请求：

```json
{ "model": "面板里选中的模型名", "text": "这一句", "callId": "通话 id", "history": [{ "role": "user", "content": "..." }] }
```

响应（每行一个 JSON）：

```json
{"delta":"你"}
{"delta":"好"}
{"done":true,"model":"deepseek-chat","provider":"deepseek-gateway","endpoint":"https://api.deepseek.com/v1/chat/completions","usage":{"promptTokens":123,"completionTokens":45,"totalTokens":168,"cacheHitRate":0.62,"estimated":false}}
```

失败时：

```json
{"error":"连不上中转（fetch failed / UND_ERR_CONNECT_TIMEOUT）","tried":["官方直连 https://api.deepseek.com/v1/chat/completions","中转 https://example.com/v1/chat/completions"]}
```

要点：

- 上游 SSE 的最后一行通常没有换行符，流结束时必须再 `consumeLine(buffer)` 一次，否则回复末尾会少字；
- `usage` 与 `delta` 要分别判断，不能写成 `else if`——有的中转把两者塞在同一行；
- 客户端断开时 `res.on('close')` 里要 `reader.cancel()`，否则上游继续烧 token；
- `lastUsage` 必须是本轮局部变量，不能泄漏到下一轮。

### `/phone/speak`

请求：

```json
{ "text": "要念的一句", "model": "面板模型名" }
```

响应（每合成好一句一行）：

```json
{"url":"/phone/audio/call-123-1.wav","durationMs":2385,"chars":14,"voice":"zh_female_tianmeitaozi_uranus_bigtts"}
```

音频必须请求 `format:'pcm'`（`pcm16` 不被认，服务端会回 mp3，拼成 wav 就是沙沙声）。

## 4. 模型怎么匹配

`resolveModel(panelModel)` 的优先级：

1. **精确匹配**：把面板模型名规范化（小写、去符号）并剥掉档位词（`flash` / `pro` / `max` / `mini` …），与 provider 里的每个模型 id 比对；
2. **包含匹配**：取最长命中的关键片段，处理「面板写 DeepSeek V4 Pro、配置里叫 deepseek-v4-pro」这类差异；
3. **厂牌提示**：匹配不上再按 `deepseek` / `claude` / `gemini` / `kimi` / `glm` / `qwen|千问|通义` / `gpt|openai` 的厂牌关键字兜底；
4. **默认模型**：最后退回 `cordis.patch.yml` 里的 `agent-default-model`。

provider 信息按文件 mtime 缓存，配置改了会自动重读。

### DeepSeek 官方直连

`DIRECT_FALLBACKS` 里列出的模型 id，会**先**打官方 `api.deepseek.com`（同一个模型、更快更稳），拿到 `DEEPSEEK_API_KEY` 才启用；官方失败再回落到 DSH 配置里的中转。

### 连接级重试

第三方中转前面常挂 Cloudflare，握手经常超过 undici 默认的 10 秒，表现为一句没头没尾的 `fetch failed`。处理方式：

- 每次 attempt 内，**连接级失败**（`UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` / `ECONNRESET` / `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN`）隔 500ms 重试一次；
- **已经拿到 HTTP 状态的失败不重试**，避免同一句话被重复计费；
- 全部失败时把 `error` 写成「连不上X（原因 / 错误码）」，前端能直接显示原因。

上游不认 `stream_options` 会直接 400，这种情况会去掉该字段重发一次（按 400 + 关键字判断，不盲目重试）。

## 5. 配置读写

- 文件：`%USERPROFILE%\.dsh\dsh-ai-phone.json`；
- 写入：先写 `*.tmp` 再 `rename`，成功后留一份 `.bak-auto`；
- 写失败不能让前端以为成功：此时返回 500 与真实错误，而不是 `bad json`；
- `publicConfig()` 只回 `keyConfigured` / `keyCustom`，不回密钥。

## 6. 端口与生命周期

```js
const PORT_CHAIN = [18770, 18771, 18772, 18773]
```

`listenAt(index)` 逐个尝试，失败记 `listen-busy`，全部失败记 `listen-fail`（插件不会「看起来存在但其实就是不启动」）。`livePort` 供 `/phone/health` 回报实际端口。

临时音频目录 `%TEMP%\dsh-ai-phone`，每小时 `sweep()` 一次，清理超过 1 小时的文件，定时器 `unref()` 不阻止进程退出。

## 7. 前端结构

`lib/client.js` 是一个注入 DSH Web UI 的模块，主要分两块：

### 通话窗

- `call` 是唯一状态对象：`open` / `phase`（`listening|transcribing|thinking|speaking`）/ `model` / `history` / `spokenLen` / `stats` / `avatarErr` / `seq`；
- `ensureEntry()` 挂入口按钮、用 `requestAnimationFrame` 合并 MutationObserver 回调，别在每次 DOM 变动时全量扫按钮；
- `start()` 一次性守卫，避免重复注册 keydown；
- `askModel(text)`：`seq` 递增做轮次编号，迟到的旧流直接丢弃，两轮的话不会串；
- `flushSpeech()`：一次 delta 里可能有多句，必须 `while` 逐句切完，否则流一结束就一大段连读；
- `speakChunk()` / `stopPlayback()`：停播要先摘 `onended` / `onerror` 再清 `src`，否则每次挂断都误报「音频没加载成功」；
- `renderWindow()` 尊重 `avatarErr`，头像加载失败后不要每 400ms 又把破图刷回来；
- `sweepDrafts()` 只在录音阶段、只在输入栏容器内清理，焦点在别处时不动手。

### 设置页「语音通话」

- `PhoneSection()` 里所有 hooks 必须在 `if (cfg === null) return ...` **之前**且数量恒定——这是之前把 DSH 设置栏整片搞空的根因；
- `rateRow(label, field)` 用本地 state 跟手 + 260ms 防抖写盘，受控 value 直写会在拖动时回弹；
- 头像选择器根节点带 `key: 'avatar-' + current`，换模型时强制重建，否则路径输入框还显示上一个模型的；
- 选图取消后要延时移除临时 `input`，不然会永久留在 body 上。

## 8. 扩展点

| 想做的事 | 改哪里 |
|---|---|
| 加一个模型的默认音色 | `index.js` 的 `DEFAULT_VOICES`，键是模型名关键字 |
| 换默认兜底音色 | `DEFAULT_VOICE` |
| 加一个 DeepSeek 型号官方直连 | `DIRECT_FALLBACKS`，键必须是 provider 里的模型 id |
| 改端口链 | `index.js` 的 `PORT_CHAIN` 和 `client.js` 的 `PORTS`，两处必须同步 |
| 改日志目录默认值 | `index.js` 的 `publicConfig()` 与 `normalize` 两处 |
| 改头像存放目录 | `AVATAR_DIR` |
| 改样式 | `client.js` 顶部的 `CSS` 字符串，前缀统一 `dsh-pw-` |

## 9. 已知包袱

- `panel.js` 与 `/phone/panel`：前端已不再加载，保留只为兼容旧链接，可以安全删掉（删了记得同步简化路由）；
- 与本插件同名的副本不能并存：端口、配置文件、头像目录、CSS 前缀、设置 slot id 全部冲突，要做并存必须先逐个隔离；
- 只按 Windows 写：`%TEMP%`、`%USERPROFILE%`、路径分隔符。

## 10. 成本与隐私

- 每次通话都会真实调用模型与 TTS，按你 DSH 里配的额度计费；小窗里的 token 数字来自服务端 `usage`，个别端点不返回时会退化成估算（`estimated:true`）；
- 通话内容不进工作台会话，但会写进你自己的 `通话-*.md` 日志；不想留就关掉 `logEnabled`；
- 插件不读取 `.credentials.yaml` 以外的任何凭据，也不会把密钥回传给前端。
