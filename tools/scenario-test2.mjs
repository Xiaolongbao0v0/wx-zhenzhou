// 批量对话测试 2：更宽的场景覆盖
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();

const groups = {
  '【他说自己倒霉】': ['今天作业好多 写不完', '我挂科了', '我手机被偷了', '我被辅导员叫去谈话了'],
  '【他自己作死】': ['我熬到三点了', '我一天没吃饭', '我明知道要考试还打了一晚上游戏'],
  '【他问你事】': ['你说我该不该报这个社团', '这题怎么做啊', '你觉得我这人怎么样'],
  '【他示好】': ['我给你买了杯奶茶', '我今天特别想你', '你在我就安心'],
  '【他烦你】': ['你好烦啊', '你能不能别说了', '滚'],
  '【日常】': ['刚下课', '好饿', '外面下雨了', '我在地铁上']
};

for (const [label, list] of Object.entries(groups)) {
  console.log('\n' + '='.repeat(52));
  console.log(label);
  console.log('='.repeat(52));
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
    console.log('【她】' + b.join('  /  '));
    if (ex.stickers.length) console.log('      [表情包: ' + ex.stickers.join(',') + ']');
  }
}
