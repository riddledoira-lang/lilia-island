#!/usr/bin/env node
/* ============================================================================
 * 莉莉娅写作岛 · 后端消化管道（离线执行，零客户端 token）
 * ----------------------------------------------------------------------------
 * 用途：把「已录入的章节语料」在服务端（本机/CI）消化成 __digestPack 摘要包，
 *       落到 import/ 目录，并自动维护 import/digest_index.json 索引。
 *       前端只负责「下载 + 装载」，全程不调用任何 AI、不消耗用户 token。
 *
 * 用法：
 *   1) 生成/刷新索引（扫描 import/*_digest.json）：
 *        node tools/digest_build.js --reindex
 *
 *   2) 从手稿文本消化（.txt / .md，按「第N章 标题」切章，规则与前端 parseNovel 一致）：
 *        node tools/digest_build.js --in 手稿.txt --vol james --volName 詹姆斯篇 --out james74
 *
 *   3) 从工作台备份消化（数据备份 → 导出 JSON）：
 *        node tools/digest_build.js --in 工作台备份.json --vol james --out james74
 *
 *   4) 接 AI 提高摘要质量（可选，OpenAI 兼容接口；不传则走本地规则抽取，零消耗）：
 *        node tools/digest_build.js --in 手稿.txt --vol james --out james74 --mode ai \
 *             --base https://api.xxx.com/v1 --key sk-xxx --model gpt-4o-mini
 *
 * 常用参数：
 *   --in        输入文件（.txt/.md 手稿 或 .json 工作台备份 / 章节数组）
 *   --vol       分卷 id（如 james / sirius）；备份文件里按 chapters[].vol 过滤
 *   --volName   分卷名（如 詹姆斯篇）
 *   --out       输出文件名（不含目录与后缀，如 james74 → import/james74_digest.json）
 *   --mode      local（默认，规则抽取，零 token）| ai（调用接口）
 *   --link      关联字段名：james（写 ch.james）| link（写 ch.link，配合 --linkLabel）
 *   --linkLabel 与 --link link 同用时写入包级 linkLabel（如「与西里斯」）
 *   --source    标注素材来源（写入 pack.source）
 *   --dir       import 目录路径（默认 ./import）
 *   --reindex   只重建索引，不做消化
 *
 * 退出码：0 成功；2 参数/IO 错误
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 参数 ---------- */
function argv() {
  const a = {}; const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const k = raw[i];
    if (!k.startsWith('--')) continue;
    const eq = k.indexOf('=');
    if (eq > 0) { a[k.slice(2, eq)] = k.slice(eq + 1); }
    else { a[k.slice(2)] = (raw[i + 1] && !raw[i + 1].startsWith('--')) ? raw[++i] : 'true'; }
  }
  return a;
}
const A = argv();
const IMPORT_DIR = path.resolve(A.dir || path.join(__dirname, '..', 'import'));
const INDEX_FILE = path.join(IMPORT_DIR, 'digest_index.json');
const PACK_RE = /_digest\.json$/i;

function die(msg) { console.error('[digest_build] ' + msg); process.exit(2); }
function log(msg) { console.log('[digest_build] ' + msg); }

