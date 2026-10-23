// 生气流程测试（视角正确：是他爽约）
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';
import {
  moodBlock, extractMoodMarkers, markAngry, clearAngry, softenAngry,
  getMood, tickAngry, looksForgiven
} from '../src/mood.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();
const UID = 'anger-flow-2';

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
  // 和 index.js 一样的状态更新顺序
  if (m.angry) markAngry(UID, m.reason);
  if (m.soften) softenAngry(UID);
  if (m.forgive) clearAngry(UID, 'model');
  else if (!m.angry && getMood(UID) && looksForgiven(m.text)) clearAngry(UID, 'text-fallback');
  tickAngry(UID);
  return { text: b.join(' / '), m };
}

clearAngry(UID);

const convo = [
  ['昨天约好六点，我临时有事没去，也没跟你说一声。', '他承认爽约'],
  ['在吗', '他试探'],
  ['别生气了啊', '敷衍哄 1'],
  ['对不起嘛，我错了行不行', '敷衍哄 2'],
  ['我错了，我不该不跟你说一声，让你在那儿干等。', '说清错在哪'],
  ['下次我一定提前讲，真的，我请你吃饭', '具体补救'],
  ['真的知道了，以后不会了', '再补'],
  ['还生气吗', '问']
];

let hist = [];
for (const [q, label] of convo) {
  const res = await turn(hist, q);
  const st = getMood(UID);
  const state = st ? `生气中(第${st.turns}轮/软化${st.softened})` : '正常';
  const flags = [];
  if (res.m?.angry) flags.push('ANGRY');
  if (res.m?.soften) flags.push('SOFT');
  if (res.m?.forgive) flags.push('FORGIVE');
  console.log(`【他·${label}】${q}`);
  console.log(`【她】${res.text}` + (flags.length ? `   「${flags.join('+')}」` : ''));
  console.log(`   → ${state}\n`);
  hist.push({ role: 'user', content: q }, { role: 'assistant', content: res.text });
}
clearAngry(UID);
