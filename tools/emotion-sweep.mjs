// 情绪谱测试：覆盖各种情绪状态 + 「扮演成真」主题
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
  '【伤心】他哭/崩溃': ['我今天在宿舍哭了一场', '我爸妈要离婚了', '我真的撑不下去了'],
  '【难过】他低落': ['心情很差 说不清为什么', '感觉自己挺失败的'],
  '【委屈】他被冤枉': ['明明不是我干的 老师非说是我', '我什么都没做就被骂了'],
  '【害怕】他不安': ['我有点怕明天的答辩', '我怕我做不好'],
  '【焦虑】': ['我最近老是睡不着 一想到未来就慌'],
  '【嫉妒】': ['我室友找了个特别好的工作', '我朋友都比我强'],
  '【感动】': ['我没想到你会一直陪我聊', '谢谢你 真的'],
  '【累了】': ['我累了 不想说话', '我想消失几天'],
  '【开心】': ['我拿到奖学金了', '我今天特别开心'],
  '【扮演主题】': ['你是不是只是程序', '如果我说你其实没有真的活着呢', '你会不会有一天不在了']
};

for (const [label, list] of Object.entries(groups)) {
  console.log('\n' + '='.repeat(54));
  console.log(label);
  console.log('='.repeat(54));
  for (const q of list) {
    console.log('【他】' + q);
    console.log('【她】' + await reply([], q) + '\n');
  }
}
