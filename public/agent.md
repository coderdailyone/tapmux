# tapmux · Agent 接口文档

tapmux 是一台机器上的网页桥,用来操作这台机器上的 tmux 会话,主要是会话里跑的 Claude Code。你(AI agent / 脚本)可以通过它:**给某个会话切模型、发斜杠指令或一句话、立刻跑会话宏、看会话屏幕和状态**。

这份文档不用登录就能读;其余所有接口都要鉴权。

## 1. 地址与鉴权

先确定 **BASE**(下面所有路径都接在它后面),再选对应的鉴权方式。最省事的判断:**BASE = 你读到本文档的网址去掉末尾的 `/agent.md` 或 `/llms.txt`**。唯一的例外是 relay 自己的那份(`https://<relay域名>/relay/agent.md`),见表格下面的说明。

| 你拿到的网址 | BASE | 鉴权 |
|---|---|---|
| 直连:`http://主机:端口/…`(默认端口 7802) | `http://主机:端口` | 请求头 `Authorization: Bearer <机器 token>` |
| 经 relay:`https://<relay域名>/d/<设备名>/…` | `https://<relay域名>/d/<设备名>` | 请求头 `Cookie: tapmux_user=<用户 token>` |
| 本机(在那台机器上跑命令) | `http://127.0.0.1:<config.json 的 port,默认 7802>` | `Bearer`,token 在 `~/.config/tapmux/config.json` 的 `token` 字段 |

- 用户给你的链接里带 `?token=xxx` 时,`xxx` 就是 token。直连形态是机器 token;relay 的 `/relay/login?token=xxx` 里是用户 token
- **不要靠 `?token=` 调接口**:它会种 cookie 再 302 跳转,不保留 cookie 的客户端会在跳转后吃 401。一律用上面的请求头
- 在 relay 自己的 `https://<relay域名>/relay/agent.md` 读到本文时,BASE 要补成 `/d/<设备名>`。不知道设备名时:`GET https://<relay域名>/relay/api/devices`(带用户 cookie)→ `{devices:[{name, online, version, …}]}`
- 写操作都是 POST/DELETE + JSON body,要用能发请求头和 body 的工具(curl 等)
- token 等于这台机器的 shell 权限,不要写进日志、回复或提交里

```bash
BASE=http://127.0.0.1:7802
AUTH="Authorization: Bearer $(python3 -c "import json;print(json.load(open('$HOME/.config/tapmux/config.json'))['token'])")"
curl -s -H "$AUTH" $BASE/api/sessions
```

如果你就在那台机器上,并且装了 tapmux,`tapmux ctl` 封装了下面全部接口,用起来更省事(见第 5 节)。

## 2. 规则(先读)

1. **只能动「纳管」会话**:纳管会话指 `GET /api/sessions` 返回的 `managed` 里的会话。`wild` 是机器上没纳管的 tmux 会话,接口一律 403
2. **安全门**:指令只在会话**空闲**(Claude 没在干活、没在等确认)且**输入框没人打字**时注入。不满足就返回 409 busy,什么都不发。此时可以用 `waitSec` 等一会,或用 `queue:true` 排队到空闲再执行。**除非用户明确要求,不要用 `force:true`**:它会抢键盘,打断正在打字的人
3. **切模型默认只改这个会话**。Claude Code 原生的 `/model <名>` 会顺手把全机「新会话默认模型」也改掉;tapmux 改为驱动选择器,只改本会话。经 tapmux 发出的 `/model <名>` 都按这个处理。只有用户明确说「设为默认 / 以后都用」时才传 `persist:true`
4. **往别的会话发一句话,等于替用户对那个 Claude 说话**。只在用户明确要你转达时才发,并且原样转达
5. **给自己所在的会话下指令**时,它此刻必然在忙(正在跑你这条命令)。要用 `queue:true`,告诉用户「本轮结束后生效」,不要原地等结果
6. 做完用一句话告诉用户结果;需要核实就看 `screen`

## 3. 接口

返回都是 JSON。失败时形如 `{"error":"说明"}`。

