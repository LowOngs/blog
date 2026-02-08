#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/lib/slug-policy.cjs
 * ============================================================
 *
 * 목적(SSOT)
 * - prefix/slug “정규 표준”을 단일 파일로 고정한다.
 * - queue-to-posts / patch-missing-labels / publish/blogger 가 이 파일만 참조한다.
 *
 * 원칙
 * 1) 정규 prefix는 6개만 존재한다.
 * 2) “과거 호환 prefix”는 입력 파싱에만 쓰고, 출력(생성)은 정규 prefix만 쓴다.
 * 3) label 6종 SSOT도 여기서 고정한다(서로 불일치 방지).
 */

// ─────────────────────────────────────────────
//  Label SSOT (6종 고정)
// ─────────────────────────────────────────────
const ALLOWED_LABELS = Object.freeze([
  'app-reviews',
  'device-reviews',
  'subscription-services',
  'how-to-playbooks',
  'smart-savings',
  'templates-checklists',
]);

const ALLOWED_LABEL_SET = new Set(ALLOWED_LABELS);

// ─────────────────────────────────────────────
//  정규 prefix SSOT (출력/생성 기준)
// ─────────────────────────────────────────────
const LABEL_TO_PREFIX = Object.freeze({
  'app-reviews':           'app',
  'device-reviews':        'device',
  'subscription-services': 'subscription',
  'how-to-playbooks':      'howto',
  'smart-savings':         'smartsavings',
  'templates-checklists':  'templates', // ✅ 정규는 templates 로 고정
});

const PREFIX_TO_LABEL_STRICT = Object.freeze({
  app:          'app-reviews',
  device:       'device-reviews',
  subscription: 'subscription-services',
  howto:        'how-to-playbooks',
  smartsavings: 'smart-savings',
  templates:    'templates-checklists',
});

// ─────────────────────────────────────────────
//  과거/별칭 prefix (입력 파싱에만 허용)
//  - 출력(생성)에서는 절대 사용 금지
// ─────────────────────────────────────────────
const PREFIX_ALIASES = Object.freeze({
  // subscription
  sub:          'subscription',
  subs:         'subscription',
  // how-to
  'how-to':     'howto',
  // smart-savings
  smart:        'smartsavings',
  save:         'smartsavings',
  // templates
  tpl:          'templates',
  tmpl:         'templates',
  template:     'templates', // ✅ template -> templates 로 흡수
});

// ─────────────────────────────────────────────
//  helpers
// ─────────────────────────────────────────────
function assertAllowedLabel(label, ctx = '') {
  const v = String(label || '').trim();
  if (!v) throw new Error(`label missing${ctx ? ` (${ctx})` : ''}`);
  if (!ALLOWED_LABEL_SET.has(v)) throw new Error(`label not allowed: "${v}"${ctx ? ` (${ctx})` : ''}`);
  return v;
}

function getCanonicalPrefixByLabel(label) {
  const v = assertAllowedLabel(label, 'getCanonicalPrefixByLabel');
  const p = LABEL_TO_PREFIX[v];
  if (!p) throw new Error(`prefix missing for label: "${v}"`);
  return p;
}

/**
 * slug에서 prefix를 뽑아 "정규 prefix"로 정규화한다.
 * - 예: template-20260207-001 -> templates
 * - 예: sub-20260207-001 -> subscription
 */
function normalizePrefix(prefixRaw) {
  const p = String(prefixRaw || '').trim().toLowerCase();
  if (!p) return '';
  if (PREFIX_TO_LABEL_STRICT[p]) return p;               // 이미 정규
  if (PREFIX_ALIASES[p]) return PREFIX_ALIASES[p];       // 별칭 -> 정규
  return p;                                              // 모르는 값은 그대로(호출부에서 처리)
}

/**
 * filename/slug에서 label을 추론한다.
 * - 1) firstgate-<label>-... 패턴이면 label을 직접 읽는다(6종만 허용)
 * - 2) 그 외: slug/filename prefix 기반
 */
function inferLabelFromSlugOrFilename(nameOrSlug) {
  const base = String(nameOrSlug || '').replace(/\.html$/i, '').replace(/\.json$/i, '').trim();
  const lower = base.toLowerCase();

  // firstgate-<label>-... 케이스
  if (lower.startsWith('firstgate-')) {
    const rest = lower.slice('firstgate-'.length);
    const m = rest.match(/^(app-reviews|device-reviews|subscription-services|how-to-playbooks|smart-savings|templates-checklists)\b/);
    if (m && m[1]) return m[1];
    return null;
  }

  // 일반 prefix 케이스
  const prefix = lower.split(/[-_]/)[0];
  const canon = normalizePrefix(prefix);
  const label = PREFIX_TO_LABEL_STRICT[canon] || null;
  return label;
}

/**
 * label + yyyymmdd + idx(숫자) 로 정규 slug 생성
 * - 출력(생성)은 항상 정규 prefix를 사용한다.
 */
function buildSlug({ label, yyyymmdd, index3 }) {
  const p = getCanonicalPrefixByLabel(label);
  const d = String(yyyymmdd || '').trim();
  const n = String(index3 || '').trim();
  if (!/^\d{8}$/.test(d)) throw new Error(`bad yyyymmdd: "${d}"`);
  if (!/^\d{3}$/.test(n)) throw new Error(`bad index3: "${n}"`);
  return `${p}-${d}-${n}`;
}

module.exports = {
  // SSOT exports
  ALLOWED_LABELS,
  ALLOWED_LABEL_SET,
  LABEL_TO_PREFIX,
  PREFIX_TO_LABEL_STRICT,
  PREFIX_ALIASES,

  // helpers
  assertAllowedLabel,
  getCanonicalPrefixByLabel,
  normalizePrefix,
  inferLabelFromSlugOrFilename,
  buildSlug,
};
