#!/usr/bin/env node
'use strict';

/**
 * rebuild-pageids-from-journal.cjs
 * - manifests/pageid-journal.jsonl 을 읽어
 * - slug → 최신 pageId 맵을 생성
 * - output: manifests/pageid-map.from-journal.json
 *
 * 목적:
 * - ledger가 깨졌을 때 "증거" 기반으로 빠르게 복구/점검하는 보조 장치
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

const JOURNAL_FILE = path.join(MANIFESTS_DIR, 'pageid-journal.jsonl');
const OUT_FILE = path.join(MANIFESTS_DIR, 'pageid-map.from-journal.json');

function isValidPageId(v) {
  return typeof v === 'string' && /^page\d{6}$/.test(v);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function main() {
  ensureDir(MANIFESTS_DIR);

  if (!fs.existsSync(JOURNAL_FILE)) {
    console.error('[rebuild] journal not found:', JOURNAL_FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
  const lines = raw.split('\n');

  const map = {}; // slug -> { pageId, ts, mode }
  let parsed = 0;
  let skipped = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (!rec || !rec.slug || !isValidPageId(rec.pageId)) {
        skipped++;
        continue;
      }
      map[rec.slug] = {
        pageId: rec.pageId,
        ts: rec.ts || '',
        mode: rec.mode || ''
      };
      parsed++;
    } catch {
      skipped++;
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    journal: path.relative(ROOT, JOURNAL_FILE),
    count: Object.keys(map).length,
    items: map
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('[rebuild] OK:', OUT_FILE);
  console.log('[rebuild] parsed lines =', parsed, '| skipped =', skipped, '| slugs =', out.count);
}

main();
