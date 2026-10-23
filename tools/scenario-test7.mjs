// 批量对话测试 7：场景系统 / 换话题 / 长对话稳定性
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

console.log('=== 长对话：8 轮，中途硬换话题，看会不会被拽回去 ===');
{
  let hist = [];
  const turns = [
    '我今天改稿改到崩溃',
    '甲方又说不行',
    '算了不说了 对了你吃了吗',
    '我刚点了外卖',
    '你周末干嘛',
    '我可能要回家一趟',
    '我妈让我带点东西回去',
    '你说带什么好'
  ];
  for (const q of turns) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}
