// Cloudflare Worker: Shaw Telegram 私聊 <-> 超级群话题 转发机器人
// 特性：
// - Shaw 动态人机验证（数学题 + 常识题）
// - Shaw 分层限流（新用户 / 普通用户）
// - Shaw 重复骚扰检测（短时重复触发冷却）
// - 话题自动创建、状态同步、管理员指令

const SHAW_KV = {
  topicByUser: (userId) => `shaw:topic:user:${userId}`,
  userByThread: (threadId) => `shaw:topic:thread:${threadId}`,
  userProfile: (userId) => `shaw:user:${userId}:profile`,
  verifySession: (userId) => `shaw:verify:${userId}`,
  spamState: (userId) => `shaw:spam:${userId}`,
  mediaGroup: (direction, mediaGroupId) => `shaw:mg:${direction}:${mediaGroupId}`,
  rateLimit: (userId, windowSec, bucket) => `shaw:rl:${userId}:${windowSec}:${bucket}`,
};

const SHAW_SETTINGS = {
  verify: {
    ttlSec: 180,
    maxAttempts: 3,
  },
  trust: {
    newUserWindowMs: 24 * 60 * 60 * 1000,
  },
  rateLimit: {
    newcomer: [
      { windowSec: 10, limit: 2 },
      { windowSec: 60, limit: 6 },
    ],
    normal: [
      { windowSec: 10, limit: 4 },
      { windowSec: 60, limit: 12 },
    ],
  },
  antiSpam: {
    repeatWindowMs: 90 * 1000,
    repeatThreshold: 3,
    cooldownMs: 30 * 60 * 1000,
  },
  mediaGroupFlushDelayMs: 2000,
};

const SHAW_COMMON_SENSE_QUESTIONS = [
  {
    question: "太阳通常从哪边升起？",
    options: ["东边", "西边", "北边", "南边"],
    correctIndex: 0,
  },
  {
    question: "一年有多少个月？",
    options: ["10", "11", "12", "13"],
    correctIndex: 2,
  },
  {
    question: "水在标准大气压下大约多少℃沸腾？",
    options: ["0℃", "50℃", "100℃", "150℃"],
    correctIndex: 2,
  },
  {
    question: "地球上白天和黑夜主要由什么造成？",
    options: ["地球自转", "月亮绕地球", "太阳绕地球", "季节变化"],
    correctIndex: 0,
  },
  {
    question: "中国首都城市是？",
    options: ["上海", "北京", "广州", "深圳"],
    correctIndex: 1,
  },
  {
    question: "一周通常有几天？",
    options: ["5", "6", "7", "8"],
    correctIndex: 2,
  },
];

export default {
  async fetch(request, env, ctx) {
    const bootstrapError = validateEnv(env);
    if (bootstrapError) return new Response(bootstrapError, { status: 500 });

    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    try {
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
        return new Response("OK");
      }

      const msg = update.message;
      if (!msg) return new Response("OK");

      if (msg.chat?.type === "private") {
        await handlePrivateChatMessage(msg, env, ctx);
        return new Response("OK");
      }

      const supergroupId = Number(env.SUPERGROUP_ID);
      if (Number(msg.chat?.id) === supergroupId && msg.message_thread_id) {
        await handleSupergroupThreadMessage(msg, env, ctx);
      }
    } catch (err) {
      console.error("Unhandled error:", err?.message || err);
    }

    return new Response("OK");
  },
};

function validateEnv(env) {
  if (!env.PM) return "Error: KV 'PM' not bound.";
  if (!env.BOT_TOKEN) return "Error: BOT_TOKEN not set.";
  if (!env.SUPERGROUP_ID) return "Error: SUPERGROUP_ID not set.";
  return "";
}

