/**
 * wx-bridge —— 微信 iLink Bot 客户端主程序
 *
 * 模式：
 *   --mode=echo   收到什么回什么（验证链路）
 *   --mode=dsh    把消息交给 DSH 处理（路线 A：headless 子进程）
 *
 * 其他：
 *   --login       强制重新扫码
 *   --logout      清除登录凭证
 *   --verbose     打印更多细节
 *
 * 凭证存 ./data/credentials.json，配置存 ./data/config.json。
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ILINK_BASE_URL,
  MSG_TYPE,
  ApiError,
  isSessionExpired,
  setBotAgent,
  fetchQrCode,
  pollQrStatus,
  notifyStart,
  notifyStop,
  getUpdates,
  sendMessage,
  getConfig as getBotConfig,
  sendTyping,
  textItem,
  extractText,
  describeItems,
  splitText,
  TYPING_STATUS
} from './ilink.js';

import { runTask, describeRuntime, resolveDshCommand } from './dsh.js';
import { chatComplete, buildChatMessages, readApiKey } from './chat.js';
import { buildTask, appendTurn, clearHistory, loadHistory, compressHistory } from './memory.js';
import {
  listPersonas, getPersona, getUserPersona, setUserPersona, ensurePersonaDir, applyPersona
} from './persona.js';
import { stripActions, splitIntoBubbles, extractStickers, ensureEmoji, ensureSticker, adjustBubbleCount } from './output.js';
import { createProactiveScheduler, touchUser } from './proactive.js';
import {
  recentLines, recentScenarios, isTooSimilar, rememberLine, fallbackLine,
  pickScenario, SCENARIO_HINTS
} from './proactivehistory.js';
import {
  isBusy, setBusy, setFree, getState as getBusyState, getAllBusy,
  extractStateMarker, guessMarker, looksFree
} from './busymode.js';
import {
  isAngry, markAngry, clearAngry, softenAngry, tickAngry,
  moodBlock, extractMoodMarkers, looksForgiven
} from './mood.js';
import { matchAction, runAction, listActions, ensureActionsFile } from './actions.js';
import { webSearch, formatSources, needsSearch, buildSearchQuery } from './websearch.js';
import { canSearch, recordSearch, getUsage as getSearchUsage } from './searchbudget.js';
import {
  searchVault,
  formatHits,
  formatProfile,
  getProfileDigest,
  getRecentTopics,
  formatRecentTopics,
  ensureIndex as ensureVaultIndex,
  getStatus as getVaultStatus,
  rebuildIndex as rebuildVaultIndex
} from './vault.js';
import {
  loadScene, saveScene, resetScene, createScene, analyzeTurn,
  recordUserTurn, recordReply, canOpenNewTopic, markNewTopic,
  formatSceneForReply, formatSceneForProactive, topicOf, lastQuestionOf
} from './scene.js';
import { imageItemsOf, downloadInboundImage } from './inbound.js';
import { describeImages, describeVisionFailure } from './vision.js';

/**
 * 这句话是不是在问「关于我自己」的事。
 * 命中就走画像事实卡那条路，而不是干等 BM25 的字面匹配。
 */
function isSelfReferential(text) {
  return /关于我|我的(资料|信息|画像|习惯|爱好|电脑|配置|笔记|知识库|数据)|你知道(我|些)|了解我|记得我|我是谁|我是什么|我平时|我玩|我用|我家|你的?(笔记|资料|知识库)|你(写|记)的|库里(有|存)/.test(String(text || ''));
}

import { sendImage, sendImageVariant } from './media.js';
import { listStickers, pickSticker, ensureStickerDir, stickerDirPath, listCategories } from './sticker.js';
import { loadConfig, ensureConfigFile, writeConfig, CFG_PATH, ROOT } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_PATH = path.join(ROOT, 'data', 'credentials.json');

// ── 命令行参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MODE = opt('mode', 'dsh');

// chat 模式用的密钥与 DSH 模式同源（都读 DSH 凭证文件），保证只有一把钥匙
const API_KEY = readApiKey();
const FORCE_LOGIN = flag('--login');
const VERBOSE = flag('--verbose');

// ── 日志 ────────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

// ── 凭证 ────────────────────────────────────────────────────────────────────
function isValidCred(v) {
  return v && typeof v === 'object'
    && typeof v.token === 'string' && v.token.length > 0
    && typeof v.baseUrl === 'string'
    && typeof v.accountId === 'string'
    && typeof v.userId === 'string';
}

async function loadCred() {
  try {
    const raw = await readFile(CRED_PATH, 'utf8');
    const v = JSON.parse(raw);
    if (isValidCred(v)) return v;
    warn('凭证文件格式不对，将重新登录');
  } catch (e) {
    if (e.code !== 'ENOENT') warn('读取凭证失败:', e.message);
  }
  return undefined;
}

async function saveCred(cred) {
  await mkdir(path.dirname(CRED_PATH), { recursive: true });
  await writeFile(
    CRED_PATH,
    JSON.stringify({ ...cred, savedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );
}

// ── 登录 ────────────────────────────────────────────────────────────────────
async function login(baseUrl = ILINK_BASE_URL) {
  log('正在获取微信登录二维码…');

  for (let round = 1; round <= 8; round++) {
    const qr = await fetchQrCode(baseUrl);
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error('接口没有返回二维码：' + JSON.stringify(qr).slice(0, 200));
    }

    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  用手机微信打开下面的链接完成登录                        │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('    ' + qr.qrcode_img_content);
    console.log('');
    console.log('    有效期约 2 分钟，等待扫码中…');
    console.log('');

    let last;
    const deadline = Date.now() + 150_000;

    while (Date.now() < deadline) {
      await delay(2000);
      let status;
      try {
        status = await pollQrStatus(baseUrl, qr.qrcode);
      } catch (e) {
        warn('查询扫码状态出错:', e.message);
        continue;
      }

      if (status.status !== last) {
        if (status.status === 'scaned') console.log('    已扫码，请在微信里点「确认登录」…');
        else if (status.status === 'confirmed') console.log('    登录确认成功');
        else if (status.status === 'expired') console.log('    二维码已过期');
        last = status.status;
      }

      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
          throw new Error('扫码已确认，但缺少凭证字段：' + JSON.stringify(status).slice(0, 300));
        }
        const cred = {
          token: status.bot_token,
          baseUrl: status.baseurl ?? baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id
        };
        await saveCred(cred);
        log(`登录成功  账号=${cred.accountId}`);
        return cred;
      }

      if (status.status === 'expired') break;
    }

    if (round < 8) log('二维码过期，重新获取…');
    else throw new Error('连续 8 次二维码过期，请检查网络后重试');
  }
}

// ── 消息发送辅助 ────────────────────────────────────────────────────────────

/** 发一条文本（自动分块），返回是否成功 */
async function sendText(state, toUserId, text) {
  const contextToken = state.contextTokens.get(toUserId) ?? '';
  if (!contextToken) {
    warn('缺少 context_token，无法回复。这是 iLink 的硬限制：必须由用户先发消息。');
    return false;
  }
  const cred = state.cred;
  let ok = true;
  for (const chunk of splitText(text)) {
    try {
      await sendMessage(cred.baseUrl, cred.token, toUserId, contextToken, [textItem(chunk)]);
    } catch (e) {
      warn('发送消息失败:', e.message);
      ok = false;
      break;
    }
  }
  return ok;
}

/** 尽力发一次"正在输入"，失败就算了 —— 这只是体验优化 */
async function tryTyping(state, toUserId, on = true) {
  if (!state.cfg.sendTyping) return;
  const contextToken = state.contextTokens.get(toUserId) ?? '';
  if (!contextToken) return;
  try {
    const cfgResp = await getBotConfig(state.cred.baseUrl, state.cred.token, toUserId, contextToken);
    const ticket = cfgResp?.typing_ticket;
    if (!ticket) return;
    await sendTyping(state.cred.baseUrl, state.cred.token, toUserId, ticket, on ? 1 : 2);
  } catch {
    /* 输入状态失败不影响主流程 */
  }
}

// ── DSH 处理 ────────────────────────────────────────────────────────────────

/** 每个用户一条串行队列：同一人连发时按顺序处理，不并发抢机器 */
const userQueues = new Map();

/** 每个用户上一次回复发了几条，用来保证这一轮不重复 */
const lastBubbleCount = new Map();

/**
 * 每个用户最近说过的几句话（只留最后 6 条）。
 *
 * 用途：把这几句塞进上下文，明确要求"别再说一样的"。
 * 光靠 temperature 压不住重复，模型在小话题上分布太集中。
 */
const recentReplyMem = new Map();
const RECENT_REPLY_KEEP = 6;

function rememberReply(userId, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  // 太长的不记（记了也占地方），只留前 40 字
  const short = clean.slice(0, 40);
  const arr = recentReplyMem.get(userId) || [];
  // 完全一样的就不重复记
  if (arr.includes(short)) return;
  arr.push(short);
  while (arr.length > RECENT_REPLY_KEEP) arr.shift();
  recentReplyMem.set(userId, arr);
}

/**
 * 表情包频率闸门。
 *
 * 实测：把人格里"什么时候发哪一类"写详细之后，模型主动发图率从 0/4 涨到 4/6，
 * 但这种密度远超"每 5~8 条一次"的要求 —— 情绪一激动就会每条都甩图。
 * 所以代码里上一道冷却：两次发图之间至少隔 stickerMinTurns 轮。
 */
const replyTurnCount = new Map();     // userId → 已经回复过多少轮
const lastStickerTurn = new Map();    // userId → 上次发图是在第几轮

/**
 * 挑这一轮要发几条。
 *
 * 原实现是 1-5 均匀随机，且不等于上一次。对「粘人」人设合适，
 * 但换了冷静人设之后就成了程序强行加戏：人家想回一句，代码逼她拆成四条。
 *
 * 现在改成：上限由 maxBubbles 决定，且分布强烈偏向前几条。
 *   max=2 时：1 条 70%，2 条 30%
 *   max=3 时：1 条 60%，2 条 30%，3 条 10%
 *   max=5 时：1 条 50%，2 条 25%，3 条 15%，4 条 7%，5 条 3%
 */
function pickBubbleCount(last, min = 1, max = 5) {
  const cap = Math.max(min, Math.min(5, Number(max) || 5));
  const weights = [];
  let total = 0;
  for (let n = min; n <= cap; n++) {
    // 越靠前权重越高：1→50, 2→25, 3→15, 4→7, 5→3（按 cap 归一化后再用）
    const w = { 1: 50, 2: 25, 3: 15, 4: 7, 5: 3 }[n] ?? 3;
    // 不连着两轮同样条数（只有一档可选时不强求）
    const eff = (n === last && cap > min) ? 0 : w;
    weights.push({ n, w: eff });
    total += eff;
  }
  if (total <= 0) return min;

  let r = Math.random() * total;
  for (const { n, w } of weights) {
    r -= w;
    if (r <= 0) return n;
  }
  return min;
}

function enqueue(userId, job) {
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => warn('队列任务出错:', e.message));
  userQueues.set(userId, next);
  next.finally(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId);
  });
  return next;
}

/**
 * "这句话是不是换了话题"——拿不准时才调的模型判题（折中方案的那一小步）。
 *
 * 为什么要限频：这类判断如果每条消息都做，等于每条多一次调用，白烧钱。
 * 所以只在两个条件同时满足时才问：
 *   ① 本地规则落在"中间地带"（关键词重合度 0.08~0.18，既不重叠也不完全无关）
 *   ② 这一小时还没问满 sceneAnalyzeMaxPerHour 次
 * 其余情况直接按"延续"处理 —— 连贯性优先。
 *
 * 返回 'continue' | 'new' | null（null = 没问/失败，调用方用默认值）
 */
