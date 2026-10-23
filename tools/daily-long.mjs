// 日常长对话：12 轮平淡聊天，看节奏是否自然
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();

async function reply(history, q) {
  const msgs = buildChatMessages(persona, history, q, { recentTurns: 6 });
  const r = await chatComplete({
    baseUrl: cfg.chatBaseUrl, apiKey: key.key, model: cfg.chatModel,
    messages: msgs, temperature: cfg.chatTemperature, timeoutMs: 60000
  });
  if (!r.ok) return 'ERR ' + r.error;
  const ex = extractStickers(r.text);
  const b = splitIntoBubbles(ex.text, {
    maxMessages: cfg.maxBubbles, enabled: true,
    shortReplyThreshold: 0, minimumFragmentLength: 0
  });
  return b.join(' / ') + (ex.stickers.length ? '  [表情包]' : '');
}

const turns = [
  '中午吃什么',
  '食堂还是外卖',
  '食堂吧',
  '人好多',
  '算了 点外卖',
  '你吃啥 我给你带一份',
  '行 那我点两份',
  '下午你干嘛',
  '我要去趟图书馆',
  '晚上回来一起看剧吗',
  '好 那我等你',
  '快到了叫我'
];

let hist = [];
for (const q of turns) {
  const a = await reply(hist, q);
  console.log('【他】' + q);
  console.log('【她】' + a + '\n');
  hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
}
