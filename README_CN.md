# TermLive

[English](README.md)

AI 编码工具远程控制平台 — 在手机上通过 Telegram、Discord 或飞书监控终端会话、审批工具权限、与 Claude Code 实时交互。

## TermLive 是什么？

TermLive 将你的 AI 编码会话桥接到即时通讯平台。在服务器上运行 Claude Code，在手机上实时查看流式响应，一键审批工具权限，通过浏览器查看终端实时输出。

**没有 TermLive：** 你盯着终端等 Claude Code 完成工作。

**有了 TermLive：** 你可以离开。Claude 需要审批或完成工作时，手机会收到通知。

## 功能

- **双向 IM 交互** — 从 Telegram、Discord 或飞书直接与 Claude Code 对话
- **工具权限审批** — 在 IM 中用按钮审批/拒绝文件编辑、命令执行
- **Web 终端** — 任意浏览器实时访问终端，支持手机
- **多会话仪表盘** — 在一个面板中管理多个终端会话
- **流式响应** — 实时看到 Claude 的输出，而不是等它写完
- **状态行** — Claude Code 底部状态栏显示会话数、费用、IM 连接状态
- **双组件架构** — Go Core（基础设施）+ Node.js Bridge（AI + IM），可独立部署
- **跨平台** — Linux、macOS、Windows
- **Docker 部署** — `docker compose up` 一键启动

## 前置条件

- **Node.js >= 22**
- **Go 1.24+**（从源码构建 Go Core，或下载预编译二进制）
- **Claude Code**（推荐）或 Codex CLI

## 安装

### npx skills（推荐）

```bash
npx skills add termlive/termlive
```

### Git clone

```bash
git clone https://github.com/termlive/termlive.git ~/.claude/skills/termlive
```

直接克隆到 Claude Code 技能目录，自动发现。

### 符号链接（开发用）

```bash
git clone https://github.com/termlive/termlive.git ~/code/termlive
mkdir -p ~/.claude/skills
ln -s ~/code/termlive ~/.claude/skills/termlive
```

### 验证安装

启动新的 Claude Code 会话，输入 `/` — 你应该能看到 `termlive` 出现在技能列表中。

## 快速开始

### 1. 配置

```
/termlive setup
```

向导会自动处理一切：
1. **构建 Go Core** — 编译 `tlive-core` 二进制（或下载预编译版）
2. **构建 Bridge** — `npm install && npm run build`
3. **选择 IM 平台** — Telegram、Discord、飞书
4. **输入凭据** — 逐个引导，告诉你去哪里获取
5. **写入配置** — `~/.termlive/config.env`

### 2. 启动

```
/termlive start
```

按顺序启动两个组件：
1. Go Core 启动 → 监听 `:8080` → 提供 Web UI + API
2. Bridge 启动 → 连接 Core → 连接 IM 平台

### 3. 开始使用

打开 IM 应用，给你的 Bot 发消息。Claude Code 会响应。当 Claude 需要使用工具时，你会在聊天中看到权限审批按钮。

### 仅启动 Core（不需要 IM）

如果只需要终端监控 + Web UI，不需要 IM 交互：

```bash
~/.termlive/bin/tlive-core daemon --port 8080 --token <你的token>
```

### Docker 部署

```bash
git clone https://github.com/termlive/termlive.git && cd termlive
cp .env.example .env    # 填入你的 token
docker compose up -d
```

## 工作原理

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code CLI                       │
│  ┌──────────┐  ┌──────────────┐                         │
│  │ SKILL.md │  │ 状态行       │                          │
│  │ /termlive│  │ statusline.sh│                         │
│  └────┬─────┘  └──────┬───────┘                         │
└───────┼───────────────┼─────────────────────────────────┘
        │               │
        ▼               ▼
┌─────────────────────────────────────────────────────────┐
│              Node.js Bridge (IM + AI)                    │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Claude SDK  │  │  Telegram    │  │  权限网关       │ │
│  │ 提供商       │  │  Discord     │  │  Permission    │ │
│  │             │  │  飞书         │  │  Gateway       │ │
│  └─────────────┘  └──────────────┘  └────────────────┘ │
│  ┌─────────────────────────────────────────────────┐    │
│  │           Core 客户端 (HTTP/WebSocket)            │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Go Core (tlive-core)                         │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────┐ │
│  │ PTY 管理  │  │ 会话管理   │  │ Web UI   │  │ 统计  │ │
│  │          │  │           │  │ 仪表盘    │  │       │ │
│  └──────────┘  └───────────┘  └──────────┘  └───────┘ │
│  ┌──────────────────────────────────────────────────┐   │
│  │              HTTP API + WebSocket                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
        │                               │
        ▼                               ▼
   终端 PTY                        浏览器 (xterm.js)