const sceneJudgeTimes = [];
async function judgeSceneChange(state, text, scene) {
  if (!scene || !scene.topic) return null;
  if (state.cfg.sceneAnalyzeModel === false) return null;

  const now = Date.now();
  const limit = Math.max(0, state.cfg.sceneAnalyzeMaxPerHour ?? 6);
  // 清掉一小时前的记录，保持数组很短
  while (sceneJudgeTimes.length && now - sceneJudgeTimes[0] > 60 * 60 * 1000) sceneJudgeTimes.shift();
  if (sceneJudgeTimes.length >= limit) return null;

  sceneJudgeTimes.push(now);
  try {
    const r = await chatComplete({
      baseUrl: state.cfg.chatBaseUrl,
      apiKey: API_KEY.key,
      model: state.cfg.chatModel,
      messages: [
        {
          role: 'system',
          content: '你只做一件事：判断接下来这句话，是不是在跟上面那件事说再见、换一个新话题。\n只输出两个词之一：CONTINUE（还是同一件事）或 NEW（换了新话题）。不要解释。'
        },
        {
          role: 'user',
          content: `当前在聊的事：${scene.topic}\n他上一句说的是：${scene.lastUserText || '（无）'}\n他这句话是：${text}`
        }
      ],
      temperature: 0,
      timeoutMs: 15000
    });
    if (!r.ok) return null;
    const t = r.text.trim().toUpperCase();
    if (t.includes('NEW')) return 'new';
    if (t.includes('CONTINUE')) return 'continue';
    return null;
  } catch {
    return null;
  }
}

