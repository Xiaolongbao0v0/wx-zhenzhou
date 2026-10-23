// 批量对话测试 9：醉话 / 八卦 / 求帮忙 / 请客 / 久别重逢
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();

async function reply(history, q) {
  const msgs = buildChatMessages(persona, history, q, { recentTurns: 3 });
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

const cases = [
  '我喝多了 我好想跟你说点心里话',
  '你知道吗 我们班那个李xx跟王xx在一起了',
  '帮我个忙 明天帮我签到',
  '周末我请你吃饭 想吃啥你定',
  '（一周没联系）在吗',
  '我今天被一个女生加了微信',
  '我觉得我长得不好看',
  '你说我要不要染个头发'
];

for (const q of cases) {
  console.log('【他】' + q);
  console.log('【她】' + await reply([], q));
  console.log('');
}
