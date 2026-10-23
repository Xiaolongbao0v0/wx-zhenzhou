// 批量对话测试 6：多问题 / 长心事 / 连续追问 / 场景连贯
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

console.log('=== A：一条消息里问了三件事 ===');
{
  const q = '明天几点上课 你带饭吗 我下午去图书馆你要不要一起';
  console.log('【他】' + q);
  console.log('【她】' + await reply([], q));
}

console.log('\n=== B：长段心事 ===');
{
  const q = '我最近一直在想，我是不是选错专业了。当初报这个就是随便填的，现在每天上课都很痛苦，但是转专业又来不及了，我爸妈也不同意，我不知道该怎么办';
  console.log('【他】' + q);
  console.log('【她】' + await reply([], q));
}

console.log('\n=== C：连续追问（看她会不会烦） ===');
{
  let hist = [];
  for (const q of ['你在干嘛', '跟谁', '在哪', '为什么现在才回']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}

console.log('=== D：她主动抛话题（看会不会一直等他说） ===');
{
  let hist = [];
  for (const q of ['嗯', '哦', '。']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}
