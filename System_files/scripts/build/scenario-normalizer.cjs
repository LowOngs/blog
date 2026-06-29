#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/scripts/build/scenario-normalizer.cjs
 * Role : Collect and Normalize Scenario Evidence from Scenario Candidates
 * Root : C:\\google-blog\\System_files
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');

const INPUT_JSON = path.join(ROOT, 'seedpool', 'profiles', 'scenario-candidates.json');
const SNAPSHOT_JSON = path.join(ROOT, 'seedpool', 'profiles', 'scenario-web-snapshots.json');
const SNAPSHOT_JSONL = path.join(ROOT, 'seedpool', 'profiles', 'scenario-web-snapshots.jsonl');

const OUT_DIR = path.join(ROOT, 'seedpool', 'profiles');
const OUT_JSON = path.join(OUT_DIR, 'scenario-normalized.json');
const OUT_JSONL = path.join(OUT_DIR, 'scenario-normalized.jsonl');
const REPORT_JSON = path.join(ROOT, 'logs', 'scenario-normalizer-report.json');

const DEFAULT_ENTITY_LIMIT = 25;
const DEFAULT_QUERY_LIMIT_PER_ENTITY = 8;
const DEFAULT_RESULT_LIMIT_PER_QUERY = 5;
const DEFAULT_MIN_SCENE_SCORE = 2;

const FETCH_MODE = normalizeText(process.env.AOIA_SCENARIO_FETCH_MODE || 'offline').toLowerCase();
const ENTITY_LIMIT = toPositiveInt(process.env.AOIA_SCENARIO_ENTITY_LIMIT, DEFAULT_ENTITY_LIMIT);
const QUERY_LIMIT_PER_ENTITY = toPositiveInt(process.env.AOIA_SCENARIO_QUERY_LIMIT_PER_ENTITY, DEFAULT_QUERY_LIMIT_PER_ENTITY);
const RESULT_LIMIT_PER_QUERY = toPositiveInt(process.env.AOIA_SCENARIO_RESULT_LIMIT_PER_QUERY, DEFAULT_RESULT_LIMIT_PER_QUERY);
const MIN_SCENE_SCORE = toPositiveInt(process.env.AOIA_SCENARIO_MIN_SCENE_SCORE, DEFAULT_MIN_SCENE_SCORE);
const BING_ENDPOINT = normalizeText(process.env.BING_SEARCH_ENDPOINT || 'https://api.bing.microsoft.com/v7.0/search');
const BING_API_KEY = normalizeText(process.env.BING_SEARCH_API_KEY);

const SOURCE_KIND_RULES = [
  { kind: 'official', patterns: ['official', 'help', 'support', 'docs', 'documentation', 'release notes', 'pricing', 'features'] },
  { kind: 'review', patterns: ['review', 'pros and cons', 'worth it', 'best features', 'limitations'] },
  { kind: 'comparison', patterns: ['alternatives', ' vs ', 'comparison', 'compare'] },
  { kind: 'forum', patterns: ['reddit', 'forum', 'community', 'complaints', 'issues', 'problems'] },
  { kind: 'user_feedback', patterns: ['daily use', 'workflow', 'use cases', 'tips', 'should i use'] }
];

const SCENE_TYPE_RULES = [
  {
    sceneType: 'workflow',
    patterns: [
      'workflow', 'daily use', 'use case', 'use cases', 'tips', 'setup', 'project', 'task',
      'notes', 'meeting', 'schedule', 'calendar', 'planning', 'study', 'writing', 'editing'
    ]
  },
  {
    sceneType: 'comparison',
    patterns: ['alternative', 'alternatives', ' vs ', 'compare', 'comparison', 'switch', 'switching']
  },
  {
    sceneType: 'pain_point',
    patterns: [
      'problem', 'problems', 'issue', 'issues', 'complaint', 'complaints', 'limitation',
      'limitations', 'slow', 'sync', 'offline', 'bug', 'crash', 'privacy', 'account'
    ]
  },
  {
    sceneType: 'decision',
    patterns: ['worth it', 'should i use', 'review', 'pros and cons', 'decision', 'choose', 'choosing']
  },
  {
    sceneType: 'official_context',
    patterns: ['official', 'pricing', 'release notes', 'help center', 'features', 'support']
  },
  {
    sceneType: 'cost',
    patterns: ['price', 'pricing', 'subscription', 'plan', 'free tier', 'cost', 'save', 'saving']
  },
  {
    sceneType: 'security_privacy',
    patterns: ['privacy', 'security', 'account', 'permission', 'data', 'tracking']
  },
  {
    sceneType: 'performance',
    patterns: ['slow', 'speed', 'battery', 'sync', 'latency', 'crash', 'lag']
  }
];

