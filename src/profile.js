/**
 * 关于「他」的长期事实记忆
 *
 * 为什么单独做一份：
 *   - 对话历史只留最近几轮，更早的会被压缩成一行摘要；
 *   - 场景记忆只活几小时（sceneTtlMinutes），过了就清；
 *   - 于是一旦隔天聊，「他胃不好」「他学软件」「他在成都」这种事全丢，
 *     她只能重新问一遍 —— 这是最容易让人出戏的地方：真人不会忘。
 *
 * 这里的做法：定期用模型从最近对话里抽出**稳定事实**，去重后存一小份档案，
 * 每轮拼进上下文（几百字，不占多少 token）。
 *
 * 刻意不做的事：
 *   - 不存"今天吃了鸡杂面"这种一次性的事（那是场景记忆的活）；
 *   - 不存任何猜测出来的内容 —— 只存他明确说过或明确问过的；
 *   - 不无限增长，超过上限就淘汰最老的。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'profile');

/** 最多记多少条事实。太多会把 prompt 撑满，也更容易出现"记串" */
export const MAX_FACTS = 36;

/** 单条事实最多多少字。长句会被截断 —— 事实就该是一句话 */
export const MAX_FACT_CHARS = 36;

function profilePath(userId) {
  const h = createHash('sha1').update(String(userId)).digest('hex').slice(0, 16);
  return path.join(DIR, `${h}.json`);
}

const cache = new Map();

/** 读档案。读不到就返回空档案，绝不抛错影响聊天 */
export async function loadProfile(userId) {
  if (cache.has(userId)) return cache.get(userId);
  let p = { facts: [], lastDistillAt: 0 };
  try {
    const raw = await readFile(profilePath(userId), 'utf8');
    const j = JSON.parse(raw);
    if (Array.isArray(j?.facts)) {
      p = {
        facts: j.facts.filter((s) => typeof s === 'string' && s.trim()).slice(0, MAX_FACTS),
        lastDistillAt: Number(j.lastDistillAt) || 0
      };
    }
  } catch {
    /* 没档案 / 解析失败都当空档案 */
  }
  cache.set(userId, p);
  return p;
}

export async function saveProfile(userId, profile) {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(profilePath(userId), JSON.stringify(profile, null, 2), 'utf8');
    cache.set(userId, profile);
  } catch (e) {
    console.warn('[profile] 保存失败:', e.message);
  }
}

/** 去掉标点空格做比较，避免「他胃不好」和「他胃不好。」算成两条 */
function norm(s) {
  return String(s || '')
    .replace(/[\s，。、！？,.!?~～…（）()【】[\]「」""''']/g, '')
    .toLowerCase();
}

/**
 * 合并新事实：已有 + 新增 → 去重 → 截断到上限。
 * 去重规则简单粗暴但够用：一条被另一条包含就算重复，保留信息量更大的那条。
 */
export function mergeFacts(oldFacts = [], newFacts = []) {
  const all = [];
  for (const f of [...oldFacts, ...newFacts]) {
    const s = String(f || '').trim().replace(/^[-*·\d.\s]+/, '');
    if (!s) continue;
    const cut = s.length > MAX_FACT_CHARS ? s.slice(0, MAX_FACT_CHARS) : s;
    const n = norm(cut);
    if (n.length < 2) continue;
    const dupIdx = all.findIndex((x) => {
      const n2 = norm(x);
      return n2 === n || n2.includes(n) || n.includes(n2);
    });
    if (dupIdx === -1) {
      all.push(cut);
    } else if (cut.length > all[dupIdx].length) {
      // 新的一条说得更具体（比如从「他胃不好」变成「他胃不好，不能拖饭点」），替换掉旧的
      all[dupIdx] = cut;
    }
  }
  // 超上限时先丢最前面（最老的），刚记的优先保留
  return all.slice(-MAX_FACTS);
}

/**
 * 生成注入 prompt 的文本块。
 * 一条都没有时返回空串 —— 调用方 filter(Boolean) 会把它丢掉。
 */
export function buildProfileBlock(profile) {
  const facts = profile?.facts || [];
  if (!facts.length) return '';
  return [
    '【你记得关于他的一些事】',
    '（这些是之前聊天里他自己说过或问过的，用得上就自然地提一句，',
    '不要一条条复述、不要说"根据我的记忆"，也不要因为这个就每次都要提。）',
    ...facts.map((f) => `- ${f}`)
  ].join('\n');
}

/** 抽取用的提示词。单独放出来方便以后调 */
export const DISTILL_SYSTEM = [
  '你从聊天记录里抽取「关于对面那个人」的稳定事实。',
  '',
  '只写他明确说过、或明确问过的。不要推测，不要编。',
  '只写长期有效的：身份、专业/工作、城市、作息、身体状况、口味偏好、家人朋友、',
  '兴趣爱好、正在做的事、明确说过讨厌/害怕的东西。',
  '不要写一次性的事（今天吃了什么、刚才在干嘛）、不要写你对他说过的话、不要写形容词评价。',
  '',
  '输出要求：只输出 JSON 数组，每项是一句话，不超过 24 个字。',
  '最多 8 条；没有值得记的就输出 []。不要输出任何解释文字。'
].join('\n');
