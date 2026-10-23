// 女生感测试：撒娇 / 淘气 / 反差
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
  return b.join('  /  ') + (ex.stickers.length ? '  [表情包]' : '');
}

const groups = {
  '【他拒绝她】': ['我想喝奶茶 你请我', '不行 我这个月没钱了'],
  '【他答应了】': ['行行行 给你买', '明天带给你'],
  '【撒娇】': ['我今天好累啊', '我不想上课', '你都不理我'],
  '【淘气】': ['我最喜欢的颜色是蓝色', '你知道我昨天干嘛了吗', '我其实有点喜欢你'],
  '【她犯小错】': ['我迟到了 对不起', '我把你那个杯子打碎了'],
  '【女生日常】': ['我剪头发了', '我在看剧', '外面好晒']
};

for (const [label, list] of Object.entries(groups)) {
  console.log('\n' + '='.repeat(50));
  console.log(label);
  console.log('='.repeat(50));
  let hist = [];
  for (const q of list) {
    const a = await reply(hist, q);
    console.log('【他】' + q);
    console.log('【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}
