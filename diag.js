/* 莉莉娅写作岛 · 数据录入完整度自检（书签按钮版）
   用法：把下面「书签栏代码」整行加入浏览器书签（保存为书签即可），
        然后打开 https://riddledoira-lang.github.io/lilia-island/ ，点该书签。
   特点：直接读 IndexedDB，不依赖页面是否启动；全程只读，零写入；报告以浮层展示在本页上。 */
(function () {
  if (window.__liliaDiag) { window.__liliaDiag.remove(); window.__liliaDiag = null; return; }

  var CFIELDS = [['name', '姓名'], ['house', '学院'], ['traits', '性格特质'],
    ['langSys', '语言体系(声线)'], ['thinkMode', '思维模式'], ['taboos', '禁区'],
    ['core', '核心矛盾'], ['desire', '表面欲望'], ['deepDesire', '深层欲望']];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function row(ok, txt, note) {
    return '<tr><td class="m">' + (ok ? '✅' : '❌') + '</td><td>' + esc(txt) + '</td><td class="n">' + esc(note || '') + '</td></tr>';
  }

  function report(books) {
    var h = [];
    h.push('<h2>📚 书架</h2>');
    if (!books || !books.length) {
      h.push('<p class="bad">IndexedDB 里没有任何书籍数据 —— 说明这个浏览器、这个地址下从未写入过数据。</p>');
      h.push('<p class="tip">换地址 = 换一份完全独立的数据。请确认你打开的就是平时在用的那个地址。</p>');
      return h.join('');
    }
    h.push('<table><tr><th>#</th><th>书名</th><th>章数</th><th>分卷</th></tr>');
    books.forEach(function (b, i) {
      h.push('<tr><td>' + (i + 1) + '</td><td>' + esc(b.title || '未命名') + '</td><td>' +
        (b.chapters || []).length + '</td><td>' + (b.volumes || []).length + '</td></tr>');
    });
    h.push('</table>');

    var b = books[0], vols = b.volumes || [], chs = b.chapters || [], chars = b.chars || [];
    var plot = b.plot || [], settings = b.settings || [], timeline = b.timeline || [];
    var dg = b.aiDigest || { volumes: {} };
    var vname = function (id) { var v = vols.filter(function (x) { return x.id === id; })[0]; return v ? v.name : '未分卷'; };

    /* 1 分卷 */
    h.push('<h2>1️⃣ 分卷结构</h2><table><tr><th>✓</th><th>项目</th><th>说明</th></tr>');
    vols.forEach(function (v) { h.push('<tr><td class="m">·</td><td>' + esc(v.name) + '</td><td class="n">id=' + esc(v.id) + '</td></tr>'); });
    h.push(row(vols.some(function (v) { return v.id === 'sirius'; }), '西里斯篇（sirius）', vols.some(function (v) { return v.id === 'sirius'; }) ? '已建立' : '缺失'));
    h.push(row(vols.some(function (v) { return v.id === 'james'; }), '詹姆斯篇（james）', vols.some(function (v) { return v.id === 'james'; }) ? '已建立' : '缺失'));
    h.push('</table>');

    /* 2 章节 */
    h.push('<h2>2️⃣ 章节正文</h2><table><tr><th>✓</th><th>项目</th><th>数值</th></tr>');
    h.push(row(chs.length > 0, '总章数', chs.length + ' 章'));
    var byVol = {};
    chs.forEach(function (c) { var k = c.vol || 'none'; byVol[k] = (byVol[k] || 0) + 1; });
    Object.keys(byVol).sort().forEach(function (k) { h.push('<tr><td class="m">·</td><td>' + esc(vname(k)) + '</td><td class="n">' + byVol[k] + ' 章</td></tr>'); });
    var bodyChars = chs.reduce(function (a, c) { return a + ((c.body || '').length); }, 0);
    h.push(row(bodyChars > 0, '正文总字数', bodyChars.toLocaleString() + ' 字'));
    var withBody = chs.filter(function (c) { return (c.body || '').trim(); }).length;
    h.push(row(withBody === chs.length, '有正文的章', withBody + ' / ' + chs.length));
    var withSyn = chs.filter(function (c) { return (c.synopsis || '').trim(); }).length;
    h.push(row(withSyn === chs.length, '有一句话梗概的章', withSyn + ' / ' + chs.length +
      (withSyn < chs.length ? ' ← 缺梗概会削弱长线脉络注入' : '')));
    Object.keys(byVol).forEach(function (k) {
      var nums = chs.filter(function (c) { return (c.vol || 'none') === k; }).map(function (c) { return Number(c.num); })
        .filter(function (n) { return isFinite(n); }).sort(function (x, y) { return x - y; });
      if (!nums.length) return;
      var miss = [];
      for (var i = nums[0]; i <= nums[nums.length - 1]; i++) if (nums.indexOf(i) < 0) miss.push(i);
      h.push(row(miss.length === 0, vname(k) + ' 章号 ' + nums[0] + '–' + nums[nums.length - 1],
        miss.length ? '断号：' + miss.join(',') : '连续无断号'));
    });
    var st = {};
    chs.forEach(function (c) { var k = c.status || 'draft'; st[k] = (st[k] || 0) + 1; });
    h.push(row((st.done || 0) === chs.length, '完稿状态',
      Object.keys(st).map(function (k) { return k + ' ' + st[k]; }).join(' / ') + '（只有 done 进续写上下文）'));
    h.push('</table>');

    /* 3 人物 */
    h.push('<h2>3️⃣ 人物设定</h2><table><tr><th>✓</th><th>项目</th><th>说明</th></tr>');
    h.push(row(chars.length > 0, '人物卡数量', chars.length + ' 人'));
    var full = 0, noLang = [];
    chars.forEach(function (c) {
      var miss = CFIELDS.filter(function (f) { return !(c[f[0]] || '').toString().trim(); }).map(function (f) { return f[1]; });
      if (!miss.length) full++;
      if (!(c.langSys || '').trim()) noLang.push(c.name || '(无名)');
      h.push('<tr><td class="m">' + (miss.length ? '⚠️' : '✅') + '</td><td>' + esc(c.name || '(无名)') +
        (c.protagonist ? ' ★主角' : '') + '</td><td class="n">' +
        (miss.length ? '缺：' + esc(miss.join('、')) : '字段齐全') + '</td></tr>');
    });
    h.push(row(full === chars.length && chars.length > 0, '字段齐全的人物', full + ' / ' + chars.length));
    h.push(row(chars.some(function (c) { return c.protagonist; }), '已标记主角',
      chars.filter(function (c) { return c.protagonist; }).map(function (c) { return c.name; }).join('、') || '无'));
    if (noLang.length) h.push('<tr><td class="m">⚠️</td><td colspan="2" class="warn">缺「语言体系」的人物不会进声线卡 —— v106 的声线统一依赖此字段：' + esc(noLang.join('、')) + '</td></tr>');
    h.push('</table>');

    /* 4-8 */
    h.push('<h2>4️⃣–8️⃣ 剧情线 / 世界观 / 设定 / 时间线 / 风格</h2><table><tr><th>✓</th><th>项目</th><th>数值</th></tr>');
    h.push(row(plot.length > 0, '剧情线（伏笔/线索）', plot.length + ' 条'));
    plot.slice(0, 10).forEach(function (p) {
      h.push('<tr><td class="m">·</td><td>' + esc(p.line || '') + '</td><td class="n">[' + esc(p.status || '?') + '] ' +
        esc(p.point || '') + (p.owner ? '（' + esc(p.owner) + '）' : '') + '</td></tr>');
    });
    h.push(row((b.world || '').trim().length > 0, '世界观', ((b.world || '').length) + ' 字'));
    h.push(row(settings.length > 0, '设定词条库', settings.length + ' 条'));
    var bc = {};
    settings.forEach(function (s) { var k = s.cat || '未分类'; bc[k] = (bc[k] || 0) + 1; });
    Object.keys(bc).forEach(function (k) { h.push('<tr><td class="m">·</td><td>' + esc(k) + '</td><td class="n">' + bc[k] + ' 条</td></tr>'); });
    h.push(row(timeline.length > 0, '时间线', timeline.length + ' 条'));
    h.push(row((b.style || []).length > 0, '风格规范', (b.style || []).length + ' 条'));
    h.push(row((b.meta || '').length > 0, '比喻素材库', ((b.meta || '').length) + ' 字'));
    h.push('</table>');

    /* 9 档案 */
    h.push('<h2>9️⃣ AI 消化档案</h2><table><tr><th>✓</th><th>分卷</th><th>档案块 / 滚动摘要 / 已消化</th></tr>');
    var dvs = dg.volumes || {}, dk = Object.keys(dvs);
    if (!dk.length) {
      h.push('<tr><td class="m">❌</td><td colspan="2" class="bad">没有任何分卷的消化档案 —— 续写时 AI 读不到已写内容的长线脉络，每章都会「失忆」。</td></tr>');
    } else {
      dk.forEach(function (vid) {
        var v = dvs[vid] || {}, bl = Object.keys(v.blocks || {}).length;
        var rl = ((v.rolling || '').trim().length), tl = ((v.text || '').length);
        var cs = v.chapters || {};
        var dn = Object.keys(cs).filter(function (k) { return String(cs[k] || '').indexOf('digested') >= 0; }).length;
        h.push('<tr><td class="m">' + (bl > 0 ? '✅' : '❌') + '</td><td>' + esc(vname(vid)) + '</td><td class="n">块 ' + bl +
          ' · rolling ' + rl + ' 字 · 缓存 ' + tl + ' 字 · 已消化 ' + dn + ' 章</td></tr>');
      });
    }
    h.push('</table>');

    /* 10 对照 */
    h.push('<h2>🔟 与源材料规模对照</h2><table><tr><th>✓</th><th>项目</th><th>说明</th></tr>');
    var jn = chs.filter(function (c) { return c.vol === 'james'; }).length;
    var sn = chs.filter(function (c) { return c.vol === 'sirius'; }).length;
    h.push(row(jn === 74, '詹姆斯篇', jn + ' / 74 章'));
    h.push(row(sn === 14, '西里斯篇', sn + ' / 14 章'));
    h.push(row(chs.length === 88, '合计', chs.length + ' / 88 章'));
    h.push('</table><p class="tip">源材料：詹姆斯篇手稿 74 章 / 255,905 字；西里斯篇手稿 14 章 / 64,661 字。两份均已生成配套消化档案包，可在「数据 → 后端消化档案」一键装载。</p>');
    return h.join('');
  }

  var mask = document.createElement('div');
  mask.id = 'liliaDiagMask';
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto;font-family:"Microsoft YaHei","PingFang SC",sans-serif';
  var box = document.createElement('div');
  box.style.cssText = 'background:#fff;color:#1a1d21;border-radius:12px;max-width:860px;width:100%;padding:24px 28px;box-shadow:0 12px 48px rgba(0,0,0,.3);font-size:14px;line-height:1.7';
  box.innerHTML = '<h1 style="font-size:20px;margin:0 0 4px">莉莉娅写作岛 · 录入完整度自检</h1>' +
    '<p style="color:#888;font-size:12.5px;margin:0 0 16px">只读统计 · 零写入 · 再次点击书签可关闭</p>' +
    '<p style="color:#666">正在读取 IndexedDB…</p>';
  mask.appendChild(box);
  document.body.appendChild(mask);
  window.__liliaDiag = mask;
  mask.addEventListener('click', function (e) { if (e.target === mask) { mask.remove(); window.__liliaDiag = null; } });

  var st = document.createElement('style');
  st.textContent = '#liliaDiagMask table{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:13.5px}' +
    '#liliaDiagMask th{background:#f0f2f5;text-align:left;padding:7px 10px;border-bottom:1px solid #e4e7ec;font-weight:600}' +
    '#liliaDiagMask td{padding:6px 10px;border-bottom:1px #eef0f3 solid;vertical-align:top}' +
    '#liliaDiagMask td.m{width:34px;text-align:center}#liliaDiagMask td.n{color:#8a919c;font-size:12.5px}' +
    '#liliaDiagMask h2{font-size:16px;margin:22px 0 2px;border-left:4px solid #1c5fa8;padding-left:9px}' +
    '#liliaDiagMask .bad{color:#c0392b;font-weight:600}#liliaDiagMask .warn{color:#9a6a06}' +
    '#liliaDiagMask .tip{background:#eef4fb;border-left:4px solid #1c5fa8;padding:9px 13px;border-radius:0 6px 6px 0;font-size:13px;margin:10px 0}';
  document.head.appendChild(st);

  new Promise(function (res, rej) {
    var rq = indexedDB.open('liliaIslandDB', 1);
    rq.onsuccess = function () {
      try {
        var tx = rq.result.transaction('kv', 'readonly');
        var g = tx.objectStore('kv').get('books');
        g.onsuccess = function () { res(g.result ? g.result.v : null); };
        g.onerror = function () { rej(g.error); };
      } catch (e) { rej(e); }
    };
    rq.onerror = function () { rej(rq.error); };
  }).then(function (books) {
    box.innerHTML += report(books) + '<p style="color:#aaa;font-size:12px;margin-top:20px">点击遮罩空白处关闭</p>';
  }).catch(function (e) {
    box.innerHTML += '<p class="bad">读取失败：' + esc(e && e.message) + '</p>';
  });
})();