async function handleCallbackQuery(query, env) {
  const userId = query.from?.id;
  const data = query.data || "";

  if (!userId || !data.startsWith("verify|")) {
    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "无效操作",
      show_alert: false,
    });
    return;
  }

  // 防止他人伪造点击（必须来自本人私聊消息）
  if (Number(query.message?.chat?.id) !== Number(userId)) {
    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "验证来源异常",
      show_alert: true,
    });
    return;
  }

  const parts = data.split("|");
  if (parts.length !== 3) {
    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "验证数据异常",
      show_alert: true,
    });
    return;
  }

  const [, nonce, selectedRaw] = parts;
  const selectedIndex = Number(selectedRaw);
  if (!Number.isInteger(selectedIndex)) {
    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "选项无效",
      show_alert: true,
    });
    return;
  }

  const key = SHAW_KV.verifySession(userId);
  const session = await env.PM.get(key, { type: "json" });
  const now = Date.now();

  if (!session || session.nonce !== nonce || now > session.expiresAt) {
    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "验证已过期，请重新发送 /start",
      show_alert: true,
    });
    return;
  }

  if (selectedIndex === session.correctIndex) {
    await markUserVerified(userId, env, now);
    await env.PM.delete(key);

    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "✅ 验证通过",
      show_alert: false,
    });

    if (query.message?.message_id) {
      await shawTelegramCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: "✅ 验证通过。现在你可以正常发送消息了。",
      });
    }
    return;
  }

  session.attempts += 1;
  if (session.attempts >= session.maxAttempts) {
    const profile = await getUserProfile(userId, env);
    profile.cooldownUntil = now + SHAW_SETTINGS.antiSpam.cooldownMs;
    await setUserProfile(userId, profile, env);
    await env.PM.delete(key);

    await shawTelegramCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "验证失败次数过多，请稍后再试",
      show_alert: true,
    });

    if (query.message?.message_id) {
      await shawTelegramCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: "❌ 验证失败次数过多，已进入冷却。请 30 分钟后再试。",
      });
    }
    return;
  }

  await env.PM.put(key, JSON.stringify(session), { expirationTtl: SHAW_SETTINGS.verify.ttlSec });

  await shawTelegramCall(env, "answerCallbackQuery", {
    callback_query_id: query.id,
    text: `答案错误，还剩 ${session.maxAttempts - session.attempts} 次`,
    show_alert: false,
  });
}

async function handlePrivateChatMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const text = (msg.text || "").trim();
  const now = Date.now();

  const profile = await getUserProfile(userId, env);
  if (profile.cooldownUntil && now < profile.cooldownUntil) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "⏳ 当前账号处于冷却中，请稍后再试。",
    });
    return;
  }

  if (text === "/start") {
    if (profile.verified) {
      await shawTelegramCall(env, "sendMessage", {
        chat_id: userId,
        text: "你已通过验证，可以直接发送消息。",
      });
    } else {
      await sendVerificationChallenge(userId, env);
    }
    return;
  }

  if (!profile.verified) {
    await ensureVerificationPrompt(userId, env);
    return;
  }

  if (msg.text?.startsWith("/")) return;

  const isNewUser = now - (profile.verifiedAt || now) < SHAW_SETTINGS.trust.newUserWindowMs;
  const limiterRules = isNewUser ? SHAW_SETTINGS.rateLimit.newcomer : SHAW_SETTINGS.rateLimit.normal;
  const allowed = await consumeRateLimit(userId, limiterRules, env, now);
  if (!allowed) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 发送太频繁了，请稍后再发。",
    });
    return;
  }

  if (msg.text) {
    const spamVerdict = await evaluateRepeatSpam(userId, msg.text, env, now);
    if (spamVerdict.blocked) {
      await shawTelegramCall(env, "sendMessage", {
        chat_id: userId,
        text: "🚫 检测到重复骚扰内容，账号已临时冷却。",
      });
      return;
    }
  }

  await forwardPrivateMessageToTopic(msg, userId, env, ctx);
}

async function ensureVerificationPrompt(userId, env) {
  const active = await env.PM.get(SHAW_KV.verifySession(userId), { type: "json" });
  if (active && Date.now() <= active.expiresAt) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "请先完成上方验证题目后再发送消息。",
    });
    return;
  }
  await sendVerificationChallenge(userId, env);
}

