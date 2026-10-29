#!/usr/bin/env node
/**
 * 把聊天归档（data/archive/chat-YYYY-MM-DD.jsonl）转成知识库用的 .md。
 *
 * 为什么要有这一步：
 *   vault.js 的检索是 BM25 + 中文 bigram，只认 .md 小标题分块。
 *   聊天归档是 JSONL，直接丢进去检索不到；转成「一天一篇、按话题分段」的
 *   markdown 之后，"我们以前聊过什么"才有东西可捞。
 *
 * 分段的规则很土但够用：相邻两条间隔超过 SESSION_GAP_MS 就算换了个话题，
 * 小标题取那一段里他的第一句话（截断），因为检索时标题是加权的。
 *
 * 用法：
 *   node tools/archive-to-vault.mjs [归档目录] [输出目录]
 * 默认：data/archive → data/vault
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'data', 'archive');
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'data', 'vault');

/** 两条消息间隔多久算换话题 */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** 小标题最长多少字（太长会把整段压扁） */
const HEAD_MAX = 16;

function hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clip(s, n = HEAD_MAX) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

async function main() {
  let files = [];
  try {
    files = (await readdir(SRC)).filter((f) => /^chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch (e) {
    console.error(`读不到归档目录 ${SRC}: ${e.message}`);
    process.exit(1);
  }
  if (!files.length) {
    console.error(`归档目录里没有 chat-*.jsonl：${SRC}`);
    process.exit(1);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let totalTurns = 0;
  let totalSections = 0;

  for (const f of files) {
    const day = f.replace(/^chat-|\.jsonl$/g, '');
    const raw = await readFile(path.join(SRC, f), 'utf8');
    const turns = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (!j?.question) continue;
        turns.push({
          at: j.at || '',
          q: String(j.question).trim(),
          a: String(j.answer || '').trim()
        });
      } catch {
        /* 坏行跳过 */
      }
    }
    if (!turns.length) continue;

    // 按时间间隔切段
    const sections = [];
    let cur = null;
    for (const t of turns) {
      const ts = Date.parse(t.at);
      if (!cur || (Number.isFinite(ts) && ts - cur.lastTs > SESSION_GAP_MS)) {
        cur = { start: t.at, lastTs: ts, turns: [] };
        sections.push(cur);
      }
      cur.turns.push(t);
      if (Number.isFinite(ts)) cur.lastTs = ts;
    }

    const md = [`# ${day}`, ''];
    for (const s of sections) {
      const head = clip(s.turns[0].q) || '聊天';
      md.push(`## ${hhmm(s.start)} ${head}`);
      md.push('');
      for (const t of s.turns) {
        md.push(`他：${t.q.replace(/\n+/g, ' / ')}`);
        if (t.a) md.push(`你：${t.a.replace(/\n+/g, ' / ')}`);
      }
      md.push('');
    }

    await writeFile(path.join(OUT, `${day}.md`), md.join('\n'), 'utf8');
    totalTurns += turns.length;
    totalSections += sections.length;
    console.log(`${day}.md  ${turns.length} 轮 / ${sections.length} 段`);
  }

  console.log(`\n共 ${files.length} 天、${totalTurns} 轮对话、${totalSections} 个话题段 → ${OUT}`);

  // ── 关于他.md ──
  // 由 profile.js 抽出来的事实拼成一张卡。
  // 为什么放进来：问到"关于我"的时候走的是 profileNotes 这条路（整卡注入，
  // 不靠检索）；存成 md 就跟着知识库一起更新，不用另外维护两份。
  const profileDir = path.join(ROOT, 'data', 'profile');
  let facts = [];
  try {
    const pfiles = (await readdir(profileDir)).filter((f) => f.endsWith('.json'));
    for (const f of pfiles) {
      try {
        const j = JSON.parse(await readFile(path.join(profileDir, f), 'utf8'));
        if (Array.isArray(j?.facts)) facts.push(...j.facts);
      } catch {
        /* 坏档跳过 */
      }
    }
  } catch {
    /* 还没有档案目录，正常 */
  }
  facts = [...new Set(facts.filter((s) => typeof s === 'string' && s.trim()))];
  if (facts.length) {
    const md = ['# 关于他', '', '## 他自己说过的', '', ...facts.map((f) => `- ${f}`), ''];
    await writeFile(path.join(OUT, '关于他.md'), md.join('\n'), 'utf8');
    console.log(`关于他.md  ${facts.length} 条事实`);
  } else {
    console.log('（还没有档案，跳过 关于他.md）');
  }
}

main().catch((e) => {
  console.error('转换失败:', e);
  process.exit(1);
});
