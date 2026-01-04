# TGbot
私信聊天转发BOT，通过群组不同话题区分用户

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
`https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/`
<!--
代码修改自
- [jikssha](https://github.com/jikssha/telegram_private_chatbot)
-->
