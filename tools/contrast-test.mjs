// 反差测试：同一段对话里，损 → 撒娇 → 损 → 生气 的切换
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

const scripts = {
  'A. 损 → 撒娇 → 损（一气呵成）': [
    '我今天特别帅',
    '我在喝奶茶 刚买的',
    '我一天喝了三杯',
    '我今天一打五又赢了'
  ],
  'B. 撒娇被拒 → 转损': [
    '我买了两杯奶茶 其中一杯是给你的',
    '算了 我自己喝了',
    '我下次不买了啊',
    '你求我'
  ],
  'C. 撒娇 → 他犯错 → 生气': [
    '我明天要去商场 你想买啥',
    '给你带',
    '对了 我昨天忘了跟你说 我没去那个约'
  ],
  'D. 淘气 → 被识破 → 认账': [
    '你知道我昨天干嘛了吗',
    '其实我去见了个女生',
    '骗你的哈哈哈',
    '你居然真信'
  ]
};

for (const [label, turns] of Object.entries(scripts)) {
  console.log('\n' + '='.repeat(52));
  console.log(label);
  console.log('='.repeat(52));
  let hist = [];
  for (const q of turns) {
    const a = await reply(hist, q);
    console.log('【他】' + q);
    console.log('【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}