```

**两个组件：**

| 组件 | 职责 | 可独立运行？ |
|------|------|-------------|
| **Go Core** (`tlive-core`) | PTY、Web UI、HTTP API、WebSocket | 是 — 可以不装 IM 只做终端监控 |
| **Node.js Bridge** | Claude SDK、IM 适配器、权限审批 | 否 — 需要 Core 运行 |

## IM 交互流程

```
你 (Telegram):    "修复 auth.ts 里的登录 bug"
                         │
Claude Code:      分析代码，找到问题...
                         │
TermLive (TG):    🔧 Claude 正在编辑 src/auth.ts
                  流式响应: "我发现了问题..."
                         │
TermLive (TG):    🔒 需要权限
                  工具: Edit | 文件: src/auth.ts
                  [允许] [本次全允许] [拒绝]
                  🖥 查看终端 ↗
                         │
你:               点击 [允许]
                         │
TermLive (TG):    ✅ 任务完成
                  已修复 auth.ts，全部测试通过
                  📊 12.3k/8.1k tok | $0.08 | 2m 34s
```

### 平台支持

| 功能 | Telegram | Discord | 飞书 |
|------|----------|---------|------|
| 流式响应 | 编辑消息，700ms | 编辑消息，1500ms | CardKit v2，200ms |
| 权限按钮 | 内联键盘 | Button 组件 | 互动卡片 |
| 图片支持 | 支持 | 支持 | 支持 |
| 字符限制 | 4096/块 | 2000/块 | 30000/块 |

## 命令

| 命令 | 说明 |
|------|------|
| `/termlive setup` | 交互式配置向导 |
| `/termlive start` | 启动 Go Core + Bridge |
| `/termlive stop` | 停止所有服务（先停 Bridge，再停 Core） |
| `/termlive status` | 查看服务状态、连接、会话 |
| `/termlive logs [N]` | 查看最近 N 行日志（Core + Bridge） |
| `/termlive doctor` | 运行诊断检查 |
| `/termlive reconfigure` | 修改 IM 平台配置 |

支持中英文输入：`setup`/`配置`、`start`/`启动`、`stop`/`停止`、`status`/`状态`、`doctor`/`诊断` 均可识别。

## 状态行

Claude Code 底部状态栏：
```
TL: 2sess | bridge:on | 12.3k/8.1k tok | $0.08
```

Web UI 仪表盘底部：
```
● 3 sessions │ TG ● DC ● FS ● │ 12.3k/8.1k tok │ $0.08 │ 2m 34s
```

## 配置

所有设置在 `~/.termlive/config.env`（由 `/termlive setup` 创建）：

```env
TL_PORT=8080
TL_TOKEN=自动生成
TL_PUBLIC_URL=https://termlive.example.com
TL_ENABLED_CHANNELS=telegram,discord,feishu

TL_TG_BOT_TOKEN=你的-bot-token
TL_TG_ALLOWED_USERS=123456789

TL_DC_BOT_TOKEN=你的-bot-token
TL_DC_ALLOWED_CHANNELS=频道ID

TL_FS_APP_ID=你的-app-id
TL_FS_APP_SECRET=你的-app-secret
```

完整变量列表参见 `config.env.example`。

## 开发

```bash
# 构建 Go Core
cd core && go build -o tlive-core ./cmd/tlive-core/

# 构建 Bridge
cd bridge && npm install && npm run build

# Go 测试
cd core && go test ./... -v -timeout 30s

# Bridge 测试 (122 个)
cd bridge && npm test
```

### 项目结构

```
termlive/
├── SKILL.md                 # Claude Code 技能定义
├── config.env.example       # 配置模板
├── core/                    # Go Core → tlive-core 二进制
│   ├── cmd/tlive-core/
│   ├── internal/
│   │   ├── daemon/          # HTTP API、会话管理、Bridge 注册、统计、令牌
│   │   ├── server/          # WebSocket 处理、状态流
│   │   ├── session/         # 会话状态和输出缓冲
│   │   ├── hub/             # 广播中心
│   │   ├── pty/             # PTY 抽象 (Unix + Windows ConPTY)
│   │   └── config/          # TOML 配置
│   └── web/                 # 内嵌 Web UI
├── bridge/                  # Node.js Bridge
│   └── src/
│       ├── providers/       # Claude Agent SDK + CLI 回退
│       ├── channels/        # Telegram、Discord、飞书适配器
│       ├── engine/          # 对话引擎、Bridge 管理器
│       ├── permissions/     # 权限网关 + 代理
│       ├── delivery/        # 分块、重试、限速
│       ├── markdown/        # IR → 各平台渲染
│       └── store/           # JSON 文件持久化
├── scripts/                 # daemon.sh、doctor.sh、statusline.sh
├── docker-compose.yml
└── .github/workflows/       # CI + 发布
```

## 安全

- **Bearer Token 认证** — 所有 API 端点（setup 时自动生成）
- **限时令牌** — IM 中的 Web 链接使用 1 小时有效的只读令牌
- **IM 用户白名单** — 按平台配置允许的用户
- **日志脱敏** — 所有日志中自动隐藏密钥
- **配置权限** — `config.env` 设置为 `chmod 600`

## 许可证

MIT
