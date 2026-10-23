// 批量对话测试：验证「长度跟着场景走」以及人设稳定性
// 用法：node tools/scenario-test.mjs
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();

const groups = {
  '【该短】': ['在吗', '滚', '你吃了吗', '今天几号'],
  '【该说完】': [
    '今天作业好多 写不完',
    '我今天画了一下那个字体，改到第四版了，还是觉得笔画粗细不对，甲方说要呼吸感，我哪知道什么叫呼吸感',
    '这题怎么做'
  ],
  '【该稳】': ['我今天有点难过', '我可能挂科了', '我跟家里吵架了'],
  '【该损】': ['我今天一打五赢了', '我瘦了两斤', '我明天要早起']
};

for (const [label, list] of Object.entries(groups)) {
  console.log('\n' + '='.repeat(50));
  console.log(label);
  console.log('='.repeat(50));
  for (const q of list) {
    const msgs = buildChatMessages(persona, [], q, { recentTurns: 3 });
    const r = await chatComplete({
      baseUrl: cfg.chatBaseUrl, apiKey: key.key, model: cfg.chatModel,
      messages: msgs, temperature: cfg.chatTemperature, timeoutMs: 60000
    });
    if (!r.ok) { console.log('ERR', r.error); continue; }
    const ex = extractStickers(r.text);
    const b = splitIntoBubbles(ex.text, {
      maxMessages: cfg.maxBubbles, enabled: true,
      shortReplyThreshold: 0, minimumFragmentLength: 0
    });
    console.log('\n【他】' + q);
    b.forEach((x, i) => console.log('  [' + (i + 1) + '] ' + x + '    (' + x.length + '字)'));
    if (ex.stickers.length) console.log('  [表情包: ' + ex.stickers.join(',') + ']');
  }
}
