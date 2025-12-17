// Cloudflare Worker：Telegram 双向机器人
// 修改内容：
// 1) 去除人机验证流程（不再校验 verified，不再发题，不再处理按钮回调）
// 2) 私聊命令不转发（包括 /start）
// 3) 话题被手动删除后，再次私聊会自动新建话题并转发（增强错误识别）

export default {
  async fetch(request, env, ctx) {
    // --- 2. 环境自检 ---
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

    // --- 3. 路由分发 ---

    // A. 处理按钮回调（已去除人机验证，这里不再处理）
    // if (update.callback_query) {
    //   await handleCallbackQuery(update.callback_query, env, ctx);
    //   return new Response("OK");
    // }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(env, Date.now()));

    // B. 处理私聊消息
    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, env, ctx);
      } catch (e) {
        const errText = `⚠️ **系统错误**\n\n\`${e.message}\`\n\n请检查配置: SUPERGROUP_ID / BOT_TOKEN / TOPIC_MAP`;
        await tgCall(env, "sendMessage", { chat_id: msg.chat.id, text: errText, parse_mode: "Markdown" });
        console.error(e);
      }
      return new Response("OK");
    }

    // C. 处理群组消息
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

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 1. 过滤掉所有指令（包括 /start），不转发
  if (msg.text && msg.text.startsWith("/")) {
      return;
  }

  // 2. 检查黑名单
  const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
  if (isBanned) return;

  // 2.1 强制检查 Username 是否存在
  if (!msg.from.username) {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⚠️ **很抱歉,你的用户名(username)未设置,无法发送消息!**\n\n(请在 Telegram 设置中配置用户名后重试)",
          parse_mode: "Markdown"
      });
      return;
  }

  // 3. 去除人机验证：直接转发消息
  await forwardToTopic(msg, userId, key, env, ctx);
}

async function forwardToTopic(msg, userId, key, env, ctx) {
    let rec = await env.TOPIC_MAP.get(key, { type: "json" });

    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await createTopic(msg.from, key, env);
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
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
        const desc = (res.description || "").toLowerCase();

        // 支持：话题被删除后重新开始（增强识别，不改变整体逻辑）
        const topicMissing =
          desc.includes("thread not found") ||
          desc.includes("topic not found") ||
          desc.includes("message_thread_not_found") ||
          desc.includes("message thread not found") ||
          (desc.includes("thread") && desc.includes("not found")) ||
          (desc.includes("topic") && desc.includes("not found"));

        if (topicMissing) {
            const newRec = await createTopic(msg.from, key, env);
            await tgCall(env, "forwardMessage", {
                chat_id: env.SUPERGROUP_ID,
                from_chat_id: userId,
                message_id: msg.message_id,
                message_thread_id: newRec.thread_id,
            });
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
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

  // --- 管理员指令区域 ---

  if (text === "/close") {
      const key = `user:${userId}`;
      let rec = await env.TOPIC_MAP.get(key, { type: "json" });
      if (rec) {
          rec.closed = true;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
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
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
      }
      return;
  }

  if (text === "/ban") {
      await env.TOPIC_MAP.put(`banned:${userId}`, "1");
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **用户已封禁**", parse_mode: "Markdown" });
      return;
  }

  if (text === "/unban") {
      await env.TOPIC_MAP.delete(`banned:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **用户已解封**", parse_mode: "Markdown" });
      return;
  }

  // /info 指令逻辑：显示 Full Name
  if (text === "/info") {
      const chatInfo = await tgCall(env, "getChat", { chat_id: userId });
      const r = chatInfo.result || {};

      const username = r.username ? `@${r.username}` : "未设置";
      const fullName = (r.first_name + " " + (r.last_name || "")).trim();

      const info = `👤 **用户信息**\nUID: \`${userId}\`\nName: \`${fullName}\`\nUsername: \`${username}\`\nTopic ID: \`${threadId}\`\nLink: [点击私聊](tg://user?id=${userId})`;

      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
      return;
  }

  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: null });
    return;
  }
  await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- 辅助函数 ----------------

async function createTopic(from, key, env) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    return rec;
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

function buildTopicTitle(from) {
  const name = (from.first_name + " " + (from.last_name || "")).trim();
  return (name || "User") + (from.username ? ` @${from.username}` : "");
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
