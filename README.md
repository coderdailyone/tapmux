<p align="center">
  <img src="https://raw.githubusercontent.com/coderdailyone/tapmux/main/assets/banner.svg" width="840" alt="tapmux — 掌上 tmux">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tapmux"><img src="https://img.shields.io/npm/v/tapmux?color=34d399&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-34d399" alt="node >= 20">
  <img src="https://img.shields.io/badge/license-MIT-8b9bab" alt="MIT">
</p>

<p align="center">用手机浏览器操作你机器上的 tmux 会话,专为「随时随地指挥 Claude Code」而生。</p>

> **tapmux** is a self-hosted web bridge for driving tmux sessions — especially [Claude Code](https://claude.com/claude-code) — from your phone's browser. One Node process on the machine where tmux lives; a PWA-ready mobile UI with an IME-friendly compose bar, a scroll rail wired to tmux copy-mode, image upload straight into Claude's context, and battle-tested reconnect logic. tmux is the single source of truth: disconnect anywhere, reattach and the screen redraws authoritatively.

<table align="center">
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/coderdailyone/tapmux/main/assets/screenshot-sessions.png" width="330" alt="会话列表"><br>
      <sub>会话列表:状态徽章 · 等确认高亮 · 屏幕预览 · 探测纳管</sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/coderdailyone/tapmux/main/assets/screenshot-terminal.jpg" width="330" alt="终端视图"><br>
      <sub>终端视图:中文输入条 · 快捷键 · 侧边滚轮(iPhone 实拍)</sub>
    </td>
  </tr>
</table>

## 特性

- **纳管制会话管理**:探测机器上的 tmux 会话,选择性纳管;网页只能触碰纳管清单内的会话
- **一键新建 Claude Code 会话**,卡片实时状态徽章:● 干活中 / ● 等你确认 / ● 空闲,附屏幕预览
- **双输入模式**:输入条(原生输入框,中文/多行舒服打,整段注入)/ 直敲(键击直入 pty + 快捷键条:Esc、⏎、Tab、粘滞 ⌃、方向键、^C、回滚、字号、防熄屏)
- **侧边滚轮**:直接驱动 tmux copy-mode 翻历史,按住连滚,滚回底部自动回实时
- **图片上传**:拍照/相册/多选 → 客户端压缩 → 路径自动填入输入条,Claude 用 Read 直接看图;按保留期自动清理
- **断线自愈**:防风暴重连,重连即由 tmux 权威重绘;iOS 键盘弹收视口有看门狗兜底
- **PWA**:加入主屏幕即全屏应用,专属图标
- **多机接入(relay)**:一台公网机 + 邀请码,承接任意多台内网机器,`/d/<设备名>/` 逐台直达
- **完工提醒**:Claude 干完活 / 停下来等确认时,推送 Telegram(可选)
- **会话宏**:条件触发的自动指令——屏幕缺失/出现某字样或定时,自动注入命令并可补确认;只在会话空闲且无人打字时动手,自带冷却。出厂预设「钉住模型」:检测到 Claude 被降级(状态条模型字样消失)自动 `/model` 钉回

## 安装

```bash
npm install -g tapmux
tapmux                    # 首次运行生成 ~/.config/tapmux/config.json(含访问 token),并打印访问链接
tapmux install-service    # 可选:生成 systemd user unit 常驻
```

或从源码:

```bash
git clone https://github.com/coderdailyone/tapmux.git && cd tapmux
npm install && npm start
```

手机与电脑同一局域网时,直接打开打印出的链接。端口/绑定地址/上传目录/保留天数/claude 启动命令等见生成的 config.json。

推荐的 `~/.tmux.conf`(tapmux 对纳管会话会自动强制关闭备用屏,全局配置是兜底):

```tmux
set -g mouse on
set -g history-limit 100000
set -g window-size latest      # 多端同看:尺寸听最后操作的客户端
set -g alternate-screen off    # Claude Code 输出进历史,滚动才有内容可翻
```

## 多机接入(relay)

公网机(放在你的反代/TLS 之后,默认只听 127.0.0.1:7803):

```bash
npm install -g tapmux
tapmux-relay &            # 建议配 systemd 常驻
```

建用户与邀请码(**一人一 token,机器挂人名下**):

```bash
tapmux-relay user-add <用户名>     # 得到用户 token(按 SSH 私钥对待)
tapmux-relay invite <用户名>       # 生成单次邀请码,注册的机器自动归属该用户
```

每台内网机:

```bash
tapmux relay-join https://你的域名 <邀请码> <设备名> [本地代理url]
# 重启 tapmux 生效
```

手机上只需登录一次:`https://你的域名/relay/login?token=<用户token>` → 进入「我的机器」门户,点任意一台直达,**全程不需要任何机器 token**(桥接凭与 relay 隧道同进程的内部密钥信任已过鉴权的流量;机器本地 token 仅用于直连形态)。管理:`users` / `devices` / `claim <设备> <用户>` / `revoke <设备>` / `user-revoke <用户>`。跨境等不稳链路时,relay-join 第四个参数填本地代理(如 `http://127.0.0.1:7890`),agent 上行隧道会走它——并且尽量用**域名**而非 IP 连 relay,才能吃上代理分流规则。

## Telegram 完工提醒(可选)

在 `~/.config/tapmux/config.json` 的 `notify` 段填 `enabled: true`、bot token、chat id(可选 `proxyUrl`),并把 `publicUrl` 设为你的访问域名(消息里带直达链接)。之后:Claude 停下来**等你确认**立刻推送;**干完一段超过一分钟的活**也推送。检测基于 tmux 屏幕状态巡检,无需改 Claude Code 任何配置。

## 公网访问

tapmux 只监听 HTTP,公网暴露请放在你自己的反向代理(TLS)之后;机器在 NAT 内时配合 frp 等反向隧道使用。要点:

- WebSocket 需要 `Upgrade/Connection` 头与足够长的 `proxy_read_timeout`(应用层自带 30s 心跳)
- 上传需要 `client_max_body_size ≥ 12m`
- tapmux 只信任来自 127.0.0.1 的 `X-Forwarded-For`

**安全底线:这个网页等于机器的 shell,token 按 SSH 私钥对待,公网必须 TLS。** 应用层自带:token 恒时比较、失败退避封禁、Origin 校验、按键与 MIME 白名单、上传目录结构性防穿越。泄露 token 时改 config.json 并重启服务即可全部作废。

## License

MIT
