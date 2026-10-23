// 长对话压力测试：10 轮，看会不会塌成单一模式
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
  '下课了 累死',
  '今天老师拖堂二十分钟',
  '我饿了 食堂关门了吧',
  '要不你来我这 我给你带',
  '我买了两份 麻辣烫',
  '你还挺够意思',
  '不过我明天要考试',
  '一个字没看',
  '完了 我肯定挂',
  '算了 吃东西吧'
];

let hist = [];
for (const q of turns) {
  const a = await reply(hist, q);
  console.log('【他】' + q);
  console.log('【她】' + a + '\n');
  hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
}
