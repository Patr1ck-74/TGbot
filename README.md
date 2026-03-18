# TGbot
私信聊天转发BOT，通过群组不同话题区分用户

### 🌟 功能描述
* **双向私信与话题隔离**：自动将用户的私聊消息转发至指定的超级群组（Supergroup），并为每位用户自动创建一个专属的话题（Topic）（标题格式为 `名字 #UID`）。管理员在对应话题内回复，即可将消息直接送达给该用户。
* **新用户人机验证防刷**：内置简单防广告骚扰机制，新用户发送 `/start` 或任何消息时，必须点击“我不是机器人”内联按钮进行验证。只有验证通过（状态在 KV 中保留）的用户，其消息才会被管理员接收。
* **管理员快捷指令**：在群组特定用户的专属话题内，管理员可使用以下指令：
   * `/info`：快速获取该用户的详细信息（UID、姓名及直达私聊链接）。
   * `/close`：关闭当前对话话题。
   * `/open`：重新开启已关闭的对话话题。
   * 若管理员在群组中利用 Telegram 自带功能关闭或重新开启话题，机器人的对话状态会自动同步更新。

### 手动复制部署 (简单直接)

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  进入 **Workers & Pages** -> **Create Application** -> **Create Worker** ，选择从`hello world`开始。
3.  命名你的 Worker，点击 **Deploy**。
4.  点击 **Edit code**，将本项目 `worker.js` 的所有代码复制粘贴进去，覆盖原代码。
5.  点击右上角 **Deploy** 保存。
6.  **配置 KV 与变量**：
    * 去 **Settings** -> **Variables**。
    * 添加 KV 绑定：Variable name 填 `TOPIC_MAP`，并绑定一个 KV 数据库。
    * 添加环境变量：`BOT_TOKEN` 和 `SUPERGROUP_ID`。
    * 点击 **Save and Deploy**。
---
# 激活 Webhook 
部署后访问：
`https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>&allowed_updates=["message","callback_query"]`

代码修改自
- [jikssha](https://github.com/jikssha/telegram_private_chatbot)

