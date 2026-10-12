---
name: tapmux
description: 操作本机 tapmux 纳管的其他 tmux / Claude Code 会话:给某个会话切模型(如切到 Fable / Opus)、发斜杠指令或一句话、立刻跑会话宏、看它的屏幕和状态。用户说「把 kaggle 会话切到 fable」「给 book 会话发 /compact」「看看 fit 会话在干嘛」「把我(这个会话)换成 opus」时用。
---

# tapmux:操作别的 Claude Code 会话

用 `tapmux ctl` 命令。它连本机 tapmux 服务,只能动纳管清单里的会话,注入前会自动等「会话空闲、输入框没人打字」。

## 先确认会话名

```bash
tapmux ctl ls        # 名字 / 状态(空闲/干活中/等确认) / 当前模型;「← 当前」= 你自己所在的会话
```

用户说的名字对不上就把列表给用户看,别猜。

## 切模型

```bash
tapmux ctl model <会话> fable      # 切到最新的 Fable(仅本会话)
tapmux ctl model <会话> opus
tapmux ctl model <会话> "fable 5"  # 指定旧版本才写版本号
tapmux ctl model . sonnet          # . = 你自己所在的会话
```

- 用户说「fable」「fable5」「切到 fable 5」,一般指**当前最新的 Fable**,传 `fable`。只有用户明确说要旧版时才写具体版本号
- 默认**只改这个会话**,不动全机的默认模型。只有用户明确说「设为默认/以后都用」才加 `--persist`
- 给自己所在的会话切:命令会自动排队,**本轮回复结束后**才生效。告诉用户「这轮结束后切换」,不要等结果
- 输出里有「注意: …重读全部历史」时转告用户:下一条消息会按新模型重读上下文,更慢、更费 token
- 找不到模型时会列出可选项,照着选一个合适的再试,或者问用户

## 发指令 / 跑宏 / 看屏幕

```bash
tapmux ctl send <会话> /compact            # 斜杠指令
tapmux ctl send <会话> "继续" --confirm     # 一句话;--confirm 遇到确认框自动回车
tapmux ctl macro <会话> 钉住模型            # 立刻跑一条已配置的宏(宏名或 id)
tapmux ctl screen <会话> -n 40             # 看屏幕末尾 40 行 + 排队 + 最近操作
tapmux ctl keys <会话> Escape              # 特殊键:Escape Enter Tab C-c Up Down …
tapmux ctl queue <会话> [--cancel <id>]    # 看/取消排队项
```

- 往别的会话发**一句话**,等于替用户对那个 Claude 说话。只在用户明确要你转达时才发,并且原样转达用户的意思
- 退出码 2 / 「会话在忙」:对方在干活或有人在打字。按用户意图选:`--wait 60` 等一会、`--queue` 排到空闲再执行。除非用户要求,不要用 `--force`(会打断别人打字或抢键)
- 做完用一句话告诉用户结果(切到了哪个模型、是否排队)。需要核实时用 `screen` 看

## 连别的机器

本机默认读 `~/.config/tapmux/config.json`。远程用环境变量:`TAPMUX_URL=http://主机:7802 TAPMUX_TOKEN=<token>`;经 relay 用 `TAPMUX_URL=https://<relay>/d/<设备名> TAPMUX_USER_TOKEN=<用户 token>`。`tapmux ctl help` 有完整用法。
