// 情绪弧测试：开心 → 转折 → 崩溃 → 被接住 → 缓过来 → 回到日常
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
  ['我今天面试过了', '开心'],
  ['不过有个事我一直没跟你说', '转折'],
  ['我上个月查出来点问题 一直在复查', '崩溃'],
  ['我怕我妈知道 她身体也不好', '更深'],
  ['其实我跟你说完好像轻一点了', '被接住'],
  ['你别担心 我没事', '装没事'],
  ['对了 你晚饭吃了没', '回到日常']
];

let hist = [];
for (const [q, label] of turns) {
  const a = await reply(hist, q);
  console.log(`【他·${label}】${q}`);
  console.log(`【她】${a}\n`);
  hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
}