### 列会话 `GET /api/sessions`

```json
{
  "managed": [
    { "name": "kaggle", "windows": 1, "attached": 0, "created": 1791805871000,
      "cmds": ["claude"], "state": "idle", "model": "Opus 5.5",
      "preview": ["最后两行正文…"], "macros": [ … ] }
  ],
  "wild": [ { "name": "scratch", … } ],
  "dead": ["已经不在 tmux 里的纳管名"]
}
```

`state`:`idle` 空闲 / `working` 干活中 / `waiting` 等人确认;不是 Claude 会话时为 `null`。`model` 取自状态条,没有状态条时为 `null`。

### 看屏幕 `GET /api/sessions/:name/screen?lines=40`

`lines` 取值 1–200,默认 40。

```json
{
  "name": "kaggle", "claude": true, "state": "idle", "inputBusy": false, "model": "Fable 5.1",
  "screen": "屏幕末尾 40 行纯文本",
  "queue":  [ { "id": "040da9ef", "action": { "model": "opus" }, "source": "agent", "addedAt": 0, "expiresAt": 0 } ],
  "recent": [ { "at": 0, "source": "agent", "action": { "model": "fable" }, "ok": true } ]
}
```

`recent` 是最近 10 次经 tapmux 的注入(agent、宏、排队),排队项执行没执行、结果如何都看这里。

### 切模型 `POST /api/sessions/:name/model`

```json
{ "model": "fable", "persist": false, "waitSec": 0, "queue": false, "force": false }
```

- `model` 的写法:`fable` / `opus` / `sonnet` / `haiku` 表示该家族**最新版**(用户说「fable」「fable5」一般就是这个);`"fable 5.1"`、`"opus 4.6"` 表示精确版本;也认模型 ID `claude-fable-5-1`;`default` 表示选择器里的 Default 项;加 `[1m]` 表示 1M 上下文版
- 成功(200):

```json
{ "ok": true, "model": "Fable 5.1", "scope": "session",
  "said": "Set model to Fable 5.1 for this session only",
  "note": "会话有上下文,已确认切换:下一条消息会按新模型重读全部历史(更慢、更费 token)",
  "state": "idle", "screen": "…" }
```

  `scope`:`session` 表示只改本会话,`default` 表示连全机默认一起改(用了 `persist`)。`note` 只在会话有对话历史、Claude Code 弹出「Switch model?」并已自动确认时出现。**把 note 转告用户**
- 找不到模型(422):`{"ok":false, "error":"选择器里没有匹配「gpt-5」的模型", "available":["Default (recommended)","Opus 5.5","Fable 5.1",…]}`。照 `available` 选一个再试,或者问用户
- 会话里没在跑 Claude Code:400

### 下指令 `POST /api/sessions/:name/command`

```json
{ "text": "/compact", "enter": true, "confirm": false, "waitSec": 0, "queue": false, "force": false, "ttlSec": 7200 }
```

- `text`:斜杠指令或一句话,4000 字以内。`/model <名>` 会被转成上面的切模型
- `enter:false`:只填进输入框,不回车
- `confirm:true`:发出约 2 秒后如果弹了确认框(「Do you want…」之类),自动回车,返回 `"confirmed": true`
- 成功(200):`{"ok":true, "state":"working", "screen":"…"}`。`state` 和 `screen` 是发出约 1 秒后的样子

### 立刻跑宏 `POST /api/sessions/:name/macros/:idOrName/run`

body 可选:`{ "waitSec": 0, "queue": false, "force": false }`。按宏的 `id` 或 `name` 查找,经过同一道安全门执行宏的动作,并把这次计入宏的冷却。

### 特殊键 `POST /api/sessions/:name/send`

```json
{ "keys": ["Escape"] }
```

一次最多 5 个键,只认这些:`Up Down Left Right Escape Tab Enter BSpace PageUp PageDown Home End C-c C-d C-u C-r C-l`。注意:这个接口**不过安全门**,是给人用的直通口。它也能发 `{"text":"…","enter":true}`,但同样不过安全门,agent 发文字请用 `/command`。

