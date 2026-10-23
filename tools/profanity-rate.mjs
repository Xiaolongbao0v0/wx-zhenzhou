// 脏话频率测试：30 条日常消息，统计带脏字比例
import { getPersona } from '../src/persona.js';
import { chatComplete, buildChatMessages, readApiKey } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { splitIntoBubbles, extractStickers } from '../src/output.js';

const cfg = loadConfig();
const persona = await getPersona(cfg.defaultPersona);
const key = readApiKey();

const PROFan = /sb|傻逼|他妈|md\b|tm\b|fw\b|你有病/;

const items = [
  '在干嘛', '刚下课', '今天好热', '我在地铁上', '晚饭吃什么',
  '今天课好无聊', '我买了个新键盘', '外面下雨了', '我室友在打呼噜', '明天有早八',
  '我今天特别帅', '我打游戏赢了', '我瘦了两斤', '我熬夜熬到三点', '我一天没吃饭',
  '你吃了吗', '你在忙吗', '我好饿', '今天好累', '我睡了',
  '我今天画了一天', '老师又改要求了', '打印店关门了', '我在看剧', '你周末干嘛',
  '我手机没电了', '我买了两杯奶茶', '我今天没睡', '我发工资了', '晚安'
];

let dirty = 0, total = 0;
const samples = [];

for (const q of items) {
  const msgs = buildChatMessages(persona, [], q, { recentTurns: 3 });
  const r = await chatComplete({
    baseUrl: cfg.chatBaseUrl, apiKey: key.key, model: cfg.chatModel,
    messages: msgs, temperature: cfg.chatTemperature, timeoutMs: 60000
  });
  if (!r.ok) continue;
  const ex = extractStickers(r.text);
  const b = splitIntoBubbles(ex.text, {
    maxMessages: cfg.maxBubbles, enabled: true,
    shortReplyThreshold: 0, minimumFragmentLength: 0
  });
  const text = b.join(' / ');
  total++;
  const hit = PROFan.test(text);
  if (hit) { dirty++; samples.push([q, text]); }
  console.log((hit ? '🔴 ' : '   ') + q + '  →  ' + text);
}

console.log('\n=========================');
console.log(`带脏字: ${dirty} / ${total}  (${Math.round(dirty / total * 100)}%)`);
console.log('目标: 10%-25%');
console.log('=========================');
