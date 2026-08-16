/* 莉莉娅的写作岛 · 离线 Service Worker（让网页变成可离线打开的 APP，且自动同步新版本） */
const CACHE = 'jkd-app-v56';
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

  // 页面导航（主文档）：网络优先，但带 4 秒超时 + HTTP 状态校验。
  // 服务端故障、返回错误页、弱网卡死、彻底离线 —— 任何一种情况都回落到本地缓存副本，
  // 保证 APP 永远能打开。成功时顺带把最新页面写回缓存，让离线副本保持最新。
  if (req.mode === 'navigate') {
    e.respondWith(
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('nav-timeout')), NAV_TIMEOUT);
        fetch(req, { cache: 'no-cache' }).then((resp) => {
          clearTimeout(timer);
          if (!resp || !resp.ok) {
            reject(new Error('nav-bad-status'));
            return;
          }
          const cp = resp.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', cp)).catch(() => {});
          resolve(resp);
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      }).catch(() => shellFromCache())
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
