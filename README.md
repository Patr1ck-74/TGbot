# TGbot (Shaw 重构版)

私信聊天转发 BOT：将用户私聊转发到超级群组话题（forum topic），管理员在对应话题回复后，消息再回到用户私聊。

---

## 功能总览

- **双向消息转发**（私聊 ↔ 超级群话题）
- **按用户自动建话题**（标题 `Name #UID`）
- **Shaw 验证系统**
  - 动态题库（数学题 + 常识题）
  - 4 选 1、nonce 一次性会话
  - 默认 3 分钟有效，失败 3 次进入冷却
- **分层限流**
  - 新用户（验证后 24h 内）：10 秒 2 条、60 秒 6 条
  - 普通用户：10 秒 4 条、60 秒 12 条
- **重复骚扰检测**
  - 短时间重复文本达到阈值会触发冷却
- **会话失效保护**
  - 管理员删除话题后，用户再次发消息会被要求重新验证
- **管理员冷却管理**（群主聊天区）
  - 可列出冷却用户并一键解封

---

## 指令说明

### A. 用户侧（私聊机器人）

- `/start`
  - 触发验证流程（未验证用户）
  - 已验证用户会收到“可直接发送消息”提示

---

### B. 管理员侧：用户话题内指令（在某个用户对应话题中）

- `/info`：查看当前用户信息（UID、Name、Username）
- `/close`：关闭当前对话（用户继续发消息会提示已关闭）
- `/open`：重新开启当前对话

---

### C. 管理员侧：群主聊天区指令（不在话题里）

- `/help`
  - 显示管理员命令总览（群主聊天区 + 话题内命令）

- `/cl` 或 `/cool`
  - 列出当前处于冷却中的用户（最多展示前 20）
  - 自动附带“解封 UID”按钮，可点击一键解封

- `/uf <uid>`
  - 手动解封指定 UID（短命令）

- `/clean <uid>`
  - 清理某个用户在 KV 中的状态数据（话题映射、验证状态、反骚扰状态、限流计数等）

- `/cleanstale [maxScan]`
  - 温和清理：仅处理“过期验证会话 + 已到期冷却状态”
  - `maxScan` 可选，默认 600，范围 50~5000

> 注：管理员命令仅群管理员/群主可用。

---

## 部署步骤（Cloudflare Dashboard）

1. 进入 **Workers & Pages** → **Create** → **Create Worker**。
2. 打开在线编辑器，将本仓库 `workers.js` 全量粘贴覆盖。
3. 在 Worker 的 **Settings → Variables** 中配置：

### 1) KV 绑定（必须）

- 绑定变量名：`PM`（必须是这个名字）
- 绑定到一个 KV Namespace（建议新建）

### 2) 环境变量（必须）

- `BOT_TOKEN`：你的 Telegram Bot Token
- `SUPERGROUP_ID`：目标超级群 ID（通常是 `-100...`）

### 3) 可选变量

- `API_BASE`：默认 `https://api.telegram.org`

4. 点击 **Save and Deploy**。

---

## 激活 Webhook

部署完成后访问（替换参数）：

```text
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>&allowed_updates=["message","callback_query"]
```

检查状态：

```bash
curl "https://api.telegram.org/bot<你的BOT_TOKEN>/getWebhookInfo"
```

---

## 常见问题

### 1) 为什么验证通过但没转发？

请先检查：
- `SUPERGROUP_ID` 是否正确
- 机器人是否在群内且有权限
- 群是否开启话题功能

### 2) 冷却多久？

默认 30 分钟（代码参数：`SHAW_SETTINGS.antiSpam.cooldownMs`）。

### 3) 可否手动取消冷却？

可以，管理员在群主聊天区使用：
- `/cl`（列表+按钮解封）
- `/uf <uid>`（指定 UID 解封）

### 4) 如何清理 KV 状态数据？

- 温和清理（推荐）：`/cleanstale [maxScan]`
- 清理单个用户：`/clean <uid>`

### 5) 管理员如何查看全部命令？

在群主聊天区发送：`/help`
