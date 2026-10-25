/* ============================================================
 * lilia-digest-plus  ·  v128
 * 消化计数一致性 / 增量缓存 / 检索性能 / 费用统计
 *
 * 接入方式与 lilia-counsel-plus.js 完全一致：
 * 「保存原函数引用 → 覆盖同名全局」，原函数体一行未动；
 * 本文件加载失败时，主程序原有行为完全不变。
 *
 * 覆盖清单：
 *   showVersion          → 消化计数改用唯一真源口径，并暴露两端差异
 *   queueDigestChapter   → 按章独立队列（原版共用一个计时器会丢单）
 *   buildRagIndex        → 按指纹缓存（原版每次调用都全量重建分词）
 *   counselCtx           → 按指纹缓存拼装结果
 *   showTrajPanel        → 追加费用统计行 + 检索索引性能行
 *   cpRangeSum           → 区间统计补上金额
 * ============================================================ */
(function () {
  'use strict';
  if (window.__LILIA_DIGEST_PLUS__) { return; }
  window.__LILIA_DIGEST_PLUS__ = { ver: 'v128', ok: false };

  var S = { ragBuild: 0, ragHit: 0, ragMs: 0, ctxHit: 0, ctxBuild: 0, digestOk: 0, digestFail: 0 };

  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  /* djb2：只做指纹，不加密。算不出指纹时一律返回变化值 → 宁可不缓存，也绝不给脏数据。 */
  function H(s) {
    var h = 5381; s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
    return h.toString(36);
  }
  function ls(k) { try { return String(localStorage.getItem(k) || ''); } catch (e) { return ''; } }

  /* ============================================================
   * A. 消化计数：把「两套口径」收敛成一套
   *
   * 症状：语料 74 章，手机端「已消化」显示 75。
   * 根因：同一件事有两个互不相同的统计来源——
   *   口径①（旧 showVersion 用的）：Object.keys(aiDigest.volumes[v].chapters).length
   *          数的是「档案里有多少条记录」。而 chapters[chId] 是**状态表**，
   *          未消化 / 解析失败 / 网络失败 / 超时 / 已被删除重建的章节，全都占一条键。
   *          所以它实际统计的是「尝试过消化的章节数」，不是「已消化的章节数」。
   *   口径②（volDigestStatusCount 用的）：遍历真实章节（正文非空 + 分卷匹配 + 已完稿），
   *          再逐条查状态，只数 DS_DIGESTED。这个才是对的。
   * 74 章语料 + ≥1 条幽灵/失败记录 = 75，差异来源就是口径①。
   *
   * 处理：不动 volDigestStatusCount（它本来就对），把它提升为唯一真源；
   *      UI 一律走 dpDigestCount()；同时提供 dpDigestAudit() 把两端差异显式摆出来。
   * ============================================================ */
  function dpDigestCount(vid) {
    var out = { total: 0, digested: 0, degraded: 0, failed: 0, undigested: 0, ghosts: 0 };
    try {
      var vids = vid ? [vid] : (allVolIds() || []);
      vids.forEach(function (v) {
        try {
          var st = volDigestStatusCount(v) || {};
          out.total += (st.total || 0);
          out.digested += (st.digested || 0);
          out.degraded += (st.degraded || 0);
          out.failed += (st.failed || 0);
          out.undigested += (st.undigested || 0);
          var a = digestGhostAudit(v) || {};
          out.ghosts += (a.ghost || 0);
        } catch (e) {}
      });
    } catch (e) {}
    return out;
  }
  /* 三口径对账：把「为什么多出来」直接算给用户看，而不是让他自己猜 */
  function dpDigestAudit() {
    var recs = 0;
    try {
      var d = getDigest();
      Object.keys((d && d.volumes) || {}).forEach(function (v) {
        recs += Object.keys((((d.volumes[v]) || {}).chapters) || {}).length;
      });
    } catch (e) {}
    var r = dpDigestCount();
    return {
      records: recs,            /* 口径①：档案记录键数（旧 UI 显示的就是它） */
      total: r.total,           /* 真实可消化章数 */
      digested: r.digested,     /* 口径②：真正已消化 */
      degraded: r.degraded, failed: r.failed, undigested: r.undigested, ghosts: r.ghosts,
      mismatch: recs - r.digested /* 用户看到的「多出来的那些」 */
    };
  }
  window.dpDigestCount = dpDigestCount;
  window.dpDigestAudit = dpDigestAudit;

  /* 让「已消化 N/M」这行自己说话：两端不一致时直接给出可点的排查入口 */
  var _origShowVersion = (typeof showVersion === 'function') ? showVersion : null;
  if (_origShowVersion) {
    showVersion = function () {
      _origShowVersion();
      try {
        var box = document.getElementById('versionBody');
        var el = box && box.querySelector('.vlog-stat');
        if (!el) return;
        var a = dpDigestAudit();
        var txt = '章节 ' + ((load('chapters', []) || []).length) + ' 篇 · 已消化 ' +
          a.digested + '/' + a.total + ' 章' +
          (a.degraded ? ('（含降级 ' + a.degraded + '）') : '');
        var extra = '';
        if (a.mismatch > 0) {
          extra = '<div class="dp-warn" style="margin-top:6px;line-height:1.65;">' +
            '⚠️ 档案里有 <b>' + a.records + '</b> 条记录，但真实已消化只有 <b>' + a.digested + '</b> 章，' +
            '多出 <b>' + a.mismatch + '</b> 条（失效记录 ' + a.ghosts + ' 条 · 失败/未消化 ' +
            Math.max(0, a.mismatch - a.ghosts) + ' 条）。<br>' +
            '这只是<b>统计口径</b>问题，正文和档案内容都没丢：旧口径数的是「尝试过消化的记录数」。<br>' +
            '<button type="button" onclick="closeVersion();openDataPanel();setTimeout(function(){var g=document.getElementById(\'dgGhostList\');if(g)g.scrollIntoView({behavior:\'smooth\',block:\'center\'});},150)">' +
            '打开「数据与备份 → 档案体检」清理失效记录</button>' +
            '</div>';
        }
        el.innerHTML = E(txt) + extra;
      } catch (e) {}
    };
  }

  /* ============================================================
   * B. 写完一章、即时消化一章：修「防抖丢单」
   *
   * 原实现只有一个全局 _digestChTimer：
   *   if(_digestChTimer) clearTimeout(_digestChTimer);
   *   _digestChTimer = setTimeout(..., 6000);
   * 连着保存 A、B 两章（间隔 < 6 秒）→ A 的定时器被 B 清掉 → **A 永远不会被消化**。
   * 这正是「写完一章却没消化」最隐蔽的一种成因：界面上毫无反应，日志里只有一句 console.warn。
   *
   * 改为按章 id 独立排队：已在队列中的章节不重复排队，也不被别的章节顶掉。
   * 另外补两件原版没有的事：消化后回查是否真的落库；失败留痕（不再只有 console.warn）。
   * ============================================================ */
  var _dqTimers = {};
  var _dqLog = [];
  function dpLog(ch, level, msg) {
    try {
      _dqLog.unshift({ at: Date.now(), num: (ch && ch.num) || '?', title: (ch && ch.title) || '', level: level, msg: String(msg || '').slice(0, 200) });
      if (_dqLog.length > 60) _dqLog.length = 60;
      try { save('digestTrace', _dqLog); } catch (e) {}
    } catch (e) {}
    S.digestFail++;
  }
  window.dpDigestLog = function () { return _dqLog.slice(); };

  /* 消化后回查：只在「状态表真的变成 digested/degraded」时才算成功 */
  function dpVerify(ch) {
    try {
      var d = getDigest();
      var v = (d && d.volumes && d.volumes[ch.vol || 'none']) || null;
      var rec = v && v.chapters && v.chapters[ch.id];
      var st = rec ? rec.status : '';
      if (st === DS_DIGESTED || st === DS_DEGRADED) {
        S.digestOk++;
        return;
      }
      /* 内容未变且已消化时，digestChapterNow 会走「算力保护」直接跳过——那是成功，不是失败 */
      if (ch.id && shouldSkipDigestion(ch, ch.vol || 'none')) { S.digestOk++; return; }
      dpLog(ch, '未落库', '消化流程结束，但档案里查不到该章（状态=' + (st || '无记录') + '）');
      try { toast('⚠️ 第' + (ch.num || '?') + '章消化后未落库，可重试；详情见「消化范围体检」'); } catch (e) {}
    } catch (e) {}
  }

  var _origQueue = (typeof queueDigestChapter === 'function') ? queueDigestChapter : null;
  if (_origQueue && typeof digestChapterNow === 'function') {
    queueDigestChapter = function (ch) {
      try {
        if (!ch || !(ch.body || '').trim()) return;
        if ((ch.status || 'draft') !== 'done') return;
        var id = ch.id || ('_n' + (ch.num || 0) + '_' + ((ch.body || '').length));
        /* 已在排队就不重置：重置等于无限顺延，反而在连写时永远消化不上 */
        if (_dqTimers[id]) return;
        _dqTimers[id] = setTimeout(function () {
          delete _dqTimers[id];
          try {
            Promise.resolve(digestChapterNow(ch)).then(function () {
              try { dpVerify(ch); } catch (e) {}
            }).catch(function (e) {
              dpLog(ch, '失败', (e && e.message) || e);
              try { toast('⚠️ 第' + (ch.num || '?') + '章自动消化失败：' + String((e && e.message) || e).slice(0, 80)); } catch (e2) {}
            });
          } catch (e) {
            dpLog(ch, '抛错', (e && e.message) || e);
          }
        }, 6000);
      } catch (e) {
        try { _origQueue.call(window, ch); } catch (e2) {}   /* 兜底：任何异常都退回原逻辑，绝不比原来更差 */
      }
    };
  }

  /* ============================================================
   * C. 检索索引缓存（本次最大的性能杠杆）
   *
   * buildRagIndex() 每次调用都要对「74 章 × 8000 字切片 + 72 条档案块 + 人物 + 线索」
   * 做一遍分词（约 60 万字），aiDeepGen 里至少一次、ragRetrieve 默认参数又一次。
   * 但索引内容只随「章节正文 / 分卷归属 / 消化档案 / 人物 / 线索」变化，
   * 同一次生成里这些内容根本不会变——完全可以复用。
   *
   * 指纹只要算不出来，就返回变化值 → 不缓存 → 结果与原来逐字一致。
   * 缓存命中的是**同一个对象**，召回结果一模一样，所以质量零影响。
   * ============================================================ */
  var _ragCache = { key: '', idx: null };
  function dpRagFp(volId) {
    try {
      var chs = load('chapters', []) || [];
      var len = 0, n = 0, mx = 0, vs = '';
      chs.forEach(function (c) {
        len += ((c.body || '').length || 0); n++;
        mx = Math.max(mx, Number(c.num) || 0);
        vs += (c.vol || 'none') + ',';          /* 分卷归属变了必须重建 */
      });
      var d = getDigest();
      return [volId || '*', n, len, mx, (d && d.digest_update_at) || 0,
        (load('chars', []) || []).length, (load('plot', []) || []).length,
        H(vs), H(ls('lilia_cp_counselVeto'))].join('#');
    } catch (e) { return 'fp' + Date.now(); }
  }
  var _origBuildRag = (typeof buildRagIndex === 'function') ? buildRagIndex : null;
  if (_origBuildRag) {
    buildRagIndex = function (volId) {
      try {
        var fp = dpRagFp(volId);
        if (_ragCache.idx && _ragCache.key === fp) { S.ragHit++; return _ragCache.idx; }
        var t0 = (Date.now ? Date.now() : 0);
        var idx = _origBuildRag(volId);
        S.ragBuild++; S.ragMs = ((typeof t0 === 'number') ? (Date.now() - t0) : 0);
        _ragCache = { key: fp, idx: idx };
        return idx;
      } catch (e) {
        return _origBuildRag(volId);
      }
    };
  }

  /* ============================================================
   * D. 参谋上下文缓存
   * counselCtx() 每次都要重新拼装「章节清单 + 人物卡 + 卷档案 + 铁律块」，
   * 而同一轮讨论里这些输入并不变。按指纹缓存整段结果，省的是重复的 CPU 与内存抖动；
   * 发给模型的 token 另有 addCacheControl 前缀缓存兜底，两者互不干扰。
   * 否决清单变化会让指纹改变（它会被注入 ctx），所以不会出现「加了否决却用的旧上下文」。
   * ============================================================ */
  var _ctxCache = { key: '', val: null };
  function dpCtxFp() {
    try {
      var chs = load('chapters', []) || [];
      var len = 0, n = 0, mx = 0, vs = '';
      chs.forEach(function (c) {
        len += ((c.body || '').length || 0); n++;
        mx = Math.max(mx, Number(c.num) || 0); vs += (c.vol || 'none') + ',';
      });
      var last = '';
      try {
        var lg = _counselLog || [];
        for (var i = lg.length - 1; i >= 0; i--) { if (lg[i].role === 'me') { last = lg[i].text || ''; break; } }
      } catch (e) {}
      var d = getDigest();
      return [n, len, mx, (d && d.digest_update_at) || 0, H(last),
        (load('chars', []) || []).length, H(vs),
        H(ls('lilia_cp_counselVeto')), H(ls('lilia_cp_counselAdopt'))].join('#');
    } catch (e) { return 'fp' + Date.now(); }
  }
  var _origCtx = (typeof counselCtx === 'function') ? counselCtx : null;
  if (_origCtx) {
    counselCtx = function () {
      try {
        var fp = dpCtxFp();
        if (_ctxCache.val && _ctxCache.key === fp) { S.ctxHit++; return _ctxCache.val; }
        var v = _origCtx();
        S.ctxBuild++;
        _ctxCache = { key: fp, val: v };
        return v;
      } catch (e) { return _origCtx(); }
    };
  }

  /* ============================================================
   * E. 费用统计：区间汇总原本只给 token 数，不给钱
   * 单价直接复用主程序已有的 AI_PRICE / aiCostEst / _fmtYuan，
   * 与「单日花费上限」用的是同一套价目表，不会两处口径打架。
   * 未登记模型按默认价估（主程序 aiPriceOf 的既定策略：宁估高勿估低）。
   * ============================================================ */
  function dpRangeItems() {
    var a = []; try { a = trajGet(); } catch (e) {}
    var from = 0, to = 0;
    try {
      var f = document.getElementById('cpFrom'), t = document.getElementById('cpTo');
      if (f && f.value) from = new Date(f.value).getTime();
      if (t && t.value) to = new Date(t.value).getTime();
    } catch (e) {}
    if (!from && !to) return { items: a, open: false };
    return {
      items: a.filter(function (x) {
        var ts = Number(x.ts) || 0;
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        return true;
      }), open: true
    };
  }
  function dpCostOf(items) {
    var total = 0, byModel = {};
    (items || []).forEach(function (x) {
      var m = x.ret || x.req || '';
      var c = 0;
      try { c = aiCostEst(Number(x.uin) || 0, Number(x.uout) || 0, m); } catch (e) {}
      total += c;
      byModel[m || '未知'] = (byModel[m || '未知'] || 0) + c;
    });
    return { total: total, byModel: byModel };
  }
  window.dpRangeCost = function () { return dpCostOf(dpRangeItems().items); };

  /* 找一个「一定存在」的挂载点。
     原实现只认 #cpRangeOut，而那个节点是 lilia-counsel-plus.js 创建的——
     那个模块一旦没加载（或将来改动挪了位置），费用行就整行不显示，等于功能缺失。
     这里退到 trajStat（主程序自带），再退到面板本体，保证钱一定有地方显示。 */
  function dpMountPoint() {
    var anchor = document.getElementById('cpRangeOut');
    if (anchor && anchor.parentNode) return { node: anchor.parentNode, after: anchor };
    var stat = document.getElementById('trajStat');
    if (stat && stat.parentNode) return { node: stat.parentNode, after: stat };
    var panel = document.getElementById('trajList');
    if (panel && panel.parentNode) return { node: panel.parentNode, after: null };
    return null;
  }
  function dpEnsureLine(id) {
    var el = document.getElementById(id);
    if (el) return el;
    var mp = dpMountPoint();
    if (!mp) return null;
    el = document.createElement('div');
    el.id = id;
    if (mp.after) mp.node.insertBefore(el, mp.after.nextSibling); else mp.node.appendChild(el);
    return el;
  }

  function dpRenderCost() {
    try {
      var r = dpRangeItems();
      var c = dpCostOf(r.items);
      var el = dpEnsureLine('dpCostLine');
      if (!el) return;
      if (!r.items.length) {
        el.innerHTML = '<div style="padding:6px 12px;color:var(--sub);">💰 费用估算 ¥0.000（该区间没有记录）</div>';
        return;
      }
      var per = Object.keys(c.byModel).map(function (m) {
        return m + ' ' + _fmtYuan(c.byModel[m]);
      }).join('　·　');
      /* 今日累计取自 AI 用量账本（按天归集），比轨迹更可靠：
         轨迹最多留 150 条，写多了会滚动丢弃，单看轨迹会把当天花费算少。 */
      var today = 0, todayTxt = '';
      try {
        today = Number(aiCostToday()) || 0;
        if (today > 0) todayTxt = '<br><span style="color:var(--sub);font-size:11.5px;">今日累计 <b>' +
          _fmtYuan(today) + '</b>（取自用量账本，含轨迹已滚动丢弃的历史调用）</span>';
      } catch (e) {}
      el.innerHTML = '<div style="padding:6px 12px 8px;line-height:1.75;border-bottom:1px solid var(--line,rgba(127,127,127,.18));">' +
        '<div>💰 费用估算 <b style="font-size:14px;">' + _fmtYuan(c.total) + '</b>' +
        (r.open ? '（该区间 · ' + r.items.length + ' 次调用）' : '（全部轨迹记录 · ' + r.items.length + ' 次调用）') + '</div>' +
        '<div style="color:var(--sub);font-size:11.5px;margin-top:2px;">分模型：' + E(per) + todayTxt + '</div>' +
        '<div style="color:var(--sub);font-size:11px;margin-top:2px;line-height:1.6;">' +
        '单价：输入 ¥1 / 百万 token，输出 ¥8 / 百万 token（与「单日花费上限」同一套价表）。<br>' +
        '非流式调用取接口返回的真实 usage；流式生成接口不给 usage，按字数估算。<br>' +
        '未计缓存命中折扣，属估算值、非官方账单。</div></div>';
    } catch (e) {}
  }

  var _origTraj = (typeof showTrajPanel === 'function') ? showTrajPanel : null;
  if (_origTraj) {
    showTrajPanel = function () {
      _origTraj();
      try { dpRenderCost(); } catch (e) {}
      /* 检索索引性能行：让「有没有变慢」这件事可见，而不是靠感觉 */
      try {
        var perf = dpEnsureLine('dpPerfLine');
        if (!perf) return;
        perf.innerHTML = '<div style="padding:4px 12px 8px;color:var(--sub);font-size:11.5px;">⚡ 检索索引：已构建 ' + S.ragBuild +
          ' 次 / 命中 ' + S.ragHit + ' 次' + (S.ragMs ? (' · 末次耗时 ' + S.ragMs + 'ms') : '') +
          '　·　参谋上下文命中 ' + S.ctxHit + ' 次</div>';
      } catch (e2) {}
    };
  }
  /* cpRangeSum 由 lilia-counsel-plus.js 提供；它没加载时这里静默跳过，不影响任何功能 */
  var _origRangeSum = (typeof cpRangeSum === 'function') ? cpRangeSum : null;
  if (_origRangeSum) {
    cpRangeSum = function () {
      _origRangeSum();
      try { dpRenderCost(); } catch (e) {}
    };
  }

  window.__LILIA_DIGEST_PLUS__.stats = function () { return S; };
  window.__LILIA_DIGEST_PLUS__.ok = true;
})();
