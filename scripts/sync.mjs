#!/usr/bin/env node
/**
 * sync.mjs —— 完整同步流水线：抓取 → 转换 → 校验
 *
 * 用法：
 *   node scripts/sync.mjs            抓取并构建（不部署）
 *   node scripts/sync.mjs --deploy   构建后部署到 Cloudflare Pages
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { crawl, ROOT, RAW } from './crawl.mjs';
import { transform, SITE, OLD_BRAND, NEW_BRAND, OLD_DOMAIN } from './transform.mjs';

const exec = promisify(execFile);
const LOG_DIR = path.join(ROOT, 'logs');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 构建后自检：品牌替换、残留检查、页面数量 */
async function verify({ log }) {
  const issues = [];

  async function walk(dir, base = dir) {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full, base)));
      else out.push(path.relative(base, full));
    }
    return out;
  }

  const files = await walk(SITE);
  const htmlFiles = files.filter((f) => f.endsWith('.html'));

  let oldBrandHits = 0;
  let contactHits = 0;
  let attributions = 0;
  const offenders = [];

  for (const f of htmlFiles) {
    const html = await fs.readFile(path.join(SITE, f), 'utf8');
    // 来源标注块本身就含原站名与原作者名，属于合规引用，需在校验前剔除
    const body = html
      .replace(/<div class="src-attr">[\s\S]*?<\/div>/g, '')
      .replace(/<div class="src-banner">[\s\S]*?<\/div>/g, '');
    // 「赛博中国鸡蛋」里含有「赛博鸡蛋」子串，需要排除
    const stripped = body.replaceAll(NEW_BRAND, '');
    const ob = (stripped.match(new RegExp(OLD_BRAND, 'g')) || []).length;
    if (ob > 0) { oldBrandHits += ob; offenders.push(`${f}: 旧品牌 ${ob}`); }
    if (/space\.bilibili\.com|249729644|qr\.jpg|炙心/.test(body)) {
      contactHits++;
      offenders.push(`${f}: 残留他人身份信息`);
    }
    if (html.includes('src-attr')) attributions++;
  }

  if (oldBrandHits > 0) issues.push(`旧品牌残留 ${oldBrandHits} 处`);
  if (contactHits > 0) issues.push(`他人身份信息残留 ${contactHits} 页`);
  if (attributions < htmlFiles.length) {
    issues.push(`来源标注缺失：${htmlFiles.length - attributions} 页无标注`);
  }

  const indexHtml = await fs.readFile(path.join(SITE, 'index.html'), 'utf8');
  const dealCount = (indexHtml.match(/"id":"[^"]+","name":/g) || []).length;

  log(`[verify] HTML ${htmlFiles.length} 页，来源标注 ${attributions} 页，福利条目 ${dealCount} 条`);
  if (offenders.length) {
    log(`[verify] 明细：${offenders.slice(0, 12).join(' | ')}${offenders.length > 12 ? ` …共 ${offenders.length} 项` : ''}`);
  }
  if (issues.length) log(`[verify] ⚠ ${issues.join('；')}`);
  else log('[verify] ✓ 全部检查通过');

  return { htmlFiles: htmlFiles.length, dealCount, issues, offenders };
}

/** 部署到 Cloudflare Pages */
async function deploy({ log }) {
  const project = 'saibochinaegg';
  log(`[deploy] 上传 site/ 到 Cloudflare Pages 项目 ${project} …`);
  const { stdout, stderr } = await exec(
    'npx',
    ['--yes', 'wrangler@latest', 'pages', 'deploy', SITE, `--project-name=${project}`, '--branch=main', '--commit-dirty=true'],
    { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, env: process.env }
  );
  const out = (stdout || '') + (stderr || '');
  log(out.trim().split('\n').slice(-12).join('\n'));
  const urlMatch = out.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
  return { url: urlMatch ? urlMatch[0] : null, output: out };
}

export async function sync({ deploy: doDeploy = false, log = console.log } = {}) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const lines = [];
  const tee = (m) => { lines.push(m); log(m); };

  const started = new Date();
  tee(`[sync] 开始 ${started.toISOString()}`);

  const c = await crawl({ log: tee });
  const t = await transform({ log: tee });
  const v = await verify({ log: tee });

  let deployResult = null;
  if (doDeploy) {
    try {
      deployResult = await deploy({ log: tee });
      tee(`[deploy] 线上地址 ${deployResult.url}`);
    } catch (e) {
      tee(`[deploy] ✗ 失败：${e.message}`);
      deployResult = { error: e.message };
    }
  }

  const logFile = path.join(LOG_DIR, `${stamp()}.log`);
  await fs.writeFile(logFile, lines.join('\n') + '\n', 'utf8');

  // 变更摘要：与上一次抓取对比页面数
  return { crawl: c, transform: t, verify: v, deploy: deployResult, logFile, started };
}

if (import.meta.filename === process.argv[1]) {
  const doDeploy = process.argv.includes('--deploy');
  sync({ deploy: doDeploy })
    .then((r) => {
      // 部署失败必须让 workflow 标红（之前被 try/catch 吞掉，导致「假绿」）
      if (r.deploy && r.deploy.error) {
        console.error('[sync] ✗ 部署失败：' + r.deploy.error);
        process.exit(1);
      }
      if (r.verify.issues.length) {
        console.log('[sync] 完成，但有告警需人工确认');
      } else {
        console.log('[sync] 完成');
      }
    })
    .catch((e) => {
      console.error('[sync] 失败:', e);
      process.exit(1);
    });
}