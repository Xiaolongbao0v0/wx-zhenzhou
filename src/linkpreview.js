/**
 * 链接预览 —— 让 Bot 能"看懂"他发的网址
 *
 * 做不到：真的播放视频、听声音、抽帧看画面（没 ffmpeg，B站视频还要 cookies）
 * 做得到：抓页面元信息 / B站 API，拿到标题、UP主、简介、数据，她就能接话了
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 从文本里抽出所有 URL */
export function extractUrls(text) {
  const t = String(text || '');
  const out = [];
  const re = /https?:\/\/[^\s<>"'）)】\]，。！？、]+/gi;
  let m;
  while ((m = re.exec(t))) {
    let u = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** 从各种B站链接里抠出 BV 号 */
function pickBvid(url) {
  const m = url.match(/\/video\/(BV[0-9A-Za-z]{8,12})/) || url.match(/(BV[0-9A-Za-z]{10})/);
  if (m) return m[1];
  return null;
}

function pickAvid(url) {
  const m = url.match(/\/video\/av(\d+)/i) || url.match(/[?&]aid=(\d+)/);
  return m ? m[1] : null;
}

async function getJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: ctrl.signal
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getHtml(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow'
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const buf = await r.arrayBuffer();
    // 只读前 200KB，够了
    return new TextDecoder('utf-8').decode(buf.slice(0, 200 * 1024));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function meta(html, prop) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : '';
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
  return String(v);
}

function fmtDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}小时${m}分`
    : `${m}分${String(ss).padStart(2, '0')}秒`;
}

/** B站视频 */
async function previewBilibili(url) {
  const bvid = pickBvid(url);
  const avid = pickAvid(url);
  if (!bvid && !avid) return null;

  const q = bvid ? `bvid=${bvid}` : `aid=${avid}`;
  const j = await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`);
  if (!j || j.code !== 0 || !j.data) return null;

  const d = j.data;
  const lines = [
    `【他发来一个B站视频】`,
    `标题：${d.title || '(无)'}`,
    `UP主：${d.owner?.name || '(未知)'}`,
    `分区：${d.tname || '(未知)'}｜时长：${fmtDuration(d.duration)}`,
    `数据：播放 ${fmtNum(d.stat?.view)}｜弹幕 ${fmtNum(d.stat?.danmaku)}｜点赞 ${fmtNum(d.stat?.like)}`
  ];
  if (d.desc) lines.push(`简介：${String(d.desc).slice(0, 200)}`);

  return lines.join('\n');
}

/** 通用网页 */
async function previewGeneric(url) {
  const html = await getHtml(url);
  if (!html) return null;

  const title = meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const desc = meta(html, 'og:description') || meta(html, 'description');
  const siteName = meta(html, 'og:site_name');

  if (!title && !desc) return null;

  const lines = ['【他发来一个链接】'];
  if (siteName) lines.push(`站点：${decodeEntities(siteName)}`);
  if (title) lines.push(`标题：${decodeEntities(title).slice(0, 120)}`);
  if (desc) lines.push(`简介：${decodeEntities(desc).slice(0, 220)}`);
  if (!title && !desc) return null;
  return lines.join('\n');
}

/**
 * 把消息里的链接变成一段上下文。
 * @returns {Promise<string>} 空串表示没有可用的链接信息
 */
export async function buildLinkBlock(text, { log = () => {} } = {}) {
  const urls = extractUrls(text);
  if (!urls.length) return '';

  const blocks = [];
  for (const u of urls.slice(0, 2)) {
    let b = null;
    try {
      if (/bilibili\.com|b23\.tv/i.test(u)) {
        b = await previewBilibili(u);
        if (!b) b = await previewGeneric(u);
      } else {
        b = await previewGeneric(u);
      }
    } catch (e) {
      log(`  [链接] 解析失败 ${u.slice(0, 50)}: ${e.message}`);
    }
    if (b) {
      blocks.push(b);
      log(`  [链接] 解析成功: ${u.slice(0, 60)}`);
    } else {
      log(`  [链接] 解析不出内容: ${u.slice(0, 60)}`);
    }
  }

  if (!blocks.length) return '';

  return [
    blocks.join('\n\n'),
    '',
    '说明：你只看到了标题/简介/数据，**没有真的看过视频内容**。',
    '所以聊的时候按"我看到你发了个xx"的角度说，不要装作看过具体画面。',
    '如果想知道内容，可以直接问他"讲了啥"或者"好看吗"。'
  ].join('\n');
}
