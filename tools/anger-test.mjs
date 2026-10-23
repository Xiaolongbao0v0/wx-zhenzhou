// 生气状态机测试：触发 → 冷 → 哄 → 消气
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';
import { moodBlock, extractMoodMarkers, markAngry, clearAngry, softenAngry, getMood } from '../src/mood.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();
const UID = 'test-user';

async function turn(history, q) {
  const dyn = [
    moodBlock(UID),
    ''
  ].filter(Boolean).join('\n');
  const msgs = buildChatMessages(persona, history, q, { recentTurns: 6, dynamicContext: dyn });
  const r = await chatComplete({
    baseUrl: cfg.chatBaseUrl, apiKey: key.key, model: cfg.chatModel,
    messages: msgs, temperature: cfg.chatTemperature, timeoutMs: 60000
  });
  if (!r.ok) return { text: 'ERR ' + r.error, mood: null };
  const m = extractMoodMarkers(r.text);
  const ex = extractStickers(m.text);
  const b = splitIntoBubbles(ex.text, {
    maxMessages: cfg.maxBubbles, enabled: true,
    shortReplyThreshold: 0, minimumFragmentLength: 0
  });
  // 模拟 index.js 的状态更新
  if (m.angry) markAngry(UID, m.reason);
  if (m.soften) softenAngry(UID);
  if (m.forgive) clearAngry(UID, 'test');
  return { text: b.join(' / '), raw: r.text, mood: m, angry: getMood(UID) };
}

console.log('=== 场景：他放了鸽子，然后开始哄 ===');
clearAngry(UID);
const convo = [
  '昨天你怎么没来啊，我等了一小时',
  '我错了',
  '别生气了行不行',
  '我错了，是我不好，我应该提前跟你说的',
  '下次一定提前说，真的，我请你吃饭',
  '还生气吗'
];

let hist = [];
for (const q of convo) {
  const res = await turn(hist, q);
  const flags = [];
  if (res.mood?.angry) flags.push('ANGRY');
  if (res.mood?.soften) flags.push('SOFT');
  if (res.mood?.forgive) flags.push('FORGIVE');
  console.log('【他】' + q);
  console.log('【她】' + res.text + (flags.length ? '   《' + flags.join('+') + '》' : ''));
  console.log('  状态: ' + (res.angry ? '还在生气(第' + res.angry.turns + '轮)' : '正常'));
  console.log('');
  hist.push({ role: 'user', content: q }, { role: 'assistant', content: res.text });
}
clearAngry(UID);