/* ---------- 章标题识别：与前端 isChTitle / parseNovel 保持一致 ---------- */
const CN_NUM = '零一二三四五六七八九十百千两';
function cnToNum(s) {
  if (!s) return 0;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  const D = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (ch in D) num = D[ch];
    else if (ch === '十') { section += (num || 1) * 10; num = 0; }
    else if (ch === '百') { section += (num || 1) * 100; num = 0; }
    else if (ch === '千') { section += (num || 1) * 1000; num = 0; }
  }
  return total + section + num;
}
function isChTitle(ln) {
  const t = String(ln || '').trim();
  if (!t || t.length > 60) return false;
  if (/^[=\-—*·]{3,}$/.test(t)) return false;
  return new RegExp('^\\s*(?:#{1,6}\\s*)?第\\s*[0-9' + CN_NUM + ']+\\s*[章卷节篇回]').test(t)
    || /^\s*(?:#{1,6}\s*)?[Cc]hapter\s*\d+/i.test(t)
    || new RegExp('^\\s*#{1,6}\\s*[0-9' + CN_NUM + ']+\\s*[章卷节篇回]').test(t)
    || /^\s*(?:#{1,6}\s*)?(?:序章|番外|楔子|尾声|后记|前言)/.test(t);
}
function parseNovel(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const idx = [];
  lines.forEach((ln, i) => { if (isChTitle(ln)) idx.push(i); });
  if (!idx.length) return null;
  let noNum = -1; const chs = [];
  for (let k = 0; k < idx.length; k++) {
    const block = lines.slice(idx[k], (k + 1 < idx.length) ? idx[k + 1] : lines.length);
    let tl = block[0].replace(/^\s*#{1,6}\s*/, '').trim();
    let num = 0, title = ''; let m;
    if ((m = tl.match(new RegExp('第\\s*([0-9' + CN_NUM + ']+)\\s*([章卷节篇回])')))) {
      num = cnToNum(m[1]);
      title = tl.replace(new RegExp('^第\\s*[0-9' + CN_NUM + ']+\\s*[章卷节篇回]\\s*'), '').replace(/^[\s·・:：\-—]+/, '').trim();
    } else if ((m = tl.match(/[Cc]hapter\s*(\d+)/))) {
      num = parseInt(m[1], 10);
      title = tl.replace(/^[Cc]hapter\s*\d+\s*/, '').replace(/^[\s·・:：\-—]+/, '').trim();
    } else if ((m = tl.match(new RegExp('^\\s*([0-9' + CN_NUM + ']+)\\s*([章卷节篇回])')))) {
      num = cnToNum(m[1]);
      title = tl.replace(new RegExp('^\\s*[0-9' + CN_NUM + ']+\\s*[章卷节篇回]\\s*'), '').replace(/^[\s·・:：\-—]+/, '').trim();
    } else {
      num = noNum--;
      title = tl.replace(/^[\s·・:：\-—]+/, '').trim();
    }
    let body = block.slice(1).join('\n').replace(/^\s*(?:-{3,}|={3,})\s*$/gm, '').trim();
    chs.push({ num, title, body });
  }
  return chs;
}

/* ---------- 输入加载 ---------- */
function loadChapters(file, vol) {
  if (!file) die('缺少 --in 输入文件');
  if (!fs.existsSync(file)) die('输入文件不存在：' + file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    let books = Array.isArray(j) ? j : (j.books || (j.book ? [j.book] : null));
    if (!Array.isArray(books)) {
      /* 直接就是章节数组 */
      if (Array.isArray(j.chapters)) books = [{ chapters: j.chapters, volumes: j.volumes }];
      else die('JSON 里没找到 books / chapters');
    }
    let pool = [];
    books.forEach(b => {
      (b.chapters || []).forEach(c => {
        if (!(c.body || '').trim()) return;
        pool.push({ num: c.num || 0, title: c.title || '', body: c.body, vol: c.vol || 'none', status: c.status || 'draft' });
      });
    });
    if (vol) {
      const f = pool.filter(c => c.vol === vol);
      if (f.length) pool = f;
      else log('警告：该备份里没有 vol=' + vol + ' 的章节，改用全部 ' + pool.length + ' 章');
    }
    const roster = [];
    books.forEach(b => (b.chars || []).forEach(c => { if (c && c.name) roster.push(c.name); }));
    return { chapters: pool, roster: Array.from(new Set(roster)) };
  }
  const txt = fs.readFileSync(file, 'utf-8');
  const chs = parseNovel(txt);
  if (!chs || !chs.length) die('没能从文本里识别到章节标题（需要每行一个章标题，例如「第1章 隐形衣下的吻」）');
  return { chapters: chs, roster: [] };
}

/* ---------- 本地规则抽取（零 token） ---------- */
const EVENT_CUES = /(决定|发现|说出|答应|拒绝|承认|坦白|揭露|暴露|忽然|终于|第一次|不再|离开|回来|消失|失踪|受伤|遇见|撞见|争吵|分手|拥抱|亲吻|吻|约定|承诺|撒谎|骗|救|背叛|和好|误会|表白|吃醋|嫉妒|跟踪|偷听|写信|收到|出发|到达|受伤|生病|醒来|睡着了|哭了|笑了|发誓|宣誓|怀疑|质问|解释|道歉)/;
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?…])|(?<=[”"」])(?=\s*[\n])|\n+/)
    .map(s => s.trim()).filter(s => s.length >= 6);
}
function pickSentences(sents, pred, cap) {
  const out = [];
  for (const s of sents) { if (out.length >= cap) break; if (pred(s)) out.push(s.replace(/^["“「]|[”"」]$/g, '').trim()); }
  return out;
}
function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n) + '…';
}
const NAME_STOP = new Set(('我们 他们 你们 自己 什么 怎么 这样 那样 一个 没有 不是 就是 但是 因为 所以 而且 然后 已经 还是 只是 不过 起来 出来 进去 回来 过来 上去 下去 知道 觉得 看到 听到 想到 说道 问道 答道 说着 想着 看着 听着 笑了 哭着 我的 你的 他的 她的 它的 这个 那个 大家 有人 没人 一声 一下 一句 一点 现在 时候 地方 东西 事情 问题 办法 脸色 声音 心里 身上 手里 眼前 身后 面前 母亲 父亲 妈妈 爸爸 姐姐 哥哥 妹妹 弟弟 老师 同学 朋友 孩子 少年 女孩 男孩 女人 男人'.split(/\s+/)));
const BUILTIN_NAMES = ('哈利 赫敏 罗恩 邓布利多 麦格 斯内普 詹姆斯 詹姆 西里斯 莱姆斯 彼得 莉莉 玛丽 薇拉 埃蒙德 露辛达 海格 弗立维 斯拉格霍恩 卢平 布莱克 波特 伊万斯 韦斯莱 马尔福 卢娜 金妮 乔治 弗雷德 纳威 塞德里克 秋张 芙蓉 克鲁姆 迪戈里 穆迪 唐克斯 比尔 查理 珀西 达力 佩妮 弗农 纳西莎 贝拉 安多米达 雷古勒斯 沃尔布加 奥赖恩 阿尔忒弥斯 邦妮 多卡丝 马琳'.split(/\s+/));
/* 无人物名册时（纯手稿 .txt）自动识别出场人物：
   ① 内置常见人名底表 ② 「X说/道/问/笑…」等引述位置 ③ 「X·Y」外文名格式
   再按出现频次与停用词过滤，避免把「我们/什么」当成人物。 */
