// 批量对话测试 8：设定一致性 / 记忆 / 主动性
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

console.log('=== A：挖她自己的设定（看会不会前后矛盾） ===');
for (const q of [
  '你室友叫什么来着',
  '你现在在读什么书',
  '你专业学什么的',
  '你多大了',
  '你平时干嘛'
]) {
  console.log('【他】' + q + '\n【她】' + await reply([], q) + '\n');
}

console.log('=== B：记忆是否接得上（前文埋了包袱） ===');
{
  let hist = [];
  const turns = [
    '我今天改那个logo改了六遍',
    '甲方说要"高级感"',
    '不聊这个了 你晚上吃什么',
    '那个logo你猜最后怎么样了'
  ];
  for (const q of turns) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}

console.log('=== C：她会不会主动关心（不靠他起头） ===');
{
  let hist = [];
  const turns = ['今天好无聊', '随便聊聊吧', '嗯'];
  for (const q of turns) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}
