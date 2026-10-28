/* ============================================================
 * lilia-counsel-plus  ·  v126
 * 剧情参谋增强模块（独立文件，不修改主程序任何一行代码）
 *
 * 接入方式：主程序 script 之后加载一行 <script src="./lilia-counsel-plus.js">。
 * 所有功能都用「保存原函数引用 → 覆盖同名全局」的包装方式接入，
 * 原函数体一行未动；本文件加载失败时，主程序原有行为完全不变。
 *
 * 覆盖清单（原函数均保留，仅不再被调用）：
 *   counselCtx        → 人物感知注入 + 章号硬约束 + 否决走向注入
 *   counselToPlot     → 线索正文容量 600 → 6000
 *   counselToBrief    → 生成指令容量 1200 → 6000
 *   counselRender     → 追加「确定走向」按钮
 *   _closeBeatPlan    → 记录选中的节拍卡
 *   _restoreBeatPlan  → 选中态恢复（不只恢复方案，还恢复「你选了哪套」）
 *   aiGen / aiDeepGen → 生成时注入否决走向
 *   showTrajPanel     → 轨迹面板加「时间区间 token 汇总」
 *   renderCharList    → 人物卡列表加下拉定位（配合注入的 CSS 取消横滑）
 * ============================================================ */
(function () {
  'use strict';
  if (window.__LILIA_COUNSEL_PLUS__) { return; }        /* 防重复加载 */
  window.__LILIA_COUNSEL_PLUS__ = { ver: 'v126', ok: false };

  var CFG = {
    charMax: 20,      /* 注入人物卡上限（原为 8，直接把配角卡掉了） */
    plotCap: 6000,    /* 存为剧情线索的正文容量（原 600） */
    briefCap: 6000,   /* 写进本章指令的容量（原 1200） */
    vetoMax: 30,      /* 否决走向最多保留条数 */
    adoptMax: 30
  };

  /* ---------------- 基础工具 ---------------- */
  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function S(k) { try { return String((load(k, '') || '')); } catch (e) { return ''; } }
  function now() { return Date.now(); }
  function arr(k) { try { var v = load(k, []); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function put(k, v) { try { save(k, v); } catch (e) { try { localStorage.setItem('lilia_cp_' + k, JSON.stringify(v)); } catch (e2) {} } }
  function get1(k) {
    try { var v = load(k, null); if (v) return v; } catch (e) {}
    try { var raw = localStorage.getItem('lilia_cp_' + k); if (raw) return JSON.parse(raw); } catch (e2) {}
    return null;
  }

  /* ============================================================
   * 模块 A：外观修正（取消手机端人物卡横滑）
   * 主程序 CSS 在移动端媒体查询里把 .char-list 改成了横向滚动，
   * 人物一多就难以定位。这里不改主程序 CSS，而是后加载覆盖。
   * ============================================================ */
  (function injectCss() {
    try {
      var st = document.createElement('style');
      st.id = 'cssCounselPlus';
      st.textContent =
        '@media (max-width:768px){' +
        '.char-list{flex-direction:column !important;max-height:70vh !important;overflow-y:auto !important;overflow-x:visible !important;}' +
        '}' +
        /* 下拉钉在列表顶部：人物多到需要滚动时，滚到下面还得先滚回顶上才能用它，
           等于把「快速定位」变成了「又多一步」。sticky + 不透明底色解决。 */
        /* flex:0 0 auto 是必须的：人物多到溢出时，纵向 flex 会把子项压扁，
           下拉被从 44px 压到 34px，而 10px 上下内边距 + 16px 字号需要 36px，
           文字就被它自己的 overflow:clip 裁掉一半。实测 selH=34 < 36 才发现的。 */
        '.cp-jump{width:100%;flex:0 0 auto;min-height:40px;margin-bottom:6px;position:sticky;top:0;z-index:5;' +
        'background:var(--card,#fff);box-shadow:0 6px 10px -8px rgba(0,0,0,.45);}' +
        '.cp-routes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}' +
        '.cp-rt{border:1px solid var(--line,rgba(127,127,127,.3));border-radius:8px;padding:6px 8px;flex:1 1 100%;}' +
        '.cp-rt-t{font-size:12.5px;line-height:1.6;margin-bottom:6px;}' +
        '.cp-rt-b{display:flex;gap:6px;}' +
        '.cp-range{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 12px;font-size:12px;' +
        'border-bottom:1px solid var(--line,rgba(127,127,127,.18));}' +
        '.cp-range input{min-height:30px;font-size:12px;}';
      document.head.appendChild(st);
    } catch (e) {}
  })();

  /* ============================================================
   * 模块 B：人物感知（本次最关键的修复）
   * 原实现三处硬伤，导致「手动录了人设，参谋还是认错人」：
   *   ① slice(0,8)   —— 只注入前 8 张卡，配角永远进不去
   *   ② 过滤只看 core/langSys/taboos/desire —— 只填了外貌的人被整条过滤掉
   *   ③ 注入时不输出别名 —— 正文里换个称呼就对不上号
   * ============================================================ */

  /* 取一个人的全部称呼：本名 + 别名（含称呼里可能出现的名字片段） */
  function namesOf(c) {
    var out = [];
    try {
      var n = String(c.name || '').trim();
      if (n.length >= 2) out.push(n);
      (c.aliases || []).forEach(function (a) {
        a = String(a || '').trim();
        if (a.length >= 2 && out.indexOf(a) < 0) out.push(a);
      });
    } catch (e) {}
    return out;
  }
  /* 只要有任何一个「人物设定类」字段不为空，就算有内容可注入。
     原过滤条件漏掉了 appearance / psyche，这两项填了也会被丢掉。 */
  function hasSubstance(c) {
    var f = ['core', 'desire', 'deepDesire', 'langSys', 'thinkMode', 'taboos', 'appearance', 'psyche'];
    for (var i = 0; i < f.length; i++) {
      if (String((c && c[f[i]]) || '').trim()) return true;
    }
    return false;
  }
  function hitIn(names, text) {
    if (!text) return false;
    var t = String(text);
    for (var i = 0; i < names.length; i++) { if (t.indexOf(names[i]) >= 0) return true; }
    return false;
  }
  function field(c, k, cap) {
    var v = String((c && c[k]) || '').trim();
    if (!v) return '';
    return cap && v.length > cap ? v.slice(0, cap) : v;
  }

  /* 排序：本章出场 > 本卷近期出场 > 主角 > 有实质设定 > 名字。
     原实现只按 protagonist 排，且硬取前 8 —— 近期活跃的配角照样被切掉。 */
  function rankChar(c, ctx) {
    var ns = namesOf(c), s = 0;
    if (hitIn(ns, ctx.body)) s += 1000;          /* 当前正在写的这一章里出现过 */
    if (hitIn(ns, ctx.recent)) s += 500;         /* 本卷最近几章出现过 */
    if (hitIn(ns, ctx.question)) s += 300;       /* 作者这次问到了他 */
    if (c.protagonist) s += 200;
    if (hasSubstance(c)) s += 50;
    return s;
  }

  function buildCharBlock(ctx) {
    var cs = [];
    try { cs = load('chars', []) || []; } catch (e) { return ''; }
    if (!cs.length) return '';
    var pool = cs.filter(function (c) { return c && String(c.name || '').trim(); });
    /* 有实质设定的人优先入选；设定全空的人只有在名额有富余时才带上，
       且明确标注「无设定」，避免模型把他们当成有据可依的角色。 */
    var withS = pool.filter(hasSubstance), noS = pool.filter(function (c) { return !hasSubstance(c); });
    withS.sort(function (a, b) { return rankChar(b, ctx) - rankChar(a, ctx); });
    noS.sort(function (a, b) { return rankChar(b, ctx) - rankChar(a, ctx); });
    /* v140：作者这一次问到的人先占位，再按相关度补满。
       原实现把「问到」只当作 +300 的排序权重：当本章出场人物已经占满名额时，
       问到的那个配角照样被切掉 —— 表现为「明明问的是菲比，参谋的回答里却没有菲比」。
       问到的人通常只有 0–3 个，先塞进来不会挤压正文相关度更高的卡。 */
    var forced = [], fk = {};
    try {
      pool.forEach(function (c) {
        var k = c.id || c.name;
        if (fk[k]) return;
        if (hitIn(namesOf(c), ctx.question)) { fk[k] = 1; forced.push(c); }
      });
    } catch (e) {}
    var restW = withS.filter(function (c) { return !fk[c.id || c.name]; });
    var restN = noS.filter(function (c) { return !fk[c.id || c.name]; });
    var picked = forced.concat(restW).slice(0, CFG.charMax);
    var room = CFG.charMax - picked.length;
    if (room > 0) picked = picked.concat(restN.slice(0, room));

    if (!picked.length) return '';
    var lines = picked.map(function (c) {
      var nm = String(c.name || '').trim();
      var al = (c.aliases || []).filter(function (a) { return String(a || '').trim() && String(a).trim() !== nm; });
      var head = '· ' + nm + (al.length ? ('（别名：' + al.join('、') + '）') : '') + (c.protagonist ? '【主角】' : '');
      var segs = [];
      var f1 = field(c, 'core', 120); if (f1) segs.push('核心特质 ' + f1);
      var f2 = field(c, 'desire', 80); if (f2) segs.push('表层欲望 ' + f2);
      var f3 = field(c, 'deepDesire', 80); if (f3) segs.push('深层渴望 ' + f3);
      var f4 = field(c, 'appearance', 120); if (f4) segs.push('外貌 ' + f4);
      var f5 = field(c, 'langSys', 120); if (f5) segs.push('说话方式 ' + f5);
      var f6 = field(c, 'thinkMode', 100); if (f6) segs.push('思维模式 ' + f6);
      var f7 = field(c, 'taboos', 160); if (f7) segs.push('行为禁区（绝不可做）' + f7);
      var f8 = field(c, 'psyche', 160); if (f8) segs.push('心理 ' + f8);
      if (!segs.length) {
        return '· ' + nm + (al.length ? ('（别名：' + al.join('、') + '）') : '') + '：作者尚未填写设定，禁止替他编造性格';
      }
      return head + '：' + segs.join('｜');
    });

    var total = pool.length;
    var hidden = total - picked.length;
    var rule =
      '【人物辨识铁律 · 必须遵守】\n' +
      '① 括号内是同一个人的不同称呼，视为同一人；\n' +
      '② 不同条目是不同人物，禁止把 A 的行为、性格、台词安到 B 头上；\n' +
      '③ 人物卡里没有的人名，一律按「你不知道」处理——禁止用原著、常识或名字的相似性去补全其性格与经历；\n' +
      '④ 判断「这个人会不会这么做」，只能依据上面卡片里的字段，不得另起一套。';
    var out = '【人物卡（判断「这个人会不会这么做」必须以此为准）】\n' + lines.join('\n') + '\n' + rule + '\n';
    if (hidden > 0) {
      out += '（本书共 ' + total + ' 位人物，此处只列出与当前章节最相关的 ' + picked.length + ' 位；其余 ' + hidden + ' 位未列入，如需讨论请让作者补充。）\n';
    }
    return out;
  }

  /* ============================================================
   * 模块 C：章号硬约束（治「凭空冒出第 76 章」）
   * 章号清单本身 v119 已经修好（分卷独立编号），缺的是「可执行」的规则：
   * 原 prompt 只说「不要编造」，模型看到的是道德劝告，不是硬规则。
   * ============================================================ */
  function buildFactBlock() {
    var idx = '';
    try { idx = String(chapterIndexBlock() || ''); } catch (e) { idx = ''; }
    if (!idx) return '';
    /* v119 的 chapterIndexBlock 已经自带【铁律·严禁编造】四条（禁造章号、禁造内容、
       查不到即视为未发生、回指要带分卷名），这里不再重复，否则 prompt 白白膨胀。
       只补 v119 缺的那一句：被问到不存在的章号时该怎么回答，而不是默默脑补。 */
    if (/严禁编造/.test(idx)) {
      return idx + '\n' +
        '【补充】被问到「第 N 章」而 N 不在上表时，直接回答「你还没有写过第 N 章」，'
        + '不要用想象补齐其内容。\n';
    }
    /* 万一拿到的清单没带铁律（例如卷内无章），自己兜住，保证规则不缺失 */
    return idx + '\n' +
      '【引用铁律 · 最高优先级】\n' +
      '① 上表是本书真实存在的全部章节；提及任何章节时，章号必须来自上表。\n' +
      '② 上表中不存在的章号（例如第 76 章），一律视为不存在——禁止提及、禁止分析其内容、禁止据此推演。\n' +
      '③ 被问到「第 N 章」而 N 不在上表时，直接回答「你还没有写过第 N 章」，不要用想象补齐。\n' +
      '④ 章号需连分卷名一起写（如「詹姆斯篇 第 12 章」）；各分卷的章号是各自从 1 开始编号的，'
      + '不同分卷的同号章节是完全不同的两章，禁止混为一谈。\n';
  }

  /* ============================================================
   * 模块 D：否决走向（优化建议 1）
   * 被否决的走向存起来，之后既不再作为选项提出，也不会进正文生成。
   * ============================================================ */
  function vetoGet() { var o = get1('counselVeto'); return (o && Array.isArray(o.items)) ? o.items : []; }
  function vetoSave(items) {
    items = items.slice(-CFG.vetoMax);
    put('counselVeto', { at: now(), items: items });
  }
  function vetoAdd(t) {
    t = String(t || '').trim(); if (!t) return;
    var a = vetoGet();
    for (var i = 0; i < a.length; i++) { if (a[i] === t) return; }
    a.push(t); vetoSave(a);
  }
  function vetoRemove(t) {
    t = String(t || '').trim();
    vetoSave(vetoGet().filter(function (x) { return x !== t; }));
  }
  function adoptGet() { var o = get1('counselAdopted'); return (o && Array.isArray(o.items)) ? o.items : []; }
  function adoptSave(items) { put('counselAdopted', { at: now(), items: items.slice(-CFG.adoptMax) }); }
  function adoptAdd(t) {
    t = String(t || '').trim(); if (!t) return;
    var a = adoptGet();
    for (var i = 0; i < a.length; i++) { if (a[i] === t) return; }
    a.push(t); adoptSave(a);
  }
  /* 生成侧要注入的负向约束 */
  function vetoBlock() {
    var a = vetoGet();
    if (!a.length) return '';
    var lines = a.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
    return '\n\n【已被作者否决的剧情走向 · 禁止采用，也禁止换种说法走回去】\n' + lines + '\n';
  }

  /* 从参谋回复里解析出「可选走向」。格式不固定（"可选走向："、"①②③"、"1. 2. 3."、"- "），
     所以只收跨度合理的列表项，且不依赖任何一种单一写法。 */
  function parseRoutes(text) {
    var t = String(text || '');
    var out = [];
    var seg = t;
    var m = t.match(/(?:可选走向|走向|接下来)[^\n]{0,40}[:：][\s\S]{0,1200}$/);
    if (m) seg = m[0];
    seg.split(/\r?\n/).forEach(function (raw) {
      var ln = String(raw || '').trim();
      if (!ln) return;
      var mm = ln.match(/^([①②③④⑤⑥]|[-•·]|\d{1,2}[.、)])\s*(.+)$/);
      if (mm) { if (mm[2].length >= 6) out.push(mm[2].trim()); return; }
      var m2 = ln.match(/^(?:可选走向|走向)\s*[:：]\s*(.+)$/);
      if (m2 && m2[1].length >= 6) out.push(m2[1].trim());
    });
    /* 去重并截断 */
    var seen = {}, res = [];
    out.forEach(function (x) { if (!seen[x] && res.length < 3) { seen[x] = 1; res.push(x); } });
    return res;
  }

  /* ============================================================
   * 模块 E：counselCtx 重写（原函数保留，仅不再被调用）
   * 复用主程序既有的 chapterIndexBlock / volName / getVolPov / getVolSetting / getDigest，
   * 只是把「人物卡 / 章号铁律 / 否决走向」三块换成增强版。
   * ============================================================ */
  var _origCounselCtx = (typeof counselCtx === 'function') ? counselCtx : null;
  counselCtx = function () {
    var vol = 'none';
    try { vol = (document.getElementById('chVol') || {}).value || 'none'; } catch (e) {}
    var s = '';
    try {
      var body = ((document.getElementById('chBody') || {}).value || '');
      /* 作者这次问了什么：必须取「讨论记录里最后一条我说的」，不能读输入框——
         主程序 counselSend 是先把 inp.value 清空、再调 counselCtx()，读输入框永远是空。
         问到谁，就把谁提到前面：问「沙菲克这么做合理吗」时沙菲克必须出现在人物卡里。 */
      var q = '';
      try {
        for (var li = _counselLog.length - 1; li >= 0; li--) {
          if (_counselLog[li] && _counselLog[li].role === 'me') { q = String(_counselLog[li].text || ''); break; }
        }
      } catch (eq) {}
      if (!q) { q = ((document.getElementById('counselInput') || {}).value || ''); }
      var recent = '';
      try {
        recent = (load('chapters', []) || [])
          .filter(function (c) { return (c.vol || 'none') === vol && (c.synopsis || c.body); })
          .sort(function (a, b) { return Number(b.num) - Number(a.num); })
          .slice(0, 5)
          .map(function (c) { return String(c.synopsis || c.body || '').slice(0, 400); }).join('\n');
      } catch (e2) {}
      var ctx = { body: body, question: q, recent: recent, vol: vol };

      s += buildFactBlock();
      s += '【本分卷】' + volName(vol) + '\n';
      try { var pov = getVolPov(vol); if (pov) s += '【本卷人称铁律】' + pov + '\n'; } catch (e3) {}
      try { var vs = getVolSetting(vol); if (vs) s += '【本卷设定】' + String(vs).slice(0, 900) + '\n'; } catch (e4) {}

      s += buildCharBlock(ctx);

      try {
        var d = getDigest(); var v = (d.volumes || {})[vol] || {};
        var roll = ((v.rolling || '').trim() || (v.text || '')).slice(0, 1500);
        if (roll) s += '【本卷已消化档案（节选）】\n' + roll + '\n';
        var g = String(d.global || '').trim();
        if (g) s += '【全书总档案（跨卷脉络，判断连贯性以此为准）】\n' + g.slice(0, 1800) + '\n';
      } catch (e5) {}

      try {
        var chs = (load('chapters', []) || []).filter(function (c) { return Number(c.num) > 0; })
          .sort(function (a, b) { return Number(a.num) - Number(b.num); }).slice(-3);
        if (chs.length) {
          s += '【最近几章】\n' + chs.map(function (c) {
            return '第' + c.num + '章《' + (c.title || '') + '》' + (c.synopsis ? ('：' + String(c.synopsis).slice(0, 120)) : '');
          }).join('\n') + '\n';
        }
      } catch (e6) {}

      if (body.trim()) s += '【当前编辑器正文尾部】\n' + body.slice(-1200) + '\n';

      var vb = vetoBlock();
      if (vb) s += vb;
    } catch (err) {
      /* 任何异常都退回主程序原实现，绝不让增强版本把参谋搞挂 */
      if (_origCounselCtx) { try { return _origCounselCtx(); } catch (e7) {} }
      return { text: '', chars: 0, vol: vol };
    }
    return { text: s, chars: s.length, vol: vol };
  };

  /* ============================================================
   * 模块 F：线索 / 指令扩容（缺陷 4）
   * ============================================================ */
  counselToPlot = function () {
    try {
      var last = null;
      for (var i = _counselLog.length - 1; i >= 0; i--) { if (_counselLog[i].role === 'ai') { last = _counselLog[i]; break; } }
      if (!last) { toast('还没有参谋的回复可以存'); return; }
      var full = String(last.text || '');
      var line = prompt('存为一条剧情线索，写一句标题（可改）：', full.slice(0, 40).replace(/\n/g, ' '));
      if (!line) return;
      var kept = full.slice(0, CFG.plotCap);
      var pl = arr('plot');
      pl.push({ id: uid(), line: line, point: kept, owner: '', status: '' });
      put('plot', pl);
      try { renderPlot(); } catch (e) {}
      var cut = full.length - kept.length;
      toast(cut > 0
        ? ('已存为剧情线索（正文 ' + kept.length + ' 字，超出的 ' + cut + ' 字被截断）')
        : ('已存为剧情线索（正文 ' + kept.length + ' 字，完整保存）'));
    } catch (e) { toast('存线索失败：' + (e && e.message)); }
  };

  counselToBrief = function () {
    try {
      var last = null;
      for (var i = _counselLog.length - 1; i >= 0; i--) { if (_counselLog[i].role === 'ai') { last = _counselLog[i]; break; } }
      if (!last) { toast('还没有参谋的回复可以落地'); return; }
      var ta = document.getElementById('chBrief');
      if (!ta) return;
      var full = String(last.text || '');
      var kept = full.slice(0, CFG.briefCap);
      ta.value = (ta.value ? ta.value + '\n' : '') + '【剧情参谋结论 · 下一轮据此写】\n' + kept;
      var cut = full.length - kept.length;
      toast(cut > 0
        ? ('已写进「生成指令」（' + kept.length + ' 字，超出的 ' + cut + ' 字被截断）')
        : ('已写进「生成指令」（' + kept.length + ' 字，完整写入）'));
    } catch (e) { toast('写入指令失败：' + (e && e.message)); }
  };

  /* ============================================================
   * 模块 G：确定走向按钮（优化建议 1 的 UI）
   * ============================================================ */
  var _origCounselRender = (typeof counselRender === 'function') ? counselRender : null;
  counselRender = function () {
    if (_origCounselRender) { try { _origCounselRender(); } catch (e) {} }
    try {
      var box = document.getElementById('counselLog');
      if (!box) return;
      var kids = box.children;
      var last = kids[kids.length - 1];
      if (!last) return;
      var tag = (last.children && last.children[0]) ? (last.children[0].textContent || '') : '';
      if (!/参谋/.test(tag)) return;                       /* 只给参谋的回复加按钮 */
      var src = '';
      for (var i = _counselLog.length - 1; i >= 0; i--) {
        if (_counselLog[i].role === 'ai') { src = _counselLog[i].text; break; }
      }
      var routes = parseRoutes(src);
      if (!routes.length) return;
      var vetoed = vetoGet(), adopted = adoptGet();
      var wrap = document.createElement('div');
      wrap.className = 'cp-routes';
      wrap.innerHTML = routes.map(function (r, i) {
        var isV = vetoed.indexOf(r) >= 0, isA = adopted.indexOf(r) >= 0;
        if (isV || isA) return '';
        return '<div class="cp-rt">'
          + '<div class="cp-rt-t">' + E(r) + '</div>'
          + '<div class="cp-rt-b">'
          + '<button type="button" class="primary" onclick="cpAdoptRoute(' + i + ')">✓ 采纳</button>'
          + '<button type="button" onclick="cpVetoRoute(' + i + ')">✗ 否决</button>'
          + '</div></div>';
      }).join('');
      if (wrap.innerHTML) last.appendChild(wrap);
      /* 记录本轮按钮对应的文本，供点击时取用 */
      _cpRoutes = routes;
    } catch (e) {}
  };
  var _cpRoutes = [];
  window.cpAdoptRoute = function (i) {
    try {
      var r = _cpRoutes[i]; if (!r) return;
      adoptAdd(r);
      var ta = document.getElementById('chBrief');
      if (ta) {
        ta.value = (ta.value ? ta.value + '\n' : '') + '【已确定的剧情走向】' + r;
        toast('已采纳：已写进「生成指令」');
      } else {
        toast('已采纳');
      }
      try { counselRender(); } catch (e) {}
    } catch (e) { toast('采纳失败：' + (e && e.message)); }
  };
  window.cpVetoRoute = function (i) {
    try {
      var r = _cpRoutes[i]; if (!r) return;
      vetoAdd(r);
      toast('已否决：之后不会再提这个走向，也不会据此生成');
      try { counselRender(); } catch (e) {}
    } catch (e) { toast('否决失败：' + (e && e.message)); }
  };
  window.cpVetoList = function () {
    try {
      var a = vetoGet();
      if (!a.length) { alert('还没有被否决的走向。'); return; }
      if (!confirm('已否决 ' + a.length + ' 条走向。\n\n点「确定」全部清除（之后会重新允许这些走向）。')) return;
      put('counselVeto', { at: now(), items: [] });
      toast('否决清单已清空');
      try { counselRender(); } catch (e) {}
    } catch (e) {}
  };
  window.cpAdoptList = function () {
    try {
      var a = adoptGet();
      if (!a.length) { alert('还没有采纳的走向。'); return; }
      alert('已采纳的走向（已写进生成指令）：\n\n' + a.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n'));
    } catch (e) {}
  };

  /* ============================================================
   * 模块 H：生成侧注入否决走向
   * 直接改 chBrief 的值再调原函数，用完还原——不动 aiGen / aiDeepGen 内部。
   * ============================================================ */
  function withVeto(fn) {
    return function () {
      var ta = null, orig = '';
      try { ta = document.getElementById('chBrief'); if (ta) orig = ta.value; } catch (e) {}
      var vb = vetoBlock();
      if (ta && vb) { ta.value = (orig ? orig + '\n' : '') + vb; }
      var self = this, args = arguments;
      return Promise.resolve().then(function () { return fn.apply(self, args); })
        .then(function (r) { if (ta) ta.value = orig; return r; },
              function (err) { if (ta) ta.value = orig; throw err; });
    };
  }
  if (typeof aiGen === 'function') { aiGen = withVeto(aiGen); }
  if (typeof aiDeepGen === 'function') { aiDeepGen = withVeto(aiDeepGen); }

  /* ============================================================
   * 模块 I：节拍卡「选中态」恢复（优化建议 2）
   * 原实现只落盘了 3 套方案（beatPending），没记录「你选了哪套」，
   * 于是选中之后、生成之前被打断，回来只剩弹窗，白选一次。
   * 这里单独存 beatPicked（不干扰主程序原有的 beatPending 清理逻辑）。
   * ============================================================ */
  var _origCloseBeatPlan = (typeof _closeBeatPlan === 'function') ? _closeBeatPlan : null;
  if (_origCloseBeatPlan) {
    _closeBeatPlan = function (i) {
      var st = null;
      try { st = _beatMask; } catch (e) {}
      var r = _origCloseBeatPlan.apply(this, arguments);
      try {
        if (st && typeof i === 'number' && i >= 0 && st.plans && st.plans[i]) {
          var p = st.plans[i];
          put('beatPicked', { idx: p.idx, tone: p.tone, beats: p.beats, raw: p.raw, at: now() });
        }
      } catch (e2) {}
      return r;
    };
  }
  var _origRestoreBeatPlan = (typeof _restoreBeatPlan === 'function') ? _restoreBeatPlan : null;
  _restoreBeatPlan = function () {
    try {
      var picked = get1('beatPicked');
      if (picked && picked.beats && picked.beats.length) {
        if ((now() - (picked.at || 0)) > 86400000) {          /* 24 小时后作废 */
          put('beatPicked', null);
        } else if (!get1('activeDeduction')) {                 /* 还没挂上才补 */
          put('activeDeduction', { idx: picked.idx, tone: picked.tone, beats: picked.beats, raw: picked.raw, at: now() });
          try { renderBeatMount(); } catch (e) {}
          try { renderDeductions(); } catch (e2) {}
          toast('上次你选了方案' + picked.idx + '，已自动恢复挂接');
          return;                                              /* 已确定，不再弹选择框 */
        }
      }
    } catch (e) {}
    if (_origRestoreBeatPlan) { try { _origRestoreBeatPlan(); } catch (e3) {} }
  };
  /* 深度续写跑完后，节拍卡已被消费，清掉选中标（否则下次进页面又挂一次） */
  if (typeof aiDeepGen === 'function') {
    var _prevDeep = aiDeepGen;
    aiDeepGen = function () {
      var self = this, args = arguments;
      return Promise.resolve().then(function () { return _prevDeep.apply(self, args); })
        .then(function (r) { try { put('beatPicked', null); } catch (e) {} return r; },
              function (err) { throw err; });
    };
  }

  /* ============================================================
   * 模块 J：生成轨迹「时间区间 token 汇总」（疑问 3 的答案）
   * 主程序已记录每条的 uin / uout / ts，这里只做本地汇总，0 token。
   * ============================================================ */
  var _origShowTrajPanel = (typeof showTrajPanel === 'function') ? showTrajPanel : null;
  if (_origShowTrajPanel) {
    showTrajPanel = function () {
      _origShowTrajPanel();
      try {
        var list = document.getElementById('trajList');
        if (!list) return;
        if (document.getElementById('cpRangeBar')) return;
        var bar = document.createElement('div');
        bar.id = 'cpRangeBar';
        bar.className = 'cp-range';
        bar.innerHTML =
          '<span>区间汇总</span>' +
          '<input type="datetime-local" id="cpFrom" style="flex:1 1 150px;">' +
          '<input type="datetime-local" id="cpTo" style="flex:1 1 150px;">' +
          '<button type="button" onclick="cpRangeSum()">统计</button>' +
          '<button type="button" onclick="cpRangeToday()">今天</button>' +
          '<button type="button" onclick="cpRangeCopy()">复制</button>' +
          '<div id="cpRangeOut" style="flex:1 1 100%;color:var(--sub);"></div>';
        list.parentNode.insertBefore(bar, list);
      } catch (e) {}
    };
  }
  function cpRangeItems() {
    var a = [];
    try { a = trajGet(); } catch (e) {}
    var from = 0, to = 0;
    try {
      var f = document.getElementById('cpFrom'), t = document.getElementById('cpTo');
      if (f && f.value) from = new Date(f.value).getTime();
      if (t && t.value) to = new Date(t.value).getTime();
    } catch (e2) {}
    if (!from && !to) return { items: a, from: 0, to: 0, open: false };
    return {
      items: a.filter(function (x) {
        var ts = Number(x.ts) || 0;
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        return true;
      }),
      from: from, to: to, open: true
    };
  }
  function cpRangeText() {
    var r = cpRangeItems();
    var n = 0, i = 0, o = 0, bad = 0;
    var byModel = {};
    r.items.forEach(function (x) {
      n++; i += Number(x.uin) || 0; o += Number(x.uout) || 0;
      if (!x.ok) bad++;
      var m = String(x.ret || x.req || '?');
      byModel[m] = byModel[m] || { n: 0, i: 0, o: 0 };
      byModel[m].n++; byModel[m].i += Number(x.uin) || 0; byModel[m].o += Number(x.uout) || 0;
    });
    var fmt = function (ts) {
      if (!ts) return '—';
      var d = new Date(ts), p = function (v) { return v < 10 ? ('0' + v) : ('' + v); };
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    var lines = [];
    lines.push('区间：' + fmt(r.from) + ' → ' + fmt(r.to) + (r.open ? '' : '（未限定，统计全部）'));
    lines.push('调用 ' + n + ' 次　输入 ' + i + ' token　输出 ' + o + ' token　合计 ' + (i + o) + ' token');
    if (bad) lines.push('其中失败 ' + bad + ' 次');
    var ms = Object.keys(byModel);
    if (ms.length) {
      lines.push('分模型：');
      ms.forEach(function (m) {
        lines.push('　' + m + '：' + byModel[m].n + ' 次，输入 ' + byModel[m].i + ' / 输出 ' + byModel[m].o);
      });
    }
    return lines.join('\n');
  }
  window.cpRangeSum = function () {
    try {
      var el = document.getElementById('cpRangeOut');
      if (el) el.textContent = cpRangeText().replace(/\n/g, '　·　');
    } catch (e) {}
  };
  window.cpRangeToday = function () {
    try {
      var d = new Date(), p = function (v) { return v < 10 ? ('0' + v) : ('' + v); };
      var s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      var f = document.getElementById('cpFrom'), t = document.getElementById('cpTo');
      if (f) f.value = s + 'T00:00';
      if (t) t.value = s + 'T23:59';
      cpRangeSum();
    } catch (e) {}
  };
  window.cpRangeCopy = function () {
    try { fallbackCopy(cpRangeText()); toast('已复制区间汇总'); } catch (e) {}
  };

  /* ============================================================
   * 模块 K：人物卡下拉定位（缺陷 1）
   * 取消横滑的 CSS 已在模块 A 注入；这里补一个下拉，选完自动滚动定位。
   * ============================================================ */
  var _origRenderCharList = (typeof renderCharList === 'function') ? renderCharList : null;
  if (_origRenderCharList) {
    renderCharList = function () {
      _origRenderCharList();
      try {
        var box = document.getElementById('charList');
        if (!box) return;
        if (document.getElementById('cpCharJump')) return;
        var cs = [];
        try { cs = load('chars', []) || []; } catch (e) {}
        if (cs.length < 6) return;                    /* 人少时下拉没意义，不打扰 */
        var sel = document.createElement('select');
        sel.id = 'cpCharJump';
        sel.className = 'cp-jump';
        sel.innerHTML = '<option value="">— 点此定位人物（共 ' + cs.length + ' 人）—</option>' +
          cs.map(function (c) {
            return '<option value="' + E(c.id) + '">' + E(c.name || '未命名') + (c.protagonist ? '（主角）' : '') + '</option>';
          }).join('');
        sel.onchange = function () {
          try { if (this.value) { selectChar(this.value); cpScrollToChar(this.value); } } catch (e2) {}
        };
        box.insertBefore(sel, box.firstChild);
      } catch (e) {}
      try { cpScrollToChar(null); } catch (e2) {}
    };
  }
  window.cpScrollToChar = function (id) {
    try {
      var box = document.getElementById('charList');
      if (!box) return;
      var target = null;
      var chips = box.querySelectorAll('.char-chip');
      for (var i = 0; i < chips.length; i++) {
        if (id ? chips[i].getAttribute('data-cid') === id : /on/.test(chips[i].className)) { target = chips[i]; break; }
      }
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
  };

  window.__LILIA_COUNSEL_PLUS__.ok = true;
})();
