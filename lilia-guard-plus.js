/* ============================================================
 * lilia-guard-plus  ·  v129
 * 判断表里三项高风险的落地：失败留痕 / 人物动态状态 / 生成管线兜底
 *
 * 与另两个模块同一套接入方式：「保存原函数引用 → 覆盖同名全局」，
 * 原函数体一行未动；本文件加载失败时，主程序原有行为完全不变。
 *
 * 覆盖清单：
 *   console.warn / console.error → 旁路监听（原样输出，不吞不改），命中降级信号就记账
 *   chapterVoiceCards            → 追加「人物近期状态·事实」（0 token，确定性推导）
 *   counselCtx                   → 同上，供剧情参谋使用
 *   planBeatCard                 → 失败时用本地最小节拍兜底（不让链路裸奔）
 *   collectPrior                 → 只做只读诊断：近章被截断时记账，不改任何内容
 *
 * 设计底线：
 *   ① 所有改动都是「附加」或「只读观测」，不改变发给模型的既有内容结构；
 *   ② 每一次降级都必须留下可查痕迹 —— 不再出现「你以为它在跑，其实少了环节」；
 *   ③ 任何异常都回退到原函数，绝不比原来更差。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__LILIA_GUARD_PLUS__) { return; }
  window.__LILIA_GUARD_PLUS__ = { ver: 'v129', ok: false };

  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function arr(k) { try { var v = load(k, []); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function H(s) {
    var h = 5381; s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
    return h.toString(36);
  }

  /* ============================================================
   * A. 降级留痕（本次最重要的一条）
   *
   * 现状：整条生成链上有七八处「非致命，直接跳过」，全都只写 console.warn。
   * 控制台在手机上根本打不开 —— 等于没有痕迹。用户看到的结果是：
   * 正文照常生成，但节拍卡没了、检索没带上下文、某章档案没更新，而他完全不知道。
   *
   * 做法：旁路监听 console.warn / console.error，命中降级信号就记账。
   * 只读参数、原样调用原函数，不吞日志、不改输出，也不影响任何调用方。
   * ============================================================ */
  var GL = { max: 120, dedupMs: 600000 };
  var _seen = {};
  function gLog(area, msg, level) {
    try {
      var key = area + '|' + String(msg).slice(0, 60);
      var now = Date.now();
      if (_seen[key] && now - _seen[key] < GL.dedupMs) return;
      _seen[key] = now;
      var a = arr('degradeLog');
      a.unshift({ at: now, area: area || '其他', msg: String(msg || '').slice(0, 300), level: level || 'warn' });
      try { save('degradeLog', a.slice(0, GL.max)); } catch (e) {}
      gBadge();
    } catch (e) {}
  }
  function gAreaOf(s) {
    s = String(s || '');
    if (/节拍卡|planBeat/.test(s)) return '节拍卡';
    if (/RAG|检索|召回/.test(s)) return '检索';
    if (/消化|digest/i.test(s)) return '消化';
    if (/续写|生成|aiGen|aiDeepGen/.test(s)) return '生成';
    if (/档案|digest/i.test(s)) return '档案';
    return '其他';
  }
  var _DEGRADE_SIG = /非致命|跳过|失败|回退|降级|无法|不可用|为空|没能|未能/;
  (function hookConsole() {
    try {
      ['warn', 'error'].forEach(function (lv) {
        var orig = console[lv];
        if (typeof orig !== 'function') return;
        console[lv] = function () {
          try {
            var parts = Array.prototype.map.call(arguments, function (x) {
              return (typeof x === 'string') ? x : String((x && x.message) || x);
            });
            var s = parts.join(' ');
            if (_DEGRADE_SIG.test(s)) gLog(gAreaOf(s), s, lv);
          } catch (e) {}
          return orig.apply(console, arguments);   /* 一律原样输出 */
        };
      });
    } catch (e) {}
  })();

  /* 我自己这一层产生的降级，也走同一个账本 */
  window.dpDegradeLog = function () { return arr('degradeLog'); };
  window.dpDegradeClear = function () {
    try { save('degradeLog', []); } catch (e) {}
    gBadge();
    try { renderDegradePanel(); } catch (e) {}
  };

  /* ============================================================
   * B. 人物动态状态（0 token，确定性推导）
   *
   * 判断表里最红的一项：人物卡是**静态**的（core/desire/taboos），
   * 模型看到「詹姆斯性格张扬」，却看不到「第 70 章他和西里斯已经闹翻」。
   * 这是长文丢人设的真正原因 —— 不是上下文不够长，是没有「截至现在他是什么状态」这一层。
   *
   * 做法不走 AI（避免额外费用与二次幻觉）：
   *   直接从已消化的**章档案块**里，按人物名/别名找出最近 3 次出场，
   *   摘出含该名字的那一行，作为「事实性近期状态」附在声线卡后面。
   *   全部来自用户已经写下的正文摘要，一个字都不是模型编的。
   * ============================================================ */
  var _cmCache = { key: '', map: null };
  function gCharMapFp(vid) {
    try {
      var d = getDigest();
      var v = (d && d.volumes && d.volumes[vid]) || {};
      var bl = Object.keys(v.blocks || {}).length;
      return [vid, bl, (d && d.digest_update_at) || 0, arr('chars').length, H(String(v.text || '').length)].join('#');
    } catch (e) { return 'fp' + Date.now(); }
  }
  function gPickLine(text, names) {
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l || l.length < 6) continue;
      for (var j = 0; j < names.length; j++) {
        if (names[j] && l.indexOf(names[j]) >= 0) return l.slice(0, 150);
      }
    }
    return String(text || '').replace(/\s+/g, ' ').slice(0, 150);
  }
  /* 建「人物 → 最近出场片段」表；按卷 + 档案版本缓存，档案一变就重建 */
  function gCharMap(vid) {
    var fp = gCharMapFp(vid);
    if (_cmCache.map && _cmCache.key === fp) return _cmCache.map;
    var map = {};
    try {
      var d = getDigest();
      var v = ensureVolDigest(d, vid);
      var blocks = volBlocksSorted(v);
      var chars = arr('chars');
      chars.forEach(function (c) {
        var names = [c.name].concat(c.aliases || []).filter(function (x) { return x && String(x).trim(); });
        if (!names.length) return;
        var hits = [];
        for (var i = blocks.length - 1; i >= 0 && hits.length < 3; i--) {
          var t = String(blocks[i].text || '');
          var found = false;
          for (var j = 0; j < names.length; j++) { if (t.indexOf(String(names[j])) >= 0) { found = true; break; } }
          if (!found) continue;
          hits.push({ num: Number(blocks[i].seq) || 0, text: gPickLine(t, names) });
        }
        if (hits.length) map[c.id] = hits;
      });
    } catch (e) {}
    _cmCache = { key: fp, map: map };
    return map;
  }
  function gCurVol() {
    try {
      var el = document.getElementById('chVol');
      var v = el && el.value;
      return (v && v !== 'all') ? v : 'none';
    } catch (e) { return 'none'; }
  }
  /* 生成/讨论前注入的「近期状态」文本块；budget 封顶，绝不无限膨胀 */
  function gRecentBlock(volId, seedText, budget) {
    budget = budget || 1200;
    var vid = (volId && volId !== 'none') ? volId : gCurVol();
    var map = gCharMap(vid);
    var chars = arr('chars');
    var t = String(seedText || '').toLowerCase();
    var picked = [];
    chars.forEach(function (c) {
      var hits = map[c.id];
      if (!hits || !hits.length) return;
      var names = [c.name].concat(c.aliases || []);
      var named = false;
      for (var i = 0; i < names.length; i++) {
        if (names[i] && t.indexOf(String(names[i]).toLowerCase()) >= 0) { named = true; break; }
      }
      picked.push({ c: c, hits: hits, pri: (named ? 1000 : 0) + (c.protagonist ? 200 : 0) + hits.length });
    });
    if (!picked.length) return '';
    picked.sort(function (a, b) { return b.pri - a.pri; });
    var out = [], used = 0;
    for (var i = 0; i < picked.length && out.length < 5; i++) {
      var p = picked[i];
      var line = '· ' + p.c.name + '：' + p.hits.map(function (h) {
        return '第' + h.num + '章 ' + h.text;
      }).join('；');
      if (used + line.length > budget) break;
      out.push(line); used += line.length;
    }
    if (!out.length) return '';
    return '\n\n【人物近期状态 · 事实（按最近出场倒序；只陈述档案里确实写过的，禁止据此推测血缘、动机或尚未写到的情节）】\n' + out.join('\n');
  }
  window.dpCharRecent = function (volId) { return gCharMap(volId || gCurVol()); };

  /* 注入点一：本章声线卡（深度续写 / 接着写都会走这里） */
  var _origVC = (typeof chapterVoiceCards === 'function') ? chapterVoiceCards : null;
  if (_origVC) {
    chapterVoiceCards = function (volId, seedText, budget) {
      var s = '';
      try { s = _origVC.apply(this, arguments); } catch (e) { s = ''; }
      try {
        var add = gRecentBlock(volId, seedText, 1200);
        if (add) return (s || '') + add;
      } catch (e2) {}
      return s;
    };
  }

  /* 注入点二：剧情参谋上下文（注意不能改缓存对象，必须新建一个） */
  var _origCtxG = (typeof counselCtx === 'function') ? counselCtx : null;
  if (_origCtxG) {
    counselCtx = function () {
      var v = null;
      try { v = _origCtxG.apply(this, arguments); } catch (e) { return _origCtxG.apply(this, arguments); }
      try {
        var q = '';
        var lg = (typeof _counselLog !== 'undefined' && _counselLog) ? _counselLog : [];
        for (var i = lg.length - 1; i >= 0; i--) { if (lg[i] && lg[i].role === 'me') { q = lg[i].text || ''; break; } }
        var add = gRecentBlock(v && v.vol, q, 1200);
        if (add) return { text: String(v.text || '') + add, chars: (Number(v.chars) || 0) + add.length, vol: v.vol };
      } catch (e2) {}
      return v;
    };
  }

  /* ============================================================
   * C. 节拍卡兜底（生成管线层）
   *
   * 原行为：planBeatCard 解析失败 → toast「可重试」→ 直接 return(undefined)
   *        → aiDeepGen 里 catch 掉当"非致命,跳过" → 整章在没有任何节拍约束下生成。
   * 这不是降级，是静默丢功能。
   *
   * 现在：拿不到 AI 节拍卡就用「最近章节结尾 + 未回收线索」在本地拼一套最小节拍，
   *      标明来源是本地兜底，并记账。链路不再裸奔。
   *
   * 关键区分：resolve(null) 表示用户**主动放弃**，必须尊重，不能强塞兜底。
   * ============================================================ */
  function gLocalBeats(opts) {
    try {
      opts = opts || {};
      var num = Number(opts.num) || 0;
      var chs = arr('chapters');
      var done = chs.filter(function (c) { return (c.status || 'draft') === 'done' && (c.body || '').trim(); })
        .sort(function (a, b) { return (Number(a.num) || 0) - (Number(b.num) || 0); });
      var prev = done.length ? done[done.length - 1] : null;
      var tail = prev ? String(prev.synopsis || prev.body || '').replace(/\s+/g, ' ').slice(-60) : '';
      var plots = arr('plot').filter(function (p) { return p && p.status !== 'done' && (p.line || p.point); }).slice(0, 2);
      var beats = [];
      beats.push('1. 承接：从上一章结尾处拾起（上一章收在「' + (tail || '暂无梗概，按正文最后一段接续') + '」），把镜头拉回主角当下处境。');
      if (plots[0]) {
        beats.push('2. 推进未回收线索「' + String(plots[0].line || '').slice(0, 24) + '」：让相关人主动提起，露出一个此前没有的具体信息。');
      } else {
        beats.push('2. 推进：让主线上的一个悬而未决的问题往前挪一步，只给信息、不下结论。');
      }
      if (plots[1]) {
        beats.push('3. 小转折：' + String(plots[1].line || '').slice(0, 24) + ' 这条线出现一次意外，代价要具体可见。');
      } else {
        beats.push('3. 小转折：让一次预期落空，人物必须为一个具体的东西付出代价。');
      }
      beats.push('4. 收束留钩：把第 2、3 步的新信息指向下一章的冲突，结尾留一个强钩子。');
      return { idx: 0, tone: '本地兜底', raw: '本地最小节拍（AI 节拍卡不可用时的兜底，非模型产出）', beats: beats, local: true };
    } catch (e) { return null; }
  }
  var _origPlan = (typeof planBeatCard === 'function') ? planBeatCard : null;
  if (_origPlan) {
    planBeatCard = async function (opts) {
      var r;
      try {
        r = await _origPlan.apply(this, arguments);
      } catch (e) {
        gLog('节拍卡', '规划抛错：' + String((e && e.message) || e));
        r = undefined;
      }
      if (r === null) return r;                                   /* 用户主动放弃，尊重 */
      if (r && r.beats && r.beats.length) return r;                /* 正常拿到 */
      var fb = gLocalBeats(opts);
      if (fb) {
        gLog('节拍卡', 'AI 节拍卡不可用（解析失败或未被接受），本次改用本地最小节拍兜底，正文仍会生成');
        try { toast('⚠️ 节拍卡未生成，已用本地兜底节拍（见「降级日志」）'); } catch (e2) {}
        return fb;
      }
      return r;
    };
  }

  /* ============================================================
   * D. 近章截断可见（只读诊断，不改任何内容）
   *
   * 判断表 3c：非 Pro 模式下 12000 字预算、近章额度 4200，
   * 倒数第二章常被切到 1500 字（实测 3300 字章节只剩 45%）。
   * 这个取舍本身有理由（保证至少 1 章完整），所以我不改预算分配——
   * 只把「这次砍了几章、砍掉多少」记进账本，让质量损失可见、可判断。
   * ============================================================ */
  var _origPrior = (typeof collectPrior === 'function') ? collectPrior : null;
  if (_origPrior) {
    collectPrior = function (targetNum, maxChars, opts) {
      var r = _origPrior.apply(this, arguments);
      try {
        var full = String((r && r.full) || '');
        if (!full) return r;
        var chs = arr('chapters');
        var bodyLen = {};
        chs.forEach(function (c) { bodyLen[String(c.id)] = ((c.body || '').length || 0); });
        var byNum = {};
        chs.forEach(function (c) { byNum[String(c.num)] = ((c.body || '').length || 0); });
        /* full 的分块头：【前文·第N章《标题》（…）】 */
        var segs = full.split(/【前文·第(\d+)章/).slice(1);
        var cut = [];
        for (var i = 0; i + 1 < segs.length; i += 2) {
          var num = Number(segs[i]) || 0;
          var seg = segs[i + 1] || '';
          var got = Math.max(0, seg.length - 40);          /* 扣掉头部说明文字 */
          var all = Number(byNum[String(num)]) || 0;
          if (all > 1200 && got < all * 0.6) cut.push(num + '（' + got + '/' + all + ' 字）');
        }
        if (cut.length) gLog('检索', '本次续写前文被截断：' + cut.join('、') + '——这几章的细节未进入上下文');
      } catch (e) {}
      return r;
    };
  }

  /* ============================================================
   * E. 入口与面板
   * ============================================================ */
  function gBadge() {
    try {
      var b = document.getElementById('moreDegradeBadge');
      if (!b) return;
      var n = arr('degradeLog').length;
      b.textContent = n ? String(n) : '';
      b.style.display = n ? 'inline-block' : 'none';
    } catch (e) {}
  }
  function gMask(html) {
    var old = document.getElementById('dpGuardMask');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var m = document.createElement('div');
    m.id = 'dpGuardMask';
    m.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;overflow:auto;';
    m.innerHTML = '<div style="background:var(--card,#fff);color:var(--text,#222);border-radius:14px;max-width:440px;width:100%;max-height:84vh;overflow:auto;padding:16px 16px 20px;box-shadow:0 8px 30px rgba(0,0,0,.25);">' + html + '</div>';
    m.addEventListener('click', function (ev) { if (ev.target === m) m.remove(); });
    document.body.appendChild(m);
    return m;
  }
  window.closeDegradePanel = function () {
    var m = document.getElementById('dpGuardMask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  };
  function renderDegradePanel() {
    try {
      var a = arr('degradeLog');
      var body;
      if (!a.length) {
        body = '<div style="color:var(--sub);line-height:1.8;padding:14px 0;">' +
          '还没有任何降级记录。<br><br>' +
          '这个页面记录的是「某个环节失败后被自动跳过」的事件：节拍卡没生成、检索没带上下文、某章消化没落库、前文被截断……' +
          '<br><br>以前这些只写进浏览器控制台（手机上根本看不到），所以你只会觉得「它好像少做了点什么」，却查不出来。' +
          '<br><br>现在它们都会出现在这里。<b>没有记录 = 每一次生成都是完整链路。</b></div>';
      } else {
        body = a.map(function (x) {
          var d = new Date(x.at);
          var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
          var ts = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
          var col = x.level === 'error' ? '#c0392b' : '#b8860b';
          return '<div style="border:1px solid var(--line,rgba(127,127,127,.22));border-radius:10px;padding:9px 11px;margin-bottom:8px;">' +
            '<div style="font-size:11.5px;color:var(--sub);margin-bottom:4px;">' +
            '<span style="color:' + col + ';font-weight:700;">' + E(x.area) + '</span> · ' + ts + '</div>' +
            '<div style="font-size:12.5px;line-height:1.7;word-break:break-word;">' + E(x.msg) + '</div></div>';
        }).join('');
      }
      gMask(
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<b style="font-size:15px;">⚠️ 降级日志</b>' +
        '<span style="color:var(--sub);font-size:11.5px;">共 ' + a.length + ' 条</span>' +
        '<button type="button" onclick="closeDegradePanel()" style="margin-left:auto;border:1px solid var(--line,rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:8px;padding:5px 10px;font-size:12px;">关闭</button>' +
        '</div>' +
        '<div style="font-size:11.5px;color:var(--sub);line-height:1.7;margin-bottom:10px;">' +
        '记录「某个环节失败后被自动跳过」的事件。降级不等于数据损坏：正文与档案都还在，只是这一步没做到。' +
        '</div>' +
        '<div id="dpDegList">' + body + '</div>' +
        (a.length ? '<div style="display:flex;gap:8px;margin-top:12px;"><button type="button" onclick="dpDegradeClear()" style="flex:1;border:1px solid var(--line,rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:9px;padding:9px;font-size:13px;">清空记录</button></div>' : '')
      );
    } catch (e) {}
  }
  window.dpShowDegradePanel = function () { try { closeMore(); } catch (e) {} renderDegradePanel(); };

  /* 往「更多 → 诊断工具」里插一个入口，紧跟模型连接体检之后 */
  (function mountEntry() {
    try {
      var anchor = null;
      var btns = document.querySelectorAll('.more-action');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].getAttribute('onclick') || '').indexOf('openAiDiag') >= 0) { anchor = btns[i]; break; }
      }
      if (!anchor || !anchor.parentNode) return;
      if (document.getElementById('moreDegradeBtn')) return;
      var b = document.createElement('button');
      b.className = 'more-action';
      b.id = 'moreDegradeBtn';
      b.setAttribute('onclick', 'dpShowDegradePanel()');
      b.innerHTML = '<span class="mi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg></span>' +
        ' ⚠️ 降级日志 · 这次生成少了什么<span class="more-badge" id="moreDegradeBadge" style="display:none;"></span>';
      anchor.parentNode.insertBefore(b, anchor.nextSibling);
      gBadge();
    } catch (e) {}
  })();

  window.__LILIA_GUARD_PLUS__.ok = true;
})();
