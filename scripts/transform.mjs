#!/usr/bin/env node
/**
 * transform.mjs —— 把 raw/ 的镜像内容转换成「赛博中国鸡蛋」站点（site/）
 *
 * 处理内容：
 *  1. 品牌改名：赛博鸡蛋 → 赛博中国鸡蛋，去掉原作者署名
 *  2. 移除他人身份与推广：微信二维码区块、QQ 群、B站、带货条（深度用 AI）、付费目录页
 *  3. 移除播客（他人真人音频，不转存）
 *  4. 域名重写：saibojidan.pages.dev → saibochinaegg.pages.dev
 *  5. 去导流：剥离指向 wzyp.cn 的商品外链（纯存档，不引流）
 *  6. 隐去「购买渠道」正文笔记（notes/gemini-18mo-deadline.html）：保留标题与截止说明，移除价格/渠道正文
 *  7. 重新生成 sitemap.xml / robots.txt / feed.xml
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const RAW = path.join(ROOT, 'raw');
export const SITE = path.join(ROOT, 'site');

export const OLD_DOMAIN = 'https://saibojidan.pages.dev';
export const NEW_DOMAIN = 'https://saibochinaegg.pages.dev';
export const OLD_BRAND = '赛博鸡蛋';
export const NEW_BRAND = '赛博中国鸡蛋';

/** 不镜像/不输出的页面 */
const DROP_PAGES = new Set([
  'classic.html',
  'classic',
  'classic/index.html',
  'podcast.xml',
  'podcast-cover.png',
  'assets/qr.jpg',
]);

/** 不镜像的二进制资源（他人音频、二维码） */
const DROP_ASSET_RE = [
  /^audio\//,
  /^assets\/qr\./,
  /^podcast-cover\./,
];

function stripSection(html, className) {
  const re = new RegExp(
    `<section[^>]*class="[^"]*\\b${className}\\b[^"]*"[\\s\\S]*?</section>\\s*`,
    'g'
  );
  return html.replace(re, '');
}

/** 逐页的 HTML 转换 */
function transformHtml(html, relPath) {
  let out = html;

  // --- 1. 品牌与署名 ---
  out = out.replaceAll('炙心的 AI 备忘 · 每天更新', 'AI 福利备忘 · 每天更新');
  out = out.replaceAll('炙心的 AI 备忘', 'AI 福利备忘');
  out = out.replaceAll('炙心补充', '编辑补充');
  out = out.replaceAll(OLD_BRAND, NEW_BRAND);

  // --- 2. 去掉他人身份 / 带货 / 联系区块 ---
  out = stripSection(out, 'services'); // 「深度用 AI」带货条
  out = stripSection(out, 'fallback'); // 微信二维码 + QQ 群 + B站

  // 页脚链接：播客、B站、付费目录
  out = out.replace(/<a href="\/podcast\.xml">播客<\/a>\s*/g, '');
  out = out.replace(
    /<a href="https:\/\/space\.bilibili\.com\/[^"]*"[^>]*>B站<\/a>\s*/g,
    ''
  );
  out = out.replace(/<a href="\/classic\.html[^"]*">[^<]*<\/a>\s*/g, '');
  out = out.replace(/<a href="\/classic">[^<]*<\/a>\s*/g, '');

  // 详情/播报页导航里的付费目录按钮
  out = out.replace(
    /<a class="navbtn" href="\/classic\.html[^"]*">[^<]*<\/a>\s*/g,
    ''
  );

  // 兜底：仍残留的 bilibili / qr.jpg / QQ 群号引用
  out = out.replace(
    /<a href="https:\/\/space\.bilibili\.com\/[^"]*"[^>]*>[^<]*<\/a>/g,
    ''
  );
  // 播报页里的「看本期视频」按钮 —— 指向原作者视频，不保留
  out = out.replace(
    /<a class="btn solid" href="https:\/\/www\.bilibili\.com\/video\/[^"]*"[^>]*>[^<]*<\/a>\s*/g,
    ''
  );
  out = out.replace(
    /<a[^>]*href="https:\/\/www\.bilibili\.com\/[^"]*"[^>]*>[^<]*<\/a>\s*/g,
    ''
  );
  // 订阅页里提到「B 站 / 飞书」的文案，改为中立表述
  out = out.replace(/不用再翻\s*B\s*站或点飞书。?/g, '不用再反复手动查看。');
  out = out.replace(/每天随视频一起更新。?/g, '每天自动同步更新。');
  out = out.replace(/每天视频同步。?/g, '');
  out = out.replace(/QQ 群\s*249729644[^<]*/g, '');
  out = out.replace(
    /<img[^>]*src="\/assets\/qr\.jpg"[^>]*>/g,
    ''
  );
  out = out.replace(
    /<img[^>]*src="assets\/qr\.jpg"[^>]*>/g,
    ''
  );

  // --- 2.6 去导流：剥离指向 wzyp.cn 的商品外链（纯存档，不引流）---
  // 移除整段 <a href="...wzyp.cn...">...</a>（含链接文字），避免向第三方店铺导流
  out = out.replace(
    /<a[^>]*href="https?:\/\/([^"\/]*\.)?wzyp\.cn[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
    ''
  );
  // 清理被移除链接后残留的「直达链接」引导语（普通与 <strong> 包裹两种，含标点）
  out = out.replace(/<strong>直达链接<\/strong>\s*[：:]\s*[，,]?/g, '');
  out = out.replace(/直达链接\s*[：: ]?/g, '');
  // 兜底：仍残留的裸 wzyp.cn 文本一律清除
  out = out.replace(/wzyp\.cn/gi, '');

  // --- 2.7 隐去「购买渠道」正文的笔记（存档，不引流）---
  // gemini-18mo-deadline.html 整篇是带价格/渠道的购卡指南，仅保留导航、标题与截止说明，
  // 购买渠道与价格正文整段替换为中性存档说明，避免向第三方店铺导流。每天 CI 重抓后依旧生效。
  if (relPath === 'notes/gemini-18mo-deadline.html') {
    out = out.replace(
      /(<p class="sub">[\s\S]*?<\/p>)([\s\S]*?)(<\/main>)/,
      '$1\n<p class="note">本备忘为存档内容，原站的购买渠道与价格信息已隐去，仅保留说明性标题。如需 Gemini 配置方法，可参考原作者公开文档。</p>\n$3'
    );
  }

  // --- 3. 域名重写 ---
  out = out.replaceAll('saibojidan.pages.dev', 'saibochinaegg.pages.dev');

  // （顶部来源横幅与每页来源标注均已按需求移除）

  return out;
}