const PURPOSE_TO_SCENE_TYPE = {
  real_usage: 'workflow',
  comparison: 'comparison',
  pain_points: 'pain_point',
  recommendation: 'decision',
  decision: 'decision',
  official_context: 'official_context'
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function uniqueArray(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(normalizeText).filter(Boolean))];
}

function compactWhitespace(value) {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function stripHtml(value) {
  return compactWhitespace(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

function sentenceSplit(text) {
  return compactWhitespace(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(compactWhitespace)
    .filter(sentence => sentence.length >= 24 && sentence.length <= 320);
}

function loadScenarioCandidates() {
  const json = readJson(INPUT_JSON, null);

  if (!json || !Array.isArray(json.candidates)) {
    throw new Error(`Invalid scenario candidates file: ${INPUT_JSON}`);
  }

  return json.candidates;
}

function loadSnapshots() {
  const jsonRows = [];
  const json = readJson(SNAPSHOT_JSON, null);

  if (json && Array.isArray(json.snapshots)) {
    jsonRows.push(...json.snapshots);
  } else if (Array.isArray(json)) {
    jsonRows.push(...json);
  }

  jsonRows.push(...readJsonl(SNAPSHOT_JSONL));

  return jsonRows.map(normalizeSnapshot).filter(Boolean);
}

function normalizeSnapshot(row) {
  if (!row || typeof row !== 'object') return null;

  const entityKey = normalizeText(row.entityKey);
  const query = normalizeText(row.query);
  const title = normalizeText(row.title);
  const url = normalizeText(row.url);
  const snippet = normalizeText(row.snippet || row.description || row.text || row.content);

  if (!entityKey || !query || (!title && !snippet)) return null;

  return {
    entityKey,
    query,
    purpose: normalizeText(row.purpose),
    sourceKind: normalizeText(row.sourceKind) || inferSourceKind(query, title, url),
    title,
    url,
    snippet: stripHtml(snippet),
    fetchedAt: normalizeText(row.fetchedAt) || ''
  };
}

function flattenQueries(candidate) {
  const rows = [];

  for (const plan of candidate.searchPlans || []) {
    for (const q of plan.queries || []) {
      rows.push({
        entityKey: candidate.entityKey,
        canonicalName: candidate.canonicalName || candidate.name,
        label: Array.isArray(candidate.labels) ? candidate.labels[0] : '',
        labels: candidate.labels || [],
        type: candidate.type || '',
        categories: candidate.categories || [],
        platforms: candidate.platforms || [],
        identityStatus: candidate.identityStatus || 'unknown',
        purpose: plan.purpose || q.purpose || '',
        planPriority: plan.priority || 0,
        query: q.query,
        queryPriority: q.priority || plan.priority || 0,
        tags: q.tags || [],
        reason: q.reason || ''
      });
    }
  }

  return rows.sort((a, b) => b.queryPriority - a.queryPriority);
}

function selectQueries(candidate) {
  const all = flattenQueries(candidate);
  const selected = [];
  const usedPurposes = new Set();
  const usedQueries = new Set();

  for (const row of all) {
    if (selected.length >= QUERY_LIMIT_PER_ENTITY) break;
    const key = normalizeLower(row.query);
    if (!key || usedQueries.has(key)) continue;

    const purpose = row.purpose || 'unknown';
    if (!usedPurposes.has(purpose) || selected.length >= Math.floor(QUERY_LIMIT_PER_ENTITY / 2)) {
      selected.push(row);
      usedQueries.add(key);
      usedPurposes.add(purpose);
    }
  }

  for (const row of all) {
    if (selected.length >= QUERY_LIMIT_PER_ENTITY) break;
    const key = normalizeLower(row.query);
    if (!key || usedQueries.has(key)) continue;
    selected.push(row);
    usedQueries.add(key);
  }

  return selected;
}

function inferSourceKind(...values) {
  const text = normalizeLower(values.join(' '));

  for (const rule of SOURCE_KIND_RULES) {
    if (rule.patterns.some(pattern => text.includes(pattern))) return rule.kind;
  }

  return 'unknown';
}

function inferSceneType(...values) {
  const text = normalizeLower(values.join(' '));

  for (const rule of SCENE_TYPE_RULES) {
    if (rule.patterns.some(pattern => text.includes(pattern))) return rule.sceneType;
  }

  return 'general_experience';
}

function cleanEntityFromPhrase(phrase, canonicalName) {
  let text = compactWhitespace(phrase);
  const entity = normalizeText(canonicalName);

  if (entity) {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
  }

  return compactWhitespace(text)
    .replace(/\b(app|web app|mobile app|official|features|pricing|release notes|help center)\b/gi, ' ')
    .replace(/\b(review|reviews|comparison|alternatives|problems|issues|complaints|limitations)\b/gi, ' ')
    .replace(/\b(worth it|should i use|pros and cons|best features|why people use)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSceneName(text, fallback, canonicalName) {
  const cleaned = cleanEntityFromPhrase(text, canonicalName);
  const value = cleaned || fallback || text;

  return compactWhitespace(value)
    .replace(/^how to\s+/i, '')
    .replace(/^best\s+/i, '')
    .replace(/^why\s+people\s+use\s+/i, '')
    .replace(/\?+$/g, '')
    .trim()
    .slice(0, 96);
}

function buildSyntheticEvidence(queryRow) {
  const sourceKind = inferSourceKind(queryRow.query, queryRow.purpose, queryRow.tags.join(' '));
  const sceneType = PURPOSE_TO_SCENE_TYPE[queryRow.purpose] || inferSceneType(queryRow.query, queryRow.reason, queryRow.tags.join(' '));
  const sceneName = normalizeSceneName(queryRow.query, queryRow.purpose, queryRow.canonicalName);

  return {
    entityKey: queryRow.entityKey,
    canonicalName: queryRow.canonicalName,
    label: queryRow.label,
    purpose: queryRow.purpose,
    query: queryRow.query,
    sourceKind,
    sceneType,
    sceneName,
    evidenceText: queryRow.query,
    evidenceHash: sha1(`${queryRow.entityKey}|${queryRow.query}|synthetic`).slice(0, 16),
    confidenceHint: 'query-derived',
    url: '',
    title: '',
    collectedAt: ''
  };
}

function buildSnapshotEvidence(snapshot, candidateByKey) {
  const candidate = candidateByKey.get(snapshot.entityKey) || {};
  const canonicalName = candidate.canonicalName || candidate.name || snapshot.entityKey;
  const sentences = sentenceSplit([snapshot.title, snapshot.snippet].filter(Boolean).join('. '));
  const evidenceRows = [];

  const sourceKind = normalizeText(snapshot.sourceKind) || inferSourceKind(snapshot.query, snapshot.title, snapshot.url);
  const baseSceneType = inferSceneType(snapshot.query, snapshot.title, snapshot.snippet, snapshot.purpose);

  for (const sentence of sentences.slice(0, 4)) {
    const sceneType = inferSceneType(sentence, snapshot.query, baseSceneType);
    const sceneName = normalizeSceneName(sentence, baseSceneType, canonicalName);

    if (!sceneName || sceneName.length < 3) continue;

    evidenceRows.push({
      entityKey: snapshot.entityKey,
      canonicalName,
      label: Array.isArray(candidate.labels) ? candidate.labels[0] : '',
      purpose: snapshot.purpose || '',
      query: snapshot.query,
      sourceKind,
      sceneType,
      sceneName,
      evidenceText: sentence,
      evidenceHash: sha1(`${snapshot.entityKey}|${snapshot.url}|${sentence}`).slice(0, 16),
      confidenceHint: 'web-snapshot',
      url: snapshot.url,
      title: snapshot.title,
      collectedAt: snapshot.fetchedAt || ''
    });
  }

  return evidenceRows;
}

function normalizeSceneKey(entityKey, sceneType, sceneName) {
  return [
    entityKey,
    sceneType,
    normalizeLower(sceneName)
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '')
  ].join('|');
}

function mergeEvidenceToScenes(evidenceRows) {
  const map = new Map();

  for (const evidence of evidenceRows) {
    if (!evidence.entityKey || !evidence.sceneName) continue;

    const key = normalizeSceneKey(evidence.entityKey, evidence.sceneType, evidence.sceneName);

    if (!map.has(key)) {
      map.set(key, {
        entityKey: evidence.entityKey,
        canonicalName: evidence.canonicalName,
        label: evidence.label,
        sceneName: evidence.sceneName,
        sceneType: evidence.sceneType,
        purposes: [],
        sourceKinds: [],
        evidenceCount: 0,
        sourceCount: 0,
        queryCount: 0,
        score: 0,
        evidence: [],
        queries: [],
        meta: {
          schema: 'AOIA',
          layer: 'scenario-normalized-scene',
          normalizer: 'scenario-normalizer.cjs',
          sceneHash: ''
        }
      });
    }

    const scene = map.get(key);

    scene.purposes = uniqueArray([...scene.purposes, evidence.purpose]);
    scene.sourceKinds = uniqueArray([...scene.sourceKinds, evidence.sourceKind]);
    scene.queries = uniqueArray([...scene.queries, evidence.query]);

    if (!scene.evidence.some(row => row.evidenceHash === evidence.evidenceHash)) {
      scene.evidence.push({
        evidenceHash: evidence.evidenceHash,
        confidenceHint: evidence.confidenceHint,
        sourceKind: evidence.sourceKind,
        query: evidence.query,
        title: evidence.title,
        url: evidence.url,
        text: evidence.evidenceText
      });
    }
  }

  for (const scene of map.values()) {
    scene.evidenceCount = scene.evidence.length;
    scene.sourceCount = uniqueArray(scene.evidence.map(row => row.url || row.sourceKind)).length;
    scene.queryCount = scene.queries.length;
    scene.score = scoreScene(scene);
    scene.meta.sceneHash = sha1(JSON.stringify({
      entityKey: scene.entityKey,
      sceneName: scene.sceneName,
      sceneType: scene.sceneType,
      purposes: scene.purposes,
      sourceKinds: scene.sourceKinds,
      evidenceCount: scene.evidenceCount,
      score: scene.score
    }));
  }

  return [...map.values()]
    .filter(scene => scene.score >= MIN_SCENE_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entityKey.localeCompare(b.entityKey) || a.sceneName.localeCompare(b.sceneName);
    });
}

function scoreScene(scene) {
  let score = 0;

  score += Math.min(scene.evidenceCount, 10);
  score += Math.min(scene.queryCount, 5);
  score += Math.min(scene.sourceKinds.length, 5) * 2;

  if (scene.sourceKinds.includes('official')) score += 3;
  if (scene.sourceKinds.includes('review')) score += 3;
  if (scene.sourceKinds.includes('forum')) score += 2;
  if (scene.sourceKinds.includes('comparison')) score += 2;

  if (scene.sceneType === 'general_experience') score -= 1;

  return Math.max(score, 0);
}

function groupScenesByEntity(scenes) {
  const map = new Map();

  for (const scene of scenes) {
    if (!map.has(scene.entityKey)) {
      map.set(scene.entityKey, {
        entityKey: scene.entityKey,
        canonicalName: scene.canonicalName,
        label: scene.label,
        sceneCount: 0,
        topScenes: [],
        sceneTypes: [],
        meta: {
          schema: 'AOIA',
          layer: 'scenario-normalized-entity',
          normalizer: 'scenario-normalizer.cjs',
          entityScenarioHash: ''
        }
      });
    }

    const entry = map.get(scene.entityKey);
    entry.topScenes.push(scene);
    entry.sceneTypes = uniqueArray([...entry.sceneTypes, scene.sceneType]);
  }

  for (const entry of map.values()) {
    entry.topScenes = entry.topScenes.sort((a, b) => b.score - a.score).slice(0, 12);
    entry.sceneCount = entry.topScenes.length;
    entry.meta.entityScenarioHash = sha1(JSON.stringify({
      entityKey: entry.entityKey,
      topScenes: entry.topScenes.map(scene => scene.meta.sceneHash)
    }));
  }

  return [...map.values()].sort((a, b) => a.entityKey.localeCompare(b.entityKey));
}

async function fetchBingResults(queryRow) {
  if (!BING_API_KEY) {
    throw new Error('BING_SEARCH_API_KEY is required when AOIA_SCENARIO_FETCH_MODE=bing');
  }

  const url = new URL(BING_ENDPOINT);
  url.searchParams.set('q', queryRow.query);
  url.searchParams.set('count', String(RESULT_LIMIT_PER_QUERY));
  url.searchParams.set('mkt', 'en-US');
  url.searchParams.set('safeSearch', 'Moderate');
  url.searchParams.set('textDecorations', 'false');
  url.searchParams.set('textFormat', 'Raw');

  const res = await fetch(url.toString(), {
    headers: {
      'Ocp-Apim-Subscription-Key': BING_API_KEY,
      'User-Agent': 'AOIA scenario-normalizer/1.0'
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bing search failed ${res.status}: ${body.slice(0, 240)}`);
  }

  const json = await res.json();
  const values = json && json.webPages && Array.isArray(json.webPages.value) ? json.webPages.value : [];

  return values.slice(0, RESULT_LIMIT_PER_QUERY).map(item => ({
    entityKey: queryRow.entityKey,
    query: queryRow.query,
    purpose: queryRow.purpose,
    sourceKind: inferSourceKind(queryRow.query, item.name, item.url, item.snippet),
    title: item.name || '',
    url: item.url || '',
    snippet: item.snippet || '',
    fetchedAt: new Date().toISOString()
  }));
}

async function collectLiveSnapshots(candidates, report) {
  const snapshots = [];

  for (const candidate of candidates.slice(0, ENTITY_LIMIT)) {
    const queries = selectQueries(candidate);

    for (const queryRow of queries) {
      try {
        if (FETCH_MODE === 'bing') {
          const rows = await fetchBingResults(queryRow);
          snapshots.push(...rows);
          report.fetchedQueries += 1;
          report.fetchedResults += rows.length;
        }
      } catch (error) {
        report.errors.push({
          entityKey: candidate.entityKey,
          query: queryRow.query,
          message: error.message || String(error)
        });
      }
    }
  }

  return snapshots.map(normalizeSnapshot).filter(Boolean);
}

function collectOfflineEvidence(candidates, snapshots, report) {
  const candidateByKey = new Map(candidates.map(candidate => [candidate.entityKey, candidate]));
  const evidenceRows = [];

  for (const candidate of candidates.slice(0, ENTITY_LIMIT)) {
    report.checkedCandidates += 1;

    const selectedQueries = selectQueries(candidate);
    report.selectedQueries += selectedQueries.length;

    for (const queryRow of selectedQueries) {
      evidenceRows.push(buildSyntheticEvidence(queryRow));
    }
  }

  for (const snapshot of snapshots) {
    if (!candidateByKey.has(snapshot.entityKey)) continue;
    const rows = buildSnapshotEvidence(snapshot, candidateByKey);
    evidenceRows.push(...rows);
    report.snapshotRows += 1;
  }

  return evidenceRows;
}

async function buildScenarioNormalized() {
  const nowIso = new Date().toISOString();
  const candidates = loadScenarioCandidates();

  const report = {
    schema: 'AOIA',
    builder: 'scenario-normalizer.cjs',
    generatedAt: nowIso,
    fetchMode: FETCH_MODE,
    inputJson: INPUT_JSON,
    snapshotJson: SNAPSHOT_JSON,
    snapshotJsonl: SNAPSHOT_JSONL,
    outputJson: OUT_JSON,
    outputJsonl: OUT_JSONL,
    checkedCandidates: 0,
    availableCandidates: candidates.length,
    selectedQueries: 0,
    snapshotRows: 0,
    fetchedQueries: 0,
    fetchedResults: 0,
    evidenceRows: 0,
    normalizedScenes: 0,
    normalizedEntities: 0,
    errors: []
  };

  let snapshots = loadSnapshots();

  if (FETCH_MODE === 'bing') {
    const liveSnapshots = await collectLiveSnapshots(candidates, report);
    snapshots = [...snapshots, ...liveSnapshots];
  }

  const evidenceRows = collectOfflineEvidence(candidates, snapshots, report);
  const scenes = mergeEvidenceToScenes(evidenceRows);
  const entities = groupScenesByEntity(scenes);

  report.evidenceRows = evidenceRows.length;
  report.normalizedScenes = scenes.length;
  report.normalizedEntities = entities.length;

  const output = {
    schema: 'AOIA',
    schemaVersion: '1.0.0',
    type: 'scenarioNormalized',
    generatedAt: nowIso,
    source: 'scenario-candidates',
    fetchMode: FETCH_MODE,
    candidateCount: candidates.length,
    evidenceCount: evidenceRows.length,
    sceneCount: scenes.length,
    entityCount: entities.length,
    entities,
    scenes,
    report: {
      checkedCandidates: report.checkedCandidates,
      selectedQueries: report.selectedQueries,
      snapshotRows: report.snapshotRows,
      fetchedQueries: report.fetchedQueries,
      fetchedResults: report.fetchedResults,
      errors: report.errors.length
    }
  };

  writeJson(OUT_JSON, output);
  writeJsonl(OUT_JSONL, scenes);
  writeJson(REPORT_JSON, report);

  return { output, report };
}

async function main() {
  const { output, report } = await buildScenarioNormalized();

  console.log('────────────────────────────────────────────');
  console.log('[scenario-normalizer]');
  console.log('ROOT              =', ROOT);
  console.log('INPUT_JSON        =', INPUT_JSON);
  console.log('SNAPSHOT_JSON     =', SNAPSHOT_JSON);
  console.log('OUT_JSON          =', OUT_JSON);
  console.log('OUT_JSONL         =', OUT_JSONL);
  console.log('REPORT            =', REPORT_JSON);
  console.log('fetchMode         =', report.fetchMode);
  console.log('availableCandidates=', report.availableCandidates);
  console.log('checkedCandidates =', report.checkedCandidates);
  console.log('selectedQueries   =', report.selectedQueries);
  console.log('snapshotRows      =', report.snapshotRows);
  console.log('fetchedQueries    =', report.fetchedQueries);
  console.log('fetchedResults    =', report.fetchedResults);
  console.log('evidenceRows      =', report.evidenceRows);
  console.log('normalizedScenes  =', output.sceneCount);
  console.log('normalizedEntities=', output.entityCount);
  console.log('errors            =', report.errors.length);
  console.log('────────────────────────────────────────────');

  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[scenario-normalizer][FATAL]', error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildScenarioNormalized,
  normalizeSnapshot,
  flattenQueries,
  selectQueries,
  mergeEvidenceToScenes,
  inferSceneType,
  inferSourceKind
};
