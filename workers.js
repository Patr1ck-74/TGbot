// Cloudflare Worker：Telegram 双向机器人

export default {
    async fetch(request, env, ctx) {
      if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
      if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
      if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");
  
      if (request.method !== "POST") return new Response("OK");
  
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("OK");
      }
  
      const msg = update.message;
      if (!msg) return new Response("OK");
  
      ctx.waitUntil(flushExpiredMediaGroups(env, Date.now()));
  
      /* ---------------- 私聊 ---------------- */
      if (msg.chat?.type === "private") {
        try {
          await handlePrivateMessage(msg, env, ctx);
        } catch (e) {
          await tgCall(env, "sendMessage", {
            chat_id: msg.chat.id,
            text: `⚠️ 系统错误\n\n${e.message}`,
          });
          console.error(e);
        }
        return new Response("OK");
      }
  
      /* ---------------- 群 Topic ---------------- */
      const supergroupId = Number(env.SUPERGROUP_ID);
      if (msg.chat && Number(msg.chat.id) === supergroupId) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
          await updateThreadStatus(msg.message_thread_id, true, env);
          return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
          await updateThreadStatus(msg.message_thread_id, false, env);
          return new Response("OK");
        }
        if (msg.message_thread_id) {
          await handleAdminReply(msg, env, ctx);
          return new Response("OK");
        }
      }
  
      return new Response("OK");
    },
  };
  
  /* ================= 私聊处理 ================= */
  
  async function handlePrivateMessage(msg, env, ctx) {
    const userId = msg.chat.id;
    const key = `user:${userId}`;
  
    // 过滤所有的命令
    if (msg.text?.startsWith("/")) return;
  
    // 黑名单
    if (await env.TOPIC_MAP.get(`banned:${userId}`)) return;
  
    // Username 强制检查
    if (!msg.from.username) {
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "⚠️ **请先在 Telegram 设置用户名 (username)，否则无法发送消息**",
        parse_mode: "Markdown",
      });
      return;
    }
  
    await forwardToTopic(msg, userId, key, env, ctx);
  }
  
  /* ================= 转发逻辑 ================= */
  
  async function forwardToTopic(msg, userId, key, env, ctx) {
    let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  
    if (rec?.closed) {
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "🚫 当前对话已被管理员关闭。",
      });
      return;
    }
  
    if (!rec || !rec.thread_id) {
      rec = await createTopic(msg.from, key, env);
    }
  
    if (msg.media_group_id) {
      await handleMediaGroup(msg, env, ctx, {
        direction: "p2t",
        targetChat: env.SUPERGROUP_ID,
        threadId: rec.thread_id,
      });
      return;
    }
  
    const res = await tgCall(env, "forwardMessage", {
      chat_id: env.SUPERGROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id,
      message_thread_id: rec.thread_id,
    });
  
    if (!res.ok) {
      await tgCall(env, "copyMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
      });
    }
  }
  
  /* ================= 管理员回复 ================= */
  
  async function handleAdminReply(msg, env, ctx) {
    const threadId = msg.message_thread_id;
    const text = (msg.text || "").trim();
  
    let userId = null;
    const list = await env.TOPIC_MAP.list({ prefix: "user:" });
    for (const { name } of list.keys) {
      const rec = await env.TOPIC_MAP.get(name, { type: "json" });
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        userId = Number(name.slice(5));
        break;
      }
    }
    if (!userId) return;
  
    const key = `user:${userId}`;
  
    if (text === "/close") {
      const rec = await env.TOPIC_MAP.get(key, { type: "json" });
      rec.closed = true;
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
      return;
    }
  
    if (text === "/open") {
      const rec = await env.TOPIC_MAP.get(key, { type: "json" });
      rec.closed = false;
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
      return;
    }
  
    if (text === "/ban") {
      await env.TOPIC_MAP.put(`banned:${userId}`, "1");
      return;
    }
  
    if (text === "/unban") {
      await env.TOPIC_MAP.delete(`banned:${userId}`);
      return;
    }
  
    if (text === "/info") {
      const chatInfo = await tgCall(env, "getChat", { chat_id: userId });
      const r = chatInfo.result || {};
      const fullName = `${r.first_name || ""} ${r.last_name || ""}`.trim();
      const username = r.username ? `@${r.username}` : "未设置";
  
      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `👤 用户信息\nUID: ${userId}\nName: ${fullName}\nUsername: ${username}`,
      });
      return;
    }
  
    if (msg.media_group_id) {
      await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId });
      return;
    }
  
    await tgCall(env, "copyMessage", {
      chat_id: userId,
      from_chat_id: env.SUPERGROUP_ID,
      message_id: msg.message_id,
    });
  }
  
  /* ================= 工具函数 ================= */
  
  async function createTopic(from, key, env) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.startsWith("-100")) throw new Error("SUPERGROUP_ID 必须以 -100 开头");
  
    const res = await tgCall(env, "createForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      name: title,
    });
  
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    return rec;
  }
  
  function buildTopicTitle(from) {
    const name = `${from.first_name || ""} ${from.last_name || ""}`.trim();
    return name + (from.username ? ` @${from.username}` : "");
  }
  
  async function tgCall(env, method, body) {
    const base = env.API_BASE || "https://api.telegram.org";
    const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await resp.json();
  }
  
  /* ================= MediaGroup ================= */
  
  async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const key = `mg:${direction}:${msg.media_group_id}`;
    const item = extractMedia(msg);
    if (!item) {
      await tgCall(env, "copyMessage", {
        chat_id: targetChat,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
        message_thread_id: threadId,
      });
      return;
    }
  
    let rec = await env.TOPIC_MAP.get(key, { type: "json" });
    if (!rec) rec = { direction, targetChat, threadId, items: [], last_ts: Date.now() };
  
    rec.items.push({ ...item });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: 60 });
  
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
  }
  
  function extractMedia(msg) {
    if (msg.photo) return { type: "photo", media: msg.photo.pop().file_id, caption: msg.caption };
    if (msg.video) return { type: "video", media: msg.video.file_id, caption: msg.caption };
    if (msg.document) return { type: "document", media: msg.document.file_id, caption: msg.caption };
    return null;
  }
  
  async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, 2000));
    const rec = await env.TOPIC_MAP.get(key, { type: "json" });
    if (!rec || rec.last_ts !== ts) return;
  
    await tgCall(env, "sendMediaGroup", {
      chat_id: rec.targetChat,
      message_thread_id: rec.threadId,
      media: rec.items,
    });
  
    await env.TOPIC_MAP.delete(key);
  }
  
  async function flushExpiredMediaGroups(env, now) {}
  
