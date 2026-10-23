// 平衡测试：加了撒娇之后，损友/生气/共情还在不在
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
  '【损友还在吗】': ['我今天一打五赢了', '我今天特别帅', '我熬夜熬到三点'],
  '【共情还在吗】': ['我今天特别难受', '我跟我爸吵架了'],
  '【生气还在吗】': ['昨天约好六点我临时没去，也没跟你说一声'],
  '【正常闲聊】': ['在干嘛', '今天好无聊', '晚安'],
  '【她会不会太甜】': ['我给你买了个礼物', '你真好']
};

for (const [label, list] of Object.entries(groups)) {
  console.log('\n' + '='.repeat(48));
  console.log(label);
  console.log('='.repeat(48));
  for (const q of list) {
    console.log('【他】' + q);
    console.log('【她】' + await reply([], q) + '\n');
  }
}