async function handleWithDsh(state, msg, text) {
  const userId = msg.from_user_id;

  // ── 收图识图 ────────────────────────────────────────────────────────────
  //
  // 分工：豆包（vision.js）只把图变成一段客观描述；怎么回你，仍由 DeepSeek
  // 带着人设和场景去说。所以这里产出的是一段「上下文材料」，不是回复本身。
  //
  // 硬要求（用户原话）：识图失败不许抛错，要像人一样说"我的眼睛看不见了"。
  // 所以下载/识图的每一步都单独兜住，任何失败都退化成一句提示词，由她来说。
  const imgItems = imageItemsOf(msg);
  let imageBlock = '';
  let imageCount = 0;

  if (imgItems.length) {
    const maxImages = Math.max(1, Number(state.cfg.visionMaxImages ?? 1));
    const files = [];

    for (const item of imgItems.slice(0, maxImages)) {
      try {
        const got = await downloadInboundImage(item, {
          destDir: path.join(ROOT, 'data', 'media', 'inbox'),
          timeoutMs: Math.max(5000, Number(state.cfg.visionImageTimeoutMs ?? 20000))
        });
        files.push(got);
        log(`  [识图] 收到图片 ${(got.bytes / 1024).toFixed(0)}KB ${got.mime}`);
      } catch (e) {
        warn(`  [识图] 图片下载失败: ${e.message}`);
      }
    }

    if (files.length) {
      const vision = state.cfg.visionEnabled === false
        ? { ok: false, kind: 'nokey', reason: '识图功能被关掉了', descriptions: [] }
        : await describeImages(files, { cfg: state.cfg, log, warn });

      if (vision.ok) {
        imageCount = vision.descriptions.length;
        imageBlock = [
          `【他刚发来 ${vision.descriptions.length} 张图片，下面是看图得到的客观描述】`,
          ...vision.descriptions.map((d, i) => `（图${i + 1}）${d}`),
          '【这段描述只用来让你看懂图，不要照着念。用你的人设自然回应，就像你真的看见了：',
          '图里有事（报错、人物、地点、文字）就顺着聊，看不出重点就直接问他。】'
        ].join('\n');
      } else {
        imageBlock = [
          `【他刚发来一张图片，但你现在看不见它：${describeVisionFailure(vision.kind)}。】`,
          '【用你的人设、带点情绪地说明你看不了图，并让他用文字讲讲图里是什么。',
          '绝对不要说"API""接口""报错""系统繁忙""模型"这些词，就当是眼睛这会儿不好使。】'
        ].join('\n');
        log(`  [识图] 失败 kind=${vision.kind}${vision.reason ? `（${vision.reason}）` : ''}`);
      }
    } else {
      imageBlock = '【他发来一张图片，但图没下载下来（网络问题）。请用你的人设自然地让他再发一次。】';
    }
  }

  // 有图就算有内容；既没字也没图才算真的空消息
  if (!text && !imgItems.length) {
    await sendText(state, userId, `这个版本只处理文字和语音（收到的是${describeItems(msg)}）。`);
    return;
  }

  // 只有图没配字时，给模型一个占位话术，让场景/历史/拆条都能正常走
  const contentText = text && String(text).trim() ? text : '（发来一张图片，没配文字）';
  text = contentText;

  const queueLen = userQueues.has(userId) ? 1 : 0;
  if (queueLen >= state.cfg.maxQueuePerUser) {
    await sendText(state, userId, '你前面还有任务在处理，这条先不算了。等会儿再发。');
    return;
  }

  const started = Date.now();

  // 处理中的可见反馈：默认只发"正在输入"，不刷一句话。
  // 想要那句"收到，正在处理…"的话，config.json 里把 showQueuedNotice 设为 true。
  await tryTyping(state, userId, true);
  const pending = state.cfg.showQueuedNotice
    ? sendText(state, userId, '收到，正在处理…')
    : Promise.resolve(false);

  // 组装任务：人设 + 历史 + 这一轮
  const personaName = await getUserPersona(userId) || state.cfg.defaultPersona;
  const basePersona = personaName ? await getPersona(personaName) : null;

  // ── 场景状态：先搞清楚"我们正在聊什么"，再决定怎么接 ──────────────────
  //
  // 用户的要求是"一个语境、一个场景、一个整体的事"。实现上分三步：
  //   ① 读出当前场景（落盘的，重启不丢）
  //   ② 判断这句是延续还是换题 —— 本地规则优先，拿不准才问模型（限频）
  //   ③ 把场景段落放进本轮动态上下文，并明确要求"接着讲"
  const sceneEnabled = state.cfg.sceneEnabled !== false;
  let scene = sceneEnabled ? await loadScene(userId) : null;
  let sceneMode = 'new';
  let sceneBlock = '';
  let sceneReason = '';

  if (sceneEnabled) {
    const analysis = analyzeTurn(text, scene, {
      ttlMs: Math.max(30, state.cfg.sceneTtlMinutes ?? 180) * 60 * 1000
    });
    sceneMode = analysis.mode;
    sceneReason = analysis.reason;

    if (sceneMode === 'ambiguous') {
      // 拿不准时的折中：默认当成"延续"（连贯性优先，宁可接错也不突然换题）。
      // 只有配置允许、且限频没超，才花一次小额调用让模型判。
      sceneMode = 'continue';
      const verdict = await judgeSceneChange(state, text, scene);
      if (verdict === 'new') sceneMode = 'new';
      if (verdict) sceneReason += `（模型判 ${verdict}）`;
    }

    if (sceneMode === 'new') {
      const prevTopic = scene?.topic;
      scene = createScene(text, { source: 'user' });
      log(`  [场景] 新场景「${scene.topic}」${prevTopic ? `（上一件：${prevTopic}）` : ''}`);
    } else {
      recordUserTurn(scene, text);
      log(`  [场景] 延续「${scene.topic}」（第 ${scene.turns} 轮，${sceneReason}）`);
    }

    sceneBlock = formatSceneForReply(scene, { mode: sceneMode });
  }

  // 联网搜索：这句话涉及时效性信息、或明确要求查的时候，先搜一下。
  // 搜到的东西作为「参考资料」塞进提示词，让她基于真实结果回答而不是编。
  //
  // 搜索前先过预算闸：一次搜索约 4000 tokens + 4.8 秒。
  // 不设上限的话她会十句话搜八次，又慢又贵。超预算就静默跳过。
  let searchBlock = '';
  if (state.cfg.autoSearch && needsSearch(text)) {
    const budget = canSearch({
      hourlyLimit: state.cfg.searchHourlyLimit,
      dailyLimit: state.cfg.searchDailyLimit
    });
    if (!budget.allowed) {
      log(`  [搜索] 跳过 —— ${budget.reason}`);
    } else {
      const searchQuery = buildSearchQuery(text, scene && scene.topic);
      log(`  [搜索] 触发联网搜索: ${searchQuery.slice(0, 40)}（本小时 ${budget.hourUsed}/${budget.hourlyLimit}，今天 ${budget.dayUsed}/${budget.dailyLimit}）`);
      try {
        recordSearch();
        const sr = await webSearch(searchQuery, {
          maxUses: state.cfg.searchMaxUses || 3,
          timeoutMs: state.cfg.searchTimeoutMs || 60000
        });
        if (sr.ok && (sr.sources.length || sr.answer)) {
          const lines = ['【联网搜索到的真实资料】'];
          // answer 是模型拿着真实网页读完之后写的摘要——比只有标题有用得多。
          // 原来只塞 sources（标题+URL），她只会回"我搜到一堆网页但没看到天气"。
          if (sr.answer) {
            lines.push('搜索摘要（根据抓到的网页整理）：', sr.answer.slice(0, 1200), '');
          }
          if (sr.sources.length) {
            lines.push('来源：', formatSources(sr.sources, 4), '');
          }
          lines.push(
            '请基于上面这些真实资料回答，把结果说成自己的话（不要罗列网址）。',
            '如果资料里确实没有相关信息，就老实说没查到，绝对不要凭印象编造。',
            '提到出处时说"网上查到的"就行。'
          );
          searchBlock = lines.join('\n');
          log(`  [搜索] 拿到 ${sr.sources.length} 条结果${sr.answer ? `、摘要 ${sr.answer.length} 字` : ''}`);
        } else {
          log(`  [搜索] 无结果或失败: ${sr.error || '空'}`);
        }
      } catch (e) {
        warn('  [搜索] 异常: ' + e.message);
      }
    }
  }

  // 知识库检索：从 Obsidian 库里找和这句话相关的笔记片段。
  // 只有分数过线才注入 —— 宁可没有背景资料，也不要塞一堆不相关的东西把回复带歪。
  //
  // 另外有一条单独的路：问到"关于我/你知道我什么/我的电脑"这类自指问题时，
  // 直接注入一份「画像事实卡」。原因是 BM25 只匹配字面，画像笔记的标题写的是
  // 「设备/技术栈/数字足迹」，和用户的问法几乎没有共同词，实测整句只命中
  // 1 条 0.47 的边缘片段，等于没有。事实卡不走检索，直接给事实。
  let ragBlock = '';
  if (state.cfg.ragEnabled && state.cfg.vaultPath && text.length >= 2) {
    const selfRef = isSelfReferential(text);

    if (selfRef) {
      try {
        const digest = getProfileDigest(
          state.cfg.vaultPath,
          state.cfg.profileNotes || [],
          state.cfg.profileMaxChars ?? 1100
        );
        if (digest) {
          ragBlock = formatProfile(digest);
          log(`  [知识库] 自指提问 → 注入完整画像事实卡（${digest.length} 字符）`);
        }
      } catch (e) {
        warn('  [知识库] 画像摘要异常: ' + e.message);
      }
    } else if ((state.cfg.sceneProfileChars ?? 0) > 0) {
      // 分层注入的第一层：每轮都带一小段"她本来就知道的事"。
      // 不做的话，只有问到"关于我"时才想起你的资料，平时聊天像个陌生人。
      // 360 字符 ≈ 250 tokens，换来的是"她一直知道你是什么人、在意什么"。
      try {
        const small = getProfileDigest(
          state.cfg.vaultPath,
          state.cfg.profileNotes || [],
          state.cfg.sceneProfileChars ?? 360
        );
        if (small) {
          ragBlock = [
            '【你本来就记得的、关于他的一些事（真事，别装作不知道）】',
            small,
            '',
            '这些是你的常识，不用刻意提，但他说到相关的事时你要接得上，',
            '不要问那些你明明知道答案的问题。也不要一口气把上面全念出来。'
          ].join('\n');
        }
      } catch (e) {
        warn('  [知识库] 小画像异常: ' + e.message);
      }
    }

    // 分层注入的第二层：他最近在弄什么（笔记标题）。
    // 画像回答「他是个什么人」，这一层回答「他这阵子在忙哪件事」，是"聊什么"的抓手。
    if ((state.cfg.sceneRecentTopics ?? 5) > 0) {
      try {
        const items = getRecentTopics(state.cfg.vaultPath, {
          days: state.cfg.recentTopicDays ?? 30,
          maxItems: state.cfg.sceneRecentTopics ?? 5
        });
        const block = formatRecentTopics(items);
        if (block) {
          ragBlock = ragBlock ? ragBlock + '\n\n' + block : block;
          log(`  [知识库] 近期笔记 ${items.length} 条 → ${items.map((i) => i.title).slice(0, 3).join(' / ')}`);
        }
      } catch (e) {
        warn('  [知识库] 近期话题异常: ' + e.message);
      }
    }

    try {
      // 延续话题时把场景词也带进检索，比只拿当前这句去搜更容易捞到同一条线上的笔记
      const query = sceneMode === 'continue' && scene?.topic
        ? `${scene.topic} ${text}`
        : text;
      const rr = await searchVault(query, state.cfg.vaultPath, {
        topK: selfRef ? 2 : (state.cfg.ragTopK ?? 3),
        minScore: selfRef ? 0.25 : (state.cfg.ragMinScore ?? 0.35)
      });
      if (rr.ok && rr.hits.length) {
        const hitsBlock = formatHits(rr.hits);
        ragBlock = ragBlock ? ragBlock + '\n\n' + hitsBlock : hitsBlock;
        log(`  [知识库] 命中 ${rr.hits.length} 段（最高 ${rr.hits[0].score}，${rr.ms}ms）→ ${rr.hits[0].title}`);
      } else if (!rr.ok) {
        log(`  [知识库] 跳过：${rr.error}`);
      } else if (!selfRef) {
        log(`  [知识库] 无相关内容（${rr.ms}ms）`);
      }
    } catch (e) {
      warn('  [知识库] 异常: ' + e.message);
    }
  }

  // ── 条数：交给场景决定，程序不再强派 ──────────────────────────────────
  //
  // 以前这里是「随机挑一个 1-N 的条数，然后逼模型必须发这么多」。
  // 实测那样会把人设按住：她本来只想回两个字的「哦」，程序逼她拆成四条。
  // 现在改成：模型自己按人设和对场景的判断写，可能一条也可能三条；
  // 程序只做两件事——按空行拆，和超过 maxBubbles 时合并到上限。
  const bubbleCap = Math.max(1, state.cfg.maxBubbles ?? 5);
  const targetCount = null;

  // ── 随机性：句式轮换 + 防重复 ─────────────────────────────────────────
  //
  // 光靠 temperature 不够：模型在小话题上的概率分布太集中，
  // 同一个问题问十次会有七八次给出同一句（实测「在干嘛」连问都回「改稿。你呢。」）。
  // 这里补两道人工随机：
  //
  //   1) 每轮随机挑一种"句式"，只影响形状，不影响内容
  //   2) 把最近说过的几句塞进上下文，明确要求别再说
  //
  const SHAPES = [
    '先直接回应，别铺垫，一两句就停。',
    '先反问一句，再回答。',
    '先损他一句，再说正事。',
    '先说一句自己的事（改稿/朋友/吃的），再接他的话。',
    '只回一两个词，把话头留给他。',
    '先答得有点跑偏，再拐回来把重点说了。',
    '接话的时候带一点具体的细节（时间、地点、数量）。',
    '先沉默式地"……"，然后才说。'
  ];
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];

  // 生气的时候不许换句式。
  //
  // 句式提示放在上下文最后，权重很高，会压过 moodBlock。
  // 实测：生气中问"在吗"，随机到"先损他一句"就会回「哟，还记得我」——
  // 冷脸当场破功。所以气着的时候只保留冷、短、带句号这一种形状。
  const shapeBlock = isAngry(userId)
    ? '【本轮句式】极短。一个词或半句话就够，用句号，不接梗不反问。'
    : `【本轮句式】${shape}`;

  const recentReplies = recentReplyMem.get(userId) || [];
  const avoidBlock = recentReplies.length
    ? `【最近你已经说过这些，不许再重复同样的说法】\n` +
      recentReplies.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '';

  // 本轮动态上下文：场景 + 情绪 + 知识库 + 搜索结果 + 句式随机。
  // 注意：不拼进 persona.prompt，走 buildChatMessages 的 dynamicContext，
  // 这样人格那段 system 前缀保持稳定、能吃上缓存。
  //
  // moodBlock 必须放在很前面：她还气着的时候，这个状态要压在场景之上，
  // 否则模型会顺着场景把话题接下去，气就白生了。
  const dynamicContext = [
    moodBlock(userId),
    sceneBlock,
    imageBlock,
    ragBlock,
    searchBlock,
    avoidBlock,
    shapeBlock
  ].filter(Boolean).join('\n');

  const persona = basePersona;

  // 两条通道：
  //   chat —— 直连 API，只带人设和历史，输入约 2400 tokens，快且省
  //   dsh  —— 走 DSH headless，带全套工具（约 17000 tokens），能干活但贵
  let result;
  if (MODE === 'chat') {
    const history = await loadHistory(userId);
    const messages = buildChatMessages(persona, history, text, {
      dynamicContext,
      recentTurns: state.cfg.historyRecentTurns ?? 3,
      olderChars: state.cfg.historyOlderChars ?? 40,
      compress: compressHistory
    });
    result = await chatComplete({
      baseUrl: state.cfg.chatBaseUrl,
      apiKey: API_KEY.key,
      model: state.cfg.chatModel,
      messages,
      temperature: state.cfg.chatTemperature,
      presencePenalty: state.cfg.chatPresencePenalty,
      frequencyPenalty: state.cfg.chatFrequencyPenalty,
      topP: state.cfg.chatTopP,
      timeoutMs: state.cfg.taskTimeoutMs
    });
  } else {
    const task = await buildTask(userId, text, persona, { extraContext: dynamicContext });
    const workdir = state.cfg.workdir
      ? path.resolve(ROOT, state.cfg.workdir)
      : ROOT;
    result = await runTask(task, {
      timeoutMs: state.cfg.taskTimeoutMs,
      cwd: workdir
    });
  }

  await pending;
  await tryTyping(state, userId, false);

  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (result.ok) {
    // 处理顺序很重要：
    //   0) 先摘掉状态标记（[BUSY]/[FREE]/[ANGRY]/[SOFT]/[FORGIVE]），绝不能发给你看
    //   1) 再摘表情包标记
    //   2) 去掉括号动作描述
    //   3) 拆成多条短消息，中间带真人停顿
    //
    // 情绪标记先摘：它和状态标记可能同时出现，先处理不会互相干扰。
    const moodRes = extractMoodMarkers(result.text);
    const markerRes = extractStateMarker(moodRes.text);

    // ── 更新生气状态 ──────────────────────────────────────────────────────
    if (moodRes.angry) {
      const r = markAngry(userId, moodRes.reason || text.slice(0, 60));
      log(`  [情绪] 真的生气了${r.changed ? '（开始）' : '（继续）'} 原因=${moodRes.reason || '(未说)'}`);
    }
    if (moodRes.soften) {
      const r = softenAngry(userId);
      if (r.changed) log(`  [情绪] 被哄动了一点（第 ${r.softened} 次）`);
    }
    if (moodRes.forgive) {
      const r = clearAngry(userId, 'model-forgive');
      if (r.changed) log('  [情绪] 原谅了，恢复正常');
    } else if (!moodRes.angry && isAngry(userId) && looksForgiven(moodRes.text)) {
      // 兜底：她嘴上已经翻篇了但忘了打 [FORGIVE]，别让状态机把她按在冷脸里
      clearAngry(userId, 'text-fallback');
      log('  [情绪] 话里已经翻篇 → 清除生气状态');
    }
    // 每轮计数一次，用于自动淡出（人不能气一辈子）
    tickAngry(userId);

    // 判定顺序有讲究：
    //   ① "我回来了/忙完了/有空了" —— 这类话优先级最高，一律退出忙碌模式。
    //      实测模型会把「我忙完了，现在有空」错标成 [BUSY]，所以不能只信标记。
    //   ② 然后才看模型标记
    //   ③ 最后才是高置信度规则兜底
    if (looksFree(text)) {
      const r = setFree(userId, '话里明确表示有空');
      if (r.changed) log(`  [忙碌] 命中"我回来了/忙完了" → 退出忙碌模式（持续 ${r.lastedMin} 分钟），回归普通节奏`);
    } else if (markerRes.marker === 'BUSY') {
      const r = setBusy(userId, text.slice(0, 40));
      log(`  [忙碌] 检测到 [BUSY] → 切进忙碌模式${r.changed ? '（首次）' : '（已在忙）'}：每 ${state.cfg.busyIntervalMinutes ?? 25} 分钟发 ${state.cfg.busyMinCount ?? 2}-${state.cfg.busyMaxCount ?? 3} 条，不连发不提问`);
    } else if (markerRes.marker === 'FREE') {
      const r = setFree(userId, '模型标记 [FREE]');
      if (r.changed) log(`  [忙碌] 检测到 [FREE] → 退出忙碌模式（持续了 ${r.lastedMin} 分钟），回归普通节奏`);
      else log('  [忙碌] 收到 [FREE] 但本来就不在忙碌模式');
    } else {
      // 模型没给标记时，用高置信度规则兜底（宁可漏判，不误判）
      const guess = guessMarker(text);
      if (guess === 'BUSY' && !isBusy(userId)) {
        setBusy(userId, text.slice(0, 40));
        log('  [忙碌] 规则兜底判定为忙碌 → 切进忙碌模式');
      }
    }

    const withStickers = extractStickers(markerRes.text);
    const cleaned = stripActions(withStickers.text, state.cfg.stripActions);
    const bubbles = splitIntoBubbles(cleaned, {
      maxMessages: state.cfg.maxBubbles,
      enabled: state.cfg.bubbleSplit,
      shortReplyThreshold: state.cfg.shortReplyThreshold,
      minimumFragmentLength: state.cfg.minimumFragmentLength
    }).filter((b) => b && b.trim());

    // 条数只设上限，不下指标。
    //
    // 原来这里会把气泡数强行改成 targetCount（多了合并、少了劈开），
    // 结果是"程序替她决定发几条"。现在只有超过上限时才合并，
    // 她写几条就发几条 —— 短的一字消息和长的两段话都允许。
    if (bubbles.length > bubbleCap) {
      const beforeAdjust = bubbles.length;
      adjustBubbleCount(bubbles, bubbleCap);
      log(`  [条数] ${beforeAdjust} → ${bubbles.length} 条（超过上限 ${bubbleCap}，已合并）`);
    }
    lastBubbleCount.set(userId, bubbles.length);

    const finalBubbles = bubbles.length ? bubbles : [];

    // ── 表情包（先定，因为它会决定"这一条还能不能加颜文字"） ──────────────
    //
    // 人格里的铁律是「颜文字 / emoji / 表情包 三选一，同一条不要叠」。
    // 所以必须先决定发不发图，再决定补不补颜文字 —— 顺序反了就会两个都加。
    //
    // 兜底的原因：人格写"每 5~8 条发一次"，模型会理解成"别发"，
    // 实测 4 个明显该发的场景 0/4。和条数、颜文字是同一个规律。
    let stickerNames = state.cfg.allowStickers ? withStickers.stickers.slice() : [];

    // ── 频率闸门：把发图间隔控制在 [minTurns, maxTurns] 轮 ─────────────────
    //
    // 为什么要区间而不是单一概率：
    //   只设"最少隔 N 轮"，实际频率完全交给模型的心情，忽高忽低；
    //   只设概率，又会出现"连着十轮一张都没有"。
    //   给定上下界之后，间隔就稳定落在 2~3 轮（目标：每 2~3 条回复发一次）。
    //
    //   gap <  minTurns  → 拦掉（哪怕模型自己想发）
    //   gap >= maxTurns  → 必须补一张
    //   中间             → 按 stickerChance 掷骰子
    const turn = (replyTurnCount.get(userId) ?? 0) + 1;
    replyTurnCount.set(userId, turn);
    const lastSt = lastStickerTurn.get(userId) ?? -999;
    const minGapTurns = Math.max(1, state.cfg.stickerMinTurns ?? 2);
    const maxGapTurns = Math.max(minGapTurns, state.cfg.stickerMaxTurns ?? 3);
    const midChance = state.cfg.stickerChance ?? 0.5;
    const gap = turn - lastSt;
    const stickerAllowed = gap >= minGapTurns;
    const stickerForced = gap >= maxGapTurns;

    // 软闸：刚好卡在下限那轮，即使模型自己想发也先掷个骰子。
    // 不加这一层的话，只要模型每轮都想发，节奏就变成严格的"隔一条一次"，
    // 会被他看出是机器在轮询。加了之后间隔自然在 2 和 3 之间浮动。
    let softBlocked = false;
    if (stickerNames.length && gap === minGapTurns && !stickerForced) {
      if (Math.random() >= midChance) {
        softBlocked = true;
        stickerNames = [];
      }
    }

    if (stickerNames.length && !stickerAllowed) {
      log(`  [表情包] 距离上次发图才 ${gap} 轮（下限 ${minGapTurns}），本轮不发`);
      stickerNames = [];
    } else if (softBlocked) {
      log(`  [表情包] 刚够下限、骰子没过，这轮先留着`);
    }

    if (state.cfg.allowStickers && stickerNames.length === 0 && stickerAllowed && !softBlocked) {
      const auto = ensureSticker(finalBubbles, withStickers.stickers, {
        // 到了上限就 100% 补一张，否则按配置概率
        chance: stickerForced ? 1 : midChance,
        recentCategories: recentScenarios(3).filter((x) => x && x.startsWith('sticker:'))
          .map((x) => x.slice(8)),
        // 把用户这句话也交给情绪判断 —— 只看她自己写的内容会漏掉"他累了"这种事
        userText: text
      });
      if (auto) {
        stickerNames = [auto];
        log(`  [表情包] ${stickerForced ? `已隔 ${gap} 轮，强制补一张` : '按概率兜底补一张'}：${auto}`);
      }
    }

    if (stickerNames.length) lastStickerTurn.set(userId, turn);

    // 表情符号兜底：整条回复一个颜文字/emoji 都没有时按概率补一个。
    // 人设里的比例要求实测执行不稳定（颜文字 24%、emoji 3%），靠代码保底。
    // 这一轮已经要发图了就不补 —— 三选一只留一个。
    if (!stickerNames.length) {
      ensureEmoji(finalBubbles, {
        kaomojiChance: state.cfg.kaomojiChance ?? 0.65,
        emojiChance: state.cfg.emojiChance ?? 0.35
      });
    }

    // 记住这次发的是哪个类别，避免连着几张都一样
    for (const n of stickerNames) rememberLine(n, 'sticker:' + n);

    await sendBubbles(state, userId, finalBubbles, stickerNames);

    // 记进历史的是一条完整的文本。
    //
    // 注意：以前这里会追加「[发了表情包：X]」当占位，结果模型在下一轮
    // 照着这个格式写进回复，这串字直接发到微信里（2026-10-21 实测）。
    // 现在只存正文；表情包发过什么只进日志，不进上下文。
    const historyText = finalBubbles.join('\n\n');
    await appendTurn(userId, text, historyText);

    // 记下这一轮说过的话，下一轮明确要求别重复
    rememberReply(userId, historyText);

    // 把这一轮写回场景：她说了什么、留没留下一个没被回答的问题。
    // 落盘是必须的 —— 内存态一重启就没了，场景会断在重启那一刻。
    if (sceneEnabled && scene) {
      recordReply(scene, finalBubbles.join('\n\n'));
      await saveScene(userId, scene);
    }

    log(`  已回复（${secs}s，${finalBubbles.length} 条${stickerNames.length ? ` + ${stickerNames.length} 个表情` : ''}${imageCount ? `，看图 ${imageCount} 张` : ''}${persona ? '，人设=' + persona.name : ''}）`);

    // 把实际发出的每一条都记下来。
    // 没有这行日志，"已回复"只能证明调用没抛错，证明不了发了什么内容，
    // 排查"用户说没收到/没效果"时就完全抓瞎。
    for (let i = 0; i < finalBubbles.length; i++) {
      const one = String(finalBubbles[i]).replace(/\n/g, ' / ');
      log(`    [${i + 1}/${finalBubbles.length}] ${one.length > 120 ? one.slice(0, 120) + '…' : one}`);
    }
  } else {
    const detail = result.error || (result.stderr ? result.stderr.slice(-400) : '未知错误');
    // 生成失败也要把"用户刚说过什么"落盘，否则下次她就忘了这句话，场景断掉
    if (sceneEnabled && scene) await saveScene(userId, scene);
    await sendText(state, userId, `处理失败（${secs}s）：${detail}\n\n可用 /new 清空上下文后重试。`);
    warn(`  失败（${secs}s）: ${detail}`);
  }
}

