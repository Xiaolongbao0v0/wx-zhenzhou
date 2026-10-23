/**
 * 直连 DeepSeek API 的聊天通道
 *
 * 为什么需要它：
 *   DSH headless 是编码 agent，每次请求都要携带系统提示词 + 19 个工具定义
 *   （约 7000-17000 tokens）。纯聊天用不上任何一个，等于每条消息白烧一万多 token。
 *   这个模块只发「人设 + 历史 + 本轮消息」，输入量降到约 2400 tokens。
 *
 * 协议：OpenAI 兼容的 /chat/completions，和 wx-bridge 原来接的那套一致。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Key 的存放位置，按优先级：
 *
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. data/apikey.txt        ← 本桥自己的，推荐。DSH 重写凭证库不会碰它
 *   3. ~/.dsh/.credentials.yaml 顶层的 DEEPSEEK_API_KEY
 *
 * 为什么要有第 2 项：DSH 桌面端重启时会按它自己的 schema 重写
 * ~/.dsh/.credentials.yaml，把外加的顶层字段（包括我们塞进去的
 * DEEPSEEK_API_KEY）整个抹掉。实测 2026-10-21 11:29 就被抹过一次，
 * 表现为桥启动横幅显示「API Key : ⚠ 缺失」、聊天全部失败。
 * 放在 data/ 下就完全独立于 DSH 的生命周期。
 */
export const KEY_FILE = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'data', 'apikey.txt'
);

/** 一行一行地找 sk- 开头的 key，apikey.txt 和 YAML 都能认 */
function pickKey(text) {
  const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m);
  if (m && m[1]) return m[1];
  // 纯文本文件：整个文件就是一行 sk-xxx
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim().replace(/^["']|["']$/g, '');
    if (/^sk-[A-Za-z0-9_-]{8,}$/.test(s)) return s;
  }
  return '';
}

/** 从 DSH 凭证文件读 key（与 dsh.js 同源，保证两模式用同一把钥匙） */
export function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) {
    return { key: process.env.DEEPSEEK_API_KEY, source: 'environment' };
  }
  const candidates = [
    KEY_FILE,
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', 'credentials.yaml')
  ];
  for (const file of candidates) {
    try {
      const key = pickKey(readFileSync(file, 'utf8'));
      if (key) return { key, source: file };
    } catch { /* 试下一个 */ }
  }
  return { key: '', source: 'none' };
}

/**
 * 调用 chat completions。
 *
 * @param {object} opts
 *   - baseUrl   接口基址，如 https://api.deepseek.com
 *   - apiKey    密钥
 *   - model     模型名
 *   - messages  [{role, content}]
 *   - temperature
 *   - timeoutMs
 * @returns {{ok:boolean, text:string, reasoning?:string, usage?:object, error?:string, ms:number}}
 */
export async function chatComplete(opts) {
  const {
    baseUrl = 'https://api.deepseek.com',
    apiKey,
    model = 'deepseek-v4-flash',
    messages = [],
    temperature = 1.3,
    timeoutMs = 60_000,
    // ── 随机性三件套 ────────────────────────────────────────────────
    // 不加这几个参数的话，同一个问题问十次会有七八次给出几乎一样的句子，
    // 因为模型在小话题上的概率分布过于集中（实测「在干嘛」三次都回「改稿。你呢。」）。
    //
    // presence_penalty：惩罚"已经出现过的词"，让措辞换开
    // frequency_penalty：按出现次数累进惩罚，压掉口头禅式的重复
    // top_p：只从累积概率前 p 的词里采样，配合温度一起放宽多样性
    presencePenalty,
    frequencyPenalty,
    topP
  } = opts;

  const started = Date.now();

  if (!apiKey) {
    return {
      ok: false, text: '', code: -1,
      ms: Date.now() - started,
      error: '未找到 API Key（检查 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY）'
    };
  }

  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      model,
      messages,
      temperature,
      stream: false
    };
    if (Number.isFinite(presencePenalty)) payload.presence_penalty = presencePenalty;
    if (Number.isFinite(frequencyPenalty)) payload.frequency_penalty = frequencyPenalty;
    if (Number.isFinite(topP)) payload.top_p = topP;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* 非 JSON */ }

    if (!res.ok || !json) {
      const msg = json?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
      return { ok: false, text: '', code: res.status, ms: Date.now() - started, error: msg };
    }

    const choice = json.choices?.[0];
    const text = (choice?.message?.content || '').trim();
    const reasoning = (choice?.message?.reasoning_content || '').trim();

    if (!text) {
      return {
        ok: false, text: '', code: 0, ms: Date.now() - started,
        error: '模型没有返回内容' + (json.error?.message ? '：' + json.error.message : '')
      };
    }

    return {
      ok: true,
      text,
      reasoning: reasoning || undefined,
      usage: json.usage,
      ms: Date.now() - started
    };
  } catch (err) {
    const aborted = err.name === 'AbortError';
    return {
      ok: false, text: '', code: -1,
      ms: Date.now() - started,
      error: aborted ? `超时 ${Math.round(timeoutMs / 1000)} 秒未响应` : (err.message || String(err))
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把「人设 + 本轮上下文 + 历史 + 本轮」组装成 API 的 messages 数组。
 *
 * 结构（顺序不能乱，直接决定省不省 token）：
 *   [0] system  人格          ← 固定不变，DeepSeek 前缀缓存能命中
 *   [1] system  本轮上下文    ← 每轮都变（条数要求/搜索结果/RAG片段/历史摘要）
 *   [2..] user/assistant      ← 最近几轮原文
 *   [n] user    这一句
 *
 * 为什么把「本轮要求」和「搜索结果」从人格里拆出来：
 *   以前是拼在 persona.prompt 末尾一起塞进 system[0] 的，
 *   结果整个 system 前缀每轮都变 → prompt_cache_hit_tokens 永远是 0，
 *   3600 token 的人格每条消息都全价重付。拆开后 [0] 可缓存，只付一半价。
 *
 * @param {object|null} persona  {name,title,prompt}
 * @param {Array} rawHistory     loadHistory 的原始返回
 * @param {string} userText      用户这句话
 * @param {{dynamicContext?:string, recentTurns?:number, olderChars?:number,
 *          compress?:Function}} opts
 */
export function buildChatMessages(persona, rawHistory, userText, opts = {}) {
  const {
    dynamicContext = '',
    recentTurns = 3,
    olderChars = 40,
    compress = null
  } = opts;

  const messages = [];

  if (persona?.prompt) {
    messages.push({
      role: 'system',
      content: [
        `你是${persona.title || persona.name}。以下是你的完整人物设定，请严格保持这个角色，不要说"作为一个AI"之类的话。`,
        '',
        persona.prompt
      ].join('\n')
    });
  }

  // 历史：最近几轮原文 + 更早的压成一行摘要
  const { digest, recent } = compress
    ? compress(rawHistory, { recentTurns, olderChars })
    : { digest: '', recent: Array.isArray(rawHistory) ? rawHistory : [] };

  // 本轮上下文合成一条动态 system，放在人格之后
  const ctxParts = [];
  if (digest) ctxParts.push('【更早的对话摘要】\n' + digest);
  if (dynamicContext) ctxParts.push(dynamicContext);
  if (ctxParts.length) {
    messages.push({ role: 'system', content: ctxParts.join('\n\n') });
  }

  for (const m of recent) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.content) continue;
    messages.push({ role: m.role, content: m.content });
  }

  messages.push({ role: 'user', content: userText });
  return messages;
}
