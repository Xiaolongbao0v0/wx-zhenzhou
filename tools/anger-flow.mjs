// 生气状态机完整测试：触发 → 持续冷 → 逐步哄 → 消气
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';
import { moodBlock, extractMoodMarkers, markAngry, clearAngry, softenAngry, getMood, isAngry } from '../src/mood.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();
const UID = 'anger-flow-test';

async function turn(history, q) {
  const msgs = buildChatMessages(persona, history, q, {
    recentTurns: 6,
    dynamicContext: moodBlock(UID)
  });
  const r = await chatComplete({
    baseUrl: cfg.chatBaseUrl, apiKey: key.key, model: cfg.chatModel,
    messages: msgs, temperature: cfg.chatTemperature, timeoutMs: 60000
  });
  if (!r.ok) return { text: 'ERR ' + r.error };
  const m = extractMoodMarkers(r.text);
  const ex = extractStickers(m.text);
  const b = splitIntoBubbles(ex.text, {
    maxMessages: cfg.maxBubbles, enabled: true,
    shortReplyThreshold: 0, minimumFragmentLength: 0
  });
  if (m.angry) markAngry(UID, m.reason);
  if (m.soften) softenAngry(UID);
  if (m.forgive) clearAngry(UID, 'test');
  return { text: b.join(' / '), m };
}

clearAngry(UID);

// 他先犯错，然后从敷衍哄到认真哄
const convo = [
  ['昨天说好六点，我等到七点半，你电话不接微信不回，最后我刷到你朋友圈在打游戏。', '触发'],
  ['在吗', '他试探'],
  ['别生气了啊', '敷衍哄 1'],
  ['我错了行不行，对不起', '敷衍哄 2'],
  ['我错了，是我不该放你鸽子，也不该不接电话，让你在那儿等了一个半小时。', '说清错在哪'],
  ['以后我要是再这样你直接骂我，我请你吃饭赔罪', '具体补救'],
  ['真的，我知道你在意时间，我不该那样', '再补一句'],
  ['还生气吗', '问']
];

let hist = [];
for (const [q, label] of convo) {
  const res = await turn(hist, q);
  const st = getMood(UID);
  const state = st ? `生气中(第${st.turns}轮,软化${st.softened})` : '正常';
  console.log(`【他·${label}】${q}`);
  console.log(`【她】${res.text}`);
  console.log(`   [状态: ${state}]\n`);
  hist.push({ role: 'user', content: q }, { role: 'assistant', content: res.text });
}
clearAngry(UID);