async function sendVerificationChallenge(userId, env) {
  const challenge = generateShawChallenge();
  const session = {
    nonce: challenge.nonce,
    correctIndex: challenge.correctIndex,
    options: challenge.options,
    attempts: 0,
    maxAttempts: SHAW_SETTINGS.verify.maxAttempts,
    expiresAt: Date.now() + SHAW_SETTINGS.verify.ttlSec * 1000,
    type: challenge.type,
  };

  await env.PM.put(SHAW_KV.verifySession(userId), JSON.stringify(session), {
    expirationTtl: SHAW_SETTINGS.verify.ttlSec,
  });

  await shawTelegramCall(env, "sendMessage", {
    chat_id: userId,
    text: `🛡️ Shaw 安全验证（${Math.floor(SHAW_SETTINGS.verify.ttlSec / 60)} 分钟内有效）\n\n${challenge.question}`,
    reply_markup: {
      inline_keyboard: [
        challenge.options.map((optionText, idx) => ({
          text: optionText,
          callback_data: `verify|${challenge.nonce}|${idx}`,
        })),
      ],
    },
  });
}

function generateShawChallenge() {
  const useMath = Math.random() < 0.55;
  if (useMath) return generateShawMathChallenge();
  return generateShawCommonSenseChallenge();
}

function generateShawMathChallenge() {
  const a = randomInt(1, 20);
  const b = randomInt(1, 20);
  const answer = a + b;

  const optionSet = new Set([answer]);
  while (optionSet.size < 4) {
    const offset = randomInt(-8, 8);
    const candidate = Math.max(0, answer + offset);
    optionSet.add(candidate);
  }

  const options = shuffleArray([...optionSet]).map((v) => String(v));
  const correctIndex = options.findIndex((v) => Number(v) === answer);

  return {
    type: "math",
    question: `请计算：${a} + ${b} = ?`,
    options,
    correctIndex,
    nonce: createNonce(),
  };
}

function generateShawCommonSenseChallenge() {
  const picked = SHAW_COMMON_SENSE_QUESTIONS[randomInt(0, SHAW_COMMON_SENSE_QUESTIONS.length - 1)];
  const order = shuffleArray([0, 1, 2, 3]);
  const options = order.map((idx) => picked.options[idx]);
  const correctIndex = order.findIndex((idx) => idx === picked.correctIndex);

  return {
    type: "general",
    question: `常识题：${picked.question}`,
    options,
    correctIndex,
    nonce: createNonce(),
  };
}

async function markUserVerified(userId, env, now) {
  const profile = await getUserProfile(userId, env);
  profile.verified = true;
  profile.verifiedAt = now;
  profile.cooldownUntil = 0;
  await setUserProfile(userId, profile, env);
}

async function getUserProfile(userId, env) {
  const profile = await env.PM.get(SHAW_KV.userProfile(userId), { type: "json" });
  return (
    profile || {
      verified: false,
      verifiedAt: 0,
      cooldownUntil: 0,
    }
  );
}

async function setUserProfile(userId, profile, env) {
  await env.PM.put(SHAW_KV.userProfile(userId), JSON.stringify(profile));
}

async function consumeRateLimit(userId, rules, env, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);

  for (const rule of rules) {
    const bucket = Math.floor(nowSec / rule.windowSec);
    const key = SHAW_KV.rateLimit(userId, rule.windowSec, bucket);
    const current = Number((await env.PM.get(key)) || "0");

    if (current >= rule.limit) return false;

    await env.PM.put(key, String(current + 1), {
      expirationTtl: rule.windowSec + 5,
    });
  }

  return true;
}

