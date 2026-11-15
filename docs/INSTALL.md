# 部署操作手册

> 面向要把它装进自己 DSH 的人。全部操作都在 Windows 桌面版 DSH 上。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 宿主 | DeepSeek Harness（DSH）桌面版，已能正常打开、能正常聊天 |
| 模型 | DSH 里至少配好一个 provider（`cordis.patch.yml`）且 key 可用 |
| 语音 | 火山引擎豆包 TTS 的 key，放在 `VOLCENGINE_TTS_API_KEY`（用户级环境变量或 `.credentials.yaml`） |
| 端口 | 18770 空闲（被占时插件会顺延到 18771 / 18772 / 18773） |

检查 key 是否就位：

```powershell
[Environment]::GetEnvironmentVariable('VOLCENGINE_TTS_API_KEY','User')
```

## 1. 放置文件

DSH 的本地插件按「源目录 + 生效目录」两份存在，两份内容必须一致：

```
源目录   %USERPROFILE%\.dsh\local-plugins\dsh-ai-phone
生效目录 %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-ai-phone
```

把仓库里的 `lib/`、`package.json`、`cordis.patch.yml` 复制到这两个目录（生效目录只需要 `lib/` 与 `package.json` 也能跑）：

```powershell
$src = "<你解压出来的 Dsh-Phone-Time 目录>"
$dst1 = "$env:USERPROFILE\.dsh\local-plugins\dsh-ai-phone"
$dst2 = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ai-phone"
New-Item -ItemType Directory -Path $dst1,$dst2 -Force | Out-Null
Copy-Item -LiteralPath "$src\lib","$src\package.json","$src\cordis.patch.yml" -Destination $dst1 -Recurse -Force
Copy-Item -LiteralPath "$src\lib","$src\package.json" -Destination $dst2 -Recurse -Force
```

目录名必须是 `dsh-ai-phone`（与 `package.json` 的 `name`、`cordis.patch.yml` 的 `insert id` 三者一致，改名会加载不上）。

## 2. 声明依赖

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，在 `dependencies` 里加一行（路径换成你自己的）：

```json
{
  "dependencies": {
    "dsh-ai-phone": "file:C:/Users/<你的用户名>/.dsh/local-plugins/dsh-ai-phone"
  }
}
```

> 已经有这一行就跳过。JSON 里用正斜杠，不要用反斜杠。

## 3. 重启 DSH

完全退出 DSH（托盘也要退），再重新打开。插件只在启动时加载。

## 4. 验证

浏览器直接打开下面这些地址（都是本机回环，不走外网）：

| 检查项 | 地址 | 期望 |
|---|---|---|
| 自检 | `http://127.0.0.1:18770/phone/health` | `{"ok":true,"port":18770,"key":true,...}` |
| 配置 | `http://127.0.0.1:18770/phone/config` | 能看到 `enabled`、`voices`、`avatars` |
| 模型 | `http://127.0.0.1:18770/phone/models` | 列出你 DSH 里配置的 provider |
| 头像 | `http://127.0.0.1:18770/phone/avatar?model=<模型名>` | 返回图片；没配头像时返回占位 |

`key:true` 说明 TTS 密钥读到了；`key:false` 就去补 `VOLCENGINE_TTS_API_KEY`。

界面上则去 DSH 设置页，确认左侧多出 **语音通话** 分区（新增分区不会动原有设置项）。

## 5. 端口

插件只监听 `127.0.0.1`，不对外网开放。端口链：

```
18770 → 18771 → 18772 → 18773
```

第一个被占用就顺延下一个，全部被占才放弃并写日志。前端也按同一条链逐个探测，所以换口不影响使用。

查看当前落在哪个口：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in 18770,18771,18772,18773 } |
  Select-Object LocalPort, OwningProcess
```

## 6. 配置

配置文件：`%USERPROFILE%\.dsh\dsh-ai-phone.json`（第一次启动自动生成）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `shortcut` | `Alt+Shift+P` | 唤起通话的快捷键 |
| `apiKey` | `""` | 自定义 TTS key，留空走 `VOLCENGINE_TTS_API_KEY` |
| `endpoint` | 火山官方 | 自定义 TTS 端点 |
| `baseVoice` | 默认女声 | 兜底音色 |
| `voices` | 7 条 | `模型关键字 → 音色 id` |
| `avatars` | `{}` | `模型关键字 → 本地图片路径` |
| `speechRate` | `0` | 语速 -50 ~ 100 |
| `loudness` | `0` | 音量 -50 ~ 100 |
| `logEnabled` | `true` | 是否写通话日志 |
| `logDir` | `~/Documents/DSH-AI通话日志` | 日志目录 |
| `isolateSession` | `true` | 通话与会话隔离 |
| `avatarPos` | `{}` | 头像裁切偏移 |

写入策略：先写临时文件再 `rename`，并留 `.bak-auto` 备份。手改配置写坏了也能回滚。

## 7. 日志

| 日志 | 位置 | 用途 |
|---|---|---|
| 调试日志 | `%TEMP%\dsh-ai-phone\debug-YYYY-MM-DD.log` | 排错用。标签：`listen-ok` / `listen-busy` / `listen-fail` / `chat-up` / `chat-ok` / `chat-http` / `chat-net` / `chat-retry` / `chat-stream-end` / `config-write-fail` / `speak-err` |
| 通话日志 | `%USERPROFILE%\Documents\DSH-AI通话日志\通话-<callId>.md` | 每通电话一份，只记输入/输出与时间 |
| 临时音频 | `%TEMP%\dsh-ai-phone\*.wav` | 每小时自动清理超过 1 小时的文件 |

## 8. 卸载 / 回滚

1. 从 `package.json` 的 `dependencies` 删掉 `dsh-ai-phone`；
2. 删掉两份插件目录；
3. 重启 DSH。

配置、头像、通话日志都不会被插件自己删，需要清就手动清；升级前建议先把 `%USERPROFILE%\.dsh\dsh-ai-phone.json` 复制一份。

## 9. 排错

| 现象 | 先看哪里 | 大概率原因 |
|---|---|---|
| 设置页没有「语音通话」 | 调试日志有无 `listen-fail` | 插件没加载成功，检查目录名、`package.json` 依赖 |
| 电话一点没声音 | `/phone/health` 的 `key` | TTS 密钥没配或过期 |
| 说了没反应 | 调试日志 `chat-up` / `chat-http` | DSH 里该模型没配好，或 key 不对 |
| 报「连不上中转」 | 日志里的 `cause=` | 该中转域名连不上（网络/握手超时），换一个档位重说一句 |
| 头像不显示 | `/phone/avatar?model=...` | 头像路径写错、文件被移动 |
| 设置保存不了 | 日志 `config-write-fail` | 配置文件被占用或没有写权限 |
| 端口全被占 | 日志 `listen-fail` | 关掉占用 18770–18773 的进程 |
