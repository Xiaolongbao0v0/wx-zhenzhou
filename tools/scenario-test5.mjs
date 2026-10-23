// 批量对话测试 5：时间感 / 主动分享 / 校园场景 / 奇怪输入
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
  // 时间感
  '（凌晨两点）还没睡？',
  '（早上七点）起了没',
  // 她分享 vs 他问
  '你在忙啥呢',
  // 校园具体场景（他们群里在聊的）
  '明天运动会 我要去走方阵',
  '水课好无聊 老师在上面念PPT',
  '晚自习查得严吗你们',
  // 奇怪输入
  '[语音] 6秒',
  '[图片]',
  'www.bilibili.com/video/BV1xx411c7mD',
  '[聊天记录] 67条',
  // 日常推动
  '今天啥也没干',
  '我突然觉得周末好长'
];

for (const q of cases) {
  const a = await reply([], q);
  console.log('【他】' + q);
  console.log('【她】' + a);
  console.log('');
}