/**
 * 分条发送文字，并在合适的位置插表情包。
 *
 * 表情包不单独成"轮"，而是混在聊天气泡之间 —— 真人也是这么发的：
 * 一句话、一个表情、再一句话。
 */
async function sendBubbles(state, userId, bubbles, stickerNames = []) {
  // 表情包插在倒数第二条之后（也就是正文说完了、还没收尾的位置），
  // 只有一条时插在最后。这样不会一上来就发表情。
  const stickerPositions = new Set();
  if (stickerNames.length && bubbles.length) {
    const base = Math.max(0, bubbles.length - 1);
    stickerNames.forEach((_, i) => {
      stickerPositions.add(Math.min(base + i, bubbles.length - 1));
    });
  }

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await tryTyping(state, userId, true);
      const base = state.cfg.bubbleGapMs;
      const jitter = base * 0.4 * (Math.random() * 2 - 1);
      await delay(Math.max(250, Math.round(base + jitter)));
    }
    await sendText(state, userId, bubbles[i]);

    if (stickerPositions.has(i)) {
      await delay(Math.max(300, Math.round(state.cfg.bubbleGapMs * 0.7)));
      await sendStickerBatch(state, userId, stickerNames);
    }
  }
}

/** 逐个发表情包（每个之间留点空隙，别刷屏） */
async function sendStickerBatch(state, userId, names) {
  const contextToken = state.contextTokens.get(userId) ?? '';
  for (const name of names) {
    const picked = await pickSticker(name);
    if (!picked) {
      warn(`表情包不存在: ${name}（跳过）`);
      continue;
    }
    try {
      await sendImage(state.cred.baseUrl, state.cred.token, userId, contextToken, picked.path);
      log(`  已发表情包: ${picked.name}`);
    } catch (e) {
      warn(`表情包发送失败 ${picked.name}: ${e.message}`);
    }
    await delay(400);
  }
}

