/* 莉莉娅的写作岛 · 离线 Service Worker（让网页变成可离线打开的 APP，且自动同步新版本） */
const CACHE = 'jkd-app-v79';
const STATIC = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];
const NAV_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC)).catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function shellFromCache() {
  return caches.match('./index.html').then((r) => r || caches.match('./'));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 跨域请求（如 AI 接口）一律放行，不经过缓存层
  let sameOrigin = false;
  try {
    sameOrigin = new URL(req.url).origin === self.location.origin;
  } catch (err) {
    sameOrigin = false;
  }
  if (!sameOrigin) return;

  // 页面导航（主文档）：缓存优先 —— 立刻返回已缓存的 index.html（秒开），同时后台静默拉取最新版写回缓存。
  // 首次访问无缓存时回退网络；网络/服务端故障时永远有本地副本兜底，APP 不会白屏。
  // 这样「下拉刷新 / 重载」都即时，不再每次走网络重新下载 1.1MB。
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(function (cached) {
        fetch(req, { cache: 'no-cache' }).then(function (resp) {
          if (resp && resp.ok) {
            caches.open(CACHE).then(function (c) { c.put('./index.html', resp.clone()); }).catch(function () {});
          }
        }).catch(function () {});
        return cached || fetch(req);
      })
    );
    return;
  }

  // 静态资源：缓存优先，未命中再走网络。
  // 只缓存 2xx 成功响应，避免把一次偶发的错误页永久写进缓存。
  e.respondWith(
    caches.match(req).then((r) =>
      r || fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const cp = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
        }
        return resp;
      }).catch(() => shellFromCache())
    )
  );
});