/** XML feed 转换 */
function transformXml(xml) {
  let out = xml;
  out = out.replaceAll(OLD_DOMAIN, NEW_DOMAIN);
  out = out.replaceAll(OLD_BRAND, NEW_BRAND);
  out = out.replaceAll('炙心的 AI 备忘', 'AI 福利备忘');
  out = out.replaceAll('<itunes:author>炙心</itunes:author>', `<itunes:author>${NEW_BRAND}</itunes:author>`);
  // 音频是原作者的真人录音，未转存；去掉 enclosure 避免阅读器指向失效地址
  out = out.replace(/<enclosure\b[^>]*\/>\s*/g, '');
  out = out.replace(/<itunes:duration>[^<]*<\/itunes:duration>\s*/g, '');
  return out;
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

export async function transform({ log = console.log } = {}) {
  await fs.rm(SITE, { recursive: true, force: true });
  await fs.mkdir(SITE, { recursive: true });

  const files = await walk(RAW);
  let written = 0;
  const skipped = [];
  const htmlPaths = [];

  for (const rel of files) {
    const norm = rel.split(path.sep).join('/');
    if (norm.startsWith('.') || norm === '.crawl-meta.json') continue;
    if (DROP_PAGES.has(norm)) { skipped.push(norm); continue; }
    if (DROP_ASSET_RE.some((re) => re.test(norm))) { skipped.push(norm); continue; }

    const src = path.join(RAW, rel);
    const dest = path.join(SITE, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    const ext = path.extname(norm).toLowerCase();
    if (ext === '.html') {
      const html = await fs.readFile(src, 'utf8');
      await fs.writeFile(dest, transformHtml(html, norm), 'utf8');
      htmlPaths.push(norm);
    } else if (ext === '.xml') {
      const xml = await fs.readFile(src, 'utf8');
      await fs.writeFile(dest, transformXml(xml), 'utf8');
    } else {
      await fs.copyFile(src, dest);
    }
    written++;
  }

  log(`[transform] 输出 ${written} 个文件（跳过 ${skipped.length}）`);

  // --- sitemap：只收 HTML 页面 ---
  const urls = htmlPaths
    .map((p) => (p === 'index.html' ? '/' : '/' + p))
    .sort();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${NEW_DOMAIN}${u}</loc></url>`).join('\n')}
</urlset>
`;
  await fs.writeFile(path.join(SITE, 'sitemap.xml'), sitemap, 'utf8');

  await fs.writeFile(
    path.join(SITE, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${NEW_DOMAIN}/sitemap.xml\n`,
    'utf8'
  );

  log(`[transform] sitemap ${urls.length} 条`);
  return { written, skipped, urls };
}

if (import.meta.filename === process.argv[1]) {
  transform().catch((e) => {
    console.error('[transform] 失败:', e);
    process.exit(1);
  });
}