async function evaluateRepeatSpam(userId, text, env, now) {
  const key = SHAW_KV.spamState(userId);
  const state =
    (await env.PM.get(key, { type: "json" })) ||
    { hash: "", count: 0, lastAt: 0 };

  const normalized = normalizeText(text);
  const hash = simpleHash(normalized);

  if (hash === state.hash && now - state.lastAt <= SHAW_SETTINGS.antiSpam.repeatWindowMs) {
    state.count += 1;
  } else {
    state.hash = hash;
    state.count = 1;
  }

  state.lastAt = now;
  await env.PM.put(key, JSON.stringify(state), { expirationTtl: 24 * 3600 });

  if (state.count >= SHAW_SETTINGS.antiSpam.repeatThreshold) {
    const profile = await getUserProfile(userId, env);
    profile.cooldownUntil = now + SHAW_SETTINGS.antiSpam.cooldownMs;
    await setUserProfile(userId, profile, env);
    return { blocked: true };
  }

  return { blocked: false };
}

async function forwardPrivateMessageToTopic(msg, userId, env, ctx) {
  let topic = await getOrCreateUserTopic(msg, userId, env);
  if (topic.closed) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "🚫 当前对话已被管理员关闭。",
    });
    return;
  }

  if (msg.media_group_id) {
    await collectAndFlushMediaGroup(msg, env, ctx, {
      direction: "p2t",
      targetChatId: Number(env.SUPERGROUP_ID),
      threadId: topic.threadId,
    });
    return;
  }

  const forwarded = await shawTelegramCall(env, "forwardMessage", {
    chat_id: Number(env.SUPERGROUP_ID),
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: topic.threadId,
  });

  const droppedInGeneral = forwarded.ok && !forwarded.result?.message_thread_id;
  if (!forwarded.ok || droppedInGeneral) {
    topic = await recreateTopicAndRefwd(msg, userId, env, forwarded);
  }

  return topic;
}

async function getOrCreateUserTopic(msg, userId, env) {
  const existing = await env.PM.get(SHAW_KV.topicByUser(userId), { type: "json" });
  if (existing?.threadId) return existing;

  const title = buildTopicTitle(msg);
  const created = await shawTelegramCall(env, "createForumTopic", {
    chat_id: Number(env.SUPERGROUP_ID),
    name: title,
  });

  if (!created.ok) throw new Error(`创建话题失败: ${created.description}`);

  const record = {
    userId,
    threadId: created.result.message_thread_id,
    title,
    closed: false,
    createdAt: Date.now(),
  };

  await env.PM.put(SHAW_KV.topicByUser(userId), JSON.stringify(record));
  await env.PM.put(SHAW_KV.userByThread(record.threadId), String(userId));

  return record;
}

async function recreateTopicAndRefwd(msg, userId, env, forwarded) {
  const errDesc = (forwarded.description || "").toLowerCase();
  const shouldRecreate =
    !forwarded.ok
      ? errDesc.includes("thread") || errDesc.includes("topic") || errDesc.includes("not found")
      : true;

  if (!shouldRecreate) return null;

  if (forwarded.ok && forwarded.result?.message_id) {
    await shawTelegramCall(env, "deleteMessage", {
      chat_id: Number(env.SUPERGROUP_ID),
      message_id: forwarded.result.message_id,
    });
  }

  await env.PM.delete(SHAW_KV.topicByUser(userId));

  const topic = await getOrCreateUserTopic(msg, userId, env);
  await shawTelegramCall(env, "forwardMessage", {
    chat_id: Number(env.SUPERGROUP_ID),
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: topic.threadId,
  });

  return topic;
}