/** 控制指令：/new /role /help */
async function handleCommand(state, msg, text) {
  const userId = msg.from_user_id;
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  const arg = raw.split(/\s+/).slice(1).join(' ').trim();

  if (cmd === '/new' || cmd === '/clear') {
    await clearHistory(userId);
    await sendText(state, userId, '上下文已清空，可以重新开始了。');
    return true;
  }

  // /role —— 人设切换
  if (cmd === '/role' || cmd.startsWith('/role ')) {
    const all = await listPersonas();
    const current = await getUserPersona(userId) || state.cfg.defaultPersona;

    if (!arg) {
      if (!all.length) {
        await sendText(state, userId,
          '还没有任何人设。在 wx-bridge/personas/ 目录下放 .md 文件即可，格式见 README。');
        return true;
      }
      const lines = ['可用人设：'];
      for (const p of all) {
        const mark = p.name === current ? ' ← 当前' : '';
        lines.push(`  /role ${p.name} — ${p.title}${p.description ? '：' + p.description : ''}${mark}`);
      }
      lines.push('');
      lines.push('发送 /role 名称 切换。发送 /role off 关掉人设。');
      await sendText(state, userId, lines.join('\n'));
      return true;
    }

    if (arg.toLowerCase() === 'off' || arg.toLowerCase() === 'none') {
      await setUserPersona(userId, '');
      await sendText(state, userId, '已关掉人设，恢复默认说话方式。');
      return true;
    }

    const target = await getPersona(arg);
    if (!target) {
      const names = all.map((p) => p.name).join('、') || '（无）';
      await sendText(state, userId, `没有名为「${arg}」的人设。可用的：${names}`);
      return true;
    }

    await setUserPersona(userId, target.name);
    await sendText(state, userId, `已切换人设：${target.title}${target.description ? '\n' + target.description : ''}`);
    return true;
  }

  if (cmd === '/help' || cmd === '/?') {
    await sendText(state, userId,
      ['wx-bridge 控制指令：',
        '',
        '【调整她】',
        '/状态           看当前设置（含忙碌模式状态）',
        '/场景           看现在聊的是哪件事（/场景 清空 可重置）',
        '/节奏 慢        调发送间隔（慢/中/快/很慢/很快）',
        '/条数 3         改一次最多发几条（1-8）',
        '',
        '【忙碌模式】',
        '/忙             我要去忙了 → 改成每 25 分钟发 2-3 条，不催不提问',
        '/闲             我回来了 → 恢复原来的节奏',
        '  （直接说"我在忙""我去上班了""我忙完了"也会自动切换）',
        '',
        '【联网】',
        '/搜 关键词      搜一下网上的资料',
        '',
        '【对话】',
        '/new            清空对话上下文',
        '/role           查看可用人设',
        '/role 名称      切换人设',
        '/role off       关掉人设',
        '',
        '【操作电脑】',
        '/do             看可执行的电脑操作',
        '/do 动作名      让电脑执行（如 /do 打开抖音）',
        '/do 任意任务    交给 AI 现场处理（较慢）',
        '',
        '/help           显示本说明',
        '',
        '直接发文字或语音，她就会以聊天方式回你。'].join('\n'));
    return true;
  }

  // /do —— 执行电脑操作
  //
  // /节奏、/条数 —— 用聊天调整发送节奏和条数
  //
  // 为什么需要：在微信里说"慢一点""多发几条"，AI 只会顺着你应承，
  // 但改不了任何设置。这几个指令才是真的改配置（同时写文件和内存）。
  if (cmd === '/节奏' || cmd === '/speed' || cmd.startsWith('/节奏 ')) {
    const arg2 = arg.toLowerCase();
    const presets = {
      慢: 3500, 很慢: 5000, 中: 2200, 正常: 2200, 快: 1200, 很快: 700
    };
    const preset = presets[arg2];
    if (preset) {
      state.cfg.bubbleGapMs = preset;
      await writeConfig({ bubbleGapMs: preset });
      await sendText(state, userId,
        `已调整：每条消息间隔约 ${(preset * 0.6 / 1000).toFixed(1)}-${(preset * 1.4 / 1000).toFixed(1)} 秒\n\n常用：/节奏 慢 · /节奏 中 · /节奏 快`);
      log(`  [设置] bubbleGapMs → ${preset}`);
      return true;
    }
    await sendText(state, userId,
      `当前每条间隔约 ${(state.cfg.bubbleGapMs * 0.6 / 1000).toFixed(1)}-${(state.cfg.bubbleGapMs * 1.4 / 1000).toFixed(1)} 秒\n\n用法：/节奏 慢 | 中 | 快 | 很慢 | 很快`);
    return true;
  }

  if (cmd === '/条数' || cmd === '/count' || cmd.startsWith('/条数 ')) {
    const n = parseInt(arg, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 8) {
      state.cfg.maxBubbles = n;
      await writeConfig({ maxBubbles: n });
      await sendText(state, userId, `已调整：一次最多发 ${n} 条（实际会按内容多少在 1-${n} 之间变）`);
      log(`  [设置] maxBubbles → ${n}`);
    } else {
      await sendText(state, userId,
        `当前一次最多 ${state.cfg.maxBubbles} 条\n\n用法：/条数 3（范围 1-8）\n注意这是上限，实际条数会按内容自动变`);
    }
    return true;
  }

  // /库 —— 查知识库检索（用来确认 RAG 到底检索到了什么）
  if (cmd === '/库' || cmd === '/rag' || cmd.startsWith('/库 ') || cmd.startsWith('/rag ')) {
    const st = getVaultStatus();
    if (!arg) {
      await sendText(state, userId, [
        `知识库检索：${state.cfg.ragEnabled ? '开启' : '关闭'}`,
        `  目录：${state.cfg.vaultPath}`,
        st.ready
          ? `  索引：${st.files} 篇 / ${st.chunks} 个片段，建于 ${st.ageMinutes} 分钟前（耗时 ${st.buildMs}ms）`
          : '  索引：还没建（发一句话就会自动建）',
        `  阈值：${state.cfg.ragMinScore}，每次最多 ${state.cfg.ragTopK} 段`,
        '',
        '用法：/库 关键词 —— 看看她会检索到什么'
      ].join('\n'));
      return true;
    }
    const rr = await searchVault(arg, state.cfg.vaultPath, {
      topK: state.cfg.ragTopK, minScore: state.cfg.ragMinScore
    });
    if (!rr.ok) {
      await sendText(state, userId, `检索失败：${rr.error}`);
      return true;
    }
    if (!rr.hits.length) {
      await sendText(state, userId, `「${arg}」没检索到相关内容（${rr.ms}ms）\n\n说明这话题她库里没有，回答时会不注入背景资料。`);
      return true;
    }
    const lines = [`「${arg}」检索到 ${rr.hits.length} 段（${rr.ms}ms）：`];
    rr.hits.forEach((h, i) => {
      const label = h.heading && h.heading !== h.title ? `${h.title} · ${h.heading}` : h.title;
      lines.push(`${i + 1}. [${h.score}] ${label}`);
      lines.push(`   ${String(h.text).replace(/\s+/g, ' ').slice(0, 60)}…`);
    });
    await sendText(state, userId, lines.join('\n'));
    return true;
  }

  // /搜 —— 手动联网搜索
  if (cmd === '/搜' || cmd === '/search' || cmd.startsWith('/搜 ')) {
    if (!arg) {
      await sendText(state, userId,
        '用法：/搜 关键词\n\n例如：/搜 2026年诺贝尔奖\n\n（平时聊天时，涉及"最新/今天/天气/新闻"这类话题她也会自动搜）');
      return true;
    }

    await tryTyping(state, userId, true);
    await sendText(state, userId, `正在搜「${arg}」…`);
    log(`  [搜索] 手动: ${arg}`);

    const sr = await webSearch(arg, {
      maxUses: state.cfg.searchMaxUses || 3,
      timeoutMs: state.cfg.searchTimeoutMs || 60000
    });
    await tryTyping(state, userId, false);

    if (!sr.ok || (!sr.sources.length && !sr.answer)) {
      await sendText(state, userId, `没搜到结果：${sr.error || '结果为空'}`);
      warn(`  [搜索] 失败: ${sr.error}`);
      return true;
    }

    // 有摘要就先给摘要（人能直接看懂），再附几条来源
    const parts = [];
    if (sr.answer) parts.push(sr.answer.slice(0, 900));
    if (sr.sources.length) parts.push(formatSources(sr.sources, 4));
    const head = `搜到 ${sr.sources.length} 条（${(sr.ms / 1000).toFixed(1)}s）：`;
    const body = parts.join('\n\n');
    await sendText(state, userId, `${head}\n\n${body}`);
    log(`  [搜索] 成功，${sr.sources.length} 条${sr.answer ? '，含摘要' : ''}`);

    // 把她搜到的结果也记进对话历史，这样后面聊到能接上
    await appendTurn(userId, `[搜索] ${arg}`, sr.answer
      ? sr.answer.slice(0, 300)
      : sr.sources.slice(0, 3).map((s) => `${s.title || s.url}`).join('；'));
    return true;
  }

  // /忙 /闲 —— 手动切换忙碌模式（不依赖模型判断，100% 准确）
  if (cmd === '/忙' || cmd === '/busy' || cmd === '/闲' || cmd === '/free') {
    if (cmd === '/忙' || cmd === '/busy') {
      const r = setBusy(userId, '/忙 命令');
      // 注意：颜文字里的反引号必须转义，否则会提前闭合模板字符串
      await sendText(state, userId,
        '好啦，你去忙吧 (´｡・ᵕ・｡`)\n\n我记得你在忙：\n' +
        `  每隔 ${state.cfg.busyIntervalMinutes ?? 25} 分钟发 ${state.cfg.busyMinCount ?? 2}-${state.cfg.busyMaxCount ?? 3} 条，不催你、不提问\n` +
        '  你回来随便说句话，或者发 /闲 就恢复原来的节奏' +
        (r.changed ? '' : '\n\n（本来就在忙碌模式）'));
      log(`  [忙碌] /忙 命令 → 进入忙碌模式${r.changed ? '' : '（已在忙）'}`);
    } else {
      const r = setFree(userId, '/闲 命令');
      await sendText(state, userId, r.changed
        ? `你回来啦！那我恢复正常啦 (＾▽＾)\n\n（刚才忙了 ${r.lastedMin} 分钟）`
        : '我现在本来就是正常的呀');
      log(`  [忙碌] /闲 命令 → ${r.changed ? `退出忙碌模式（持续 ${r.lastedMin} 分钟）` : '本来就不在忙碌模式'}`);
    }
    return true;
  }

  // /场景 —— 看现在挂着的那件事，也可以手动清掉
  if (cmd === '/场景' || cmd === '/scene' || cmd.startsWith('/场景 ') || cmd.startsWith('/scene ')) {
    if (arg === '换' || arg === '清空' || arg === 'new' || arg === 'reset') {
      await resetScene(userId);
      log('  [场景] 手动清空');
      await sendText(state, userId, '场景已清空。下一句话会开一个新场景。');
      return true;
    }

    const sc = await loadScene(userId);
    if (!sc) {
      await sendText(state, userId, '现在没有挂着的场景。你说一句话就会开一个。');
      return true;
    }

    const mins = Math.round((Date.now() - (sc.startedAt || Date.now())) / 60000);
    const intervalMin = Math.max(1, state.cfg.proactiveNewTopicMinutes ?? 180);
    const sinceNew = sc.lastNewTopicAt ? Date.now() - sc.lastNewTopicAt : Infinity;
    const cooldown = sinceNew >= intervalMin * 60000
      ? '已到，允许开新话题'
      : `还剩 ${Math.ceil((intervalMin * 60000 - sinceNew) / 60000)} 分钟`;

    await sendText(state, userId, [
      `当前场景：${sc.topic}`,
      `开始于 ${mins} 分钟前，已经聊了 ${sc.turns || 0} 轮`,
      sc.lastUserText ? `他最后说的：「${sc.lastUserText}」` : '',
      sc.openQuestion ? `你问过、他还没答的：「${sc.openQuestion}」` : '',
      '',
      `换题冷却：${cooldown}（/场景 清空 可手动重置）`
    ].filter(Boolean).join('\n'));
    return true;
  }

  if (cmd === '/状态' || cmd === '/status') {
    const su = getSearchUsage();
    await sendText(state, userId, [
      '当前设置：',
      `  发送间隔：${(state.cfg.bubbleGapMs * 0.6 / 1000).toFixed(1)}-${(state.cfg.bubbleGapMs * 1.4 / 1000).toFixed(1)} 秒`,
      `  最多条数：${state.cfg.maxBubbles} 条`,
      `  合并概率：${Math.round((state.cfg.bubbleMergeChance || 0) * 100)}%`,
      `  联网搜索：${state.cfg.autoSearch ? '自动开启' : '仅手动（/搜 关键词）'}`,
      `  搜索预算：本小时 ${su.hourUsed}/${state.cfg.searchHourlyLimit}，今天 ${su.dayUsed}/${state.cfg.searchDailyLimit}`,
      `  知识库：${state.cfg.ragEnabled ? `开启（阈值 ${state.cfg.ragMinScore}，最多 ${state.cfg.ragTopK} 段，每轮固定注入 ${state.cfg.sceneProfileChars ?? 0} 字画像）` : '关闭'}`,
      `  场景延续：${state.cfg.sceneEnabled === false ? '关闭' : `开启（过期 ${state.cfg.sceneTtlMinutes ?? 180} 分钟，同一件事最多聊 ${state.cfg.sceneMaxTurns ?? 12} 轮）`}`,
      `  随机换题：${state.cfg.proactiveNewTopicMinutes ?? 180} 分钟内只接着说，不另起话题`,
      `  识图：${state.cfg.visionEnabled === false ? '关闭' : ((state.cfg.visionApiKey || process.env.ARK_API_KEY) ? `开启（豆包 ${state.cfg.visionModel || 'doubao-seed-1-6-vision-250815'}）` : '开启但没配 Key')}`,
      `  记忆档位：最近 ${state.cfg.historyRecentTurns} 轮全文 + 更早的压成摘要`,
      `  主动消息：${state.cfg.proactive ? `开启（沉默 ${state.cfg.proactiveIdleMinutes} 分钟后开始，每 ${state.cfg.proactiveMinMinutes}-${state.cfg.proactiveMaxMinutes} 分钟一条）` : '关闭'}`,
      `  连发规则：沉默满 ${state.cfg.proactiveBurstAfterIdleMinutes ?? 5} 分钟 → 连发 ${state.cfg.proactiveBurstMinCount ?? 3}-${state.cfg.proactiveBurstMaxCount ?? 5} 条（间隔 ${((state.cfg.proactiveBurstGapMs ?? 500) / 1000).toFixed(1)} 秒）`,
      (() => {
        const bs = getBusyState(userId);
        if (!state.cfg.busyModeEnabled) return '  忙碌模式：已关闭';
        if (bs?.busy) {
          const min = Math.round((Date.now() - new Date(bs.since).getTime()) / 60000);
          return `  忙碌模式：⏸ 生效中（已 ${min} 分钟）→ 每 ${state.cfg.busyIntervalMinutes ?? 25} 分钟发 ${state.cfg.busyMinCount ?? 2}-${state.cfg.busyMaxCount ?? 3} 条，不提问`;
        }
        return `  忙碌模式：待命（你说"在忙"或发 /忙 就切进去）`;
      })()
    ].join('\n'));
    return true;
  }

  // /do 前缀：让电脑执行操作
  if (cmd === '/do' || cmd.startsWith('/do ')) {
    // 权限：/do 等于把命令执行权交给微信消息，必须限定在白名单内
    const doUsers = Array.isArray(state.cfg.doUsers) ? state.cfg.doUsers : [];
    const allowList = doUsers.length ? doUsers : state.cfg.allowedUsers;
    if (!allowList.length) {
      await sendText(state, userId,
        '⛔ /do 还没启用。为了安全，需要先在 data/config.json 的 allowedUsers 里写上你自己的微信 id。\n\n你的 id 是：' + userId);
      return true;
    }
    if (!allowList.includes(userId)) {
      await sendText(state, userId, '⛔ 你没有执行电脑操作的权限。');
      return true;
    }

    if (!arg) {
      const list = listActions();
      const lines = ['可执行的电脑操作：'];
      for (const a of list) {
        lines.push(`  /do ${a.name}${a.desc ? '  — ' + a.desc : ''}`);
      }
      lines.push('');
      lines.push('匹配不上时会交给 AI 现场处理（较慢）。');
      await sendText(state, userId, lines.join('\n'));
      return true;
    }

    // 1) 预设动作
    const action = matchAction(arg);
    if (action) {
      await sendText(state, userId, `执行：${action.name}`);
      log(`  [do] 预设动作: ${action.name}`);
      const r = await runAction(action);
      if (r.ok) {
        await sendText(state, userId, String(r.output).slice(0, 800) || '完成');
        log(`  [do] 成功`);
      } else {
        await sendText(state, userId, `执行失败：${r.output}`);
        warn(`  [do] 失败: ${r.output}`);
      }
      return true;
    }

    // 2) 回落 DSH
    await sendText(state, userId, '没有对应的预设动作，交给 AI 处理，可能要等几十秒…');
    log(`  [do] 回落 DSH: ${arg}`);

    // 工作目录用专用工作区，而不是项目根目录：
    // 沙箱把 workspaceRoot 设成子进程 cwd，所以 agent 的读写被限制在这里，
    // 不会误删机器人自己的源码/数据/凭证。
    const agentCwd = process.env.WX_AGENT_CWD || path.join(ROOT, '..', 'workspace');
    try { await mkdir(agentCwd, { recursive: true }); } catch {}

    // 干活通道也套人设，让汇报语气和聊天一致。
    //
    // 用单独的 doPersona（personas/gongju.md）而不是聊天人设：
    // 聊天人设里写着"我不太会写代码"，直接套到 agent 上会让它拒绝干活；
    // 而车间报报告的语感和闲聊本来就不一样，需要一份短得多、带技术味的设定。
    const doPersonaName = state.cfg.doPersona || 'gongju';
    const doPersona = doPersonaName === 'off' ? null : await getPersona(doPersonaName);
    const taskText = doPersona
      ? applyPersona(doPersona, arg, {
          header: [
            `这轮他给你派了个电脑上的技术活。先把活干完、干对，再说怎么汇报。`,
            `技术细节不许为了语气好看而省略或糊弄；没做成必须明说。`,
            `汇报按下面这个人的说话方式来，但别让语气影响干活的质量。`
          ]
        })
      : arg;

    const r = await runTask(taskText, {
      timeoutMs: Math.min(state.cfg.doTimeoutMs || 120000, 600000),
      cwd: agentCwd
    });

    if (r.ok) {
      const cleaned = stripActions(r.text, state.cfg.stripActions);
      const out = splitIntoBubbles(cleaned, {
        maxMessages: 4, enabled: true, shortReplyThreshold: 0, minimumFragmentLength: 0
      }).filter(Boolean);
      await sendBubbles(state, userId, out, []);
      log(`  [do] DSH 完成，${out.length} 条`);
    } else {
      await sendText(state, userId, `执行失败：${(r.error || '').slice(0, 500)}`);
      warn(`  [do] DSH 失败: ${r.error}`);
    }
    return true;
  }

  // 图片/表情包功能已停用：iLink 的图片上传虽然返回成功，
  // 但消息在微信客户端始终显示为「已过期」，排查多轮未解决。
  // 为免用户发 /sticker 后收到错误提示，这里给出明确说明而不是静默失败。
  if (cmd === '/sticker' || cmd.startsWith('/sticker ')) {
    await sendText(state, userId, '图片和表情包功能暂未启用（iLink 图片通道未打通），目前只支持文字和语音。');
    return true;
  }

  return false;
}