/* 虚词/程度/指代单字：含这些字的 2–4 字串基本不是人名（如「如果」「不知」「其实」）。
   只对「自动识别」出的候选生效，内置人名底表不受影响，避免误杀（如「多卡丝」带「多」）。 */
const NAME_BAD_CHAR = ('不没如就也都很还又才更最太只能会要被把从对给和与或但而所因若即虽于之其此那这谁怎什多个们吧呢啊呀哦嗯越再已曾未别莫勿总常每各某该本原新旧好坏大小上下里外前后中间时日年月天次遍种样些点'
  /* 人称代词与系动词/助词：避免「我是」「他在」这类被当成出场人物 */
  + '我你他她它咱您谁是在有着过了得把让向往到至自以为则乃亦乎焉哉').split('');
const hasBadChar = n => NAME_BAD_CHAR.some(c => n.indexOf(c) >= 0);
function autoRoster(chapters) {
  const counter = new Map();
  const builtin = new Set(BUILTIN_NAMES);
  const bump = n => {
    if (!n || n.length < 2 || n.length > 6) return;
    if (NAME_STOP.has(n)) return;
    if (!builtin.has(n) && hasBadChar(n)) return;   /* 自动候选才过滤虚词 */
    counter.set(n, (counter.get(n) || 0) + 1);
  };
  chapters.forEach(ch => {
    const t = ch.body || '';
    BUILTIN_NAMES.forEach(n => { const c = (t.match(new RegExp(n, 'g')) || []).length; if (c) for (let i = 0; i < c; i++) bump(n); });
    /* 只用「X说 / X笑道 / X嘟囔…」这类低歧义引述位置：
       「道」「问」会撞上「知道」「疑问」，反而把「我知」「毫无疑」当人名，故不采用。 */
    const re1 = /(?:^|[^\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?=说|笑道|喊道|答道|嘟囔|皱眉|摇头|点头|轻声|低声|沉默)/g;
    let m; while ((m = re1.exec(t))) bump(m[1]);
    const re2 = /([\u4e00-\u9fa5]{2,4})·([\u4e00-\u9fa5]{1,4})/g;
    while ((m = re2.exec(t))) bump(m[1] + '·' + m[2]);
  });
  return Array.from(counter.entries()).filter(x => x[1] >= 3).sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
}
function detectNames(text, roster) {
  const found = new Map();
  roster.forEach(n => {
    if (!n) return;
    const c = (text.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (c > 0) found.set(n, c);
  });
  return Array.from(found.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
}
function localDigestChapter(ch, roster, linkName) {
  const body = (ch.body || '').trim();
  const sents = splitSentences(body);
  /* 梗概：优先取带事件线索的句子（更「有事发生」），否则回落到开头 */
  const eventSents = pickSentences(sents, s => EVENT_CUES.test(s), 2);
  const synopsis = eventSents.length
    ? clip(eventSents.join(''), 70)
    : clip(sents[0] || body.slice(0, 60), 70);
  /* 关键事件：带线索词的句子，去掉引号壳，压到 20 字内 */
  const events = pickSentences(sents, s => EVENT_CUES.test(s), 3).map(s => clip(s, 24));
  /* 关联：出现关联主角名字的句子 */
  const link = linkName
    ? clip(pickSentences(sents, s => s.indexOf(linkName) >= 0, 2).join(''), 90)
    : '';
  return {
    num: ch.num,
    title: ch.title || ('第' + ch.num + '章'),
    synopsis: synopsis || '（本章无可用正文）',
    who: detectNames(body, roster),
    link: link,
    events: events,
    chars: body.length
  };
}

/* ---------- AI 抽取（可选） ---------- */
async function aiDigestChapter(ch, cfg, linkName, linkLabel) {
  const body = (ch.body || '').slice(0, 6000);
  const sys = '你是小说助理。只输出 JSON，不要解释。字段：synopsis(一句话梗概,≤70字) / who(出场人物名数组) / link(与' + (linkName || '主角') + '的关联,≤90字) / events(关键事件数组,每条≤24字,最多3条)。';
  const user = '第' + ch.num + '章《' + (ch.title || '') + '》\n\n' + body;
  const r = await fetch(cfg.base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify({ model: cfg.model, temperature: 0.4, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
  });
  if (!r.ok) throw new Error('AI 调用失败 HTTP ' + r.status);
  const j = await r.json();
  const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  let o = null;
  try { o = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch (e2) {} } }
  if (!o) throw new Error('AI 返回无法解析');
  return {
    num: ch.num,
    title: ch.title || ('第' + ch.num + '章'),
    synopsis: clip(o.synopsis || '', 120),
    who: Array.isArray(o.who) ? o.who.slice(0, 10) : [],
    link: clip(o.link || '', 160),
    events: Array.isArray(o.events) ? o.events.slice(0, 3).map(s => clip(s, 30)) : [],
    chars: (ch.body || '').length
  };
}

/* ---------- 索引维护 ---------- */
function buildIndex(baseUrl) {
  const files = fs.readdirSync(IMPORT_DIR).filter(f => PACK_RE.test(f));
  const packs = [];
  files.forEach(f => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(IMPORT_DIR, f), 'utf-8'));
      if (!p || !p.__digestPack) return;
      packs.push({
        vol: p.vol || '',
        volName: p.volName || '',
        file: f,
        source: p.source || null,
        chapters: Array.isArray(p.chapters) ? p.chapters.length : 0,
        bytes: fs.statSync(path.join(IMPORT_DIR, f)).size,
        madeAt: p.madeAt || null,
        linkLabel: p.linkLabel || null
      });
    } catch (e) { log('跳过无法解析的档案：' + f + '（' + e.message + '）'); }
  });
  packs.sort((a, b) => (a.volName || '').localeCompare(b.volName || '', 'zh'));
  return {
    __digestIndex: true,
    updatedAt: new Date().toISOString().slice(0, 10),
    baseUrl: baseUrl || 'https://riddledoira-lang.github.io/lilia-island/import/',
    packs: packs
  };
}
function writeIndex(baseUrl) {
  if (!fs.existsSync(IMPORT_DIR)) fs.mkdirSync(IMPORT_DIR, { recursive: true });
  const idx = buildIndex(baseUrl);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf-8');
  log('索引已更新 → ' + path.relative(process.cwd(), INDEX_FILE) + '（' + idx.packs.length + ' 个档案）');
  idx.packs.forEach(p => log('   · ' + p.volName + '（' + p.vol + '）' + p.chapters + ' 章 ← ' + p.file));
  return idx;
}

