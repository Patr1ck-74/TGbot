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

    // 1. 优先处理验证按钮点击 (支持随机ID前缀匹配)
    if (update.callback_query) {
      try {
        await handleCallback(update.callback_query, env);
      } catch (e) {
        console.error("Callback Error:", e.message);
      }
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(env, Date.now()));

    // 2. 处理私聊
    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, env, ctx);
      } catch (e) {
        const errText = `⚠️ **系统错误**\n\n\`${e.message}\``;
        await tgCall(env, "sendMessage", { chat_id: msg.chat.id, text: errText, parse_mode: "Markdown" });
      }
      return new Response("OK");
    }

    // 3. 处理超级群组 (回复逻辑)
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

// 处理验证按钮回调
async function handleCallback(query, env) {
  const userId = query.from.id;
  const data = query.data;

  // 修改：改为匹配随机ID前缀
  if (data.startsWith("verify:")) {
    // 在 KV 中标记已验证
    await env.TOPIC_MAP.put(`verified:${userId}`, "true", { expirationTtl: 2592000 });
    
    // 消除按钮转圈并弹出提示
    await tgCall(env, "answerCallbackQuery", { 
      callback_query_id: query.id, 
      text: "✅ 验证成功！",
      show_alert: true 
    });

    // 编辑验证消息
    await tgCall(env, "editMessageText", {
      chat_id: userId,
      message_id: query.message.message_id,
      text: "✅ **验证已通过**\n\n现在您可以直接发送消息给管理员了。",
      parse_mode: "Markdown"
    });
  }
}

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;
  const text = (msg.text || "").trim();



  const isVerified = await env.TOPIC_MAP.get(`verified:${userId}`);

  // 修改：/start 立即触发验证
  if (text === "/start") {
    if (isVerified) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "您已经通过验证，可以直接发送消息。" });
    } else {
      const verifyId = Math.random().toString(36).substring(2, 10);
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "🛡️ **为了防止广告骚扰，请点击下方按钮完成验证。**\n验证通过后即可开始对话。",
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "我不是机器人 [点击验证]", callback_data: `verify:${verifyId}` }
          ]]
        }
      });
    }
    return;
  }

  // 修改：拦截未验证用户的普通消息
  if (!isVerified) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ **请先点击上方的验证按钮完成验证。**\n只有验证通过后，管理员才能收到您的消息。",
      parse_mode: "Markdown"
    });
    return; 
  }

  // 原有逻辑：指令过滤
  if (msg.text && msg.text.startsWith("/")) return;

  await forwardToTopic(msg, userId, key, env, ctx);
}

// --- 以下所有原始函数保持原样，不做任何修改 ---

async function forwardToTopic(msg, userId, key, env, ctx) {
    let rec = await env.TOPIC_MAP.get(key, { type: "json" });
    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }
    if (!rec || !rec.thread_id) {
        rec = await createTopic(msg, key, env);
    }
    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
        return;
    }
    let res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    const droppedInGeneral = res.ok && !res.result.message_thread_id;
    if (!res.ok || droppedInGeneral) {
        let shouldRecreate = false;
        if (!res.ok) {
            const desc = (res.description || "").toLowerCase();
            if (desc.includes("thread") || desc.includes("topic") || desc.includes("not found")) shouldRecreate = true;
        } else if (droppedInGeneral) {
            await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: res.result.message_id });
            shouldRecreate = true;
        }
        if (shouldRecreate) {
            await env.TOPIC_MAP.delete(key); 
            const newRec = await createTopic(msg, key, env);
            await tgCall(env, "forwardMessage", {
                chat_id: env.SUPERGROUP_ID,
                from_chat_id: userId,
                message_id: msg.message_id,
                message_thread_id: newRec.thread_id,
            });
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
