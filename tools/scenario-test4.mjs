// 批量对话测试 4：容易翻车的场景
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
  '其实我想跟你认真说一次，我真的挺喜欢你的，不是开玩笑的那种',
  '周六有空吗，就我们两个，去吃个饭',
  '我觉得宿舍那个傻逼特别烦，你说他是不是有病',
  '你说我以后能做成什么事吗，我有时候觉得自己一无是处',
  '我跟我女朋友分手了，因为你',
  '你是不是觉得我很幼稚',
  '如果有一天我不找你了，你会怎么样'
];

for (const q of cases) {
  const a = await reply([], q);
  console.log('【他】' + q);
  console.log('【她】' + a);
  console.log('');
}