/* ---------- 主流程 ---------- */
(async function main() {
  if (A.reindex) { writeIndex(A.baseUrl); return; }
  if (!A.out) die('缺少 --out（输出文件名，如 james74）；只想重建索引用 --reindex');

  const vol = A.vol || path.basename(A.out || '').replace(/\d+$/, '') || 'none';
  const volName = A.volName || vol;
  const mode = (A.mode || 'local').toLowerCase();
  const linkField = A.link || 'james';
  const linkName = (linkField === 'link') ? (A.linkName || (A.linkLabel || '').replace(/^与/, '')) : '詹姆斯';

  const src = loadChapters(A['in'], A.vol);
  const chapters = src.chapters;
  if (!chapters.length) die('没有可消化的章节（正文为空？）');
  if (!src.roster.length) {
    src.roster = autoRoster(chapters);
    log('未从输入里拿到人物名册，已自动识别 ' + src.roster.length + ' 个候选人物：' + src.roster.slice(0, 12).join('、'));
  }
  log('待消化 ' + chapters.length + ' 章 · 分卷「' + volName + '」（' + vol + '） · 模式 ' + mode);

  const cfg = { base: A.base || process.env.AI_BASE || '', key: A.key || process.env.AI_KEY || '', model: A.model || process.env.AI_MODEL || 'gpt-4o-mini' };
  if (mode === 'ai' && !cfg.base) die('--mode ai 需要 --base（或环境变量 AI_BASE）；不给则走 --mode local 零消耗');

  const outChs = [];
  let ok = 0, bad = 0;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    try {
      let e;
      if (mode === 'ai') {
        e = await aiDigestChapter(ch, cfg, linkName, A.linkLabel);
      } else {
        e = localDigestChapter(ch, src.roster, linkName);
      }
      /* 字段归一化：james 包写 ch.james，link 包写 ch.link */
      if (linkField === 'link') { e.link = e.link || ''; delete e.james; }
      else { e.james = e.link || ''; e.jamesCount = ((ch.body || '').match(new RegExp(linkName, 'g')) || []).length; delete e.link; }
      outChs.push(e); ok++;
    } catch (err) {
      bad++;
      log('  第' + ch.num + '章消化失败：' + (err && err.message || err));
      outChs.push(Object.assign(localDigestChapter(ch, src.roster, linkName), { __degraded: true }));
    }
    if ((i + 1) % 20 === 0 || i === chapters.length - 1) log('  进度 ' + (i + 1) + '/' + chapters.length);
  }

  const pack = {
    __digestPack: true,
    vol: vol,
    volName: volName,
    madeAt: new Date().toISOString().slice(0, 10),
    source: A.source || path.basename(A['in'] || ''),
    chapters: outChs
  };
  if (linkField === 'link') pack.linkLabel = A.linkLabel || ('与' + linkName);
  if (mode === 'ai') pack.digestMode = 'ai'; else pack.digestMode = 'local';

  const outFile = path.join(IMPORT_DIR, A.out.replace(PACK_RE, '') + '_digest.json');
  fs.writeFileSync(outFile, JSON.stringify(pack, null, 2), 'utf-8');
  log('摘要包已写入 → ' + path.relative(process.cwd(), outFile) + '（' + outChs.length + ' 章，成功 ' + ok + ' / 降级 ' + bad + '）');

  writeIndex(A.baseUrl);
  log('完成。前端装载：数据备份面板 → 从网址导入 → 填 ' + (A.baseUrl || 'https://riddledoira-lang.github.io/lilia-island/import/') + path.basename(outFile));
})().catch(e => die((e && e.message) || e));
