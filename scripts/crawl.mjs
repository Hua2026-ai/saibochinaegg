#!/usr/bin/env node
/**
 * crawl.mjs —— 抓取上游站点（赛博鸡蛋）全部页面与静态资源到 raw/
 *
 * 上游是纯静态站：首页数据内嵌在 DEALS 数组里，另有 deals / episodes / notes 三类详情页，
 * 以及 feed.xml、podcast.xml、音频、封面图。sitemap.xml 给出了权威 URL 清单。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const SOURCE = 'https://saibojidan.pages.dev';
export const ROOT = path.resolve(import.meta.dirname, '..');
export const RAW = path.join(ROOT, 'raw');

const CONCURRENCY = 6;
const RETRY = 3;

/** sitemap 之外、但站点正常运作必需的固定路径 */
const EXTRA_PATHS = [
  '/',
  '/feed.xml',
  '/podcast.xml',
  '/podcast-cover.png',
  '/assets/qr.jpg',
];

const ASSET_EXT = new Set([
  '.mp3', '.m4a', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif',
  '.css', '.js', '.ico', '.woff', '.woff2', '.json',
]);

/** URL 路径 → 本地相对文件路径 */
function toRelPath(urlPath) {
  let p = urlPath.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.endsWith('/')) p += 'index.html';
  return p.slice(1);
}

async function fetchText(url, { retry = RETRY } = {}) {
  let lastErr;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'saibochinaegg-mirror/1.0 (+daily sync)' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retry - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchBuffer(url, { retry = RETRY } = {}) {
  let lastErr;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'saibochinaegg-mirror/1.0 (+daily sync)' },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < retry - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 限并发地跑一批任务 */
async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 从 sitemap 解析路径清单 */
async function getSitemapPaths() {
  const xml = await fetchText(`${SOURCE}/sitemap.xml`);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  return locs.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** 从 HTML/XML 文本里挖出站内资源路径 */
function extractAssetPaths(text) {
  const found = new Set();
  const patterns = [
    /(?:href|src)="(\/[^"?#]+)"/g,
    /(?:href|src)="https:\/\/saibojidan\.pages\.dev(\/[^"?#]*)"/g,
    /url="https:\/\/saibojidan\.pages\.dev(\/[^"?#]*)"/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const p = m[1];
      if (!p || p === '/') continue;
      if (p.startsWith('/_next/')) continue;
      const ext = path.extname(p.split('?')[0]).toLowerCase();
      if (ASSET_EXT.has(ext)) found.add(p);
    }
  }
  return [...found];
}

async function downloadPage(relPath) {
  const url = `${SOURCE}/${relPath}`;
  const isBinary = ASSET_EXT.has(path.extname(relPath).toLowerCase());
  const dest = path.join(RAW, relPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  try {
    if (isBinary) {
      const buf = await fetchBuffer(url);
      await fs.writeFile(dest, buf);
      return { relPath, ok: true, bytes: buf.length, binary: true };
    }
    const text = await fetchText(url);
    await fs.writeFile(dest, text, 'utf8');
    return { relPath, ok: true, bytes: Buffer.byteLength(text), binary: false, text };
  } catch (e) {
    return { relPath, ok: false, error: e.message };
  }
}

export async function crawl({ log = console.log } = {}) {
  await fs.mkdir(RAW, { recursive: true });

  const sitemapPaths = await getSitemapPaths();
  log(`[crawl] sitemap 发现 ${sitemapPaths.length} 个页面`);

  const pagePaths = [...new Set([...EXTRA_PATHS, ...sitemapPaths])]
    .map((p) => toRelPath(p))
    .filter((p) => p && !p.endsWith('/'));

  const pageResults = await pool(pagePaths, downloadPage);
  const failedPages = pageResults.filter((r) => !r.ok);
  const okPages = pageResults.filter((r) => r.ok);
  log(`[crawl] 页面完成：成功 ${okPages.length} / 失败 ${failedPages.length}`);

  // 第二轮：从已下载的 HTML 与 feed 中提取资源
  const assetSet = new Set();
  for (const r of okPages) {
    if (r.binary || !r.text) continue;
    for (const a of extractAssetPaths(r.text)) assetSet.add(toRelPath(a));
  }
  // feed/podcast 里的音频
  const feedCandidates = ['feed.xml', 'podcast.xml'];
  for (const f of feedCandidates) {
    const p = path.join(RAW, f);
    if (!(await exists(p))) continue;
    const text = await fs.readFile(p, 'utf8');
    for (const a of extractAssetPaths(text)) assetSet.add(toRelPath(a));
  }

  const assetPaths = [...assetSet].filter(
    (p) => p && !p.endsWith('index.html') && !(pagePaths.includes(p))
  );
  log(`[crawl] 发现 ${assetPaths.length} 个静态资源`);

  const assetResults = await pool(assetPaths, downloadPage);
  const failedAssets = assetResults.filter((r) => !r.ok);
  log(`[crawl] 资源完成：成功 ${assetResults.length - failedAssets.length} / 失败 ${failedAssets.length}`);

  const totalBytes = [...okPages, ...assetResults.filter((r) => r.ok)].reduce((s, r) => s + (r.bytes || 0), 0);
  log(`[crawl] 累计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  if (failedPages.length) {
    log(`[crawl] 失败页面：${failedPages.map((f) => f.relPath + ' (' + f.error + ')').join(', ')}`);
  }
  if (failedAssets.length) {
    log(`[crawl] 失败资源：${failedAssets.map((f) => f.relPath + ' (' + f.error + ')').join(', ')}`);
  }

  await fs.writeFile(
    path.join(RAW, '.crawl-meta.json'),
    JSON.stringify(
      {
        crawledAt: new Date().toISOString(),
        pages: okPages.length,
        assets: assetResults.length - failedAssets.length,
        failed: [...failedPages, ...failedAssets].map((f) => ({ path: f.relPath, error: f.error })),
      },
      null,
      2
    ),
    'utf8'
  );

  return {
    pages: okPages.length,
    assets: assetResults.length - failedAssets.length,
    failed: [...failedPages, ...failedAssets],
    totalBytes,
  };
}

if (import.meta.filename === process.argv[1]) {
  crawl()
    .then((r) => {
      if (r.failed.length) process.exitCode = 0;
      console.log('[crawl] 完成');
    })
    .catch((e) => {
      console.error('[crawl] 失败:', e);
      process.exit(1);
    });
}