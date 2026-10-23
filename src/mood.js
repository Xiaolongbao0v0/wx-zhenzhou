/**
 * 生气状态机
 *
 * 为什么不能只靠提示词：
 *   记忆窗口只喂最近 6 轮，而且是每轮重算的。单纯在提示词里写「你会生气」，
 *   模型第 3 轮就自己好了 —— 那不叫生气，那叫演了一下。
 *
 *   真实的气是**跨轮存活**的：他昨天放你鸽子，今天你还是不想理他。
 *   所以状态要落盘，并且由代码强制「必须被哄才消气」。
 *
 * 模型通过标记告诉代码：
 *   [ANGRY:原因]  真的生气了
 *   [SOFT]        被哄动了一点，但还没好
 *   [FORGIVE]     原谅了
 *
 * 没给 [FORGIVE] 之前，代码会一直把「你还在生气」塞进上下文，
 * 模型就不敢自己翻篇。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'mood-state.json');

/** 超过这么多轮还没消气，就自动淡掉（人不能气一星期） */
const AUTO_FADE_TURNS = 5;

let cache = null;

function readAll() {
  if (cache) return cache;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = (j && typeof j === 'object' && j.users) ? j : { users: {} };
  } catch {
    cache = { users: {} };
  }
  return cache;
}

function writeAll(state) {
  cache = state;
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[mood] 保存失败:', e.message);
  }
}

/** 取某人的情绪记录（可能为空对象） */
export function getMood(userId) {
  const s = readAll();
  return s.users?.[userId] || null;
}

/** 是不是正在真生气 */
export function isAngry(userId) {
  const m = getMood(userId);
  if (!m?.angry) return false;
  if ((m.turns ?? 0) >= AUTO_FADE_TURNS) {
    // 气太久了，自动淡掉，免得她永远在生气
    clearAngry(userId, 'auto-fade');
    return false;
  }
  return true;
}

/** 进入生气状态 */
export function markAngry(userId, reason = '') {
  const s = readAll();
  const prev = s.users[userId];
  if (prev?.angry) {
    // 已经气着了，更新原因，不重置计时
    prev.reason = reason || prev.reason;
    prev.updatedAt = new Date().toISOString();
    writeAll(s);
    return { changed: false, turns: prev.turns ?? 0 };
  }
  s.users[userId] = {
    angry: true,
    since: new Date().toISOString(),
    reason: String(reason || '').slice(0, 120),
    turns: 0,
    softened: 0,
    updatedAt: new Date().toISOString()
  };
  writeAll(s);
  return { changed: true, turns: 0 };
}

/** 被哄动一点（还没完全好） */
export function softenAngry(userId) {
  const s = readAll();
  const m = s.users?.[userId];
  if (!m?.angry) return { changed: false };
  m.softened = Math.min(3, (m.softened ?? 0) + 1);
  m.updatedAt = new Date().toISOString();
  // 被哄动两次就算真的好了，别让状态机拖着不放
  if (m.softened >= 2) {
    delete s.users[userId];
    writeAll(s);
    return { changed: true, softened: m.softened, autoCleared: true };
  }
  writeAll(s);
  return { changed: true, softened: m.softened };
}

/** 消气 */
export function clearAngry(userId, why = '') {
  const s = readAll();
  if (!s.users?.[userId]) return { changed: false };
  const was = s.users[userId];
  delete s.users[userId];
  writeAll(s);
  return { changed: !!was?.angry, why };
}

/** 每轮 +1，用于自动淡出 */
export function tickAngry(userId) {
  const s = readAll();
  const m = s.users?.[userId];
  if (!m?.angry) return;
  m.turns = (m.turns ?? 0) + 1;
  writeAll(s);
}

/**
 * 兜底：从她自己的话里判断是不是已经翻篇了。
 *
 * 为什么需要：实测模型经常嘴上说「没真生气」「行了」了，却忘了打 [FORGIVE]。
 * 那样代码会一直以为她还在气，下一轮又把她按回冷脸 —— 比不生气更假。
 * 所以文字上已经明显翻篇时，代码主动清掉状态。
 */
const FORGIVE_HINTS = /没真生气|不生气了|没生气了|早不气了|原谅你|这事过了|下不为例|记住就行|气什么|脑子上线|别再犯|这次就算|翻篇/;

export function looksForgiven(text) {
  return FORGIVE_HINTS.test(String(text || ''));
}

/**
 * 把当前情绪写成一段提示词材料。
 * 空串表示没有情绪，不用注入。
 */
export function moodBlock(userId) {
  if (!isAngry(userId)) return '';
  const m = getMood(userId);
  if (!m) return '';
  const turns = m.turns ?? 0;
  const softened = m.softened ?? 0;

  const lines = [
    `【你现在真的在生他的气】`,
    m.reason ? `原因：${m.reason}` : '原因：他之前做的事让你不舒服',
    `已经气了 ${turns} 轮。`
  ];

  if (softened === 0) {
    lines.push(
      '表现：极短回复（「哦」「嗯」「知道了」），用句号，不接梗、不损他、不反问、不主动开话题。',
      '**不损人**是重点：你平时骂他是因为亲近，生气的时候反而不骂，只剩冷。',
      '他要是问「怎么了」，先说「没事」；他要是追问，才说具体哪里不舒服。',
      '**不要自己翻篇。** 他不认真哄，你就一直这样。'
    );
  } else if (softened === 1) {
    lines.push(
      '你已经松了一点，但还没好。语气可以短一点软一点，但还是别热情。',
      '他要是再说一句实在的，你可以再松；要是他又敷衍，退回上一步。'
    );
  } else {
    lines.push(
      '你已经被哄得差不多了，只差个台阶。可以小声抱怨一句，然后翻篇。',
      '别硬撑着——他哄到这个份上，再冷就假了。'
    );
  }

  lines.push('他要是拿「你是不是生气了」开玩笑，你会更生气，不是缓和。');
  return lines.join('\n');
}

/**
 * 从模型输出里摘出情绪标记。
 * 必须在拆气泡之前调用，否则标记会被当正文发出去。
 *
 * @returns {{text:string, angry:boolean, reason:string, soften:boolean, forgive:boolean}}
 */
export function extractMoodMarkers(input) {
  let text = String(input ?? '');
  let angry = false;
  let reason = '';
  let soften = false;
  let forgive = false;

  // [ANGRY:原因] / 【生气：原因】这类变体
  const angryRe = /[[【]\s*ANGRY\s*[：:]\s*([^\]】]*?)\s*[\]】]/i;
  const angryBareRe = /[[【]\s*ANGRY\s*[\]】]/i;
  const m1 = text.match(angryRe);
  if (m1) {
    angry = true;
    reason = (m1[1] || '').trim();
    text = text.replace(angryRe, '');
  } else if (angryBareRe.test(text)) {
    angry = true;
    text = text.replace(angryBareRe, '');
  }

  const softRe = /[[【]\s*SOFT\s*[\]】]/i;
  if (softRe.test(text)) { soften = true; text = text.replace(softRe, ''); }

  const forRe = /[[【]\s*(FORGIVE|OK)\s*[\]】]/i;
  if (forRe.test(text)) { forgive = true; text = text.replace(forRe, ''); }

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, angry, reason, soften, forgive };
}