async function handleSupergroupThreadMessage(msg, env, ctx) {
  const threadId = msg.message_thread_id;

  if (msg.forum_topic_closed) {
    await setTopicClosedByThread(threadId, true, env);
    return;
  }

  if (msg.forum_topic_reopened) {
    await setTopicClosedByThread(threadId, false, env);
    return;
  }

  const userId = Number(await env.PM.get(SHAW_KV.userByThread(threadId)) || 0);
  if (!userId) return;

  const text = (msg.text || "").trim();

  if (text === "/close") {
    await setTopicClosedByThread(threadId, true, env);
    await shawTelegramCall(env, "closeForumTopic", {
      chat_id: Number(env.SUPERGROUP_ID),
      message_thread_id: threadId,
    });
    return;
  }

  if (text === "/open") {
    await setTopicClosedByThread(threadId, false, env);
    await shawTelegramCall(env, "reopenForumTopic", {
      chat_id: Number(env.SUPERGROUP_ID),
      message_thread_id: threadId,
    });
    return;
  }

  if (text === "/info") {
    const chatInfo = await shawTelegramCall(env, "getChat", { chat_id: userId });
    const r = chatInfo.result || {};
    const fullName = `${r.first_name || ""} ${r.last_name || ""}`.trim() || "Unknown";
    const profile = await getUserProfile(userId, env);
    const verifiedText = profile.verified ? "是" : "否";

    const info = [
      "👤 用户信息",
      `UID: ${userId}`,
      `Name: ${fullName}`,
      `Verified: ${verifiedText}`,
      `Link: tg://user?id=${userId}`,
    ].join("\n");

    await shawTelegramCall(env, "sendMessage", {
      chat_id: Number(env.SUPERGROUP_ID),
      message_thread_id: threadId,
      text: info,
    });
    return;
  }

  if (msg.media_group_id) {
    await collectAndFlushMediaGroup(msg, env, ctx, {
      direction: "t2p",
      targetChatId: userId,
      threadId: null,
    });
    return;
  }

  await shawTelegramCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: Number(env.SUPERGROUP_ID),
    message_id: msg.message_id,
  });
}

async function setTopicClosedByThread(threadId, closed, env) {
  const userId = Number(await env.PM.get(SHAW_KV.userByThread(threadId)) || 0);
  if (!userId) return;

  const key = SHAW_KV.topicByUser(userId);
  const topic = await env.PM.get(key, { type: "json" });
  if (!topic) return;

  topic.closed = closed;
  await env.PM.put(key, JSON.stringify(topic));
}

function buildTopicTitle(msg) {
  const from = msg.from || {};
  const chat = msg.chat || {};
  const name = (from.first_name || chat.first_name || "User").trim();
  const userId = from.id || chat.id;
  return `${name} #${userId}`.slice(0, 64);
}

async function collectAndFlushMediaGroup(msg, env, ctx, { direction, targetChatId, threadId }) {
  const media = extractMedia(msg);
  if (!media) {
    const payload = {
      chat_id: targetChatId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    };
    if (threadId) payload.message_thread_id = threadId;

    await shawTelegramCall(env, "copyMessage", payload);
    return;
  }

  const key = SHAW_KV.mediaGroup(direction, msg.media_group_id);
  const now = Date.now();

  const record =
    (await env.PM.get(key, { type: "json" })) ||
    { targetChatId, threadId, items: [], lastAt: now };

  record.items.push(media);
  record.lastAt = now;

  await env.PM.put(key, JSON.stringify(record), { expirationTtl: 60 });
  ctx.waitUntil(flushMediaGroupAfterDelay(env, key, now));
}

function extractMedia(msg) {
  if (msg.photo?.length) {
    return { type: "photo", media: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || "" };
  }
  if (msg.video?.file_id) {
    return { type: "video", media: msg.video.file_id, caption: msg.caption || "" };
  }
  if (msg.document?.file_id) {
    return { type: "document", media: msg.document.file_id, caption: msg.caption || "" };
  }
  return null;
}

async function flushMediaGroupAfterDelay(env, key, expectedTs) {
  await sleep(SHAW_SETTINGS.mediaGroupFlushDelayMs);

  const record = await env.PM.get(key, { type: "json" });
  if (!record || record.lastAt !== expectedTs) return;

  const payload = {
    chat_id: record.targetChatId,
    media: record.items.map((it, index) => ({
      type: it.type,
      media: it.media,
      caption: index === 0 ? it.caption : "",
    })),
  };

  if (record.threadId) payload.message_thread_id = record.threadId;

  if (payload.media.length > 0) {
    await shawTelegramCall(env, "sendMediaGroup", payload);
  }

  await env.PM.delete(key);
}

async function shawTelegramCall(env, method, body) {
  const base = env.API_BASE || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    return await resp.json();
  } catch {
    return { ok: false, description: `Non-JSON response from Telegram: ${resp.status}` };
  }
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return String(hash);
}

function createNonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