### 排队

- 加入:上面三个动作的 body 带 `queue:true`。会话空闲就当场执行(200);忙就排队,返回 202 `{"ok":true, "queued":"040da9ef", "position":1}`。之后每 3 秒检查一次,空闲就执行
- 看:`screen` 返回的 `queue` 字段;结果看 `recent`
- 取消:`DELETE /api/sessions/:name/queue/:id`
- 每个会话最多排 10 项;`ttlSec`(60–86400,默认 7200)到期就丢弃。排队只存在内存里,tapmux 服务重启就清空

### 状态码

| 码 | 含义 | 你该怎么办 |
|---|---|---|
| 200 | 成功(看 `ok`) | — |
| 202 | 已排队 | 告诉用户会在空闲后执行 |
| 400 | 参数不对 / 不是 Claude 会话 | 改参数 |
| 401 | 没鉴权或 token 错 | 检查第 1 节;连错 5 次会被临时封 IP |
| 403 | 会话没纳管 | 告诉用户;用户同意后才能调 adopt 纳管(第 4 节) |
| 404 | 会话不存在 / 宏不存在 / 排队项不存在 | 先 `GET /api/sessions` |
| 409 | 会话忙,`{"error":"busy","state":"working","inputBusy":false}` | `waitSec`(单次最多 15 秒,可以重试)或 `queue:true` |
| 422 | 动作执行失败,`error` 里有原因 | 读原因;切模型失败时会附 `available` |
| 429 | 排队满了 | 等等或取消旧项 |

经 relay 时单个请求超过 30 秒没有数据会被断开,所以 `waitSec` 封顶 15 秒;想等更久就重试。

## 4. 会话与宏的管理(仅在用户明确要求时)

- 新建会话:`POST /api/sessions {"name":"exp1","claude":true}`。`name` 只能用字母、数字和 `_.-`,50 字以内;`claude:true` 表示建好后启动 Claude Code。重名返回 409
- 纳管已有会话:`POST /api/sessions/:name/adopt`
- 关闭会话:`DELETE /api/sessions/:name`。**会结束里面在跑的程序,必须先得到用户确认**
- 配置宏:`PUT /api/sessions/:name/macros {"macros":[…]}`。**整表替换**:先从 `GET /api/sessions` 拿到该会话现有的 `macros`,在它基础上改,再整表提交。一个会话最多 8 条:

```json
{ "id": "pin-fable", "name": "钉住模型", "enabled": true,
  "trigger": { "type": "missing", "pattern": "\\[Fable 5\\.1\\]" },
  "action": { "text": "/model claude-fable-5-1", "enter": true, "confirmEnter": false },
  "cooldownSec": 300 }
```

  `trigger.type` 有三种:`missing` 表示屏幕上找不到该正则时触发;`present` 表示出现时触发;`interval` 表示定时触发,要写 `everySec`(≥60)。`cooldownSec` ≥60。宏每 30 秒巡检一次,也只在会话空闲、没人打字时注入

## 5. 命令行 `tapmux ctl`(在装了 tapmux 的机器上)

```bash
tapmux ctl ls                          # 会话 / 状态 / 模型;「← 当前」= 你所在的会话
tapmux ctl model kaggle fable          # 切模型(仅本会话)
tapmux ctl model . opus                # . = 你所在的会话:自动排队,本轮结束后执行
tapmux ctl send kaggle /compact        # 斜杠指令或一句话;--confirm --no-enter
tapmux ctl macro kaggle 钉住模型
tapmux ctl screen kaggle -n 40
tapmux ctl keys kaggle Escape
tapmux ctl queue kaggle [--cancel <id>]
# 通用选项:--wait <秒>  --queue  --force  --persist  --json
# 连别的机器:TAPMUX_URL=<BASE> 加 TAPMUX_TOKEN=<机器 token>(直连)或 TAPMUX_USER_TOKEN=<用户 token>(relay)
```

退出码:0 表示成功或已排队,1 表示失败,2 表示会话忙。`tapmux ctl help` 有完整用法。
