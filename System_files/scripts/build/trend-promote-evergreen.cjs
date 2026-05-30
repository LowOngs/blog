#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/trend-promote-evergreen.cjs
 * ============================================================
 *
 * 역할:
 * - dist/evergreen-candidates/evergreen-candidates.json 을 읽는다.
 * - status === "promoteCandidate" 항목만 evergreen warehouse에 주입한다.
 * - hold / reject 항목은 절대 주입하지 않는다.
 * - 기존 evergreen seedpool 파일은 삭제/초기화하지 않는다.
 * - fingerprint / entity.name / rawConceptKey 기준으로 중복 주입을 막는다.
 *
 * 입력:
 * - System_files/dist/evergreen-candidates/evergreen-candidates.json
 *
 * 출력:
 * - System_files/seedpool/warehouse/evergreen/{label}-evergreen.json
 * - System_files/logs/trend-promote-evergreen-report.json
 *
 * 환경변수:
 * - EVERGREEN_CANDIDATES_FILE
 * - EVERGREEN_WAREHOUSE_DIR
 * - TREND_PROMOTE_WRITE_MODE
 *   - local / active / write : 실제 저장
 *   - dry / dryrun / test    : 저장하지 않고 리포트만 생성
 *
 * 설계 원칙:
 * 1) promoteCandidate만 evergreen 주입 대상이다.
 * 2) hold/reject는 장기 대기/검토 기록일 뿐 seedpool에 넣지 않는다.
 * 3) 기존 warehouse 구조를 최대한 보존한다.
 * 4) 배열형 / 객체형 seeds/items 구조 모두 대응한다.
 * 5) 중복 판단은 fingerprint + entity.name + rawConceptKey 복합 기준으로 한다.
 * 6) 이 파일은 승격 주입기이며 trend 후보 판정은 trend-evergreen-candidate.cjs 책임이다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_EVERGREEN_CANDIDATES_FILE = path.join(
  ROOT,
  'dist',
  'evergreen-candidates',
  'evergreen-candidates.json'
);

const DEFAULT_EVERGREEN_WAREHOUSE_DIR = path.join(
  ROOT,
  'seedpool',
  'warehouse',
  'evergreen'
);

const LOGS_DIR = path.join(ROOT, 'logs');
const REPORT_FILE = path.join(LOGS_DIR, 'trend-promote-evergreen-report.json');

const EVERGREEN_CANDIDATES_FILE = String(
  process.env.EVERGREEN_CANDIDATES_FILE || DEFAULT_EVERGREEN_CANDIDATES_FILE
).trim();

const EVERGREEN_WAREHOUSE_DIR = String(
  process.env.EVERGREEN_WAREHOUSE_DIR || DEFAULT_EVERGREEN_WAREHOUSE_DIR
).trim();

const WRITE_MODE = String(
  process.env.TREND_PROMOTE_WRITE_MODE || 'dryrun'
).trim().toLowerCase();

const CAN_WRITE = WRITE_MODE === 'local' || WRITE_MODE === 'active' || WRITE_MODE === 'write';
const DRY_RUN = WRITE_MODE === 'dry' || WRITE_MODE === 'dryrun' || WRITE_MODE === 'test' || !CAN_WRITE;

function log(...args) {
  console.log('[trend-promote-evergreen]', ...args);
}

function warn(...args) {
  console.warn('[trend-promote-evergreen][WARN]', ...args);
}

