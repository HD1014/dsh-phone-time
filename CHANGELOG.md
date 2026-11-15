# Changelog

版本号遵循「主版本.次版本.修订」；当前对外发布版本为 **1.0.0**。

## 1.0.0 — 首发

首个可对外发布的版本：把一份长期在本地自用的 DSH 语音通话插件，做了一次从头到尾的代码审查、修掉已知与未知缺陷，整理成可安装的正式版。

### 宿主侧（lib/index.js）

- 修：语音合成失败分支引用了作用域里不存在的 `endpointUrl`，会抛 `ReferenceError`，前端拿不到任何错误、NDJSON 流异常 → 改为使用正确的端点与错误文案。
- 修：`lastUsage` 从未声明，在 sloppy mode 下变成全局变量，上一轮的 token / 缓存命中会漏到下一轮 → 改成本轮局部变量。
- 修：流式解析在 `done` 时直接收手，缓冲区最后一行（通常没有换行符）被丢弃，回复末尾少字 → 流结束补处理一次。
- 修：个别 OpenAI 兼容端点不认 `stream_options` 会直接 400 且没有降级，表现为「电话完全不回话」→ 命中 `400 + stream_options` 时去掉该字段重发一次。
- 修：端口只在 18770 / 18771 之间兜底，两个都被占时 `listen` 静默不启动，插件等同消失 → 扩到 4 个端口并记录 `listen-ok` / `listen-busy` / `listen-fail`。
- 修：`sweep()` 只在启动跑一次，临时 wav 无限累积 → 每小时清扫一次，定时器 `unref()`。
- 修：`writeConfig` 直接覆写文件，写到一半中断会把整份配置写坏 → 改为临时文件 + `rename`，并留 `.bak-auto`。
- 修：客户端断开后 reader 不 cancel，上游继续烧 token → `res.on('close')` 时取消。
- 修：`/phone/config` 的 catch 把「写盘失败」也回成 `bad json`，前端照样显示「已保存」→ 区分参数错误与写盘错误。
- 修：默认声线表里残留重复的「千问」键（配置已去重，默认值没跟着删）。
- 增：连接级失败（握手超时 / 连接被重置等）自动重试一次，每次 attempt 之间隔 500ms；已拿到 HTTP 状态的失败不重试，避免重复计费。
- 增：失败文案改成「连不上X（原因 / 错误码）」，并附 `tried` 列表，前端能看见到底试了哪些地址。
- 增：调试日志补 `listen-*` / `chat-net` / `chat-retry` / `chat-stream-end` / `config-write-fail` / `speak-err` 标签。

### 前端侧（lib/client.js）

- 修：`flushSpeech` 一次只切一句，一次 delta 含多句时后面的要等下一次出字，流一结束就被当成一大段连读 → 改为逐句切完（带次数上限防死循环）。
- 修：`applyUsage` 用 `else if` 挂在 delta 后，同一行同时带 delta 和 usage 时 usage 被吞 → 拆成独立判断。
- 修：`askModel` / `speakChunk` 同样不处理尾行 → 补上。
- 修：头像加载失败后 `renderWindow` 每 400ms 又把破图显示回来，来回闪 → 记 `avatarErr` 并尊重它。
- 修：`sweepDrafts` 通话期间每 400ms 扫页面下半部所有 `textarea`/`contenteditable` 并清空，会误删用户在设置页等处正在输入的字，还会被 `hardClear` 里的 focus 抢走焦点 → 只在录音阶段、只在输入栏容器内清理，焦点在别处不动。
- 修：`findMicStopButton` 泛匹配「停止」两字，可能误点 DSH 的「停止生成」按钮 → 只认「停止录音 / 结束录音 / 停止听写 / 停止语音」且限定在输入栏内。
- 修：`stopPlayback` 清 `audio.src` 会触发一次 error 事件且解绑前未摘回调，每次挂断/静音都误报「这一段音频没加载成功」→ 先摘 `onended` / `onerror` 再清源。
- 修：设置页滑块是受控 value 且每次 `onChange` 都 POST 写盘，拖动时回弹且频繁落盘 → 本地即时跟手 + 260ms 防抖保存。
- 修：头像路径输入框用 `defaultValue`，切模型后不刷新，显示上一模型路径、blur 时写错键 → 选择器按当前模型重建。
- 修：`pickAvatar` / `chooseFile` 用户取消选择后临时 `input` 永久留在 body → 延时清理。
- 修：`ensureEntry` 每次 MutationObserver 回调全量扫按钮 → 改走 rAF 合并调度。
- 修：`start()` 可能被重复 apply 导致 keydown / 观察器重复注册 → 加一次性守卫。
- 修：中文 token 估算 0.6/字明显偏低（「每秒只有十几 token」的直接原因之一）→ 校正到 1.5/字。
- 修：上下文余量只减 prompt 未计输出 → 余量按 `contextWindow - (prompt + completion)` 计算。
- 增：`askModel` 加轮次编号（`seq`），上一轮迟到的流直接丢弃，两轮的话不会串。
- 增：设置页新增语速 / 音量档位条，拖动跟手、停手落盘。

### 文档与素材

- 新增 `docs/INSTALL.md`（部署操作手册）、`docs/USER-GUIDE.md`（用户手册）、`docs/DEV-NOTES.md`（源码说明）。
- 新增 `assets/poster.png` 宣传图。
- 仓库不附带任何角色头像，头像由使用者自行上传。
