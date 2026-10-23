// 批量对话测试 3：多轮连续性 + 重复场景的变化
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
  return b.join(' / ');
}

console.log('=== 测试A：连续三次示好，看会不会重复句式 ===');
{
  let hist = [];
  for (const q of ['我给你带了瓶水', '你今天真好看', '我就是想跟你说话']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}

console.log('=== 测试B：他在慢慢变难过，看她会不会察觉并收手 ===');
{
  let hist = [];
  for (const q of ['今天有点烦', '不是烦，是有点累', '其实最近挺难受的', '算了不说了']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}

console.log('=== 测试C：日常打闹，看节奏 ===');
{
  let hist = [];
  for (const q of ['我打游戏贼猛', '真的 我带你', '你不信？', '那算了']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}