// ── 主循环 ──────────────────────────────────────────────────────────────────
async function main() {
  if (flag('--logout')) {
    await rm(CRED_PATH, { force: true });
    log('已清除登录凭证，下次运行需要重新扫码');
    return;
  }

  ensureConfigFile();
  await ensurePersonaDir();
  await ensureStickerDir();
  const cfg = loadConfig();
  const personas = await listPersonas();
  const stickers = await listStickers();

  console.log('');
  console.log('  wx-bridge  ·  微信 iLink Bot');
  console.log('  ─────────────────────────────────────────');
  console.log(`  模式     : ${MODE}${MODE === 'chat' ? '（直连 API，轻量）' : MODE === 'dsh' ? '（DSH headless，带工具）' : ''}`);
  console.log(`  协议地址 : ${ILINK_BASE_URL}`);
  if (MODE === 'dsh') {
    console.log(`  DSH 运行时: ${describeRuntime()}`);
  } else if (MODE === 'chat') {
    console.log(`  模型     : ${cfg.chatModel}`);
    console.log(`  接口地址 : ${cfg.chatBaseUrl}`);
    console.log(`  API Key  : ${API_KEY.key ? `已就绪（${API_KEY.source}）` : '⚠ 缺失'}`);
    console.log(`  温度     : ${cfg.chatTemperature}`);
  }
  if (MODE === 'dsh' || MODE === 'chat') {
    console.log(`  任务超时 : ${cfg.taskTimeoutMs / 1000} 秒`);
    console.log(`  人设     : ${personas.length} 个可用${cfg.defaultPersona ? `，默认 ${cfg.defaultPersona}` : '（未设默认）'}`);
    console.log(`  表情包   : ${stickers.length} 个${cfg.allowStickers ? '' : '（已停用）'}`);
    console.log(`  处理提示 : ${cfg.showQueuedNotice ? '会先回"收到，正在处理…"' : '仅"正在输入"，不刷消息'}`);
    console.log(`  场景记忆 : ${cfg.sceneEnabled === false
      ? '关闭（每条回复独立生成）'
      : `开启（过期 ${cfg.sceneTtlMinutes ?? 180} 分钟，最多 ${cfg.sceneMaxTurns ?? 12} 轮，判定=${cfg.sceneAnalyzeModel ?? 'auto'}）`}`);
    console.log(`  换题冷却 : ${cfg.proactiveNewTopicMinutes ?? 180} 分钟内只说手头这件事`)
    ;
    const visionKey = cfg.visionApiKey || process.env.ARK_API_KEY || '';
    console.log(`  识图     : ${cfg.visionEnabled === false
      ? '关闭'
      : visionKey
        ? `开启（豆包 ${cfg.visionModel || 'doubao-seed-1-6-vision-250815'}，一次最多 ${cfg.visionMaxImages ?? 1} 张，识别失败会自己说看不见）`
        : '开启但没配 Key（收到图会说"眼睛不好使"）'}`);
  }
  console.log(`  配置文件 : ${CFG_PATH}`);
  if (cfg.allowedUsers.length) {
    console.log(`  白名单   : ${cfg.allowedUsers.length} 个用户`);
  } else {
    console.log('  白名单   : 未设置（任何能给 bot 发消息的人都可用）');
  }
  console.log('  ─────────────────────────────────────────');
  console.log('');

  // ── 知识库自检 + 预热 ────────────────────────────────────────────────────
  //
  // 为什么要在这里做，而不是等第一条消息：RAG 是懒加载的，如果库目录被改名、
  // 盘符变了、或者权限出问题，她会整整一段时间"静默地没有知识库"——
  // 用户只会觉得"怎么又不好用了"，而日志里什么都没有。
  // 所以启动时就把索引建好并把结果打出来，出了问题当场能看见。
  if (cfg.ragEnabled && (MODE === 'dsh' || MODE === 'chat')) {
    if (!cfg.vaultPath) {
      warn('知识库：未配置 vaultPath，RAG 不会生效');
    } else if (!existsSync(cfg.vaultPath)) {
      warn(`知识库：目录不存在 → ${cfg.vaultPath}（RAG 不生效，检查盘符或路径）`);
    } else {
      try {
        const t0 = Date.now();
        const st = await ensureVaultIndex(cfg.vaultPath);
        const missing = (cfg.profileNotes || []).filter(
          (rel) => !existsSync(path.join(cfg.vaultPath, rel))
        );
        log(`知识库就绪：${st.files} 篇 / ${st.N} 个片段 / 建索引 ${Date.now() - t0}ms`);
        log(`  目录：${cfg.vaultPath}`);
        log(`  阈值 ${cfg.ragMinScore}，最多 ${cfg.ragTopK} 段；画像卡 ${cfg.profileNotes?.length || 0} 篇`);
        if (missing.length) {
          warn(`  画像卡缺文件：${missing.join('、')}（这几篇不会注入）`);
        }
        // 深呼吸一次：真的检索一遍，确认从「按键」到「出结果」整条路是通的
        const probe = await searchVault('显卡 配置', cfg.vaultPath, { topK: 1, minScore: 0.2 });
        if (probe.ok && probe.hits.length) {
          log(`  自测检索通过（${probe.ms}ms）→ ${probe.hits[0].title}`);
        } else {
          warn('  自测检索没有命中，知识库可能是空的或全是无关文件');
        }
      } catch (e) {
        warn('知识库初始化失败（RAG 不会生效）: ' + e.message);
      }
    }
  }

  let cred = FORCE_LOGIN ? undefined : await loadCred();
  if (cred) log(`复用已有凭证  账号=${cred.accountId}`);
  else cred = await login();

  // 上报自我标识（UA 风格，仅用于服务端日志归因，不参与鉴权）
  const agent = setBotAgent(cfg.botAgent);
  log(`bot_agent=${agent}`);

  const state = { cred, contextTokens: new Map(), handled: 0, cfg };
  let cursor = '';
  // 长轮询超时由服务端建议值决定，初始 40 秒
  let pollTimeoutMs = 40000;
  let stopped = false;
  let controller;
  let notifiedStop = false;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    log('正在停止…');
    controller?.abort();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 告诉服务端我们上线了。失败不影响收消息，只记一笔。
  try {
    await notifyStart(cred.baseUrl, cred.token);
    log('已上报上线通知');
  } catch (e) {
    warn('上线通知失败（不影响正常收发）:', e.message);
  }

  // ── 主动消息调度 ──────────────────────────────────────────────────────
  //
  // 两档行为：
  //   普通档 —— 用户安静一会儿，发一条，像正常搭话
  //   升级档 —— 连着发了好几次都没回音，一次性连发 5 条，表达"你到底理不理我"
  const composeProactive = async (userId, _user, info = {}) => {
    const { escalate = false, wantCount = 1, streak = 0, idleMinutes = 0, busy = false } = info;

    if (cfg.proactiveCompose === 'fixed') {
      const pool = Array.isArray(cfg.proactiveLines) && cfg.proactiveLines.length
        ? cfg.proactiveLines
        : ['在忙吗？'];
      if (!escalate) return pool[Math.floor(Math.random() * pool.length)];
      // 固定句子连发时循环取值
      const out = [];
      for (let i = 0; i < wantCount; i++) out.push(pool[i % pool.length]);
      return out;
    }

    const personaName = (await getUserPersona(userId)) || cfg.defaultPersona;
    const persona = personaName ? await getPersona(personaName) : null;

    // ── 主动搭话：连贯性 + 内容轮换 ──────────────────────────────────────
    //
    // 三个层次，缺一个都会让消息显得"莫名其妙"：
    //   1. 只有「用户不理她之后的第一条」是随机开新话题
    //   2. 之后每一条都接着上一条往下说（补充细节 / 说后来怎样）
    //   3. 偶尔在句末带一句具体的问题（问后来怎么了、为什么）
    //
    // 以前的问题：提示词写得太通用，模型每轮都收敛到同一句
    // （实测永远输出"哥哥你在干嘛呀"）。光写"要换着说"没用，所以代码里三层：
    //   1. 随机指定一个场景，提示词带上具体方向
    //   2. 把最近发过的话列进"禁止重复"清单
    //   3. 生成完做相似度检查，太像就重来一次，还不行用本地兜底句
    const recent = recentLines(12);
    const usedScenarios = recentScenarios(5);

    // ── 场景：先看"有没有一件挂着的事"，再决定说这件事还是开新题 ──────────
    //
    // 用户要的是"一个语境、一个整体的事，随机开新话题每 3 小时才一次"。
    // 所以这里的判定顺序是：
    //   ① 有当前场景、且没到换题冷却 → 必须接着说这件事
    //   ② 到了冷却（proactiveNewTopicMinutes，默认 180 分钟）→ 有资格抽新题
    //   ③ 同一件事已经聊了 sceneMaxTurns 轮 → 也允许换，不然会反复嚼同一件事
    const sceneEnabled = cfg.sceneEnabled !== false;
    let scene = sceneEnabled ? await loadScene(userId) : null;
    const newTopicIntervalMs = Math.max(1, cfg.proactiveNewTopicMinutes ?? 180) * 60 * 1000;
    const topicCooledDown = canOpenNewTopic(scene, { intervalMs: newTopicIntervalMs });
    const sceneExhausted = scene && (scene.turns || 0) >= Math.max(1, cfg.sceneMaxTurns ?? 12);
    const allowNewTopic = !scene || topicCooledDown || sceneExhausted;

    // streak 是「上次用户说话之后，她已经主动发过几次」。
    const isFirstAfterSilence = streak === 0;
    const prevLine = recent.length ? recent[recent.length - 1] : '';

    // 冷却到了也不一定立刻换题（每次都掐着 3 小时整换，反而像闹钟）。
    // 给 85% 概率换新题，剩下 15% 继续把手上这件事说完。
    const wantNewTopic = allowNewTopic && Math.random() < 0.85;
    const continueMode = !escalate && !wantNewTopic && !!prevLine;

    // 分享类场景权重更高（合计约 62%），所以大多数主动消息都在分享具体的小事。
    const scenario = escalate ? 'cute' : pickScenario(usedScenarios);
    const scenarioMeta = SCENARIO_HINTS[scenario] || {};
    const scenarioHint = scenarioMeta.hint || SCENARIO_HINTS.care.hint;
    // 有些场景本身就是"围着他"（权重高），必须带问句；带脾气的场景不强制提问。
    const wantsAsk = scenarioMeta.ask === true;
    const isTemper = scenario.startsWith('temper_');

    // 接着说的时候，把"你们挂着的那件事"喂给它。
    // 没有这一段，模型只能看到"上一条说过的话"，不知道那件事的来龙去脉。
    const sceneBlock = sceneEnabled && scene && !wantNewTopic
      ? formatSceneForProactive(scene, { canNewTopic: allowNewTopic })
      : '';

    // 偶尔带一个具体的问题。这里是纯代码掷骰子，不靠模型自己想。
    // 忙碌模式绝对不提问 —— 忙的人最烦被追问。
    const askChance = Number.isFinite(cfg.proactiveQuestionChance) ? cfg.proactiveQuestionChance : 0.35;
    const withQuestion = !escalate && !busy && (wantsAsk || Math.random() < askChance);

    // 忙碌模式的四种"不打扰"表达，轮着来，避免每 25 分钟都一句"我不催你"
    const BUSY_FLAVORS = [
      { key: 'report', hint: '说一句你自己在做什么（画画、吃东西、收拾东西），短，不要求回应' },
      { key: 'care', hint: '一句很轻的关心（记得喝水 / 别熬太晚），不追问、不说教' },
      { key: 'wait', hint: '让他安心的一句（我在这儿 / 你忙你的 / 我不催你）' },
      { key: 'cute', hint: '一个小小的撒娇，但绝不能带催促或委屈的语气' }
    ];
    const busyFlavor = busy ? BUSY_FLAVORS[Math.floor(Math.random() * BUSY_FLAVORS.length)] : null;

    // "禁止重复"清单。
    // 注意两种模式的要求是相反的：开新话题时连"同一件事"都不许重复；
    // 接着讲时相反 —— 必须还是那件事，只是话要换。
    // 忙碌模式：只禁止原句重复，不禁止同一件事（因为"等你"本来就是同一个主题）
    const noRepeatBlock = !recent.length
      ? ''
      : (continueMode || busy)
        ? [
            '',
            '**你已经发过的原句不能再重复**（但话题要继续，说的还是同一件事）：',
            ...recent.slice(-6).map((r) => `  · ${r}`),
            '',
            '可以问"在吗"，但别问"在干嘛""吃了吗""忙不忙"这类查岗式空话。'
          ].join('\n')
        : [
            '',
            '你最近主动发过下面这些，**这一句绝对不能再重复，也不能换个说法说同一件事**：',
            ...recent.slice(-8).map((r) => `  · ${r}`),
            '',
            '尤其不要问"在干嘛""吃了吗""忙不忙"这类问题——这些你已经问过了。"在吗"可以用，但别每次都用。'
          ].join('\n');

    // 提问要求：让问题有真正的落点，而不是"你在干嘛"
    const questionHint = withQuestion
      ? [
          '',
          '【这条消息必须包含一个问题】',
          '说完那件小事之后，**句末一定要问他一句**，而且必须问得具体。可选方向：',
          '- 问那件事的**后来**："你猜后来怎么着""后来我还是没找到"',
          '- 问他**为什么/怎么了**："你怎么突然这么累呀"',
          '- 问他**做了什么/选哪个**："那你打算怎么办"',
          '✗ 不要问："在干嘛""吃了吗""忙不忙"（"在吗"可以，但别当口头禅）',
          '整句话可以稍微长一点（10~35 个字），因为要多一个问句。'
        ].join('\n')
      : '';

    // 带问题时，从画像里挑一块他真实的信息当"提问素材"，
    // 这样问出来的东西有落点（问他电脑、问他游戏、问他工作），而不是空问。
    let questionContext = '';
    if (withQuestion && !escalate && cfg.ragEnabled && cfg.vaultPath) {
      try {
        const d = getProfileDigest(cfg.vaultPath, cfg.profileNotes || [], 320);
        if (d) {
          questionContext = [
            '',
            '【你可以问的素材（你记得的关于他的事）】',
            d,
            '挑其中**一件**，问一个具体的问题。不要全列出来，也不要问"你的电脑是什么配置"这种像查户口的。'
          ].join('\n');
        }
      } catch { /* 拿不到素材就不带，问题照样能问 */ }
    }

    // 开新话题时，从「他最近在弄的东西」里挑一个当话题候选。
    // 纯随机的烘焙/下雨天聊一百次也就那样，而聊他手上那件事更容易接下去。
    let recentTopicContext = '';
    if ((wantNewTopic || wantsAsk) && !busy && !escalate && cfg.ragEnabled && cfg.vaultPath) {
      try {
        const items = getRecentTopics(cfg.vaultPath, {
          days: cfg.recentTopicDays ?? 30,
          maxItems: cfg.sceneRecentTopics ?? 5
        });
        const block = formatRecentTopics(items, { maxChars: 200 });
        if (block) {
          recentTopicContext = [
            '',
            block,
            wantsAsk
              ? '这次就挑上面**一件**问他一句具体的（弄到哪一步了/搞定了没），别列清单、别像查户口。'
              : '如果你想聊他，就从上面挑**一件**问一句具体的（进展/有没有搞定/好不好玩）；',
            wantsAsk ? '' : '不想聊他就照【这次说什么】说自己的事，别硬扯。'
          ].filter(Boolean).join('\n');
        }
      } catch { /* 拿不到就不带，场景照样能说 */ }
    }

    const buildInstruction = (extraBan = '') => (busy
      ? [
          `他说了要去忙，现在过了 ${idleMinutes} 分钟了。`,
          '',
          '你不打扰他，但你还在，你想让他知道这一点。',
          '',
          `【这次说什么】${busyFlavor.hint}`,
          '',
          '要求：',
          `1. 一共输出 ${wantCount} 条，用空行隔开，每条之间不要编号。`,
          '2. 每条都很短，3~12 个字，看他手机屏幕一眼就能看完。',
          '3. **绝对不要提问**。不要问"忙完了吗""在忙吗""几点回来""还忙吗"。',
          '4. **不要催他**，不要表达委屈，不要说"你都不理我"。',
          '5. 不要提"忙""等很久""这么久"这类带时间暗示的词。',
          '6. 不要写括号动作，不要加引号。',
          '7. 语气是"我懂你在忙"，不是"你怎么还不回我"。',
          noRepeatBlock,
          extraBan
        ].filter(Boolean).join('\n')
      : escalate
      ? [
          idleMinutes > 0
            ? `他已经 ${idleMinutes} 分钟没回你了。`
            : `你已经主动找过对方 ${streak} 次了，对方一直没回你。`,
          `你等不住了，想一口气连发 ${wantCount} 条短消息给他。`,
          '',
          prevLine ? `你上一条发的是：「${prevLine}」` : '',
          prevLine ? `**这 ${wantCount} 条要接着上面那件事往下走**，不要突然换话题。` : '',
          sceneBlock,
          '',
          '要求：',
          `1. 一共输出 ${wantCount} 条，用空行隔开，每条之间不要编号。`,
          '2. 每条都很短，5-12 个字，像真的急了在连发微信。',
          '3. 情绪要有递进：先接着说那件事，再委屈，再有点生气/赌气，最后一条软下来留台阶。',
          '4. 不要提"主动""定时""第几次""几分钟"之类的字眼。',
          '5. 不要写括号动作，不要加引号。',
          noRepeatBlock,
          extraBan
        ].filter(Boolean).join('\n')
      : continueMode
        ? [
            '现在没有人跟你说话。你上面已经跟他说过一件事了，他没回，你还想接着说。',
            '',
            `【你上一条说的是】${prevLine}`,
            '',
            sceneBlock,
            '**这次接着说同一件事**，不要开新话题。可以选一种往下走：',
            '- 补充一个刚想起来的新细节',
            '- 说这件事后来怎样了（哪怕只是"还是没找到"）',
            '- 就这件事再问一句',
            '',
            '要求：',
            '- 只说一句很短的话（5~25 个字），像真人接着自己的话发第二条。',
            '- 还是要有具体的东西（东西、颜色、味道、几个、什么时候）。',
            '- 原句绝不能重复，但话题必须连着。',
            '- 只输出这一句话本身：不要引号、不要括号里的动作、不要解释。',
            '- 不要提到"主动""定时"之类的字眼。',
            questionHint,
            questionContext,
            noRepeatBlock,
            extraBan
          ].filter(Boolean).join('\n')
        : [
            '现在没有人跟你说话，你想主动找他聊一句。',
            '',
            wantsAsk
              ? '这次**围着他**说，不要说自己的事。你说这句话，是因为你想知道他今天怎么样、他手上那件事怎么样了。'
              : isTemper
                ? '这次你心里有点不痛快：他最近陪你说话太少，或者回得敷衍。你想说一句带脾气的话，但这种脾气是"要人哄"的，不是吵架。'
                : '你分享欲很强。看到什么、吃到什么、做了什么，都忍不住想跟他说一句。',
            wantsAsk
              ? '所以这次不说身边的小事，也不问"在干嘛"，而是**问一件跟他有关的具体的事**。'
              : '所以这次不说"没事"，也不问"在干嘛"，而是**把一件具体的小事说给他听**。',
            '',
            `【这次说什么】${scenarioHint}`,
            '',
            '要求：',
            '- 只说一句很短的话（5~25 个字），像真人随手发的一条微信。',
            wantsAsk
              ? '- **必须问得具体**：问的是哪件事、哪一天、哪一步，不要泛泛一句"今天怎么样"。'
              : '- **必须带一个具体细节**：什么东西、什么颜色、什么味道、几个、什么时候。',
            '  ✗ 不行："好无聊呀""今天好累"（太抽象，没有可以说下去的钩子）',
            '  ✓ 可以："楼下桂花开了，一小簇一小簇的黄"',
            '  ✓ 可以："烤饼干焦了一盘，就中间那两个还能看"',
            isTemper
              ? '- 脾气要露出来一点（哼、才不、你都不、我不高兴了），但**不许真的骂人、不许威胁、不许说"再也不理你"**，结尾要留个台阶让他哄你。'
              : '',
            '- 只输出这一句话本身：不要引号、不要括号里的动作、不要解释。',
            '- 不要提到"主动""定时"之类的字眼。',
            questionHint || '- 尽量别用问句；要问也只问一件具体的小事。',
            questionContext,
            recentTopicContext,
            noRepeatBlock,
            extraBan
          ].filter(Boolean).join('\n'));

    // 主动搭话也走当前模式的通道：chat 模式用直连 API（省 token），dsh 模式用 headless
    const generate = async (instruction) => {
      if (MODE === 'chat') {
        const history = await loadHistory(userId);
        const messages = buildChatMessages(persona, history, instruction, {
          recentTurns: cfg.historyRecentTurns ?? 3,
          olderChars: cfg.historyOlderChars ?? 40,
          compress: compressHistory
        });
        return chatComplete({
          baseUrl: cfg.chatBaseUrl,
          apiKey: API_KEY.key,
          model: cfg.chatModel,
          messages,
          temperature: cfg.chatTemperature,
          timeoutMs: 60000
        });
      }
      const task = await buildTask(userId, instruction, persona);
      return runTask(task, { timeoutMs: Math.min(cfg.taskTimeoutMs, 90000) });
    };

    let result = await generate(buildInstruction());
    if (!result.ok || !result.text) return '';

    let cleaned = stripActions(result.text, cfg.stripActions);

    // ── 忙碌模式：发 2-3 条，逐条去重 ────────────────────────────────────
    // 这里不重试、不换话题：重复的直接丢掉，宁少一条也不重复。
    // 因为忙碌模式本来就是"轻轻说一句"，少一条完全没影响。
    if (busy) {
      const rawBubbles = cleaned
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, wantCount);

      const kept = [];
      for (const b of rawBubbles) {
        if (isTooSimilar(b, { threshold: 0.8 }).similar) {
          log(`  [忙碌] 丢弃重复句：${b.slice(0, 20)}`);
          continue;
        }
        kept.push(b);
        rememberLine(b, 'busy');
      }

      if (!kept.length) {
        const fb = fallbackLine();
        log(`  [忙碌] 全部重复，改用兜底句（${fb.scenario}）`);
        rememberLine(fb.text, fb.scenario);
        return fb.text;
      }
      return kept;
    }

    if (!escalate) {
      let first = cleaned.split(/\n{2,}/)[0].trim().slice(0, 200);

      // 重复判定分两档：
      //   · 开新话题 → 门槛 0.5，连"说同一件事"都不行
      //   · 接着讲   → 门槛 0.8，只拦"几乎一字不差"，因为这里**本来就要说同一件事**
      const simOpts = continueMode ? { threshold: 0.8 } : {};
      let check = isTooSimilar(first, simOpts);

      // 带问题的那一轮，如果生成的句子里根本没有问句，就再要一次。
      // 实测：光在提示词里写"必须问一句"，模型照样会漏掉 —— 得有代码检查。
      // 注意不能只看问号：中文经常靠"怎么/为什么/哪/多少"来提问而不带问号。
      const hasQuestion = (s) => {
        const t = String(s || '');
        if (/[？?]/.test(t)) return true;
        if (/(吗|呢|呀|吧)\s*$/.test(t.trim())) return true;
        return /怎么|为什么|为啥|什么|哪[个里儿]|多少|几个|多久|是不是|有没有|要不要|行不行|好不好/.test(t);
      };

      if (withQuestion && !hasQuestion(first)) {
        log('  [主动] 要求带问题但没问号，重生成一次');
        const qRetry = await generate(buildInstruction(
          `\n【刚才你写的是】${first}\n这句话里**没有问他任何问题**。必须在这一句的末尾加一个具体的问题（问后来怎样、为什么、怎么了）。`
        ));
        if (qRetry.ok && qRetry.text) {
          const c3 = stripActions(qRetry.text, cfg.stripActions).split(/\n{2,}/)[0].trim().slice(0, 200);
          if (c3 && hasQuestion(c3)) {
            first = c3;
            check = isTooSimilar(first, simOpts);
          }
        }
      }

      if (check.similar) {
        log(`  [主动] 第一版被判定重复（${check.reason}），重生成一次`);
        const retry = await generate(buildInstruction(
          continueMode
            ? `\n【刚才你写的是】${first}\n这句和上一条几乎一模一样，换句话接着说同一件事。`
            : `\n【刚才你写的是】${first}\n这句不能用（${check.reason}）。换一个完全不同的说法和角度。`
        ));
        if (retry.ok && retry.text) {
          const c2 = stripActions(retry.text, cfg.stripActions).split(/\n{2,}/)[0].trim().slice(0, 200);
          if (c2 && !isTooSimilar(c2, simOpts).similar) {
            first = c2;
            check = { similar: false };
          }
        }
      }

      if (check.similar && continueMode) {
        // 接着讲的时候**不要**换成无关的兜底句 —— 那才是真正"莫名其妙"。
        // 宁可这句话和上一条有点近，也要保住话题连贯。
        log(`  [主动] 仍在同话题上重复，但为保连贯，保留当前这句`);
        check = { similar: false };
      } else if (check.similar) {
        // 开新话题时还重复 → 用本地兜底句，保证绝不重样
        const fb = fallbackLine();
        log(`  [主动] 模型两次都重复，改用本地兜底句（场景 ${fb.scenario}）`);
        first = fb.text;
        rememberLine(first, fb.scenario);
        if (sceneEnabled) {
          if (wantNewTopic || !scene) {
            scene = markNewTopic(scene, first, { source: 'proactive' });
            log(`  [场景] 兜底句作为新话题「${scene.topic}」`);
          } else {
            scene = recordReply(scene, first);
          }
          await saveScene(userId, scene);
        }
        return first;
      }

      rememberLine(first, continueMode ? 'continue' : scenario);

      // ── 把这次主动消息写回场景 ──────────────────────────────────────────
      // 开新题：markNewTopic 会重置场景并落"换题冷却"，这是 3 小时阈值的锚点。
      // 接着说：只更新"上次说到"和"欠他一个问题"，话题本身不动。
      if (sceneEnabled) {
        if (wantNewTopic || !scene) {
          if (!escalate) {
            scene = markNewTopic(scene, first, { source: 'proactive' });
            await saveScene(userId, scene);
            log(`  [场景] 主动开了新话题「${scene.topic}」，下次换题至少 ${Math.round(newTopicIntervalMs / 60000)} 分钟后`);
          }
        } else {
          scene = recordReply(scene, first);
          await saveScene(userId, scene);
        }
      }
      return first;
    }

    // 升级档：先按空行拆；模型常常只用单换行，那就再按单换行拆。
    // 不处理单换行的话，四句话会被挤进一条，连发就失去意义了。
    let bubbles = splitIntoBubbles(cleaned, {
      maxMessages: wantCount,
      enabled: true,
      shortReplyThreshold: 0,
      minimumFragmentLength: 0
    }).filter((b) => b && b.trim());

    // 如果条数还不够，且原文里本来就有单换行，就按单换行重拆
    if (bubbles.length < wantCount && /\n/.test(cleaned)) {
      const byLine = cleaned
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (byLine.length > bubbles.length) bubbles = byLine;
    }

    // 模型给的条数还不够就补几句，别让"连发 5 条"变成"发了 2 条就没了"。
    // 补的句子也要避开"在干嘛/在吗"这类被用烂的句式。
    const fillers = ['宝宝？', '理我一下嘛…', '哼', '我先去吃饼干了', '……好吧'];
    let i = 0;
    while (bubbles.length < wantCount && i < fillers.length) {
      bubbles.push(fillers[i++]);
    }

    const result2 = bubbles.slice(0, wantCount).map((b) => b.slice(0, 200));
    for (const b of result2) rememberLine(b, 'cute');
    log(`  [主动] 升级连发 ${result2.length} 条（沉默 ${streak} 次）`);

    // 升级连发也是"接着那件事急起来了"，不当作换题
    if (sceneEnabled && scene) {
      scene = recordReply(scene, result2.join('\n\n'));
      await saveScene(userId, scene);
    }
    return result2;
  };

  // ── 发送窗口"续期"尝试 ─────────────────────────────────────────────────
  //
  // 背景：iLink 只允许在用户最后说话之后的一段时间内主动发消息，超了返回 ret=-2。
  // 协议里没有任何官方"续期"接口（我查过 ilink.js 全部 18 个端点）。
  // 所以这里选了个最不打扰的试探：先 getconfig（纯读接口，用户看不见），
  // 再发一次「正在输入」并立刻取消（一闪而过）。
  //
  // 这个动作到底能不能延长窗口，目前**未知** —— 所以每次尝试的结果都会记进
  // data/window-probe.jsonl，攒几天就能测出真实窗口到底多长。
  const keepAliveFor = async (userId) => {
    if (cfg.busyKeepAlive === false) return;
    const contextToken = state.contextTokens.get(userId) ?? '';
    if (!contextToken) return;
    try {
      const cfgResp = await getBotConfig(state.cred.baseUrl, state.cred.token, userId, contextToken);
      const ticket = cfgResp?.typing_ticket;
      if (ticket) {
        await sendTyping(state.cred.baseUrl, state.cred.token, userId, ticket, 1);
        await sendTyping(state.cred.baseUrl, state.cred.token, userId, ticket, 2);
      }
    } catch { /* 续期只是试探，失败不影响发送 */ }
  };

  // 记录「沉默多久 → 能不能发出去」，用来反推真实窗口
  const recordWindowProbe = (rec) => {
    try {
      const dir = path.join(ROOT, 'data');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        path.join(dir, 'window-probe.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n',
        'utf8'
      );
    } catch { /* 记录失败不影响主流程 */ }
  };

  const proactive = createProactiveScheduler({
    enabled: cfg.proactive,
    minGapMs: Math.max(1, cfg.proactiveMinMinutes) * 60 * 1000,
    maxGapMs: Math.max(cfg.proactiveMinMinutes, cfg.proactiveMaxMinutes) * 60 * 1000,
    idleBeforeMs: Math.max(1, cfg.proactiveIdleMinutes) * 60 * 1000,
    contextTtlMs: Math.max(cfg.proactiveIdleMinutes, cfg.proactiveContextTtlMinutes) * 60 * 1000,
    tickEveryMs: Math.max(3, cfg.proactiveTickSeconds ?? 15) * 1000,
    burstAfter: Math.max(1, cfg.proactiveBurstAfter ?? 3),
    burstAfterIdleMs: Math.max(1, cfg.proactiveBurstAfterIdleMinutes ?? 5) * 60 * 1000,
    burstCount: Math.max(1, cfg.proactiveBurstCount ?? 5),
    burstMinCount: Math.max(1, cfg.proactiveBurstMinCount ?? 3),
    burstMaxCount: Math.max(1, cfg.proactiveBurstMaxCount ?? 5),
    burstGapMs: Math.max(200, cfg.proactiveBurstGapMs ?? 500),
    // 忙碌模式
    busyGapMs: Math.max(1, cfg.busyIntervalMinutes ?? 25) * 60 * 1000,
    busyMinCount: Math.max(1, cfg.busyMinCount ?? 2),
    busyMaxCount: Math.max(1, cfg.busyMaxCount ?? 3),
    busyBurstGapMs: Math.max(300, cfg.busyBurstGapMs ?? 1500),
    getBusy: (userId) => (cfg.busyModeEnabled === false ? false : isBusy(userId)),
    keepAlive: cfg.busyKeepAlive === false ? null : keepAliveFor,
    recordProbe: recordWindowProbe,
    retryDelayMs: Math.max(10, cfg.proactiveRetrySeconds ?? 60) * 1000,
    maxFailStreak: Math.max(1, cfg.proactiveMaxFailStreak ?? 3),
    compose: composeProactive,
    send: async (userId, text) => sendText(state, userId, text),
    log,
    warn
  });

  proactive.start();

  log('开始长轮询，等待微信消息…');
  console.log('');

  let retryMs = 1000;
  let emptyPolls = 0;

  while (!stopped) {
    try {
      controller = new AbortController();
      const resp = await getUpdates(cred.baseUrl, cred.token, cursor, controller.signal, pollTimeoutMs);
      controller = undefined;

      if (resp.get_updates_buf) cursor = resp.get_updates_buf;

      // 服务端可以建议下次轮询的时长，听从它
      if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
        pollTimeoutMs = Math.min(Math.max(resp.longpolling_timeout_ms, 5000), 120000);
      }

      const msgs = resp.msgs ?? [];
      if (msgs.length === 0) {
        emptyPolls++;
        if (emptyPolls % 20 === 0) log(`仍在等待…（已空轮询 ${emptyPolls} 次，超时 ${Math.round(pollTimeoutMs / 1000)}s）`);
      } else {
        emptyPolls = 0;
      }

      for (const msg of msgs) {
        if (msg.message_type !== MSG_TYPE.USER) continue;
        if (!msg.from_user_id) continue;

        // 把收到的原始消息落盘一份。
        // 用途：排查协议问题（比如收发的 image_item 结构差异）时，
        // 这就是最权威的对照物，比猜参数组合靠谱得多。
        if (MODE === 'dsh' || VERBOSE) {
          try {
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const dir = path.join(ROOT, 'data', 'received');
            mkdirSync(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            writeFileSync(
              path.join(dir, `${stamp}.json`),
              JSON.stringify(msg, null, 2),
              'utf8'
            );
          } catch { /* 落盘失败不影响主流程 */ }
        }

        if (msg.context_token) {
          state.contextTokens.set(msg.from_user_id, msg.context_token);
        }

        const userId = msg.from_user_id;

        // 记录活跃时间，并把"沉默计数"清零 ——
        // 用户回话了说明撒娇该收敛，不能继续按"他不理我"的档位发连珠炮。
        touchUser(userId, { lastSeenAt: Date.now(), userSpoke: true });

        // 白名单
        if (cfg.allowedUsers.length && !cfg.allowedUsers.includes(userId)) {
          warn(`拒绝未授权用户: ${userId}`);
          continue;
        }

        const text = extractText(msg);
        log(`收到  来自=${userId}  类型=${describeItems(msg)}` +
          (text ? `  内容=${JSON.stringify(text.slice(0, 60))}` : ''));

        if (VERBOSE) {
          log(`  context_token=${(state.contextTokens.get(userId) || '').slice(0, 16)}…`);
        }

        try {
          if (MODE === 'echo') {
            await sendText(state, userId, text
              ? `收到：${text}\n\n—— wx-bridge echo 模式，链路正常`
              : '这个模式目前只处理文字消息。');
            state.handled++;
          } else if (MODE === 'dsh' || MODE === 'chat') {
            // chat 和 dsh 共用同一条处理链路（人设/记忆/分条/指令都一样），
            // 只在真正调用模型那一步分岔。之前只放行了 dsh，导致 chat 模式
            // 掉进"未知模式"分支。
            if (await handleCommand(state, msg, text ?? '')) {
              state.handled++;
              continue;
            }
            // 丢进该用户的队列，不阻塞长轮询
            enqueue(userId, async () => {
              await handleWithDsh(state, msg, text);
              state.handled++;
            });
          } else {
            await sendText(state, userId, `未知模式 ${MODE}`);
          }
        } catch (e) {
          warn('处理消息失败:', e.message);
        }
      }

      retryMs = 1000;
    } catch (e) {
      controller = undefined;
      if (stopped) break;

      if (e.name === 'AbortError' || e.name === 'TimeoutError') continue;

      if (isSessionExpired(e)) {
        warn('会话已过期（errcode -14），需要重新扫码登录');
        await rm(CRED_PATH, { force: true });
        try {
          cred = await login(cred.baseUrl);
          state.cred = cred;
          state.contextTokens.clear();
          cursor = '';
          retryMs = 1000;
          continue;
        } catch (loginErr) {
          warn('重新登录失败:', loginErr.message);
          break;
        }
      }

      warn('长轮询出错:', e.message);
      await delay(retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }
  }

  // 停掉主动消息调度，避免退出过程中还在发东西
  proactive.stop();

  // 告诉服务端我们下线了。放在这里而不是 shutdown 里，是因为 shutdown 只做中断，
  // 真正退出在这里 —— 这样通知一定能发出去，不会因进程被打断而丢失。
  if (!notifiedStop) {
    notifiedStop = true;
    try {
      await notifyStop(cred.baseUrl, cred.token);
      log('已上报下线通知');
    } catch (e) {
      warn('下线通知失败（不影响已收到的消息）:', e.message);
    }
  }

  log(`已停止。本次共处理 ${state.handled} 条消息`);
}

main().catch((e) => {
  console.error('');
  console.error('  启动失败:', e.message);
  if (e instanceof ApiError && e.status) console.error('  HTTP 状态:', e.status);
  console.error('');
  process.exit(1);
});
