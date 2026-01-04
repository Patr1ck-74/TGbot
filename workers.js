// Cloudflare Worker：Telegram 双向机器人
// 修改内容：
// 1) 去除人机验证流程（不再校验 verified，不再发题，不再处理按钮回调）
// 2) 话题被手动删除后，再次私聊会自动新建话题并转发（增强错误识别）
// 3) 彻底移除 Username 校验逻辑，无用户名用户也可正常使用
// 4) 话题标题强制使用 UserID (例如: 张三 #6062184506)-区分相同姓名用户

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
  
      if (msg.chat && msg.chat.type === "private") {
        try {
          await handlePrivateMessage(msg, env, ctx);
        } catch (e) {
          const errText = `⚠️ **系统错误**\n\n\`${e.message}\``;
          await tgCall(env, "sendMessage", { chat_id: msg.chat.id, text: errText, parse_mode: "Markdown" });
        }
        return new Response("OK");
      }
  
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
  
  async function handlePrivateMessage(msg, env, ctx) {
    const userId = msg.chat.id;
    const key = `user:${userId}`;
    if (msg.text && msg.text.startsWith("/")) return;
    const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
    if (isBanned) return;
  
    await forwardToTopic(msg, userId, key, env, ctx);
  }
  
  async function forwardToTopic(msg, userId, key, env, ctx) {
      let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  
      if (rec && rec.closed) {
          await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
          return;
      }
  
      // 1. 如果没有记录，创建新话题
      if (!rec || !rec.thread_id) {
          rec = await createTopic(msg, key, env);
      }
  
      if (msg.media_group_id) {
          await handleMediaGroup(msg, env, ctx, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
          return;
      }
  
      // 2. 尝试转发
      let res = await tgCall(env, "forwardMessage", {
          chat_id: env.SUPERGROUP_ID,
          from_chat_id: userId,
          message_id: msg.message_id,
          message_thread_id: rec.thread_id,
      });
  
      // --- 核心修复逻辑 ---
      // 即使 res.ok 是 true，如果返回的消息里没有 message_thread_id，说明它掉进了 General 话题
      const droppedInGeneral = res.ok && !res.result.message_thread_id;
      const errorOccurred = !res.ok;
  
      if (errorOccurred || droppedInGeneral) {
          let shouldRecreate = false;
  
          if (errorOccurred) {
              const desc = (res.description || "").toLowerCase();
              if (desc.includes("thread") || desc.includes("topic") || desc.includes("not found")) {
                  shouldRecreate = true;
              }
          } else if (droppedInGeneral) {
              // 如果掉进了通用话题，删除刚刚发错的那条消息（可选）
              await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: res.result.message_id });
              shouldRecreate = true;
          }
  
          if (shouldRecreate) {
              // 强制删除旧 KV 并重建
              await env.TOPIC_MAP.delete(key); 
              const newRec = await createTopic(msg, key, env);
              await tgCall(env, "forwardMessage", {
                  chat_id: env.SUPERGROUP_ID,
                  from_chat_id: userId,
                  message_id: msg.message_id,
                  message_thread_id: newRec.thread_id,
              });
              return;
          }
      }
  }
  
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
  
    if (text === "/close") {
        const key = `user:${userId}`;
        let rec = await env.TOPIC_MAP.get(key, { type: "json" });
        if (rec) {
            rec.closed = true;
            await env.TOPIC_MAP.put(key, JSON.stringify(rec));
            await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
        }
        return;
    }
    if (text === "/open") {
        const key = `user:${userId}`;
        let rec = await env.TOPIC_MAP.get(key, { type: "json" });
        if (rec) {
            rec.closed = false;
            await env.TOPIC_MAP.put(key, JSON.stringify(rec));
            await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
        }
        return;
    }
    if (text === "/info") {
        const chatInfo = await tgCall(env, "getChat", { chat_id: userId });
        const r = chatInfo.result || {};
        const info = `👤 **用户信息**\nUID: \`${userId}\`\nName: \`${(r.first_name || "") + " " + (r.last_name || "")}\`\nLink: [点击私聊](tg://user?id=${userId})`;
        await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
        return;
    }
  
    if (msg.media_group_id) {
      await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: null });
      return;
    }
    await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
  }
  
  async function createTopic(msg, key, env) {
      const title = buildTopicTitle(msg);
      const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
      if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
      const rec = { thread_id: res.result.message_thread_id, title, closed: false };
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      return rec;
  }
  
  function buildTopicTitle(msg) {
    const from = msg.from || {};
    const chat = msg.chat || {};
    const name = (from.first_name || chat.first_name || "User").trim();
    const userId = from.id || chat.id;
    return `${name} #${userId}`.slice(0, 64);
  }
  
  function updateThreadStatus(threadId, isClosed, env) {
      return env.TOPIC_MAP.list({ prefix: "user:" }).then(list => {
          for (const { name } of list.keys) {
              env.TOPIC_MAP.get(name, { type: "json" }).then(rec => {
                  if (rec && Number(rec.thread_id) === Number(threadId)) {
                      rec.closed = isClosed;
                      env.TOPIC_MAP.put(name, JSON.stringify(rec));
                  }
              });
          }
      });
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
  
  async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
      const groupId = msg.media_group_id;
      const key = `mg:${direction}:${groupId}`;
      const item = extractMedia(msg);
      if (!item) {
          await tgCall(env, "copyMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: threadId });
          return;
      }
      let rec = await env.TOPIC_MAP.get(key, { type: "json" });
      if (!rec) rec = { direction, targetChat, threadId, items: [], last_ts: Date.now() };
      rec.items.push({ ...item, msg_id: msg.message_id });
      rec.last_ts = Date.now();
      await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: 60 });
      ctx.waitUntil(delaySend(env, key, rec.last_ts));
  }
  
  function extractMedia(msg) {
      if (msg.photo) return { type: "photo", id: msg.photo.pop().file_id, cap: msg.caption };
      if (msg.video) return { type: "video", id: msg.video.file_id, cap: msg.caption };
      if (msg.document) return { type: "document", id: msg.document.file_id, cap: msg.caption };
      return null;
  }
  
  async function flushExpiredMediaGroups(env, now) {}
  async function delaySend(env, key, ts) {
      await new Promise(r => setTimeout(r, 2000));
      const rec = await env.TOPIC_MAP.get(key, { type: "json" });
      if (rec && rec.last_ts === ts) {
          const media = rec.items.map((it, i) => ({ type: it.type, media: it.id, caption: i===0?it.cap:"" }));
          if (media.length > 0) await tgCall(env, "sendMediaGroup", { chat_id: rec.targetChat, message_thread_id: rec.threadId, media });
          await env.TOPIC_MAP.delete(key);
      }
  }
