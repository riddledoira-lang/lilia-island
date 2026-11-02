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

  /* 暴露到模块标记上，便于在控制台按需调预算（改动即时生效，不需重新部署） */
  window.__LILIA_COUNSEL_PLUS__.CFG = {
    charMax: 20,      /* 注入人物卡上限（原为 8，直接把配角卡掉了） */
    plotCap: 6000,    /* 存为剧情线索的正文容量（原 600） */
    briefCap: 6000,   /* 写进本章指令的容量（原 1200） */
    vetoMax: 30,      /* 否决走向最多保留条数 */
    adoptMax: 30,
    /* v147：参谋按需召回（治「74 章里只有最后 3–5 章的梗概能进上下文」） */
    ragTop: 6,        /* 召回条数上限 */
    ragPer: 320,      /* 每条片段字数上限 */
    ragCap: 1800,     /* 召回块总字数上限 */
    ragStop: 12000    /* 上下文已经这么长就不再追加召回，防超预算 */
  };
  var CFG = window.__LILIA_COUNSEL_PLUS__.CFG;

  /* ---------------- 基础工具 ---------------- */
  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function S(k) { try { return String((load(k, '') || '')); } catch (e) { return ''; } }
  function now() { return Date.now(); }
  function arr(k) { try { var v = load(k, []); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  /* ★ 兜底 key 必须带书 ID。
     原来是 'lilia_cp_' + k —— 不带书 ID，是全局的。
     只在 save() 抛错（配额满 / IndexedDB 瞬时失败）时才走这条兜底，属降级路径；
     但一旦触发，采纳/否决列表就会跨书串：A 书留下备份 → 任何一本自己没存过
     的 B 书读到它 → 作者继续操作、save() 这次成功 → A 书内容被写进 B 书，
     而且全局 key 永不过期，污染是粘性的。
     同类更严重的一处在 index.html 的 counselSave()/counselLoad()
     （lilia_counsel_bak，回落条件是「本书为空」而非「load 失败」，触发更宽松），
     由 agent-app-engineer 处理。两边口径保持一致。 */
  function cpBakKey(k) {
    var bid = '';
    try { bid = String((typeof curId !== 'undefined' && curId) ? curId : ''); } catch (e) {}
    return 'lilia_cp_' + bid + '_' + k;
  }
  /* 缺陷 2：主路径写成功就必须清掉兜底副本。
     兜底只在「save 抛错」这一个时刻才该存在；留着会让下一次 load 取不到值时
     读回一份过期副本——例如作者清空了讨论，却被兜底副本原样复活。 */
  function put(k, v) {
    try {
      save(k, v);
      try { localStorage.removeItem(cpBakKey(k)); } catch (e3) {}
    } catch (e) {
      try { localStorage.setItem(cpBakKey(k), JSON.stringify(v)); } catch (e2) {}
    }
  }
  function get1(k) {
    try { var v = load(k, null); if (v) return v; } catch (e) {}
    try { var raw = localStorage.getItem(cpBakKey(k)); if (raw) return JSON.parse(raw); } catch (e2) {}
    return null;
  }

  /* ============================================================
   * 缺陷 4b：存量旧全局兜底 key「只删不回填」
   *
   * v153 之前兜底 key 是 'lilia_cp_' + k —— 不带书 ID，是全局的。老用户机器上
   * 可能还留着 lilia_cp_counselAdopted / lilia_cp_counselVeto / ... 这类旧 key。
   *
   * 为什么不迁移到新 key（'lilia_cp_<书ID>_<k>'）：旧 key 里没有任何书 ID 信息，
   * 无法判断它当初属于哪本书。往当前书回填，等于把一份归属不明的内容灌进作者
   * 正在写的这本书——正是 v153 要根治的跨书污染，只是换个方向再犯一次。所以只删。
   * 代价（已写进更新日志向作者说明）：极少数老用户会发现「已采纳 / 已否决」列表空了，
   * 重新点一次即可；不丢正文、不丢章节。
   * ============================================================ */
  window.CP_PURGE_LEGACY = 1;   /* 0=不动旧 key（回滚用） */
  var CP_LEGACY_KEYS = ['counselAdopted', 'counselVeto', 'beatPicked', 'activeDeduction', 'plot'];
  function cpPurgeLegacyBak() {
    var removed = [];
    try {
      for (var i = 0; i < CP_LEGACY_KEYS.length; i++) {
        var k = 'lilia_cp_' + CP_LEGACY_KEYS[i];
        if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); removed.push(k); }
      }
    } catch (e) {}
    return removed;
  }
  try { if (window.CP_PURGE_LEGACY) cpPurgeLegacyBak(); } catch (ePurge) {}

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
    try { idx = String(chapterIndexBlock(window.CI_COUNSEL_FULL ? { full: true } : null) || ''); } catch (e) { idx = ''; }
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
  /* ============================================================
   * 模块 D2：章节作用域（v167）
   *
   * 采纳/否决清单与讨论记录此前都是「书级」存储：作者在第 77 章敲定的
   * 「暗红药剂 / 克劳奇那句台词 / 时间线锁五分钟」，会被原样带进第 78 章，
   * 成为后续章节的既定事实——这就是「强制令跨章污染」的真实通道。
   * 现按章节 ID 分桶：切章即自动失效，无需手动清理。
   * 回滚：window.CP_ADOPT_PERCHAP = 0（回到书级单桶，旧数据随即重新可见）。
   * ============================================================ */
  window.CP_ADOPT_PERCHAP = 1;
  window.CP_LOG_PERCHAP = 1;
  function cpChId() {
    try { var el = document.getElementById('chId'); return (el && el.value) ? String(el.value) : ''; } catch (e) { return ''; }
  }
  function cpChNum() {
    try { var el = document.getElementById('chNum'); return (el && el.value) ? String(el.value) : ''; } catch (e) { return ''; }
  }
  /* v170：回滚态（CP_ROLLBACK_V143=1）下取消章节分桶——V143 是书级单桶。运行时读取，与脚本加载顺序无关。 */
  function cpAdoptKey() { var c = cpChId(); return (window.CP_ADOPT_PERCHAP !== 0 && window.CP_ROLLBACK_V143 !== 1 && c) ? ('counselAdopted_ch_' + c) : 'counselAdopted'; }
  function cpVetoKey() { var c = cpChId(); return (window.CP_ADOPT_PERCHAP !== 0 && window.CP_ROLLBACK_V143 !== 1 && c) ? ('counselVeto_ch_' + c) : 'counselVeto'; }
  /* 讨论记录按章过滤：带章标记的消息只在本章可见；无标记的（v167 之前产生的）
     保留可见，避免一次性清空作者的历史讨论。 */
  function cpLogScoped() {
    var base = (typeof _counselLog !== 'undefined' && Array.isArray(_counselLog)) ? _counselLog : [];
    if (window.CP_LOG_PERCHAP === 0 || window.CP_ROLLBACK_V143 === 1) return base;
    var c = cpChId(), n = cpChNum();
    if (!c && !n) return base;
    var f = base.filter(function (m) {
      if (!m) return false;
      if (!m.ch && !m.chNum) return true;
      return (c && m.ch === c) || (n && m.chNum === n);
    });
    return f.length ? f : base;
  }

  function vetoGet() { var o = get1(cpVetoKey()); return (o && Array.isArray(o.items)) ? o.items : []; }
  function vetoSave(items) {
    items = items.slice(-CFG.vetoMax);
    put(cpVetoKey(), { at: now(), items: items });
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
  function adoptGet() { var o = get1(cpAdoptKey()); return (o && Array.isArray(o.items)) ? o.items : []; }
  function adoptSave(items) { put(cpAdoptKey(), { at: now(), items: items.slice(-CFG.adoptMax) }); }
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

  /* ============================================================
   * 修复 3（A4）：补齐缺失的正向约束——「作者已确定的走向」
   *
   * 对称缺失：原实现只注入了 vetoBlock（哪些不能提），没有对应的 adoptBlock（哪条已经定了）。
   * 于是参谋只知道「别往哪走」，不知道「哪条已经定了」，会把作者点过「✓ 采纳」的走向
   * 继续当作待议项重新抛出来问 —— 这正是「不断询问走向、收敛不了」的一类直接来源。
   *
   * 与 vetoBlock 保持同样的写法、同样的开关方式（挂在 window 上，控制台改完立即生效）。
   * 回滚：window.CP_ADOPT_CTX = 0 即逐字还原改动前行为。
   * ============================================================ */
  window.CP_ADOPT_CTX = 1;   /* 1=把「作者已确定的走向」注入参谋上下文；0=不注入 */
  function adoptBlock() {
    if (!window.CP_ADOPT_CTX) return '';
    var a = adoptGet();
    if (!a.length) return '';
    var lines = a.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
    return '\n\n【作者已确定的剧情走向 · 不要再当作待议项重复提问，直接作为既定前提使用】\n' + lines + '\n';
  }

  /* 列表标记正则（供 parseRoutes 用），与 DL.list 同源，同样排除小数开头。
     缺陷 3a：不排除时「0.5 秒后，灯灭了」会被当成一条候选走向，
     还会变成一个写着「5 秒后，灯灭了」的采纳/否决按钮——那是凭空造出来的走向。 */
  function listMarkRe() {
    return (window.CP_LIST_NUM === 0)
      ? /^([①②③④⑤⑥]|[-•·]|\d{1,2}[.、)])\s*(.+)$/
      : /^([①②③④⑤⑥]|[-•·]|\*\*\d{1,2}\.\*\*|\d{1,2}(?:\.(?!\d)|[、)]))\s*(.+)$/;
  }

  /* 缺陷 3：判断「这一轮为什么没有可勾选的走向候选」。
     返回 ''=不该提示（纯问答轮，或已有合格候选被去重/截断）；
           'nolist'=有走向段头但一条列表项都没有；
           'short'=有列表项但每条都不足 6 字、被 parseRoutes 的长度门槛全部滤掉。
     两种成因要分开说：前者的下一步是「请它用 ①②③ 重列」，后者是「请它把每条写完整」。 */
  function routeMissReason(text) {
    try {
      var t = String(text || '');
      if (!/(?:可选走向|走向|接下来)[^\n]{0,40}[:：]/.test(t)) return '';
      var seg = t;
      var m = t.match(/(?:可选走向|走向|接下来)[^\n]{0,40}[:：][\s\S]{0,1200}$/);
      if (m) seg = m[0];
      var hasMark = 0, allShort = 1;
      seg.split(/\r?\n/).forEach(function (raw) {
        var ln = String(raw || '').trim();
        if (!ln) return;
        var mm = ln.match(listMarkRe());
        var m2 = ln.match(/^(?:可选走向|走向)\s*[:：]\s*(.+)$/);
        var body = mm ? mm[2] : (m2 ? m2[1] : '');
        if (!body) return;
        hasMark = 1;
        if (String(body).trim().length >= 6) allShort = 0;
      });
      if (!hasMark) return 'nolist';
      if (allShort) return 'short';
      return '';
    } catch (e) { return ''; }
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
      var mm = ln.match(listMarkRe());
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
   * 模块 D2（v147）：参谋按需召回
   *
   * 症状：74 章的小说里，参谋只能看到「最后 5 章梗概（各 400 字）+ 最后 3 章梗概（各 120 字）
   *       + 一句卷滚动摘要 + 全书总档案」。问「菲比在第 6 章那个动作合理吗」时，
   *       第 6 章的正文根本不在上下文里——实测「把那封信收进袖口」整句不可达。
   *       这不是容量不够（整段上下文才 3.4k 字，远小于窗口），是根本没有召回这一步。
   *       主程序已有的检索索引（人物 / 线索 / 章节正文 / 消化档案）完全可用，
   *       实测同一句提问能命中第 3/4/5 章的档案块与章节正文——属于「有能力但没接」。
   *
   * 做法：用「本次提问 + 编辑器正文尾部」查一次索引，把命中的原文片段追加进上下文。
   *   ① 只在末尾追加，不动已有任何一块的顺序与内容；
   *   ② 零命中就一个字都不加（与关闭开关时字节一致）；
   *   ③ 跳过「人物」类命中——人物卡已由 buildCharBlock 完整注入，不必重复占预算；
   *   ④ 整段 try/catch，任何异常都返回空串，绝不让召回把参谋搞挂。
   * 回滚：CP_RAG 置 0 即逐字还原 v146 行为。
   * ============================================================ */
  window.CI_COUNSEL_FULL = 1;   /* v148：1=参谋拿全量章节清单；0=与 v147 逐字一致 */
  window.CP_RAG = 1;           /* 0=不召回，逐字还原 v146 行为；可在控制台改，立即生效 */
  function winAround(t, qTok, per) {
    /* 章节切片最长 8000 字，直接取开头 320 字拿到的常常是无关内容。
       以第一个命中词为中心开窗，前后带省略号表示是节选。 */
    try {
      if (!qTok) return t.slice(0, per);
      var best = -1;
      for (var k in qTok) {
        if (String(k).length < 2) continue;
        var p = t.indexOf(k);
        if (p >= 0 && (best < 0 || p < best)) best = p;
      }
      if (best < 0) return t.slice(0, per);
      var st = Math.max(0, best - Math.floor(per / 3));
      return (st > 0 ? '…' : '') + t.slice(st, st + per) + (((st + per) < t.length) ? '…' : '');
    } catch (e) { return t.slice(0, per); }
  }
  function buildRecallBlock(ctx) {
    if (!window.CP_RAG) return '';
    try {
      if (typeof ragRetrieve !== 'function' || typeof buildRagIndex !== 'function') return '';
      var q = (String(ctx.question || '') + ' ' + String(ctx.body || '').slice(-400)).trim();
      if (q.replace(/\s+/g, '').length < 2) return '';
      var hits = ragRetrieve(q, CFG.ragTop, buildRagIndex(null)) || [];
      if (!hits.length) return '';
      var qTok = null;
      try { qTok = (typeof _ragTok === 'function') ? _ragTok(q) : null; } catch (et) { qTok = null; }
      var lines = [], used = 0;
      for (var i = 0; i < hits.length && used < CFG.ragCap; i++) {
        var h = hits[i]; if (!h) continue;
        if (h.type === '人物') continue;
        var t = String(h.text || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        t = winAround(t, qTok, CFG.ragPer);
        if (!t) continue;
        var room = CFG.ragCap - used;
        if (t.length > room) t = t.slice(0, room);
        if (!t) continue;
        used += t.length;
        lines.push('· [' + (h.type || '材料') + '] ' + (h.title || '') + '：' + t);
      }
      if (!lines.length) return '';
      return '【按你的提问召回的相关剧情（可跨越早期章节，原文节选）】\n' + lines.join('\n') + '\n' +
        '用法：以上是检索命中的原文片段，可能只是节选、也可能只与提问部分相关。' +
        '引用时以这里的原文为准；片段没覆盖到的部分，直接说「档案里没有」，不要凭印象补全。\n';
    } catch (e) { return ''; }
  }

  /* ============================================================
   * 模块 D3（v148）：作者对本书的定调（故事结构面板）
   * 只输出「你填了的那几项」，一项没填就整个块不出现——
   * 未使用本面板的用户，上下文与改动前逐字相同。
   * ============================================================ */
  function buildStructBlock() {
    if (!window.STRUCT_TO_COUNSEL) return '';
    var s = null;
    try { s = (typeof loadStoryStruct === 'function') ? loadStoryStruct() : null; } catch (e) { s = null; }
    if (!s) return '';
    var lines = [];
    try {
      var f = (typeof SS_FIELDS !== 'undefined') ? SS_FIELDS : [];
      var nn = (typeof SS_NINE !== 'undefined') ? SS_NINE : [];
      var ll = (typeof SS_LINES !== 'undefined') ? SS_LINES : [];
      [['base', f], ['nine', nn], ['lines', ll]].forEach(function (p) {
        var g = s[p[0]] || {};
        (p[1] || []).forEach(function (it) {
          var v = String(g[it[0]] || '').trim();
          if (v) lines.push('· ' + it[1] + '：' + v.slice(0, 300));
        });
      });
    } catch (e2) { return ''; }
    if (!lines.length) return '';
    return '【作者对本书的定调（故事结构面板）】\n' + lines.join('\n') + '\n' +
      '用法：这是作者自己写下的本书骨架，优先级高于你的推断；与它冲突的走向先提出来问作者，不要自行改写。\n';
  }

  /* ============================================================
   * 模块 E：counselCtx 重写（原函数保留，仅不再被调用）
   * 复用主程序既有的 chapterIndexBlock / volName / getVolPov / getVolSetting / getDigest，
   * 只是把「人物卡 / 章号铁律 / 否决走向」三块换成增强版。
   * ============================================================ */
  /* ============================================================
   * 修复 4（B3）：参谋上下文的档案口径与生成侧对齐
   *
   * 原实现直接对 v.rolling 做 slice(0,1500)。rolling 是按章序滚动压缩的产物：
   * 头部 = 最老剧情，尾部 = 最新进展。只取头部等于把「最近几章发生了什么」整段切掉，
   * 参谋看到的剧情进度因此落后于正文。
   * 而生成侧走的是 volDigestForPrompt() = rolling + volRecentBlocks(vid,4)，
   * 再经 capDigestForPrompt() 做「头 + 尾」保留。两侧对同一段历史的口径不一样，
   * 于是「讨论时说好的」和「生成时写出来的」对不上。
   *
   * 现在改成与生成侧同一条口径。volDigestForPrompt / capDigestForPrompt 都是
   * index.html 里的全局函数声明，本模块可直接调用。
   * 三层兜底：① 生成侧函数可用 → 与生成侧逐字同源；
   *          ② 不可用 → 自建 head+tail；
   *          ③ 再失败 → 退回改动前的裸 slice。
   * 任何一层抛异常都不会让参谋挂掉（外层还有 counselCtx 的整体 try/catch）。
   * 回滚：window.CP_DIGEST_ALIGN = 0 即逐字还原改动前行为。
   * ============================================================ */
  window.CP_DIGEST_ALIGN = 1;           /* 1=档案节选口径对齐生成侧（头+尾）；0=保持原来的裸 slice */
  window.CP_DIGEST_ALIGN_BUDGET = 2600; /* 本卷档案节选的字数预算 */
  window.CP_DIGEST_GLOBAL_BUDGET = 1800;/* 全书总档案的字数预算（与改动前同额度） */
  function cpAlignBudget() { return Number(window.CP_DIGEST_ALIGN_BUDGET) || 2600; }
  function cpGlobalBudget() { return Number(window.CP_DIGEST_GLOBAL_BUDGET) || 1800; }
  /* 兜底用的头尾收敛：只有主程序 capDigestForPrompt 不可达时才走到这里 */
  function cpCapFallback(t, budget) {
    t = String(t || '');
    budget = budget || 2600;
    if (t.length <= budget) return t;
    var head = Math.min(1200, Math.floor(budget * 0.45));
    var tail = Math.max(400, budget - head);
    return t.slice(0, head) + '\n…（中间部分略，本段共 ' + t.length + ' 字）…\n' + t.slice(-tail);
  }
  function cpCap(t, budget) {
    t = String(t || '');
    budget = budget || 2600;
    if (t.length <= budget) return t;
    try {
      if (typeof capDigestForPrompt === 'function') return capDigestForPrompt(t, budget);
    } catch (e) {}
    return cpCapFallback(t, budget);
  }
  /* 本卷档案：与生成侧同源 = rolling + 最近 4 个卷块，再按头尾收敛。
     fallback 是改动前的裸 slice 结果，开关关闭时逐字返回它。 */
  function cpVolDigest(vol, fallback) {
    if (!window.CP_DIGEST_ALIGN) return fallback;
    try {
      if (typeof volDigestForPrompt !== 'function') return cpCap(fallback, cpAlignBudget());
      /* 先按大预算取整段，避免 volDigestForPrompt 内部先按默认 4000 截一次、
         外面再截一次，把尾部的最新进展二次削掉 */
      var t = volDigestForPrompt(vol, Math.max(cpAlignBudget(), 8000));
      if (t && String(t).trim()) return cpCap(String(t), cpAlignBudget());
    } catch (e) {}
    return cpCap(fallback, cpAlignBudget());
  }
  /* 全书总档案同样按头尾收敛（与改动前同额度）。
     它也是按时间线铺的，只取头部会重犯本卷档案那个「早期线索在、近期进展没了」的毛病。 */
  function cpGlobalDigest(g) {
    g = String(g || '');
    if (!window.CP_DIGEST_ALIGN) return g.slice(0, cpGlobalBudget());
    return cpCap(g, cpGlobalBudget());
  }

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
        var _scLog = cpLogScoped(); for (var li = _scLog.length - 1; li >= 0; li--) {
          if (_scLog[li] && _scLog[li].role === 'me') { q = String(_scLog[li].text || ''); break; }
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

      /* v166：块序重排——人物卡/分卷/已定状态等高优先级材料前置，章节清单后置。
         原序把全量章节清单（90 章规模约 2.5k 字）排在第一位，收敛输入按
         CTXCHARS 头部截断时，排在中后段的人物卡整段被切掉。 */
      s += '【本分卷】' + volName(vol) + '\n';
      try { var pov = getVolPov(vol); if (pov) s += '【本卷人称铁律】' + pov + '\n'; } catch (e3) {}
      try { var vs = getVolSetting(vol); if (vs) s += '【本卷设定】' + String(vs).slice(0, 900) + '\n'; } catch (e4) {}

      s += buildStructBlock();
      s += buildCharBlock(ctx);

      /* v166：定稿回流——#chBrief 里已锁定的定稿块注入参谋上下文。
         此前定稿内容对参谋完全不可见（counselCtx 不含 chBrief），已定死的
         开头/中间/结尾结构滑出聊天窗口后就被当待议项重开讨论。 */
      try {
        var _taB = document.getElementById('chBrief');
        var _bv = String((_taB && _taB.value) || '');
        var _fb = _bv.indexOf(CP_FINAL_BEGIN);
        if (_fb >= 0) {
          var _fe = _bv.indexOf(CP_FINAL_END, _fb);
          var _fblk = (_fe >= 0) ? _bv.slice(_fb, _fe + CP_FINAL_END.length) : _bv.slice(_fb, _fb + 3000);
          if (_fblk.length > 3000) _fblk = _fblk.slice(0, 3000) + '\n…（定稿块过长已截断，完整内容在「生成指令」框）';
          s += '【本章已锁定的定稿指令（作者已拍板。以下内容一律视为既定事实：不得重开讨论、不得当作待议项再次提问、不得建议改动，除非作者主动提出要改）】\n' + _fblk + '\n';
        }
      } catch (eB) {}

      /* 修复 3：先给「已经定了什么」，再给「不能提什么」。
         两块的相对顺序固定为 adopt → veto，与各自的开关状态无关。 */
      var ab = adoptBlock();
      if (ab) s += ab;
      var vb = vetoBlock();
      if (vb) s += vb;

      if (body.trim()) s += '【当前编辑器正文尾部】\n' + body.slice(-1200) + '\n';

      s += buildFactBlock();

      try {
        var d = getDigest(); var v = (d.volumes || {})[vol] || {};
        /* 修复 4：口径对齐生成侧（头+尾），fallback 是改动前的裸 slice(0,1500) */
        var roll = cpVolDigest(vol, ((v.rolling || '').trim() || (v.text || '')).slice(0, 1500));
        if (roll) s += '【本卷已消化档案（节选）】\n' + roll + '\n';
        var g = String(d.global || '').trim();
        if (g) s += '【全书总档案（跨卷脉络，判断连贯性以此为准）】\n' + cpGlobalDigest(g) + '\n';
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

      if (s.length < CFG.ragStop) s += buildRecallBlock(ctx);
    } catch (err) {
      /* 任何异常都退回主程序原实现，绝不让增强版本把参谋搞挂 */
      if (_origCounselCtx) { try { return _origCounselCtx(); } catch (e7) {} }
      return { text: '', chars: 0, vol: vol };
    }
    return { text: s, chars: s.length, vol: vol };
  };

  /* ============================================================
   * 模块 L（v152）：讨论要点的本地提炼器
   *
   * 原实现只取「最后一条 AI 回复」原文前 6000 字写进生成指令，带来三个问题：
   *   ① 跨轮结论全部丢失（讨论到第 8 轮时，第 1 轮定的走向已经不在指令里了）；
   *   ② 寒暄、复述提问、被推翻的备选方案照样进指令，白白烧 token；
   *   ③ 每点一次就追加一次，指令框无限膨胀。
   * 本模块从整轮讨论里摘结构化要点：走向 / 结论 / 情感落点 / 关键细节 / 待决问题。
   *
   * 关键取舍：**零 token**。不再额外调一次 AI 去总结（那等于为了省 token 先烧 token），
   * 全部用本地规则完成；任何异常或提炼收益不足都由调用方回退到旧行为。
   * 回滚：window.CP_DIGEST = 0 即逐字还原 v151 行为。
   * ============================================================ */
  window.CP_DIGEST = 1;        /* 1=提炼要点写进指令；0=旧行为（最后一条原文前 6000 字） */
  window.CP_DIGEST_MAX = 1800; /* 要点块总字数上限 */
  window.CP_DIGEST_TURN = 9999;  /* 参与提炼的最近轮数（v157：全量，不再丢早期轮次） */
  window.CP_DIGEST_LINE = 120; /* 单条要点字数上限 */
  /* 修复 1：提炼成功的判据改为「绝对量」，不再用压缩比例。
     minRate 用「要点字数 / 讨论原文字数」当判据是错的：要点条数被 DL.keep 与跨轮去重
     钉死后会迅速饱和（实测 ~560 字），而讨论原文字数随轮数线性增长，
     于是这个比值必然单调下降 —— 讨论越长越必定判定失败，回退到 v151 的旧行为。
     实测：单条回复 3000 字时，第 3 轮 rate=0.0609 勉强通过，第 4 轮起永久失败。 */
  window.CP_DIGEST_MINLEN = 200;  /* 要点块最短字数：低于此值判定提炼失败，回退原文 */
  window.CP_DIGEST_MINLINE = 6;   /* 最少条目数：少于此值同样判定失败，回退原文 */
  /* ★★ 这两个是「观测位」，不是现役开关 —— 默认值 0，本次发布不接入行为判定。★★
     来历：与 agent-app-engineer 讨论「提炼判据是否该按类别覆盖再卡一道」时留下的。
     结论是**不接**，两条理由：
       ① 实测样本下开关与否无差异（3/4/6/10 轮结果一致），既无收益也无伤害；
          没有收益的开关不该带着行为风险进发布版。
       ② 更关键：它判「不过」时的动作是 return null → 回退到「最后一条 AI 回复原文前
          6000 字」，而那正是用户投诉的对象。等于「判断出指令质量不够 → 换一条更差的」。
          这与本次事故的根因（v152 的 minRate 就是这么写的）是同一个错误，不能犯第二次。
     保留原因：等拿到真实 _counselLog 跑完对照后，若数据显示「确实存在一类讨论提炼不出
     决策信息」，再单独开一版改成「照样写要点块 + toast 明说缺什么」（需要
     buildCounselDigest 返回 {ok, reason} 而非 null，本版不做该重构）。
     0=不卡；2=要点至少覆盖 2 个分区 / 决策类（走向+结论）至少 2 条。 */
  window.CP_DIGEST_MINKIND = 0;
  window.CP_DIGEST_MINDECISIVE = 0;
  /* 缺陷 3a：1=列表项判定排除「小数开头」（0.5 秒后… 这类散文不再被当成列表项）；
     0=逐字回退到 v155 的旧正则。运行期可改，立即生效。 */
  window.CP_LIST_NUM = 1;
  /* 缺陷 3：走向候选抽不出来时是否在参谋回复下方给出说明。
     1=给（只对「有走向段头却没抽出候选」这两种成因给）；0=逐字回退（完全静默）。 */
  /* v166：场景完整性体检默认关闭（CP_GAP_CHECK=1 才启用）。
     原实现的场景清单是第77章讨论的产物，被当成了普适检查表：对其它章节，
     「待补缺口」会把羽毛感应/手链/请柬一类与本章无关的场景列成「未覆盖」，
     收敛 AI 按锁死铁律把它们当待锁死项处理——等于诱导编造。 */
  window.CP_GAP_CHECK = 0;
  window.CP_ROUTE_HINT = 1;

  var DL = {
    minLine: 6,     /* 已移交给 window.CP_DIGEST_MINLINE，此字段保留兼容，函数内不再读取 */
    minRate: 0.06,  /* 已不再作为成功判据；rate 现仅用于向作者展示压缩比例 */
    keep: { 走向: 6, 结论: 10, 情感: 5, 细节: 6, 待决: 3, 方向: 12, 排除: 8 },
    /* 判定顺序（供 dlClassify 用）：越具体的类越先判，避免「必须 / 之后」这类泛词把句子抢走。
       走向放最后判词典，但列表项（①②③）直接判为走向，见 dlClassify。
       这个顺序是对的，不能动。 */
    order: ["情感", "细节", "走向", "结论", "待决"],
    /* 修复 2：order 原先一个字段同时承担「判定顺序」与「预算分配顺序」，而这两者的
       要求是相反的——判定要具体类先判，预算要决策类先拿。现在拆成两个常量：
         clsOrder    → 判定顺序，与上面的 order 完全一致（dlClassify 用）
         budgetOrder → 预算分配与输出顺序（buildCounselDigest 用）
       order 保留原名，兼容任何外部引用。 */
    clsOrder: ["情感", "细节", "方向", "走向", "结论", "待决"],
    /* 预算分配顺序：决策类先拿预算。
       原先沿用判定顺序，情感(5)+细节(6) 先吃掉 1800 字里的约 1320 字，
       而真正决定下一轮写什么的「走向 / 结论」只剩约 480 字 ≈ 4 条。 */
    budgetOrder: ["走向", "结论", "方向", "待决", "排除", "细节", "情感"],
    lex: {
      /* 走向只收「未来动作与决策」：去掉了 之后 / 结尾 / 顺序 这类会被误命中的泛词 */
      走向: /(接下来|下一步|下一章|后续|走向|路线|分岔|建议走|建议(你|让|把|先)|不如|不妨|可以(考虑|试试|先)|最终|收束|摊牌|挑明|主动道歉|先开口|先低头|结局)/,
      结论: /(结论|小结|因此|所以|关键是|核心是|记住|注意|建议|应该|应当|务必|必须|不宜|不要|别让|避免|优先|前提|底线|换句话说|定下来|拍板|关键在于|要点是|取决于)/,
      情感: /(情感|感情|情绪|心动|暧昧|吃醋|醋意|冷战|哄|告白|表白|吻|拥抱|委屈|吃味|裂痕|信任|依赖|安抚|脸红|眼眶|鼻酸|心疼|失落|撒娇|不安|动心|柔软|酸涩|绷紧|松开|别扭|较劲)/,
      /* 细节不收「必须」：那是结论语气，收到结论区更准 */
      细节: /(伏笔|细节|呼应|回扣|道具|时间线|年表|顺序|先后|设定|规则|限制|保留|不要忘|不能忘|记得|埋|铺垫|flag|FLAG|手势|口头禅|习惯|伤疤|信物|铁律|禁区)/,
      待决: /(要不要|需不需要|你觉得呢|还是说|待定|还没想好|你自己定|二选一|取决于你)/,
      方向: /(节奏|主线|脉络|结构|主题|立意|动机|世界观|叙事|视角|人称|基调|张力|冲突|开场|开头|结尾|收尾|场景|时间线|顺序)/
    },
    /* 列表项：①②③ / 1. / - 。参谋列举「可选走向」时用的就是这些，
       它们本身即候选走向，不能再被词典判到别处去 */
    list: (window.CP_LIST_NUM === 0)
      ? /^([①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2}[.、)]|[-•·>])\s*/
      : /^([①②③④⑤⑥⑦⑧⑨⑩]|\*\*\d{1,2}\.\*\*|\d{1,2}(?:\.(?!\d)|[、)])|[-•·>])\s*/,
    /* 噪声句：寒暄 / 能力声明 / 免责声明 / 复述 —— 一律不进指令 */
    noise: /(你好|很高兴|希望.{0,4}(有帮助|帮到你)|如果你还有|以上(是|为)?(我的)?(分析|建议|看法)|仅供参考|祝(你)?写作顺利|还有什么可以帮|我明白了|明白你的意思|有问题随时|随时(告诉|找我)|这只是.{0,8}可能|当然，?这只是|^好的[，,。]?$|谢谢你的(提问|补充))/,
    /* 同上：剥列表头时也必须跳过小数，否则「0.5 秒后」被削成「5 秒后」。 */
    head: (window.CP_LIST_NUM === 0)
      ? /^([①②③④⑤⑥⑦⑧⑨⑩]|[-•·*>]|\d{1,2}[.、)]|\*\*|##+)\s*/
      : /^([①②③④⑤⑥⑦⑧⑨⑩]|[-•·*>]|\*\*\d{1,2}\.\*\*|\d{1,2}(?:\.(?!\d)|[、)])|\*\*|##+)\s*/,
    md: /[*_`#>{}\[\]]/g,
    /* v166：去第77章硬编码。决策加分只认通用拍板语——原词典全是第77章特定剧情词，
       对其它章节的讨论一句都命不中，+25 加分形同虚设。 */
    decision: /(就按|定死|定下来|就这么定|拍板|锁死|不再问|已确定|定稿指令)/,
    exclude: /(排除|砍掉|砍了|砍[。！？；，,、]|整段砍|整节砍|一律不能用|不能这么用|这章不碰|这章不出现|本章不出现|这章不出场|本章不出场|不当(已知)?(事实)?写|否掉|已否决|否决|废掉|作废|降级|仅备查|备查|不列(入|为)(正文|选项))/,
    pending: /(待定|未定|未确认|还没定|没定|二选一|保留还是砍|保留还是|要不要保留|要不要|是否保留|是否|取决于你|你自己定|还没想好|留个口子|具体.{0,4}(待定|未定))/,
    outline: /^([一二三四五六七八九十]{1,2}[、.．]|[A-Ga-g][.、)．]|第\d{1,2}[条章节])/,
    /* v167：原场景锚是第76/77章的专属清单（克劳奇线/羽毛感应/沙菲克线/手链/请柬/第76章…），
       对其它章节全部失配，且一旦开启场景体检就会把上一章的场景当作本章的「待补缺口」，
       诱导模型去补写从未讨论过的情节——正是跨章污染的第二个通道。
       现改为与内容无关的通用结构锚，只认「章节部位」不认具体剧情。 */
    scenes: [
      { n: '开场', re: /开场|开头|第一句|起笔/ },
      { n: '中段', re: /中段|中间|过渡|转场/ },
      { n: '结尾', re: /结尾|收尾|最后一?句|落点/ },
      { n: '伏笔/线索', re: /伏笔|线索|呼应|铺垫|回收|钩子/ },
      { n: '人物关系', re: /关系|对手戏|互动|对手/ }
    ],
    /* v159：跨句状态归并 + 矛盾消解
       subjects → 关键决策点的主题锚，用于把同一决策点散落在多分区、多轮的讨论归并成
                  一条「最终状态」（时间序覆盖，后写覆盖前写）。
       conflict → 矛盾信号词：讨论里明说「矛盾/冲突/二选一/vs/互相抢」的地方，
                  即真正的未收敛冲突点，标记为「需裁定」。 */
    /* v159：跨句状态归并 + 矛盾消解
       v166：subjects 原是第77章讨论的 11 个决策点主题锚（全部为该章特定决策点），
       对其它章节全部失配。收敛输入已改喂讨论原文（见 cpHybridUser），
       状态归并与矛盾消解交由收敛 AI 在原文上自行完成，本地锚清空。
       conflict 保留：无锚冲突句（orphanConflicts）的收集逻辑不变。 */
    subjects: [],
    conflict: /(两条是矛盾的|是矛盾的|存在.{0,4}冲突|位置冲突|隐性冲突|互相抢功|抢功|vs\s*)/
  };

  /* 一条待判定的句子 */
  function dlClean(s) {
    s = String(s || "").replace(/\r/g, " ").trim();
    s = s.replace(DL.head, "").replace(DL.head, "");
    s = s.replace(DL.md, "");
    s = s.replace(/\s{2,}/g, " ").trim();
    if (s.length > CFG.dLineMax()) s = s.slice(0, CFG.dLineMax()) + "…";
    return s;
  }
  CFG.dLineMax = function () { return Number(window.CP_DIGEST_LINE) || 120; };
  /* ④ 情节决策原文清理：与 dlClean 相同，但不做 120 字截断，保留决策原文完整 */
  function dlFull(s) {
    s = String(s || "").replace(/\r/g, " ").trim();
    s = s.replace(DL.head, "").replace(DL.head, "");
    s = s.replace(DL.md, "");
    s = s.replace(/\s{2,}/g, " ").trim();
    return s;
  }

  function dlKey(s) { return String(s || "").replace(/[\s，。、；：！？!?,;:（）()「」《》"'…—\-·*#]/g, "").slice(0, 60); }

  function dlCharNames() {
    var ns = [];
    try {
      (load("chars", []) || []).forEach(function (c) {
        var n = String((c && c.name) || "").trim();
        if (n.length >= 2) ns.push(n);
      });
    } catch (e) {}
    return ns;
  }

  /* 把一轮讨论文本切成候选句（按行 + 句号/问号/分号二次切） */
  function dlSplit(text) {
    var out = [];
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var ln = String(raw || "").trim();
      if (!ln) return;
      if (DL.noise.test(ln)) return;
      /* 标题行（【xx】）单独成条，是有价值的分区信息 */
      String(ln).split(/(?<=[。！？；])/).forEach(function (seg) {
        var s = String(seg || "").trim();
        if (s.length >= 6) {
          /* v158：提纲标题残留（「九、某某场景那段」「B. 他带回来的东西」）
             是讨论的问题列表，不是指令，短句即丢 */
          if (DL.outline.test(s) && s.length < 22) return;
          out.push(s);
        }
      });
    });
    return out;
  }

  function dlClassify(s) {
    /* 判定顺序：具体类先判（clsOrder），与预算分配顺序无关 */
    for (var i = 0; i < DL.clsOrder.length; i++) {
      var k = DL.clsOrder[i];
      if (DL.lex[k].test(s)) return k;
    }
    return "";
  }

  /* v159：按主题锚归并——返回句子命中的决策点名称，未命中返回 null */
  function dlSubject(s) {
    for (var i = 0; i < DL.subjects.length; i++) {
      if (DL.subjects[i].re.test(s)) return DL.subjects[i].n;
    }
    return null;
  }

  /* 打分：v166 反转为用户 > AI——作者的判断优先于参谋的复述（原实现 AI+10 > 用户+6，
     是「作者原话被丢、AI 复述存活」的权威倒置的一半成因） */
  function dlScore(s, meta, names) {
    var sc = meta.role === "ai" ? 5 : 12;
    sc += Math.min(meta.rec, 6);                              /* 最近程度 0..6 */
    for (var i = 0; i < names.length; i++) { if (s.indexOf(names[i]) >= 0) { sc += 4; break; } }
    var L = s.length;
    if (L >= 12 && L <= 90) sc += 3; else if (L > 90) sc += 1;
    if (/^[①②③④⑤⑥]/.test(s)) sc += 2;  /* 明确的可选走向列表项 */
    if (DL.decision.test(s)) sc += 25;  /* 情节决策句优先召回 */
    return sc;
  }

  /* ============================================================
   * 模块 F：线索 / 指令扩容（缺陷 4）
   * ============================================================ */
  counselToPlot = function () {
    try {
      var last = null;
      var _scLog = cpLogScoped(); for (var i = _scLog.length - 1; i >= 0; i--) { if (_scLog[i].role === 'ai') { last = _scLog[i]; break; } }
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

  /* 从整轮讨论里提炼要点块。失败（讨论太短 / 没有结论句）返回 null，由调用方回退原文。 */
  function buildCounselDigest() {
    try {
      var log = cpLogScoped();
      var turnMax = Number(window.CP_DIGEST_TURN) || 12;
      var src = log.slice(-turnMax);
      if (!src.length) return null;
      var names = dlCharNames();
      var vetoed = vetoGet(), adopted = adoptGet();
      var bucket = { 走向: [], 结论: [], 情感: [], 细节: [], 待决: [], 方向: [], 排除: [] };
      var seen = {}, rawLen = 0;
      /* ② 已采纳走向全保留：不再受 keep.走向=6 与 CP_DIGEST_MAX 上限约束。
         同时把已采纳句子的 key 标记进 seen，避免它在讨论原文里重复出现时被二次计入 */
      var adoptedFull = adopted.map(function (t) { return '（已确定）' + String(t); });
      adopted.forEach(function (t) { seen[dlKey(String(t))] = 1; });
      /* ④ 情节决策原文存档：命中 DL.decision 的句子原文（不截断）单独收集 */
      var decisions = [], dSeen = {};
      var subjMap = {};
      var orphanConflicts = [];
      for (var i = 0; i < src.length; i++) {
        var it = src[i]; if (!it) continue;
        var txt = String(it.text || '');
        rawLen += txt.length;
        var meta = { role: it.role || 'ai', rec: Math.min(6, Math.round((i + 1) / src.length * 6)) };
        dlSplit(txt).forEach(function (seg) {
          if (DL.noise.test(seg)) return;
          /* v166：用户发言不做 120 字截断——作者的要求原样保留（AI 回复仍截） */
          var clean = (it.role === 'me') ? dlFull(seg) : dlClean(seg);
          if (clean.length < 6) return;
          var k = dlKey(clean);
          if (seen[k]) return;
          /* 被否决的走向，即使原文里又提了一次也不再进指令 */
          for (var v = 0; v < vetoed.length; v++) {
            if (String(vetoed[v]).length >= 8 && clean.indexOf(String(vetoed[v]).slice(0, 12)) >= 0) return;
          }
          /* 列表项（参谋列举「可选走向」时用的 ①②③/1./-）本身就是候选走向，
             不再交给词典判定——否则跨轮定的那条走向会因为措辞朴素而被丢掉 */
          var isList = DL.list.test(seg);
          /* ④ 情节决策原文存档：命中决策词典的句子原文（不截断）单独收集，独立于分类 */
          if (DL.decision.test(seg)) {
            var full = dlFull(seg);
            var dk = dlKey(full);
            if (full.length >= 6 && !dSeen[dk]) { dSeen[dk] = 1; decisions.push(full); }
          }
          /* v158：排除/待决 在词典分类前独立前置判定，对齐 DeepSeek 的
             「已砍清单 + 未定状态标记」。待决最优先（「保留还是砍?」这类二选一
             必须先归未定态，不能因含「砍」字被误判为排除），排除次之，最后才走 isList/dlClassify。 */
          var kind;
          if (DL.pending.test(clean)) kind = '待决';
          else if (DL.exclude.test(clean)) kind = '排除';
          else kind = isList ? '走向' : ((it.role === 'me' && /[？?]/.test(clean)) ? '待决' : dlClassify(clean));
          /* v166：用户陈述句免词典过滤——不命中任何词典也按作者指令收进结论区。
             原实现直接 return，实测把「惊喜互动/冲淡恐怖压抑/暗藏付出/暗中观察」
             这类无关键词的作者核心要求整句丢弃，只留下命中「建议」等词的参谋复述。 */
          if (!kind && it.role === 'me') kind = '结论';
          if (!kind) return;
          seen[k] = 1;
          /* 「建议走②」这类拍板句置顶，避免三个互斥候选并列时模型拿不准 */
          var bonus = (isList ? 10 : 0) + (/建议走|就按|按②|按①|按③|采用/.test(clean) ? 12 : 0);
          bucket[kind].push({ text: clean, sc: dlScore(clean, meta, names) + bonus });
          /* v159：跨句状态归并 + 矛盾消解（在句子已判出 kind 之后执行）
             归并：同一决策点（主题锚）的多句按时间序记录最新状态（后写覆盖前写）；
             消解：命中 conflict 信号词的句子，把该决策点标记为「需裁定」。 */
          var subj = dlSubject(clean);
          var isConf = DL.conflict.test(clean);
          if (subj) {
            /* 状态判定：沿用全句 kind（待决/排除/已定）。窗口定位经实测在同句多主题
               紧挨时无法切断（「手链笔」句里「羽毛降级」紧邻），反引入切词误判，故回退 */
            var st = kind === '待决' ? '待决' : (kind === '排除' ? '排除' : '已定');
            /* 状态强度：排除(3) > 待决(2) > 已定(1)。只有强度不低于当前记录的才覆盖 */
            var sw = st === '排除' ? 3 : (st === '待决' ? 2 : 1);
            var rec = subjMap[subj];
            if (!rec) { rec = subjMap[subj] = { state: st, text: clean, conflict: false, w: 0 }; }
            if (sw >= rec.w) { rec.state = st; rec.text = clean; rec.w = sw; }
            if (isConf) rec.conflict = true;
          } else if (isConf) {
            /* v160：无主题锚的冲突句（如「条目2(a)和条目4存在隐性冲突」）单独收集，
               conflict 词典已精确化，只收明确的决策冲突信号 */
            orphanConflicts.push(clean);
          }
        });
      }
          /* ② 已采纳走向全保留：由 adoptedFull 在输出区前置，不再受 keep/上限约束 */

      var max = Number(window.CP_DIGEST_MAX) || 1800;
      var pickedBy = {}, total = 0, kept = 0;
      /* 修复 2：按 budgetOrder 分配预算，让「走向 / 结论 / 待决」这些决策类先拿 */
      DL.budgetOrder.forEach(function (kind) {
        var list = bucket[kind].slice().sort(function (a, b) { return b.sc - a.sc; });
        var cap = DL.keep[kind] || 4, arr = [];
        for (var j = 0; j < list.length && arr.length < cap; j++) {
          var t = list[j].text;
          var dup = false;
          for (var m2 = 0; m2 < arr.length; m2++) {
            var ka = dlKey(arr[m2]), kb = dlKey(t);
            if (ka.indexOf(kb) >= 0 || kb.indexOf(ka) >= 0) { dup = true; break; }
          }
          if (dup) continue;
          if (total + t.length > max) continue;
          arr.push(t); total += t.length; kept++;
        }
        if (arr.length) pickedBy[kind] = arr;
      });
      var _minLine = Number(window.CP_DIGEST_MINLINE) || 6;
      if (kept < _minLine) return null;
      /* 修复 2：输出顺序与预算分配顺序一致（决策类在前），
         否则刚把走向/结论抢到预算，又把情感/细节排到块首，作者看到的重点还是错的 */
      var adoptedBlock = adoptedFull.length
        ? '【走向 · 已确定（全保留）】\n' + adoptedFull.map(function (t) { return '· ' + t; }).join('\n')
        : '';
      var decisionBlock = decisions.length
        ? '【情节决策 · 原文存档】\n' + decisions.map(function (t) { return '· ' + t; }).join('\n')
        : '';
      var body = (adoptedBlock ? adoptedBlock + '\n' : '') + (decisionBlock ? decisionBlock + '\n' : '')
        + DL.budgetOrder.filter(function (k) { return pickedBy[k] && pickedBy[k].length; })
        .map(function (k) { return '【' + k + '】\n' + pickedBy[k].map(function (t) { return '· ' + t; }).join('\n'); })
        .join('\n');
      if (!body) return null;
      /* 修复 1：rate 只用于向作者展示压缩比例，不再作为成功判据 */
      var rate = rawLen ? (body.length / rawLen) : 0;
      /* 真正的空结果下限保护：要点块太短说明这次讨论确实没提炼出东西。
         80 字是硬下限，不受 CP_DIGEST_MINLEN 影响——它代表「确实没有可提炼内容」；
         CP_DIGEST_MINLEN（默认 200）是可调的「够不够用」标准。 */
      if (body.length < 80) return null;
      var _minLen = Number(window.CP_DIGEST_MINLEN) || 200;
      if (body.length < _minLen) return null;
      /* 可选：类别覆盖判据（与 agent-app-engineer 讨论后加的可选闸门）。
         作者要的是「走向 / 结论」这类能定下一轮写什么的决策信息；一份只有
         情感/细节、没有任何决策条的要点块，即使字数够，作为「生成指令」也不成立。
         两个开关默认 0（关闭）—— 关闭时行为与 team-lead 的规格逐字一致；
         置为 2 即启用「至少覆盖 2 类 / 决策类至少 2 条」。
         ★ 注意：触发时当前实现是回退到旧行为（原文前 6000 字）。而原文正是作者投诉的
           对象，所以在闸门打开前请先跑 verify_replay.js 量一遍——我的建议是把它改成
           「提示」而不是「回退」，见给 team-lead 的说明。 */
      var _minKind = Number(window.CP_DIGEST_MINKIND) || 0;
      var _minDec = Number(window.CP_DIGEST_MINDECISIVE) || 0;
      if (_minKind > 0) {
        var _kinds = 0;
        for (var _k in pickedBy) { if (pickedBy[_k] && pickedBy[_k].length) _kinds++; }
        if (_kinds < _minKind) return null;
      }
      if (_minDec > 0) {
        var _dec = ((pickedBy['走向'] || []).length) + ((pickedBy['结论'] || []).length);
        if (_dec < _minDec) return null;
      }
      /* v158：场景完整性体检 + 缺口清单，对齐 DeepSeek 的「待补给缺口汇总」。
         缺覆盖的场景在输出末尾提示，纯增量、不改变现有提炼与 minLen 判据 */
      var missing = [];
      if (window.CP_GAP_CHECK) DL.scenes.forEach(function (sc) { if (!sc.re.test(body)) missing.push(sc.n); });
      var gapBlock = missing.length
        ? '\n【待补缺口 · 本轮讨论未覆盖】\n' + missing.map(function (n) { return '· ' + n; }).join('\n')
        : '';
      /* v159：跨句状态归并 + 矛盾消解 的输出区
         状态归并：把同一决策点的最终状态单列，消除散落多分区的冗余；
         矛盾提示：把含冲突信号词的决策点单列，显式标记「需裁定」，避免模型拿矛盾指令去写 */
      var subjNames = [];
      for (var sn in subjMap) { if (subjMap[sn]) subjNames.push(sn); }
      subjNames.sort(function (a, b) { return a.length - b.length; });
      var mergeBlock = subjNames.length
        ? '\n【状态归并 · 各决策点最终态】\n' + subjNames.map(function (n) {
            var r = subjMap[n];
            return '· ' + n + ' → ' + r.state + (r.conflict ? '（需裁定）' : '') + '：' + r.text;
          }).join('\n')
        : '';
      var conflicts = subjNames.filter(function (n) { return subjMap[n] && subjMap[n].conflict; });
      var allConflicts = conflicts.map(function (n) { return n + '：' + subjMap[n].text; })
        .concat(orphanConflicts.map(function (t) { return '（未归类冲突）' + t; }));
      var conflictBlock = allConflicts.length
        ? '\n【矛盾提示 · 需人工裁定】\n' + allConflicts.map(function (t) { return '· ' + t; }).join('\n')
        : '';
      var block = '【剧情参谋要点 · 下一轮据此写】\n' + body + mergeBlock + conflictBlock + gapBlock
        + '\n（由最近 ' + src.length + ' 条讨论本地提炼：原文 ' + rawLen + ' 字 → 要点 ' + body.length + ' 字。'
        + '要点用于约束下一轮走向；涉及具体措辞与事实仍以正文为准）\n' + CP_END;
      /* ④ 情节决策原文存档：幂等覆盖写 KV，跨会话可查（与 counselAdopted/counselVeto 并列） */
      try { put('counselDecision', { at: now(), items: decisions }); } catch (e) {}
      return { text: block, raw: rawLen, chars: body.length, kept: kept, rate: rate, turns: src.length, decisions: decisions.length, excluded: (pickedBy['排除'] || []).length, gaps: missing.length, merged: subjNames.length, conflicts: allConflicts.length };
    } catch (e) { return null; }
  }

  /* 标记块：写入可幂等替换，不再一味追加 */
  var CP_BEGIN = '【剧情参谋要点 · 下一轮据此写】';
  var CP_END = '【要点完】';
  var _cpBriefBak = null;
  function cpWriteBrief(block) {
    var ta = document.getElementById('chBrief');
    if (!ta) return false;
    _cpBriefBak = ta.value;
    var v = String(ta.value || ''), b = v.indexOf(CP_BEGIN);
    if (b >= 0) {
      var e = v.indexOf(CP_END, b);
      if (e >= 0) { v = v.slice(0, b) + block + v.slice(e + CP_END.length); }
      else {
        var nx = v.indexOf('\n【', b + 1);
        v = (nx > 0) ? (v.slice(0, b) + block + v.slice(nx + 1)) : (v.slice(0, b) + block);
      }
      v = v.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    } else {
      v = (v ? v + '\n' : '') + block;
    }
    ta.value = v;
    cpPersistBrief();     /* 程序赋值不触发 input，必须显式落盘，否则切章就蒸发 */
    return true;
  }
  /* ============================================================
   * 修复 5（P2-1）：三条回退路径的幂等写入
   *
   * 原先三处（开关关闭 / 讨论过短 / 提炼失败）都是无脑
   *   ta.value = (ta.value ? ta.value + '\n' : '') + '【剧情参谋结论 · 下一轮据此写】\n' + kept;
   * 点几次就往指令框里堆几段，而且没有备份 —— 于是 window.cpUndoBrief() 在这条路径上
   * 会回滚到一个过期的、更早的值，等于把中间几次写入一起吃掉。
   *
   * 现在统一走 cpWriteLegacy()：按旧块头定位，有则整块替换、无则追加，并在写入前备份。
   * ============================================================ */
  var CP_LEGACY_BEGIN = '【剧情参谋结论 · 下一轮据此写】';
  function cpWriteLegacy(kept) {
    var ta = document.getElementById('chBrief');
    if (!ta) return false;
    /* 必须备份：否则回退路径上的「撤销」会回滚到更早的过期值 */
    _cpBriefBak = ta.value;
    var v = String(ta.value || '');
    var b = v.indexOf(CP_LEGACY_BEGIN);
    if (b < 0) {
      ta.value = (v ? v + '\n' : '') + CP_LEGACY_BEGIN + '\n' + kept;
      cpPersistBrief();   /* 程序赋值不触发 input，必须显式落盘 */
      return true;
    }
    /* 已有旧块：从块头一直替换到块尾。块尾取「下一个【要点完】」或「下一个【…】段头」，
       都没有就到文末——保证再点一次是替换而不是叠加。 */
    var stop = -1;
    var e = v.indexOf(CP_END, b);
    if (e >= 0) stop = e + CP_END.length;
    else {
      var nx = v.indexOf('\n【', b + 1);
      stop = (nx > 0) ? (nx + 1) : v.length;
    }
    ta.value = (v.slice(0, b) + CP_LEGACY_BEGIN + '\n' + kept + v.slice(stop))
      .replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    cpPersistBrief();     /* 同上 */
    return true;
  }
  window.cpUndoBrief = function () {
    try {
      var ta = document.getElementById('chBrief');
      if (!ta || _cpBriefBak === null) { toast('没有可撤销的上一步'); return; }
      ta.value = _cpBriefBak; _cpBriefBak = null;
      cpPersistBrief();     /* 撤销也是一次写入：不落盘的话切章后库里还是写入后的值，撤销被静默回滚 */
      toast('已撤销上一次写入');
    } catch (e) {}
  };
  /* 清理由旧版本累积的原文块（v152 之前的「剧情参谋结论」整段）——需作者显式调用，
     绝不自动删你没确认过的内容 */
  window.cpBriefClearOld = function () {
    try {
      var ta = document.getElementById('chBrief'); if (!ta) return;
      var before = String(ta.value || '').length;
      ta.value = String(ta.value || '').replace(/【剧情参谋结论[^\n]*\n[\s\S]{0,6000}?(?=\n【|$)/g, '')
        .replace(/\n{3,}/g, '\n\n').trim();
      cpPersistBrief();     /* 清理是一次删除型写入，同样要落盘，否则切章后旧块又回来 */
      toast('已清理旧版原文块：指令 ' + before + ' 字 → ' + String(ta.value || '').length + ' 字');
    } catch (e) { toast('清理失败：' + (e && e.message)); }
  };

  counselToBrief = function () {
    try {
      var last = null;
      var _scLog = cpLogScoped(); for (var i = _scLog.length - 1; i >= 0; i--) { if (_scLog[i].role === 'ai') { last = _scLog[i]; break; } }
      if (!last) { toast('还没有参谋的回复可以落地'); return; }
      var ta = document.getElementById('chBrief');
      if (!ta) return;
      var full = String(last.text || '');
      var kept = full.slice(0, CFG.briefCap);

      /* 开关关闭 = 逐字还原 v151 行为：最后一条原文前 6000 字，写进指令。
         修复 5：走 cpWriteLegacy 保证幂等（原来是每点一次追加一段） */
      if (!window.CP_DIGEST) {
        if (cpWriteLegacy(kept)) {
          var cut = full.length - kept.length;
          toast(cut > 0
            ? ('已写进「生成指令」（' + kept.length + ' 字，超出的 ' + cut + ' 字被截断）')
            : ('已写进「生成指令」（' + kept.length + ' 字，完整写入）'));
        }
        return;
      }

      /* 讨论本身就短时，提炼没有收益（分区标题反而让它变长）——直接原样写入 */
      var rawTotal = 0;
      try {
        cpLogScoped().slice(-(Number(window.CP_DIGEST_TURN) || 12)).forEach(function (x) { rawTotal += String((x && x.text) || '').length; });
      } catch (e2) {}
      if (rawTotal <= 700) {
        if (cpWriteLegacy(kept)) toast('讨论较短（' + rawTotal + ' 字），已原样写进「生成指令」');
        return;
      }

      var d = buildCounselDigest();
      if (!d) {
        /* 提炼不出足够要点时回退原文：宁可多烧，也不丢信息。
           修复 1 之后这条路径已很少触发（原先 ≥4 轮讨论 100% 走这里）。
           文案不再暗示「你讨论得不够」——那会把参数阈值问题误导成作者的问题。 */
        if (cpWriteLegacy(kept)) toast('这次没提炼出足够要点，已按原样写入 ' + kept.length + ' 字（可运行 cpBriefClearOld() 清理历史累积）');
        return;
      }
      if (cpWriteBrief(d.text)) {
        toast('已提炼 ' + d.kept + ' 条要点写进「生成指令」：原文 ' + d.raw + ' 字 → 要点 ' + d.chars
          + ' 字（省 ' + Math.round((1 - d.rate) * 100) + '%）；写错了可撤销');
      }
    } catch (e) { toast('写入指令失败：' + (e && e.message)); }
  };

  /* ============================================================
   * 模块 H：定稿指令出口 counselFinalizeBrief()
   *
   * 作者（产品经理）反馈里最核心的一条：「他一直问，但是得不出一个准确的总结性
   * AI 指令，走向、情节梳理、线索、伏笔及结论」。
   * 产品里原先没有这个出口，只有两类东西：
   *   ① v152 的本地提炼器 —— 产出 5 类「无状态」要点，且长讨论里根本不执行（P0-1）；
   *   ② 「写进本章指令」   —— 要么塞最后一条回复的原文，要么塞一堆没有定/未定之分
   *      的要点，两者都当不了「定稿」。
   * 作者要的是一份**带状态**的定稿：每条标明 已定 / 待定 / 未定 / 排除，
   * 并单独列出「已砍掉、不列入正文」的部分——这样下一轮生成才知道什么必须遵守、
   * 什么还在议、什么已经不要了。
   *
   * 与 counselToBrief 的三点本质区别：
   *   ① 输入是**整轮讨论**（CP_FINAL_TURNS=40，按字符预算从后往前尽量多带），
   *      不是「最近 8 条」——作者抱怨的长期记忆遗忘，在定稿出口必须补回来；
   *   ② 采纳 / 否决清单显式喂给模型，让它有「已定」与「排除」的判定依据；
   *   ③ 输出带状态标记，且第五条固定为「已排除」。
   *
   * 五条降级路径全部兜回 counselToBrief()，绝不写入空指令或半截指令。
   * 回滚：window.CP_FINAL_BRIEF = 0 即逐字还原（转调原逻辑）。
   * ============================================================ */
  /* v165：定稿出口默认退役（被「生成定稿指令」=混合提炼取代；其允许【未定】进指令框是质量漏洞）。
     注意：此赋值必须晚于 index.html 侧语义生效——本文件加载在后，若这里写死 1 会把 index 的 0 覆盖掉。 */
  window.CP_FINAL_BRIEF = 0;      /* 1=启用定稿出口；0=按钮隐藏且函数转调 counselToBrief（回滚改 1） */
  window.CP_FINAL_MAXCHARS = 2600; /* 定稿块字符上限 */
  window.CP_FINAL_MAXLINES = 40;   /* 条目上限 */
  window.CP_FINAL_LINEMAX = 120;   /* 单条上限，超出截断加… */
  window.CP_FINAL_TURNS = 40;      /* 参与定稿的最近条数（尽量覆盖全轮） */
  /* 以下为调用参数与输入预算，同样挂 window，使用处现读 */
  window.CP_FINAL_INCHARS = 24000;  /* 喂给模型的讨论原文预算 */
  window.CP_FINAL_CTXCHARS = 8000;  /* 喂给模型的上下文预算（v166：4000→8000。
     原值配合头部截断会把排在中后段的人物卡整段切掉——90 章规模实测人物卡
     从第 3772 字才开始，4000 字线只放进来 228 字，收敛 AI 写人设红线时手里
     根本没有人物卡。块序重排（见 counselCtx）+ 预算翻倍双保险。 */
  window.CP_FINAL_TEMP = 0.55;      /* 定稿要稳，明显低于参谋讨论的 0.85 */
  window.CP_FINAL_MAXTOK = 3000;
  window.CP_FINAL_MODEL = '';       /* 空 = 用参谋同款模型（ai.counselModel || deepseek-flash） */

  var CP_FINAL_BEGIN = '【剧情定稿指令';
  /* ★ 结束标记用独立的【定稿完】，不复用要点块的【要点完】——已与 team-lead 确认，不要合并。
     原因：定稿块与要点块可以在指令框里并存。若两者共用结束标记，
     cpWriteBrief 用 indexOf(CP_END, b) 定位要点块结尾时，可能截到定稿块的尾巴上
     （嵌套误判，定位到错误偏移）。各自独立后互不干扰，已断言两种块共存时各只有一个。
     注意 CP_FINAL_BEGIN 只取到「【剧情定稿指令」不含章号——章号会变，只用它做定位。 */
  var CP_FINAL_END = '【定稿完】';

  /* 把模型返回收敛成行数组：去块头、去 Markdown 符号、按单条上限截断 */
  function cpFinalLines(raw) {
    var lines = String(raw || '').split(/\r?\n/);
    var out = [];
    var lineMax = Number(window.CP_FINAL_LINEMAX) || 120;
    for (var i = 0; i < lines.length; i++) {
      var ln = String(lines[i] || '').replace(/\r/g, '').trim();
      if (!ln) continue;
      if (ln.indexOf(CP_FINAL_BEGIN) === 0) continue;      /* 块头由我们生成，不要模型那份 */
      if (ln === CP_FINAL_END || ln === CP_END) continue;  /* 结束标记同样由我们生成 */
      ln = ln.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/^>\s*/, '').trim();
      if (!ln) continue;
      if (ln.length > lineMax) ln = ln.slice(0, lineMax) + '…';
      out.push(ln);
    }
    return out;
  }

  /* 定稿块的幂等写入：与 cpWriteBrief 同一套机制（按块头定位 + 整块替换 + 写前备份），
     共用 _cpBriefBak，所以 window.cpUndoBrief() 对两种块都能撤回。
     结束标记用独立的【定稿完】，避免与要点块的【要点完】互相干扰定位。 */
  function cpWriteFinal(block) {
    var ta = document.getElementById('chBrief');
    if (!ta) return false;
    _cpBriefBak = ta.value;
    var v = String(ta.value || '');
    var b = v.indexOf(CP_FINAL_BEGIN);
    if (b < 0) {
      ta.value = (v ? v + '\n' : '') + block;
      cpPersistBrief();   /* 首次写入走这条分支，同样必须落盘 */
      return true;
    }
    var stop = -1;
    var e = v.indexOf(CP_FINAL_END, b);
    if (e >= 0) stop = e + CP_FINAL_END.length;
    else {
      var nx = v.indexOf('\n【', b + 1);
      stop = (nx > 0) ? (nx + 1) : v.length;
    }
    ta.value = (v.slice(0, b) + block + v.slice(stop))
      .replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    cpPersistBrief();     /* 程序赋值不触发 input，必须显式落盘 */
    return true;
  }

  /* v164 降级路径专用写入：DeepSeek 收敛不可用（未配置 AI / 异常 / 空返回 / 格式不符）时，
     只能落本地要点块——但本地要点块含【待决】，深度续写读到会留白编造。
     这里做两件防护（单次备份，撤销一步到位）：
       ① 先清除旧的锁死版定稿块（CP_FINAL_BEGIN..CP_FINAL_END）——
          否则旧定稿与新要点并存，深度续写会同时吃到两套互相矛盾的指令；
       ② 再写本地要点块，由调用方用 toast 明确警告「未收敛，深度续写可能留白」。 */
  function cpWriteBriefDegraded(block) {
    var ta = document.getElementById('chBrief');
    if (!ta) return false;
    _cpBriefBak = ta.value;
    var v = String(ta.value || '');
    var b = v.indexOf(CP_FINAL_BEGIN);
    if (b >= 0) {
      var stop = -1;
      var e = v.indexOf(CP_FINAL_END, b);
      if (e >= 0) stop = e + CP_FINAL_END.length;
      else {
        var nx = v.indexOf('\n【', b + 1);
        stop = (nx > 0) ? (nx + 1) : v.length;
      }
      v = (v.slice(0, b) + v.slice(stop)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    }
    var bb = v.indexOf(CP_BEGIN);
    if (bb >= 0) {
      var ee = v.indexOf(CP_END, bb);
      if (ee >= 0) { v = v.slice(0, bb) + block + v.slice(ee + CP_END.length); }
      else {
        var nx2 = v.indexOf('\n【', bb + 1);
        v = (nx2 > 0) ? (v.slice(0, bb) + block + v.slice(nx2 + 1)) : (v.slice(0, bb) + block);
      }
      v = v.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    } else {
      v = (v ? v + '\n' : '') + block;
    }
    ta.value = v;
    cpPersistBrief();
    return true;
  }

  /* 指令框写入后触发一次落盘。三条写入路径（cpWriteBrief / cpWriteLegacy / cpWriteFinal）
     都必须调用它。
     ★ 为什么必须显式调：主程序给 #chBrief 绑的 input 监听只对「用户敲键盘」生效，
       而这三个函数都是**程序给 ta.value 赋值**，不会触发 input 事件——
       光靠监听，写入的指令在切章 / 切书 / 刷新时会蒸发（P0-2）。
     ★ 落盘本体由 index.html 侧提供（autoSaveChapter，开关 window.CP_BRIEF_AUTOSAVE）。
       这里只负责调用；函数不存在或抛错都吞掉，并明确告诉作者要手动保存一次。 */
  function cpPersistBrief() {
    try {
      if (typeof autoSaveChapter !== 'function') throw new Error('autoSaveChapter 不存在');
      autoSaveChapter();
      return true;
    } catch (e) {
      try { toast('指令已写入，但自动保存未触发——请手动点一次「保存」'); } catch (e2) {}
      return false;
    }
  }

  window.counselFinalizeBrief = async function () {
    /* 降级 1：开关关闭 → 逐字转调原有逻辑 */
    if (!window.CP_FINAL_BRIEF) {
      try { counselToBrief(); } catch (e) { toast('写入指令失败：' + (e && e.message)); }
      return;
    }
    /* 降级 2：讨论为空 → 与 counselToBrief 完全一致的提示 */
    var last = null;
    try {
      var _scLog = cpLogScoped(); for (var i = _scLog.length - 1; i >= 0; i--) {
        if (_scLog[i] && _scLog[i].role === 'ai') { last = _scLog[i]; break; }
      }
    } catch (e0) {}
    if (!last) { toast('还没有参谋的回复可以落地'); return; }

    var ta = document.getElementById('chBrief');
    if (!ta) return;

    /* 未配置 AI 时同样兜回原逻辑——原逻辑是纯本地的，不需要 AI。
       ★ 与降级 1（CP_FINAL_BRIEF=0）的区别，两者不要一起"补 toast"：
         降级 1 是刻意打开的回滚态，不是故障，静默才对，打扰作者反而是噪音；
         这里是「功能点了但环境不具备」，属于事实缺失，必须明说。
         静默降级的害处：这个按钮的全部价值是「带状态标注的五段定稿」，
         作者点下去却拿到一份没有【已定】/【待定】的普通要点，界面上只飘一句
         counselToBrief() 自己的 toast——他会以为按钮坏了，而不是自己没配 AI。
         这类「看起来像 bug 的降级」最难排查。
       ★ 也不禁用按钮：AI 配置在设置页改，作者可能在打开参谋弹窗之后才配，
         按钮凭空消失更像 bug。 */
    var ai = {};
    try { ai = load('ai', {}) || {}; } catch (e1) {}
    if (!ai.base || !String(ai.base).trim()) {
      try { toast('还没配置 AI：定稿需要模型参与，已按原样写入讨论原文（不带状态标注）。到「AI 生成设置」配好模型后可再用定稿'); } catch (e2a) {}
      try { counselToBrief(); } catch (e2) {}
      return;
    }

    try {
      /* ---- 组装输入 ---- */
      var log = cpLogScoped();
      var turnMax = Number(window.CP_FINAL_TURNS) || 40;
      var inMax = Number(window.CP_FINAL_INCHARS) || 24000;
      var src = log.slice(-turnMax);
      /* 从后往前取，尽量多带：先保证最新的完整留下，超预算再丢最旧的 */
      var used = 0, picked = [];
      for (var k = src.length - 1; k >= 0; k--) {
        var t = String((src[k] && src[k].text) || '');
        if (picked.length && used + t.length > inMax) break;
        picked.unshift(src[k]); used += t.length;
      }
      var hist = picked.map(function (m) {
        return (m.role === 'me' ? '我' : '参谋') + '：' + String(m.text || '');
      }).join('\n');

      var adopted = adoptGet(), vetoed = vetoGet();
      var ctxText = '';
      try {
        var c = counselCtx();
        ctxText = String((c && c.text) || '').slice(0, Number(window.CP_FINAL_CTXCHARS) || 4000);
      } catch (e3) {}

      var chNum = '', chTitle = '';
      try { chNum = String((document.getElementById('chNum') || {}).value || ''); } catch (e4) {}
      try { chTitle = String((document.getElementById('chTitle') || {}).value || '').trim(); } catch (e5) {}
      var chLabel = '第' + (chNum || '?') + '章' + (chTitle ? ('《' + chTitle + '》') : '');

      var sys = [
        '你是一位长篇小说的「剧情定稿编辑」，不是写手，也不是聊天对象。',
        '职责：把作者与「剧情参谋」之间的一整轮讨论，收敛成一份可直接用于下一轮正文生成的定稿指令。',
        '铁律：',
        '① 只输出下面规定格式的条列，不要寒暄、不要开场白、不要任何解释性文字；',
        '② 不要输出 Markdown 标题符号（#）与加粗星号（**），作者在手机上看；',
        '③ 每一条必须是一句话，行首「· 」，行尾带且只带一个状态标记：【已定】/【待定】/【未定】/【排除】；',
        '④ 状态判定标准：已被作者明确采纳、或已经写进正文的=【已定】；方向定了但具体做法还没定=【待定】；讨论过但没有结论的=【未定】；已被作者否决、或明确不采用的=【排除】；',
        '⑤ 第五段的每一条固定标【排除】，它记录的是「已经砍掉、不列入正文」的东西，只备查不执行；',
        '⑥ 绝不写正文、绝不代写段落；',
        '⑦ 一切结论必须以分卷设定、人物卡与已有剧情为准，不得凭空新增设定；不确定就标【未定】，不要编造。',
        '输出格式（五段的段名逐字照抄，每段下面若干条）：',
        '一、整体故事与剧情走向',
        '二、讨论达成的最终结论',
        '三、关键情感落点',
        '四、必须保留的细节与设定',
        '五、已排除（不列入正文，仅备查）'
      ].join('\n');

      var user = '下面是作者与剧情参谋这一轮讨论的完整记录（按时间顺序）：\n\n' + (hist || '（无）') + '\n\n';
      user += '下面是作者已经拍板采纳的走向——这些一律判【已定】：\n'
        + (adopted.length ? adopted.map(function (t) { return '· ' + t; }).join('\n') : '（无）') + '\n\n';
      user += '下面是作者已经否决的走向——这些一律进第五段并标【排除】：\n'
        + (vetoed.length ? vetoed.map(function (t) { return '· ' + t; }).join('\n') : '（无）') + '\n\n';
      if (ctxText) user += '下面是当前作品的相关信息：\n' + ctxText + '\n\n';
      user += '当前待定稿的章节是' + chLabel + '。\n请输出定稿指令（五段，每条带状态标记）。';

      var _m = String(window.CP_FINAL_MODEL || '').trim() || ai.counselModel || 'deepseek-flash';
      var _t = Number(window.CP_FINAL_TEMP);
      if (!isFinite(_t)) _t = 0.55;
      var _mt = Number(window.CP_FINAL_MAXTOK) || 3000;
      try { trajTag('剧情定稿'); } catch (e6) {}

      var out = '';
      try {
        out = await callAI({ sys: sys, user: user, temperature: _t, max_tokens: _mt, modelOverride: _m });
      } catch (e7) {
        /* 降级 3：AI 调用异常 → 明确报错 + 兜回原逻辑 */
        toast('定稿失败：' + ((e7 && e7.message) || e7 || '未知错误') + '；已改用普通要点写入');
        try { counselToBrief(); } catch (e8) {}
        return;
      }
      out = String(out || '').trim();
      if (!out) {
        /* 降级 3：返回空 */
        toast('模型返回了空内容，已改用普通要点写入');
        try { counselToBrief(); } catch (e9) {}
        return;
      }

      /* 降级 5：不含任何状态标记 → 判为格式失败 */
      if (!/【(已定|待定|未定|排除)】/.test(out)) {
        toast('模型这次没有按定稿格式返回（缺状态标记），已改用普通要点写入');
        try { counselToBrief(); } catch (e10) {}
        return;
      }

      var lines = cpFinalLines(out);
      if (!lines.length) {
        toast('定稿内容为空，已改用普通要点写入');
        try { counselToBrief(); } catch (e11) {}
        return;
      }

      /* 降级 4：按条目与字符双重截断。
         ★ 语义（已与 team-lead 确认，不要改）：CP_FINAL_MAXLINES 是**条目**上限，
           只对行首「· 」的行计数。五段的段名（一、整体故事与剧情走向 …）是固定骨架，
           属于结构而非条目，不占作者的条目配额。
           若改成连段名一起数，会出现「设了 40 条、实际只有 39 条」的偏差。 */
      var maxLines = Number(window.CP_FINAL_MAXLINES) || 40;
      var keptLines = [], items = 0, cut = 0;
      for (var li = 0; li < lines.length; li++) {
        var isItem = lines[li].indexOf('· ') === 0;
        if (isItem) {
          if (items >= maxLines) { cut++; continue; }
          items++;
        }
        keptLines.push(lines[li]);
      }
      if (cut > 0) lines = keptLines;
      var body = lines.join('\n');
      /* 截断提示绝不引导作者去做破坏性操作。
         早期措辞是「可点『撤销』查看完整内容」——那是错的：cpUndoBrief() 是撤回到写入前，
         会把刚写好的定稿整块删掉，不但看不到完整内容，还会把已写的东西一起弄没。 */
      if (cut > 0) body += '\n…（已截断 ' + cut + ' 条：为控制指令长度只保留前 ' + maxLines
        + ' 条，完整内容仍在上方讨论里）';
      var maxChars = Number(window.CP_FINAL_MAXCHARS) || 2600;
      if (body.length > maxChars) body = body.slice(0, maxChars) + '…';

      var block = '【剧情定稿指令 · ' + chLabel + '】\n' + body + '\n' + CP_FINAL_END;
      if (cpWriteFinal(block)) {
        toast('已生成定稿指令：' + lines.length + ' 条'
          + (cut > 0 ? ('（超出的 ' + cut + ' 条已截断）') : '')
          + '，写进「生成指令」；可点「撤销」撤回');
        /* v169：写盘后立刻过一次指令质量闸门（本地计算，零 token）。
           源材料取本轮参谋讨论原文——它能抓到「讨论里出现过、但没被写进指令」的物证，
           这正是上一版把暗红药剂这条核爆线丢掉的那类缺口。 */
        try {
          if (window.CP_INSTR_AUDIT !== 0 && typeof window.cpInstrReport === 'function') {
            var _src = '';
            try { _src = (cpLogScoped() || []).map(function (m) { return String((m && m.text) || ''); }).join('\n'); } catch (eS) {}
            var _rp = window.cpInstrReport(body, _src, cpChNum());
            if (_rp && _rp.texts && _rp.texts.length) {
              console.warn('[指令质量闸门] ' + _rp.level + '\n· ' + _rp.texts.join('\n· '));
              try {
                if (_rp.level === 'block') {
                  alert('指令质量闸门（阻断级）\n\n' + _rp.texts.join('\n\n') + '\n\n建议改完再生成；仍要继续可直接生成。');
                } else {
                  toast('⚠️ 指令质量闸门：' + _rp.texts.length + ' 条提示（详见控制台 / 点「🔍 指令体检」可复看）');
                }
              } catch (eT) {}
            }
          }
        } catch (eA) { console.warn('[指令质量闸门] 运行失败(非致命)：', eA && eA.message); }
      }
    } catch (e) {
      /* 外层兜底：任何非预期异常也要留给作者一份可用指令 */
      try { toast('定稿过程出错：' + ((e && e.message) || e) + '；已改用普通要点写入'); } catch (e12) {}
      try { counselToBrief(); } catch (e13) {}
    }
  };

  /* ============================================================
   * 模块 I：混合提炼出口 counselHybridBrief()
   *
   * 「本地零 token 提炼器 + 外接 DeepSeek」串行接力，二者在同一窗口（#chBrief）协同：
   *   ① 本地 buildCounselDigest()（0 token）先跑，把整轮讨论压成结构化要点 d；
   *   ② 按分型分流（三道闸）：
   *      闸1 本地技术性失败（null，内容<6条/<80字）→ 零 token 落原文，不调 AI；
   *      闸2 本地成功且无矛盾、无需收敛 → 零 token 落要点块，不调 AI；
   *      闸3 需要收敛时，DeepSeek 只吃 d（要点，≈6200 字），非原文（≈12.6 万字），
   *          单次调用，失败即落本地产物 d，绝不重试；
   *   ③ 成功时要点块（本地产物）+ 定稿块（DeepSeek 产物）在 #chBrief 并存。
   *
   * 与 counselToBrief / counselFinalizeBrief 的区别：二者是独立二选一；本出口是串行接力，
   * 本地产物永远兜底，DeepSeek 只在「成功且有语义收敛需求」时增强，不重复消耗 token。
   * 回滚：window.CP_HYBRID = 0 即回到 v160 的两按钮，本出口不参与。
   * 只做加法：不修改 counselToBrief / counselFinalizeBrief / buildCounselDigest 任何一行。
   * ============================================================ */
  window.CP_HYBRID = 1;        /* 1=启用混合出口；0=关闭（回到两按钮） */
  window.CP_HYBRID_MODEL = ''; /* 空 = 用 CP_FINAL_MODEL 同款（ai.counselModel || deepseek-flash） */
  window.CP_HYBRID_FORCE = 0;  /* 1=即便无矛盾/归并也强制交 DeepSeek 收敛 */
  window.CP_HYBRID_TEMP = 0.55;
  window.CP_HYBRID_MAXTOK = 3000;
  /* v162：混合出口定稿块字符上限。比纯定稿（CP_FINAL_MAXCHARS=2600）更宽，
     用于容纳完整不截断的「细节与设定」段 + 「已排除」段（这两段是备查性质，不抢决策配额）。 */
  window.CP_HYBRID_MAXCHARS = 4000;

  /* 收敛 sys：v166 改造——输入从「本地要点」换成「讨论原文」，规则随之重写：
     ① 新增作者优先铁律（⑦），作者亲口说定的要求一条不许丢；
     ② 去第77章硬编码示例（注水日常举例/物理锚点举例/人设红线举例全部移除），
        人设红线改为从人物卡「行为禁区」推导；
     ③ 原⑦⑧⑬⑭对「要点分区」的引用改为对讨论原文的引用。 */
  function cpHybridSys() {
    return [
      '你是一位长篇小说的「剧情定稿编辑」，不是写手，也不是聊天对象。',
      '职责：把作者与「剧情参谋」一整轮讨论的原文，收敛成一份可直接驱动「深度续写」生成正文的成品指令。',
      '铁律：',
      '① 只输出下面规定格式的条列，不要寒暄、不要开场白、不要任何解释性文字；',
      '② 不要输出 Markdown 标题符号（#）与加粗星号（**），作者在手机上看；',
      '③ 每一条必须是一句话，行首「· 」，行尾带且只带一个状态标记：【已定】/【排除】；',
      '④ 这份指令是给「深度续写 AI」直接消费的成品指令，不是给人看的过程存档。状态判定只有两档：确定要写的=【已定】；已被作者否决、或明确不采用、不列入正文的=【排除】。严禁出现【待定】【未定】两档；',
      '⑤ 第五段的每一条固定标【排除】，它记录的是「已经砍掉、不列入正文」的东西，只备查不执行；',
      '⑥ 绝不写正文、绝不代写段落；',
      '⑦ 【作者优先·最重要】讨论记录里「我：」开头的是作者本人的话，优先级最高：作者亲口说定的开头/结构/细节/情感/人设要求，必须逐条进入对应段落并标【已定】，一个都不许丢、不得改写其含义；参谋的建议若与作者要求冲突，一律以作者为准；',
      '⑧ 讨论中相互冲突的决定必须裁定出唯一结论，不得并列两个互相冲突的结论；',
      '⑨ 【锁死铁律】对讨论中所有「还没拍板」的事项，你必须基于人物卡、前文上下文与已给定的事实，替作者做出最合理的具体决定（锁死成【已定】），并在该条里写明你锁死的依据；严禁输出【未定】【待定】——深度续写读到「没定」就会留白、编造与本章无关的注水日常；',
      '⑩ 情感落点与细节设定以讨论原文中作者的明确要求为准；找不到依据的，基于人物卡和前文上下文做出最合理的具体决定（锁死），不得留白、不得编造与档案冲突的内容；',
      '⑪ 必须给出本章的「核心物理锚点」：至少一个关键道具/动作/伤疤/体征，写明它的外观、气味、温度，以及至少一处与之相关的具体细节。物理锚点必须取自讨论原文、人物卡或前文已有物件，不得凭空新造。物理锚点是情感的物理支撑——没有它，悬疑感会垮成日常流水账；',
      '⑫ 必须给出「人设红线」：从下方作品信息里各人物卡的「行为禁区（绝不可做）」与核心特质逐条推导，写明本章每个出场关键角色绝不可做的事；人物卡未覆盖的角色，基于讨论与上下文谨慎推导并写明依据，不得凭印象编造；',
      '⑬ 第四段「必须保留的细节与设定」不得为空：讨论中约定的伏笔呼应、时间线、人物设定、具体动作、物理锚点都要落进第四段，不要把它们混进第二段「结论」；',
      '⑭ 第五段「已排除」必须完整列出已否决清单与讨论中明确砍掉、不列入正文的每一项，不得遗漏、不得合并、不得省略；',
      '⑮ 第三段「关键情感落点」只写「情感怎么呈现」，不写「角色如何想」——禁用「他觉得 / 她心想 / 感到」这类判断句，改用动作、表情、比喻、以及与之绑定的物理锚点来落点；',
      '⑯ 第六段「锁死的补充决定」：把讨论中所有原本「待决/未定」的软性点，逐条替作者锁死成【已定】的具体决定（写明依据），不留任何留白给深度续写；',
      '⑰ 输入若附「作者已拍板采纳的走向」，一律判【已定】，不得降级为待决、不得质疑；输入若附「作者已否决的走向」，一律进第五段并标【排除】，不得以任何形式复活进决策段；输入若附「已锁定的定稿指令」，其中已定内容延续有效，除非本轮讨论明确推翻；',
      '输出格式（六段的段名逐字照抄，每段下面若干条）：',
      '一、整体故事与剧情走向',
      '二、讨论达成的最终结论',
      '三、关键情感落点',
      '四、必须保留的细节与设定',
      '五、已排除（不列入正文，仅备查）',
      '六、锁死的补充决定（原本待决的软性点，已替作者锁死）'
    ].join('\n');
  }

  /* 收敛 user：v166 改喂讨论原文（P0）。
     原实现只喂本地词典要点（≤1800 字）——实测会把作者亲口强调的开头要求整句丢弃、
     只留下参谋自己的复述与建议（如「松饼落到肩上」），深度续写拿到的指令
     从一开始就丢了作者要求。现与 v153 定稿出口同口径：整轮讨论原文
     （按预算从后往前尽量多带）+ 采纳/否决清单 + 作品上下文（含人物卡、已锁定定稿）。 */
  window.CP_HYBRID_INCHARS = 24000;  /* 喂给模型的讨论原文字符预算 */
  function cpHybridUser() {
    var chNum = '', chTitle = '';
    try { chNum = String((document.getElementById('chNum') || {}).value || ''); } catch (e) {}
    try { chTitle = String((document.getElementById('chTitle') || {}).value || '').trim(); } catch (e) {}
    var chLabel = '第' + (chNum || '?') + '章' + (chTitle ? ('《' + chTitle + '》') : '');
    var log = cpLogScoped();
    var turnMax = Number(window.CP_FINAL_TURNS) || 40;
    var inMax = Number(window.CP_HYBRID_INCHARS) || 24000;
    var src = log.slice(-turnMax);
    /* 从后往前取，尽量多带：先保证最新的完整留下，超预算再丢最旧的 */
    var used = 0, picked = [];
    for (var k = src.length - 1; k >= 0; k--) {
      var t = String((src[k] && src[k].text) || '');
      if (picked.length && used + t.length > inMax) break;
      picked.unshift(src[k]); used += t.length;
    }
    var hist = picked.map(function (m) {
      return (m.role === 'me' ? '我' : '参谋') + '：' + String(m.text || '');
    }).join('\n');
    var s = '下面是作者与剧情参谋这一轮讨论的完整记录（按时间顺序，原文未删节；「我：」开头的是作者本人的话，优先级最高）：\n\n' + (hist || '（无）') + '\n\n';
    var adopted = [], vetoed = [];
    try { adopted = adoptGet() || []; } catch (e1) {}
    try { vetoed = vetoGet() || []; } catch (e2) {}
    s += '下面是作者已经拍板采纳的走向——这些一律判【已定】：\n'
      + (adopted.length ? adopted.map(function (t) { return '· ' + t; }).join('\n') : '（无）') + '\n\n';
    s += '下面是作者已经否决的走向——这些一律进第五段并标【排除】：\n'
      + (vetoed.length ? vetoed.map(function (t) { return '· ' + t; }).join('\n') : '（无）') + '\n\n';
    var ctxText = '';
    try {
      var c = counselCtx();
      ctxText = String((c && c.text) || '').slice(0, Number(window.CP_FINAL_CTXCHARS) || 8000);
    } catch (e3) {}
    if (ctxText) s += '下面是当前作品的相关信息（分卷设定 / 人物卡 / 已锁定的定稿 / 已有剧情摘要，锁死决定与人设红线以此为档案依据）：\n' + ctxText + '\n\n';
    s += '当前待定稿的章节是' + chLabel + '。\n请输出定稿指令（六段，每条带状态标记【已定】或【排除】；这是给深度续写 AI 的成品指令，作者亲口说定的要求一条都不许丢，所有待决项都必须替作者锁死成【已定】，严禁出现【未定】【待定】，并务必给出核心物理锚点与人设红线）。';
    return s;
  }

  window.counselHybridBrief = async function () {
    try {
      /* 降级 0：开关关闭 → 转调原逻辑（纯本地） */
      if (!window.CP_HYBRID) {
        try { counselToBrief(); } catch (e) {}
        return;
      }
      /* 讨论为空 */
      var last = null;
      var _scLog = cpLogScoped(); for (var i = _scLog.length - 1; i >= 0; i--) {
        if (_scLog[i] && _scLog[i].role === 'ai') { last = _scLog[i]; break; }
      }
      if (!last) { toast('还没有参谋的回复可以落地'); return; }
      var ta = document.getElementById('chBrief');
      if (!ta) return;

      /* v166：本地提炼降级为「备查存档」——只存 counselDigest 供面板/导出查看，
         不再进模型输入（原实现把它当收敛 AI 的唯一讨论来源，实测丢作者原话）。 */
      var d = buildCounselDigest();
      if (d) { try { save('counselDigest', { text: d.text, kept: d.kept, chars: d.chars, at: Date.now() }); } catch (eSave) {} }

      /* v166：讨论过短不再跳过收敛——收敛输入已是原文，短讨论=小输入，
         统一走锁死版出口，避免「短讨论落无状态原文」的质量分叉。 */

      /* ② v164：原「闸2」（无矛盾无归并就跳过收敛、直接落本地要点块）已废除。
         原因：本地要点块含【待决】，深度续写读到「没定」就留白、然后编造
         与本章无关的注水日常——这与有没有矛盾无关，
         只要落的是本地点块就会中招。所以只要配置了 AI，一律走收敛产出锁死版。 */

      /* 未配置 AI → 降级：有要点落要点块（清掉旧定稿块，防两套指令并存），
         没有要点退回讨论原文。两条路径都明确警告「未收敛」。 */
      var ai = {};
      try { ai = load('ai', {}) || {}; } catch (e3) {}
      if (!ai.base || !String(ai.base).trim()) {
        if (d) {
          if (cpWriteBriefDegraded(d.text)) toast('未配置 AI——已按本地要点写入（未收敛，含待决项，深度续写可能留白；建议配置 AI 后收敛成锁死版）');
        } else {
          if (cpWriteLegacy(String(last.text || '').slice(0, CFG.briefCap))) toast('未配置 AI 且本轮没提炼出要点，已按原样写入讨论原文（未收敛）');
        }
        return;
      }

      /* ③ DeepSeek 收敛（单次，吃讨论原文 + 采纳/否决清单 + 作品上下文） */
      try { trajTag('混合定稿'); } catch (e4) {}
      var _m = String(window.CP_HYBRID_MODEL || '').trim() || String(window.CP_FINAL_MODEL || '').trim() || ai.counselModel || 'deepseek-flash';
      var _t = Number(window.CP_HYBRID_TEMP);
      if (!isFinite(_t)) _t = 0.55;
      var _mt = Number(window.CP_HYBRID_MAXTOK) || 3000;
      var out = '';
      try {
        out = await callAI({ sys: cpHybridSys(), user: cpHybridUser(), temperature: _t, max_tokens: _mt, modelOverride: _m });
      } catch (e5) {
        /* 闸3：AI 异常 → 降级落本地要点块（清旧定稿），不重试 */
        if (d) { if (cpWriteBriefDegraded(d.text)) toast('DeepSeek 收敛失败（' + ((e5 && e5.message) || e5 || '未知错误') + '），已按本地要点写入（未重试；含待决项，深度续写可能留白）'); }
        else { if (cpWriteLegacy(String(last.text || '').slice(0, CFG.briefCap))) toast('DeepSeek 收敛失败，已按原样写入讨论原文（未重试）'); }
        return;
      }
      out = String(out || '').trim();
      if (!out) {
        if (d) { if (cpWriteBriefDegraded(d.text)) toast('DeepSeek 返回空内容，已按本地要点写入（未重试；含待决项，深度续写可能留白）'); }
        else { if (cpWriteLegacy(String(last.text || '').slice(0, CFG.briefCap))) toast('DeepSeek 返回空内容，已按原样写入讨论原文（未重试）'); }
        return;
      }
      /* v164：锁死版只允许【已定】/【排除】——若模型仍输出【待定】【未定】，
         说明没有锁死，判为格式不符走降级（宁可降级也不让「未定」进深度续写指令） */
      if (!/【(已定|排除)】/.test(out) || /【(待定|未定)】/.test(out)) {
        if (d) { if (cpWriteBriefDegraded(d.text)) toast('DeepSeek 未按锁死格式返回（缺状态标记或仍含【待定】【未定】），已按本地要点写入（未重试；含待决项，深度续写可能留白）'); }
        else { if (cpWriteLegacy(String(last.text || '').slice(0, CFG.briefCap))) toast('DeepSeek 未按锁死格式返回，已按原样写入讨论原文（未重试）'); }
        return;
      }
      var lines = cpFinalLines(out);
      if (!lines.length) {
        if (d) { if (cpWriteBriefDegraded(d.text)) toast('定稿内容为空，已按本地要点写入（含待决项，深度续写可能留白）'); }
        else { if (cpWriteLegacy(String(last.text || '').slice(0, CFG.briefCap))) toast('定稿内容为空，已按原样写入讨论原文'); }
        return;
      }

      /* ④ 截断：决策段（一/二/三）受 CP_FINAL_MAXLINES 条目配额约束；
         备查段（四、细节与设定 / 五、已排除 / 六、待补给缺口）豁免配额，完整保留（v162 #3 → v163 扩到第六段）。
         字符上限用混合出口专属 CP_HYBRID_MAXCHARS（4000），不占用纯定稿的 2600。 */
      var maxLines = Number(window.CP_FINAL_MAXLINES) || 40;
      var keptLines = [], items = 0, cut = 0, inTail = false;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (line.indexOf('四、') === 0 || line.indexOf('五、') === 0 || line.indexOf('六、') === 0) { inTail = true; }
        var isItem = line.indexOf('· ') === 0;
        if (isItem && !inTail) {
          if (items >= maxLines) { cut++; continue; }
          items++;
        }
        keptLines.push(line);
      }
      if (cut > 0) lines = keptLines;
      var body = lines.join('\n');
      if (cut > 0) body += '\n…（已截断 ' + cut + ' 条）';
      var maxChars = Number(window.CP_HYBRID_MAXCHARS) || 4000;
      if (body.length > maxChars) body = body.slice(0, maxChars) + '…';

      var chNum2 = '';
      try { chNum2 = String((document.getElementById('chNum') || {}).value || ''); } catch (e6) {}
      var chTitle2 = '';
      try { chTitle2 = String((document.getElementById('chTitle') || {}).value || '').trim(); } catch (e7) {}
      var chLabel2 = '第' + (chNum2 || '?') + '章' + (chTitle2 ? ('《' + chTitle2 + '》') : '');

      /* ⑤ v164：本地点块（过程存档，含待决/矛盾）不再写进 #chBrief——它会被深度续写当成指令，
         读到【待决】【未定】就留白、然后编造注水日常。
         v166：备查存储已提前到收敛调用前（见上），此处只负责写锁死版定稿块；
         #chBrief 只保留「锁死版定稿块」（深度续写成品指令），并先移除旧要点块避免干扰。
         撤销恢复含旧要点块的状态。 */
      _cpBriefBak = String(ta.value || '');   /* 备份（含旧要点块+旧定稿块），供撤销恢复 */
      var v0 = String(ta.value || '');
      var b0 = v0.indexOf(CP_BEGIN);
      if (b0 >= 0) {
        var e0 = v0.indexOf(CP_END, b0);
        var stop0 = (e0 >= 0) ? (e0 + CP_END.length) : v0.length;
        v0 = (v0.slice(0, b0) + v0.slice(stop0)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      }
      var block = CP_FINAL_BEGIN + ' · ' + chLabel2 + '】\n' + body + '\n' + CP_FINAL_END;
      var bf = v0.indexOf(CP_FINAL_BEGIN);
      if (bf >= 0) {
        var ef = v0.indexOf(CP_FINAL_END, bf);
        var stopf = (ef >= 0) ? (ef + CP_FINAL_END.length) : v0.length;
        v0 = v0.slice(0, bf) + block + v0.slice(stopf);
      } else {
        v0 = (v0 ? v0 + '\n' : '') + block;
      }
      ta.value = v0.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      cpPersistBrief();
      toast('定稿完成：锁死版定稿 ' + items + ' 条已写入「生成指令」供深度续写（含物理锚点与人设红线；基于整轮讨论原文收敛）' + (d ? ('；本地要点 ' + d.kept + ' 条已存入备查（不进指令）') : '') + '；可点「撤销」撤回');
    } catch (e) {
      try { toast('混合提炼出错：' + ((e && e.message) || e) + '；已按普通要点写入'); } catch (e8) {}
      try { counselToBrief(); } catch (e9) {}
    }
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
      var _scLog = cpLogScoped(); for (var i = _scLog.length - 1; i >= 0; i--) {
        if (_scLog[i].role === 'ai') { src = _scLog[i].text; break; }
      }
      var routes = parseRoutes(src);
      if (!routes.length) {
        /* 缺陷 3：参谋写了「走向」段头却一条候选都没列出来时，界面原本完全静默——
           作者看到的是「这一轮下方没有任何按钮」，最自然的判断是按钮坏了。
           现在按两种成因分别明说。纯问答轮（根本没有走向段头）继续静默：
           那是参谋最常见的正常轮次，天天弹提示只会变成噪音。 */
        if (window.CP_ROUTE_HINT) {
          try {
            var why = routeMissReason(src);
            if (why && !last.__cpHintDone) {
              var hb = document.createElement('div');
              hb.className = 'cp-routes';
              hb.innerHTML = '<div class="cp-rt"><div class="cp-rt-t">'
                + (why === 'short'
                    ? '这一轮列出了走向条目，但每条都不足 6 个字，没法作为候选采纳。可以让参谋把每条写成一句完整的话。'
                    : '这一轮参谋提到了「走向」，但没列出可勾选的候选条目。可以让它用 ①②③ 编号重列一遍，或直接在「生成指令」里写下结论。')
                + '</div></div>';
              last.__cpHintDone = 1;
              last.appendChild(hb);
            }
          } catch (e13) {}
        }
        return;
      }
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
        cpPersistBrief();   /* 采纳是「定下来的走向」，必须落盘：
                               这条蒸发是完全无声的（撤销还有 toast，采纳没有），
                               且它正是产品原话「讨论过的内容被删改」的另一半 */
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
   * 模块 G2（v166）：散文拍板自动入册
   *
   * 根因：作者在讨论里用散文拍板（「结构就定死：……」「就按①来」）时，
   * 这些决定从未进入「已采纳清单」——清单此前只收 parseRoutes 从最后一条
   * AI 回复里抽出的候选按钮（≤3 条/轮）。于是「已定」状态只存在于聊天
   * 窗口内，窗口一滑过去，参谋就把定过的事当待议项重问。
   *
   * 做法：包一层 counselSend，作者发言里含拍板语、且不是疑问/二选一句的
   * 句子，自动 adoptAdd 入册（去重、8-160 字、单条消息最多 6 条）。
   * 入册后同时进入：①参谋上下文 adoptBlock（不再重问）②收敛输入（一律【已定】）。
   * 回滚：window.CP_AUTO_ADOPT = 0。
   * ============================================================ */
  window.CP_AUTO_ADOPT = 1;
  var CP_ADOPT_RE = /(就按|按这[个条方案]|定死|定下来|就这么定|就这样定|拍板|锁死|不再问|别再问|不要再问|不再改|不再动|就采用|就保留|定了[：，。!！])/;
  var CP_ADOPT_NOT = /(要不要|需不需要|还是说|二选一|待定|未定|还没想好|你觉得呢|取决于你|是不是该|行不行|可不可以)/;
  window.cpAutoAdopt = function (q) {
    if (!window.CP_AUTO_ADOPT || window.CP_ROLLBACK_V143 === 1) return 0;
    var n = 0;
    try {
      String(q || '').split(/(?<=[。！？；\n])/).forEach(function (seg) {
        var s = String(seg || '').trim();
        if (n >= 6) return;
        if (s.length < 8 || s.length > 160) return;
        if (!CP_ADOPT_RE.test(s)) return;
        if (CP_ADOPT_NOT.test(s)) return;
        if (/[？?]$/.test(s)) return;
        var a = adoptGet();
        for (var i = 0; i < a.length; i++) { if (a[i] === s) return; }
        adoptAdd(s); n++;
      });
    } catch (e) {}
    return n;
  };
  var _origCounselSend = (typeof counselSend === 'function') ? counselSend : null;
  if (_origCounselSend) {
    counselSend = async function () {
      try {
        var el = document.getElementById('counselInput');
        var q = String((el && el.value) || '').trim();
        if (q) {
          var n = window.cpAutoAdopt(q);
          if (n > 0) { try { toast('已把 ' + n + ' 条拍板要点记入「已确定」（参谋不会再重问）'); } catch (eT) {} }
        }
      } catch (e) {}
      return _origCounselSend.apply(this, arguments);
    };
  }

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
          put('activeDeduction', { idx: picked.idx, tone: picked.tone, beats: picked.beats, raw: picked.raw, fp: (typeof _beatFp === 'function') ? _beatFp(picked.beats) : '', at: now() });
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

  /* ============================================================
   * 切书时的内存态重置（跨书静默污染家族）
   *
   * 谁调用：index.html 的 switchBook()，由 agent-app-engineer 接线。
   *
   * 为什么不由 plus 自己监听切书：
   *   本模块是靠「保存原函数引用 → 覆盖同名全局」挂进宿主的增强模块。
   *   切书是宿主的核心管线（switchBook → resetChapterForm → 重渲染），
   *   plus 再包一层 switchBook 会与宿主的改动抢时序，而且没法保证自己
   *   排在 resetChapterForm 之后。交给宿主显式调用，时序可控、责任清楚。
   *
   * ★★ 这个函数里绝不能做任何落盘动作 ★★
   *   切书路径上任何 counselSave() / cpPersistBrief() 都是错的。
   *   尤其 counselSave() 是 save("counselLog", _counselLog)——按 curId 分书，
   *   清空内存态之后再调，curId 已经切到新书，结果不是「保存清空」，
   *   而是把新书原有的讨论写成空。（agent-app-engineer 在 index.html:3253
   *   已把这个陷阱写死并做成断言。）
   *   本函数只做一件事：把内存里的旧书残影清掉。不碰 DOM，不碰 IndexedDB。
   *
   * 为什么只清这两个：
   *   _cpBriefBak  撤销快照。不清的话：A 书写指令 → 切 B 书 → 点「撤销」
   *                → A 书指令被写进 B 书的生成指令框。补了落盘之后，
   *                这个污染还会被真正写进 B 书，从「瞬时」变成「持久化」。
   *   _cpRoutes    最近一次 AI 回复解析出的走向。切书后若 B 书参谋日志为空
   *                （没有新 AI 回复触发重算），残留的仍是 A 书走向，
   *                点「✓ 采纳」会采纳到错误的走向。
   *
   * 刻意**不清**的：
   *   采纳/否决列表（counselAdopted / counselVeto）——它们走 load/save，
   *   按 curBook() 分书隔离，切书会自动跟着换。清了反而毁掉另一本书的数据。
   *   _orig* 系列——那是宿主原函数的引用，是常量，清掉会永久破坏包装链。
   *
   * 副作用（是预期行为，不是 bug）：重置后点「撤销」会提示
   *   「没有可撤销的上一步」——本来就没有本轮写入可撤，正确。
   * ============================================================ */
  window.cpOnBookSwitch = function () {
    try {
      _cpBriefBak = null;
      _cpRoutes = [];
    } catch (e) {}
  };

  /* ============================================================
   * 模块 E · 指令质量闸门（v169）
   *
   * 为什么需要：v144–v168 修的全是「管道保真度」——让作者说过的话一条不丢地
   * 到达深度续写。管道已经不漏了，但没有任何一环对「指令本身的内容质量」负责：
   * 一段弱指令会被完整、忠实地执行，产出忠实但无用的正文。
   *
   * 本闸门是「筛选器」的落地，全部本地计算、零 token、纯函数、可单测：
   *   ① cpInstrAudit  文本级自检（槽位缺失 / 排除自伤 / 互斥时间 / 章号越界）
   *   ② cpInstrGap    差集体检（源材料里有、指令里没有的物证与人物）——
   *                    这一条才是能抓到「核爆线被丢掉」的检查
   * ============================================================ */
  window.CP_INSTR_AUDIT = 1;

  /* 具象物证词根（通用，不绑定任何一本书） */
  var CP_PROP_RE = /瓶|药剂?|汁|糖|字条|纸条?|信|疤|伤痕?|链|珠|羽毛?|袍|帚|刀|镜|钥匙|杯|盘|斗篷|罐|绳|扣子?|戒指|铃|灯|爪印|请柬|名单|绷带|手套|帽子|靴|箱子|口袋|纽扣|硬币|针|线|发带|袖口|领子/;
  /* 量词前导的实体抽取：比通用词典噪音低得多，命中即物证 */
  var CP_CLS_RE = /(一只|一瓶|一张|一道|一颗|一枚|一条|一封|一把|一根|一双|一串|一件|一截|一片|一剂|一壶|一杯|一盘|一方|一块|一本|一支|一副|一盏|一罐)([\u4e00-\u9fa5]{1,4})/g;

  /* 从文本中抽取物证实体（量词前导 + 通用词根）。返回去重数组。 */
  function cpProps(text){
    var out = {}, t = String(text || '');
    var m; CP_CLS_RE.lastIndex = 0;
    while ((m = CP_CLS_RE.exec(t))) { if (m[2]) out[m[2]] = 1; }
    var lines = t.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i];
      if (/^\s*[-·*]?\s*【排除】/.test(s)) continue;      /* 排除行不算「指令里有的物证」 */
      var g = s.match(CP_PROP_RE);
      if (g) out[g[0]] = 1;
    }
    return Object.keys(out);
  }

  /* 抽取本章相关人物名（以人物卡为准，未命中则不报人物差集） */
  function cpCharNames(text){
    var t = String(text || ''), out = {};
    var chars = [];
    try { chars = (typeof load === 'function' ? load('chars', []) : (window.__chars || [])) || []; } catch (e) { chars = []; }
    for (var i = 0; i < chars.length; i++) {
      var n = chars[i] && chars[i].name;
      if (n && t.indexOf(n) >= 0) out[n] = 1;
    }
    return Object.keys(out);
  }

  /* ① 文本级自检 */
  function cpInstrAudit(text, opt){
    opt = opt || {};
    var t = String(text || '');
    var issues = [];
    var lines = t.split(/\r?\n/);
    var keepLines = [], exLines = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i];
      if (/【排除】/.test(s)) exLines.push(s);
      else keepLines.push(s);
    }
    var keep = keepLines.join('\n');

    /* A1 物证槽位：可落地的物证少于 2 种，结尾大概率降级成陈述句 */
    var props = cpProps(keep);
    if (props.length < 2) {
      issues.push({ code: 'A1', level: 'warn',
        text: '本章指令里可落地的具象物证只有 ' + props.length + ' 种' + (props.length ? '（' + props.join('、') + '）' : '') +
              '。少于 2 种时，结尾没有东西可结算，模型会退回「我记着这笔账」这类态度陈述。' });
    }
    /* A2 结尾锚 */
    if (!/结尾|收尾|末段|最后一段|章末|收束/.test(t)) {
      issues.push({ code: 'A2', level: 'warn', text: '指令没有写结尾怎么收。缺结尾锚点时，收束会滑向概括性陈词。' });
    }
    /* A3 排除自伤：排除行否定的动作，在保留行里仍被要求 */
    var NEG = [{ re: /不带|不带回|不写.{0,4}带|不写.{0,4}给|别带/, word: '带' },
               { re: /不给|不送|不递/, word: '给' },
               { re: /不出现|不出场/, word: '出现' },
               { re: /不提|不写.{0,4}提/, word: '提' }];
    for (var k = 0; k < NEG.length; k++) {
      var hitEx = false;
      for (var j = 0; j < exLines.length; j++) if (NEG[k].re.test(exLines[j])) { hitEx = true; break; }
      if (!hitEx) continue;
      if (keep.indexOf(NEG[k].word) >= 0) {
        issues.push({ code: 'A3', level: 'block',
          text: '【排除】里否定了「' + NEG[k].word + '」，但指令其它位置仍在要求它——两条约束互相矛盾，模型只能各取一半。' });
      }
    }
    /* A4 互斥时间：短时与持续并存 */
    var shortT = /两三天|三五天|几天内|一小时|几分钟|五分钟|半小时/.test(t);
    var longT = /一直|始终|从没|从未|这些天|这段时间|连着/.test(t);
    if (shortT && longT) {
      issues.push({ code: 'A4', level: 'warn', text: '指令里同时出现「短时段」与「一直/始终」两类时间表达，二者互斥，会让开场的时间状态自相矛盾。' });
    }
    /* A5 章号越界 */
    if (opt.chNum && Number(opt.chNum) > 0) {
      var mm, re = /第\s*(\d+)\s*章/g, bad = [];
      while ((mm = re.exec(t))) {
        var n = Number(mm[1]);
        if (n > Number(opt.chNum)) bad.push('第' + n + '章');
      }
      if (bad.length) {
        issues.push({ code: 'A5', level: 'warn', text: '指令引用了 ' + bad.join('、') + '，但当前是第 ' + opt.chNum + ' 章——未来章被引成了已发生的事。' });
      }
    }
    var lvl = 'ok';
    for (var q = 0; q < issues.length; q++) {
      if (issues[q].level === 'block') { lvl = 'block'; break; }
      if (issues[q].level === 'warn') lvl = 'warn';
    }
    return { level: lvl, issues: issues, props: props };
  }

  /* ② 差集体检：源材料（参谋讨论 / 作者贴的素材 / 上一版底本）里有、指令里没有的 */
  function cpInstrGap(instr, source){
    var a = cpProps(source || ''), b = cpProps(instr || '');
    var bs = {}; for (var i = 0; i < b.length; i++) bs[b[i]] = 1;
    var missProp = [];
    for (var j = 0; j < a.length; j++) if (!bs[a[j]]) missProp.push(a[j]);
    var ca = cpCharNames(source || ''), cb = {};
    var cn = cpCharNames(instr || ''); for (var m = 0; m < cn.length; m++) cb[cn[m]] = 1;
    var missChar = [];
    for (var n = 0; n < ca.length; n++) if (!cb[ca[n]]) missChar.push(ca[n]);
    return { missProp: missProp, missChar: missChar };
  }

  /* ③ 一次跑完，给界面用的文案 */
  window.cpInstrReport = function (instr, source, chNum) {
    var r = cpInstrAudit(instr, { chNum: chNum });
    var g = cpInstrGap(instr, source);
    var texts = [];
    var i;
    for (i = 0; i < r.issues.length; i++) texts.push((r.issues[i].level === 'block' ? '⛔ ' : '⚠️ ') + r.issues[i].text);
    if (g.missProp.length) texts.push('⚠️ 源材料里有、但指令里没写的物证：' + g.missProp.join('、') + '。若其中有本章的核爆物证（要被喝下/被毁/被交出去的那件），补回指令，否则结尾无从结算。');
    if (g.missChar.length) texts.push('⚠️ 源材料里出现、指令未提及的人物：' + g.missChar.join('、') + '。');
    if (typeof window.cpInstrAuditV171 === 'function') {
      try {
        (window.cpInstrAuditV171(instr) || []).forEach(function (x) {
          texts.push((x.level === 'block' ? '\u26d4 ' : '\u26a0\ufe0f ') + x.text);
        });
      } catch (e) {}
    }
    var level = r.level;
    if (level !== 'block' && g.missProp.length >= 3) level = 'warn';
    return { level: level, texts: texts, audit: r, gap: g };
  };

  /* 供宿主「🔍 指令体检」读取本轮参谋讨论原文（差集的源材料） */
  window.cpCounselSourceText = function () {
    try { return (cpLogScoped() || []).map(function (m) { return String((m && m.text) || ''); }).join('\n'); } catch (e) { return ''; }
  };

  /* ============================================================
   * v171 · 三处新闸门（全部本地纯函数，零 token，有实测依据）
   *
   * 依据来自 v170/V169/DeepSeek版/究极缝合版 的四方比对：
   *   ① 核爆物证密度：缝合版 33 处 vs 其余 1~6 处 → 差集必须从「提示」升级为「阻断」
   *   ② V169 指令 43 条锁死，正文却漏执行第18条（伊格诺图斯悖论 0 处）与第22条（请柬 0 处）
   *      → 条目越多执行率越低，需要条数上限
   *   ③ V169 指令把结尾写死成「该磨牙了」→ 结尾三件套 0/3；
   *      V143 要点式指令不写死结尾 → 三件套 1/3
   *      → 指令必须只给「结尾验收标准」，禁止给结尾句子
   * ============================================================ */

  /* 结尾三件套验收标准（R5）的本地打分。返回 {score, detail}。
     只判最后 400 字：物证结算 / 不可逆动作 / 未完成动作+时间锚。 */
  var CP_END_PROP = /瓶|药|剂|汁|字条|纸|信|疤|链|珠|羽毛?|斗篷|帚|刀|钥匙|杯|盘|罐|扣子?|戒指|铃|灯|爪印|请柬|名单|手套|帽子|靴|箱子|口袋|硬币|拼图|挂坠|纸条?/;
  var CP_END_IRREV = /喝下去?了?|喝完|吞下|撕了?掉?|烧掉|扔进|砸碎|折断|签了?字?|交出去?了?|递出去?了?|说出口了?|承认了|点破|揭穿|走进去|推开门|拧开|打开瓶/;
  var CP_END_ANCHOR = /明天|后天|下[周星个][五一二三四六日天]?|周五|周一|周二|周三|周四|周六|周日|圣诞节|今晚|明晚|第\s*\d+\s*天|三日后|一周后/;
  var CP_END_ACT = /我[^。！？]{0,6}(走向|走进|进去|去找|去见|去看|出发|动身|推开|拧开|喝下|离开|回去|转身)|转身(往|向|走)|往[^，。]{0,6}(走|去)/;
  /* 结算动词：物证不能只是「被提到」，必须给出最终状态或动作结果。
     反例（实测）：V167「珠子里的雾安安静静地趴着，像什么都没发生过」、
     V169「雾在珠子里缓缓翻了个身，又沉下去了」、143「没转，也没散。它只是在等」
     ——三处都出现了物证，但没有一件落到「最终状态」，属于悬置而非结算。 */
  var CP_END_SETTLE = /搁在|放在|搁回|收进|塞进|揣进|空了|空瓶|瓶底|剩|发烫|烫了一下|转了两圈|转得比|停下来|撕|折好|扣上|拧开|喝完|喝下去|交出去|递到|按在掌心/;

  function cpScoreEnding(text){
    var t = String(text || '').replace(/\s+/g, '');
    var tail = t.slice(-400);
    if (!tail) return { score: 0, detail: { prop: false, irrev: false, anchor: false }, note: '正文为空' };
    var d = {
      prop: CP_END_PROP.test(tail) && CP_END_SETTLE.test(tail),   /* 物证给出最终状态（结算位） */
      irrev: CP_END_IRREV.test(tail),        /* 已发生的不可逆动作 */
      anchor: CP_END_ANCHOR.test(tail) && CP_END_ACT.test(tail)  /* 未完成动作 + 时间锚 */
    };
    var score = (d.prop ? 1 : 0) + (d.irrev ? 1 : 0) + (d.anchor ? 1 : 0);
    return { score: score, detail: d, tail: tail.slice(-120) };
  }
  window.cpScoreEnding = cpScoreEnding;

  /* ② 指令侧：A6 结尾写死检测 / A7 排除连带检测 / A8 条数上限 */
  function cpInstrAuditV171(text, opt){
    opt = opt || {};
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    var body = [], exLines = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i];
      if (/【排除】|已排除/.test(s)) exLines.push(s); else body.push(s);
    }
    var keep = body.join('\n');

    /* A6 结尾写死：指令直接给出了结尾动作句 / 结尾原话 */
    var deadEnd = null;
    for (var j = 0; j < body.length; j++) {
      var ln = body[j];
      if (!/结尾|收束|收尾|章末/.test(ln)) continue;
      if (CP_END_IRREV.test(ln) || /["“][^"”]{4,}["”]/.test(ln) || /该磨牙|记着这笔账|像在绕/.test(ln)) { deadEnd = ln; break; }
    }
    if (deadEnd) {
      out.push({ code: 'A6', level: 'block',
        text: '指令把结尾写死了（' + String(deadEnd).slice(0, 40).replace(/\s+/g, '') + '…）。实测：V169 指令写死「该磨牙了」→ 结尾三件套 0/3；V143 要点式指令不写死 → 1/3。只给验收标准，别给句子。' });
    }
    /* A7 排除连带：排除项是否切断了时间锚 / 核爆物证 */
    var cut = [];
    for (var k = 0; k < exLines.length; k++) {
      if (CP_END_ANCHOR.test(exLines[k])) cut.push('时间锚');
      if (/瓶|药|剂|安神|馅饼|纸包|带回来|带东西/.test(exLines[k])) cut.push('核心物证');
      if (/沙菲克/.test(exLines[k])) cut.push('沙菲克（缝合版结尾「下周五」的时间锚来源）');
    }
    if (cut.length) {
      out.push({ code: 'A7', level: 'block',
        text: '【排除】可能切断了 ' + cut.join(' / ') + '。实测：V169 排除沙菲克后，正文失去「下周五」这个时间锚，结尾三件套直接少一项。' });
    }
    /* A8 条数上限：条目越多，正文漏执行率越高 */
    var items = 0;
    for (var m = 0; m < lines.length; m++) if (/^\s*[·•\-*]/.test(lines[m])) items++;
    if (items > 25) {
      out.push({ code: 'A8', level: 'warn',
        text: '指令共 ' + items + ' 条。实测：V169 的 43 条里，第18条（伊格诺图斯悖论）与第22条（请柬）在正文中漏执行（0 处命中）。超过 25 条时建议把关键项前置、其余移入备查。' });
    }
    return out;
  }
  window.cpInstrAuditV171 = cpInstrAuditV171;

  window.cpInstrAudit = cpInstrAudit;
  window.cpInstrGap = cpInstrGap;
  window.cpProps = cpProps;

  window.__LILIA_COUNSEL_PLUS__.ok = true;
})();
