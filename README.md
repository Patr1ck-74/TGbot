# TGbot (Shaw 重构版)

私信聊天转发 BOT：将用户私聊转发到超级群组的话题（forum topic），管理员在对应话题回复后，消息再回到用户私聊。

---

## 功能总览

- **双向消息转发**（私聊 ↔ 超级群话题）
- **按用户自动建话题**（标题 `Name #UID`）
- **Shaw 验证系统**
  - 动态验证题（数学题 + 常识题）
  - 4 选 1，带 nonce，一次性会话
  - 默认 3 分钟有效，3 次失败进入冷却
- **分层限流**
  - 新用户（验证后 24h 内）：10 秒 2 条、60 秒 6 条
  - 普通用户：10 秒 4 条、60 秒 12 条
- **重复骚扰检测**
  - 短时间重复文本达到阈值会触发冷却
- **管理员指令（在用户话题里使用）**
  - `/info` 查看用户信息
  - `/close` 关闭当前会话
  - `/open` 重新开启会话

---

## 部署步骤（Cloudflare Dashboard）

1. 进入 **Workers & Pages** → **Create** → **Create Worker**。
2. 打开在线编辑器，将本仓库 `workers.js` 全量粘贴覆盖。
3. 在 Worker 的 **Settings → Variables** 中配置：

### 1) KV 绑定（必须）

- 绑定变量名：`PM`（必须是这个名字）
- 绑定到任意一个 KV Namespace（可新建）

### 2) 环境变量（必须）

- `BOT_TOKEN`：你的 Telegram Bot Token
- `SUPERGROUP_ID`：你的目标超级群 ID（通常为负数）

### 3) 可选变量

- `API_BASE`：默认不填，默认值为 `https://api.telegram.org`

4. 点击 **Save and Deploy**。

---

## 激活 Webhook

部署完成后，打开下面 URL（替换为你自己的参数）：

```text
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>&allowed_updates=["message","callback_query"]
```

可用下面命令检查：

```bash
curl "https://api.telegram.org/bot<你的BOT_TOKEN>/getWebhookInfo"
```