function fatal(message) {
  console.error('[trend-promote-evergreen][FATAL]', message);
  process.exit(1);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    warn(`JSON 읽기 실패: ${filePath}`, e.message || e);
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function slugify(value) {
  return normalizeLower(value)
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueArray(values) {
  const seen = new Set();
  const out = [];
  for (const value of ensureArray(values)) {
    const text = normalizeText(value);
    if (!text) continue;
    const key = normalizeLower(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function loadEvergreenCandidates(filePath) {
  if (!fs.existsSync(filePath)) fatal(`evergreen candidates 파일 없음: ${filePath}`);
  const doc = readJsonSafe(filePath, null);
  if (!doc || typeof doc !== 'object') fatal(`evergreen candidates JSON 비정상: ${filePath}`);
  return doc;
}

function pickPromoteCandidates(doc) {
  if (Array.isArray(doc.promoteCandidates)) {
    return doc.promoteCandidates.filter(item => item && item.status === 'promoteCandidate');
  }
  if (Array.isArray(doc.items)) {
    return doc.items.filter(item => item && item.status === 'promoteCandidate');
  }
  return [];
}

function extractLabel(candidate) {
  return normalizeText(candidate && candidate.label) || 'device-reviews';
}

function extractEntity(candidate) {
  if (candidate && candidate.entity && typeof candidate.entity === 'object') return candidate.entity;
  if (candidate && candidate.reviewEntity && typeof candidate.reviewEntity === 'object') return candidate.reviewEntity;
  return { name: normalizeText(candidate && candidate.title) || 'Unknown entity' };
}

function extractEntityName(candidate) {
  const entity = extractEntity(candidate);
  return normalizeText(entity.name) || normalizeText(candidate && candidate.title) || 'Unknown entity';
}

function extractReviewEntity(candidate) {
  if (candidate && candidate.reviewEntity && typeof candidate.reviewEntity === 'object') return candidate.reviewEntity;
  return extractEntity(candidate);
}

function extractSourceTrend(candidate) {
  return candidate && candidate.sourceTrend && typeof candidate.sourceTrend === 'object' ? candidate.sourceTrend : {};
}

function extractPromotionReadiness(candidate) {
  return candidate && candidate.promotionReadiness && typeof candidate.promotionReadiness === 'object' ? candidate.promotionReadiness : {};
}

function extractSelectionMeta(candidate) {
  return candidate && candidate.selectionMeta && typeof candidate.selectionMeta === 'object' ? candidate.selectionMeta : {};
}

function extractSourceTrace(candidate) {
  const sourceTrend = extractSourceTrend(candidate);
  return sourceTrend && sourceTrend.sourceTrace && typeof sourceTrend.sourceTrace === 'object' ? sourceTrend.sourceTrace : {};
}

function extractRawConceptKey(candidate) {
  const trace = extractSourceTrace(candidate);
  return normalizeText(trace.rawConceptKey) || normalizeText(candidate && candidate.rawConceptKey) || '';
}

function extractSourceFingerprint(candidate) {
  const sourceTrend = extractSourceTrend(candidate);
  const trace = extractSourceTrace(candidate);
  return normalizeText(candidate && candidate.fingerprint) || normalizeText(sourceTrend.fingerprint) || normalizeText(trace.rawFingerprint) || '';
}

function extractTrendFingerprint(candidate) {
  const sourceTrend = extractSourceTrend(candidate);
  return normalizeText(sourceTrend.fingerprint) || '';
}

function extractKeyPoints(candidate) {
  const sourceTrend = extractSourceTrend(candidate);
  const evidence = sourceTrend.evidence && typeof sourceTrend.evidence === 'object' ? sourceTrend.evidence : {};
  return uniqueArray([
    ...ensureArray(candidate && candidate.keyPoints),
    ...ensureArray(evidence.keyFacts),
    ...ensureArray(evidence.useCases),
  ]);
}

function labelToEvergreenFilename(label) {
  const normalized = normalizeLower(label);
  const allowed = new Set([
    'app-reviews',
    'device-reviews',
    'subscription-services',
    'how-to-playbooks',
    'smart-savings',
    'templates-checklists',
  ]);
  if (!allowed.has(normalized)) return 'device-reviews-evergreen.json';
  return `${normalized}-evergreen.json`;
}

function evergreenFilePathByLabel(label) {
  return path.join(EVERGREEN_WAREHOUSE_DIR, labelToEvergreenFilename(label));
}

function createEmptyWarehouseDoc(label) {
  return {
    version: 1,
    updatedAt: null,
    label,
    mode: 'evergreen',
    seeds: [],
  };
}

function getSeedArrayInfo(doc) {
  if (Array.isArray(doc)) return { kind: 'array', seeds: doc };
  if (!doc || typeof doc !== 'object') return { kind: 'object-seeds', seeds: [] };
  if (Array.isArray(doc.seeds)) return { kind: 'object-seeds', seeds: doc.seeds };
  if (Array.isArray(doc.items)) return { kind: 'object-items', seeds: doc.items };
  return { kind: 'object-seeds', seeds: [] };
}

function setSeedArray(doc, info, seeds, label) {
  if (info.kind === 'array') return seeds;
  const out = doc && typeof doc === 'object' ? { ...doc } : createEmptyWarehouseDoc(label);
  if (info.kind === 'object-items') out.items = seeds;
  else out.seeds = seeds;
  out.updatedAt = nowIso();
  if (!out.label) out.label = label;
  if (!out.mode) out.mode = 'evergreen';
  return out;
}

function loadWarehouseDoc(filePath, label) {
  if (!fs.existsSync(filePath)) return createEmptyWarehouseDoc(label);
  const doc = readJsonSafe(filePath, createEmptyWarehouseDoc(label));
  if (Array.isArray(doc)) return doc;
  if (!doc || typeof doc !== 'object') return createEmptyWarehouseDoc(label);
  return doc;
}

function seedEntityName(seed) {
  if (seed && seed.entity && typeof seed.entity === 'object') return normalizeText(seed.entity.name);
  if (seed && seed.reviewEntity && typeof seed.reviewEntity === 'object') return normalizeText(seed.reviewEntity.name);
  return normalizeText(seed && seed.title);
}

function seedRawConceptKey(seed) {
  return normalizeText(seed && seed.selectionMeta && seed.selectionMeta.rawConceptKey) ||
    normalizeText(seed && seed.seedMeta && seed.seedMeta.rawConceptKey) ||
    normalizeText(seed && seed.rawConceptKey);
}

function seedFingerprints(seed) {
  return uniqueArray([
    seed && seed.fingerprint,
    seed && seed.sourceFingerprint,
    seed && seed.trendFingerprint,
    seed && seed.selectionMeta && seed.selectionMeta.sourceFingerprint,
    seed && seed.selectionMeta && seed.selectionMeta.trendFingerprint,
    seed && seed.seedMeta && seed.seedMeta.sourceFingerprint,
    seed && seed.seedMeta && seed.seedMeta.trendFingerprint,
  ]);
}

function buildExistingIndex(seeds) {
  const fingerprints = new Set();
  const entityNames = new Set();
  const conceptKeys = new Set();
  for (const seed of ensureArray(seeds)) {
    for (const fp of seedFingerprints(seed)) fingerprints.add(normalizeLower(fp));
    const entity = seedEntityName(seed);
    if (entity) entityNames.add(normalizeLower(entity));
    const conceptKey = seedRawConceptKey(seed);
    if (conceptKey) conceptKeys.add(normalizeLower(conceptKey));
  }
  return { fingerprints, entityNames, conceptKeys };
}

function findDuplicateReason(candidate, existingIndex) {
  const candidateFp = extractSourceFingerprint(candidate);
  const trendFp = extractTrendFingerprint(candidate);
  const entityName = extractEntityName(candidate);
  const rawConceptKey = extractRawConceptKey(candidate);
  const fpKeys = uniqueArray([candidateFp, trendFp]).map(normalizeLower);

  for (const fp of fpKeys) {
    if (fp && existingIndex.fingerprints.has(fp)) return `duplicate fingerprint: ${fp}`;
  }
  if (entityName && existingIndex.entityNames.has(normalizeLower(entityName))) return `duplicate entity: ${entityName}`;
  if (rawConceptKey && existingIndex.conceptKeys.has(normalizeLower(rawConceptKey))) return `duplicate rawConceptKey: ${rawConceptKey}`;
  return '';
}

function buildEvergreenSeedId(candidate) {
  const label = extractLabel(candidate);
  const entityName = extractEntityName(candidate);
  const rawConceptKey = extractRawConceptKey(candidate);
  const sourceFingerprint = extractSourceFingerprint(candidate);
  const basis = ['evergreen-from-trend', label, entityName, rawConceptKey, sourceFingerprint].join('|');
  return `${slugify(entityName) || 'evergreen-seed'}-${sha1(basis).slice(0, 10)}`;
}

function buildPromotedFingerprint(candidate) {
  const label = extractLabel(candidate);
  const entityName = extractEntityName(candidate);
  const rawConceptKey = extractRawConceptKey(candidate);
  const sourceFingerprint = extractSourceFingerprint(candidate);
  const basis = ['promoted-evergreen', label, entityName, rawConceptKey, sourceFingerprint].join('|');
  return `fp1:${sha1(basis)}`;
}

function buildPromotedSeed(candidate) {
  const label = extractLabel(candidate);
  const entity = extractEntity(candidate);
  const reviewEntity = extractReviewEntity(candidate);
  const sourceTrend = extractSourceTrend(candidate);
  const promotionReadiness = extractPromotionReadiness(candidate);
  const selectionMeta = extractSelectionMeta(candidate);
  const sourceTrace = extractSourceTrace(candidate);
  const rawConceptKey = extractRawConceptKey(candidate);
  const sourceFingerprint = extractSourceFingerprint(candidate);
  const trendFingerprint = extractTrendFingerprint(candidate);
  const promotedAt = nowIso();
  const entityName = extractEntityName(candidate);

  return {
    id: buildEvergreenSeedId(candidate),
    label,
    mode: 'evergreen',
    sourceMode: 'trend',
    sourceLayer: 'trend-promote-evergreen',
    status: 'ready',
    priority: 'normal',
    title: normalizeText(candidate.title) || `${entityName} evergreen review`,
    entity,
    reviewEntity,
    angle: normalizeText(candidate.angle) || normalizeText(sourceTrend.angle) || `Evaluate ${entityName} as an evergreen review target.`,
    audience: normalizeText(candidate.audience) || normalizeText(sourceTrend.audience) || 'users evaluating a durable product decision',
    intent: normalizeText(candidate.intent) || `evergreen/${label}`,
    goal: normalizeText(candidate.goal) || `promote ${entityName} from trend to evergreen`,
    keyPoints: extractKeyPoints(candidate),
    bodyPrompt: '',
    fingerprint: buildPromotedFingerprint(candidate),
    sourceFingerprint,
    trendFingerprint,
    rawConceptKey,
    trendPromotion: {
      promotedAt,
      source: 'trend-promote-evergreen',
      fromCandidateStatus: normalizeText(candidate.status),
      fromCandidateReason: normalizeText(candidate.reason),
      promotionScore: Number(candidate.score || 0) || 0,
      promotionReadiness,
      sourceTrendTitle: normalizeText(sourceTrend.title),
      sourceTrendAngle: normalizeText(sourceTrend.angle),
      sourceTrendGoal: normalizeText(sourceTrend.goal),
      sourceTrace,
    },
    selectionCriteria: {
      ...(candidate.selectionCriteria && typeof candidate.selectionCriteria === 'object' ? candidate.selectionCriteria : {}),
      promotedFromTrend: true,
      evergreenWarehouseInjected: true,
      promoteCandidateOnly: true,
      duplicateGuard: ['fingerprint', 'entity.name', 'rawConceptKey'],
    },
    selectionMeta: {
      ...(selectionMeta && typeof selectionMeta === 'object' ? selectionMeta : {}),
      source: 'trend-promote-evergreen',
      promotedAt,
      inputSource: path.basename(EVERGREEN_CANDIDATES_FILE),
      targetWarehouse: labelToEvergreenFilename(label),
      rawConceptKey,
      sourceFingerprint,
      trendFingerprint,
    },
  };
}

function groupCandidatesByLabel(candidates) {
  const groups = new Map();
  for (const candidate of ensureArray(candidates)) {
    const label = extractLabel(candidate);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(candidate);
  }
  return groups;
}

function promoteGroup(label, candidates) {
  const filePath = evergreenFilePathByLabel(label);
  const existingDoc = loadWarehouseDoc(filePath, label);
  const info = getSeedArrayInfo(existingDoc);
  const existingSeeds = ensureArray(info.seeds);
  const existingIndex = buildExistingIndex(existingSeeds);
  const nextSeeds = existingSeeds.slice();
  const results = [];

  for (const candidate of ensureArray(candidates)) {
    const entityName = extractEntityName(candidate);
    const duplicateReason = findDuplicateReason(candidate, existingIndex);

    if (duplicateReason) {
      results.push({
        label,
        entityName,
        status: 'skippedDuplicate',
        reason: duplicateReason,
        targetFile: filePath,
      });
      continue;
    }

    const promotedSeed = buildPromotedSeed(candidate);
    const status = DRY_RUN ? 'wouldCreate' : 'created';

    results.push({
      label,
      entityName,
      status,
      reason: DRY_RUN ? 'dryrun only' : 'promoted to evergreen warehouse',
      targetFile: filePath,
      seedId: promotedSeed.id,
      fingerprint: promotedSeed.fingerprint,
    });

    nextSeeds.push(promotedSeed);

    for (const fp of seedFingerprints(promotedSeed)) existingIndex.fingerprints.add(normalizeLower(fp));
    const promotedEntity = seedEntityName(promotedSeed);
    if (promotedEntity) existingIndex.entityNames.add(normalizeLower(promotedEntity));
    const promotedConceptKey = seedRawConceptKey(promotedSeed);
    if (promotedConceptKey) existingIndex.conceptKeys.add(normalizeLower(promotedConceptKey));
  }

  const nextDoc = setSeedArray(existingDoc, info, nextSeeds, label);
  if (CAN_WRITE && !DRY_RUN) writeJsonAtomic(filePath, nextDoc);

  return {
    label,
    targetFile: filePath,
    before: existingSeeds.length,
    after: nextSeeds.length,
    created: results.filter(item => item.status === 'created').length,
    wouldCreate: results.filter(item => item.status === 'wouldCreate').length,
    skippedDuplicate: results.filter(item => item.status === 'skippedDuplicate').length,
    results,
  };
}

function buildReport(inputDoc, promoteCandidates, groupReports) {
  const flat = groupReports.flatMap(report => report.results);
  return {
    schemaVersion: 'trend-promote-evergreen-report.v1',
    generatedAt: nowIso(),
    writeMode: WRITE_MODE,
    canWrite: CAN_WRITE && !DRY_RUN,
    inputFile: EVERGREEN_CANDIDATES_FILE,
    warehouseDir: EVERGREEN_WAREHOUSE_DIR,
    inputSummary: inputDoc && inputDoc.summary ? inputDoc.summary : null,
    checkedPromoteCandidates: promoteCandidates.length,
    created: flat.filter(item => item.status === 'created').length,
    wouldCreate: flat.filter(item => item.status === 'wouldCreate').length,
    skippedDuplicate: flat.filter(item => item.status === 'skippedDuplicate').length,
    groups: groupReports,
  };
}

function promoteEvergreenCandidates() {
  const doc = loadEvergreenCandidates(EVERGREEN_CANDIDATES_FILE);
  const promoteCandidates = pickPromoteCandidates(doc);
  const groups = groupCandidatesByLabel(promoteCandidates);
  const groupReports = [];

  for (const [label, candidates] of groups.entries()) {
    groupReports.push(promoteGroup(label, candidates));
  }

  const report = buildReport(doc, promoteCandidates, groupReports);
  writeJsonAtomic(REPORT_FILE, report);
  return report;
}

function main() {
  log('source    =', EVERGREEN_CANDIDATES_FILE);
  log('warehouse =', EVERGREEN_WAREHOUSE_DIR);
  log('mode      =', WRITE_MODE, DRY_RUN ? '(DRY)' : '(WRITE)');

  const report = promoteEvergreenCandidates();

  log('promote candidates =', report.checkedPromoteCandidates);
  log('created            =', report.created);
  log('wouldCreate        =', report.wouldCreate);
  log('skippedDuplicate   =', report.skippedDuplicate);
  log('report saved       =', REPORT_FILE);

  if (DRY_RUN) log('dryrun mode: warehouse 파일은 변경하지 않았습니다.');
}

if (require.main === module) {
  main();
}

module.exports = {
  promoteEvergreenCandidates,
  buildPromotedSeed,
  buildPromotedFingerprint,
  buildEvergreenSeedId,
  pickPromoteCandidates,
  findDuplicateReason,
};

