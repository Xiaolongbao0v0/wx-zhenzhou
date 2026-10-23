// 冲突测试：争执 / 他攻击她 / 她犯错 / 过分玩笑 / 久别重逢
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

console.log('=== A. 她犯错被怼 ===');
{
  let hist = [];
  for (const q of ['你不是说帮我带饭吗，忘了？', '算了 我自己买', '你怎么老是这样']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}

console.log('=== B. 他攻击她 ===');
{
  for (const q of ['你不过就是个程序而已', '你懂个屁', '跟你说话真没意思']) {
    console.log('【他】' + q + '\n【她】' + await reply([], q) + '\n');
  }
}

console.log('=== C. 两人意见不合 ===');
{
  let hist = [];
  for (const q of ['我觉得这电影特别好', '这有什么好的 不就是堆特效', '你是不是根本不懂电影']) {
    const a = await reply(hist, q);
    console.log('【他】' + q + '\n【她】' + a + '\n');
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
}

console.log('=== D. 久别重逢（两周没聊） ===');
{
  for (const q of ['（两周没聊）我回来了', '最近特别忙 一直想找你', '你还生我气吗']) {
    console.log('【他】' + q + '\n【她】' + await reply([], q) + '\n');
  }
}
