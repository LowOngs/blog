#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/scripts/build/scenario-normalizer.cjs
 * Role : Scenario Collector + Scenario Normalizer for AOIA Experience Layer
 * Root : C:\\google-blog\\System_files
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const ROOT = path.resolve(__dirname, '../..');

const INPUT_JSON = path.join(ROOT, 'seedpool', 'profiles', 'scenario-candidates.json');
const SNAPSHOT_JSON = path.join(ROOT, 'seedpool', 'profiles', 'scenario-web-snapshots.json');
const SNAPSHOT_JSONL = path.join(ROOT, 'seedpool', 'profiles', 'scenario-web-snapshots.jsonl');
const SNAPSHOT_LEDGER_JSONL = path.join(ROOT, 'seedpool', 'profiles', 'scenario-web-snapshots-ledger.jsonl');
const SCENE_LEDGER_JSONL = path.join(ROOT, 'seedpool', 'profiles', 'scenario-scene-ledger.jsonl');
const OUT_JSON = path.join(ROOT, 'seedpool', 'profiles', 'scenario-normalized.json');
const OUT_JSONL = path.join(ROOT, 'seedpool', 'profiles', 'scenario-normalized.jsonl');
const REPORT_JSON = path.join(ROOT, 'logs', 'scenario-normalizer-report.json');

const FETCH_MODE = normalizeText(process.env.AOIA_SCENARIO_FETCH_MODE) || 'offline';
const BING_SEARCH_API_KEY = normalizeText(process.env.BING_SEARCH_API_KEY);
const BING_SEARCH_ENDPOINT = normalizeText(process.env.BING_SEARCH_ENDPOINT) || 'https://api.bing.microsoft.com/v7.0/search';

const MAX_CANDIDATES = toPositiveInt(process.env.AOIA_SCENARIO_MAX_CANDIDATES, 25);
const MAX_QUERIES_TOTAL = toPositiveInt(process.env.AOIA_SCENARIO_MAX_QUERIES, 200);
const MAX_QUERIES_PER_ENTITY = toPositiveInt(process.env.AOIA_SCENARIO_MAX_QUERIES_PER_ENTITY, 8);
const MAX_RESULTS_PER_QUERY = toPositiveInt(process.env.AOIA_SCENARIO_MAX_RESULTS_PER_QUERY, 5);
const REQUEST_TIMEOUT_MS = toPositiveInt(process.env.AOIA_SCENARIO_REQUEST_TIMEOUT_MS, 12000);

const COLLECTOR_VERSION = '3.1.0';
const NORMALIZER_VERSION = '3.1.0';

const PURPOSE_WEIGHT = {
  real_usage: 1.0,
  comparison: 0.92,
  pain_points: 0.88,
  recommendation: 0.82,
  decision: 0.78,
  official_context: 0.72,
};

const SOURCE_TYPE_WEIGHT = {
  official: 1.0,
  review: 0.9,
  forum: 0.8,
  qna: 0.76,
  marketplace: 0.72,
  video: 0.68,
  unknown: 0.55,
};

const SCENE_PATTERNS = [
  {
    scene: 'daily workflow',
    sceneType: 'workflow',
    tokens: ['workflow', 'daily use', 'use cases', 'routine', 'task', 'productivity', 'project', 'schedule', 'planning'],
  },
  {
    scene: 'setup and onboarding',
    sceneType: 'setup',
    tokens: ['setup', 'onboarding', 'getting started', 'install', 'configure', 'account', 'sign up', 'login'],
  },
  {
    scene: 'comparison and switching',
    sceneType: 'comparison',
    tokens: ['alternative', 'alternatives', 'vs', 'versus', 'compare', 'comparison', 'switch', 'migration', 'replace'],
  },
  {
    scene: 'performance or reliability issue',
    sceneType: 'performance',
    tokens: ['slow', 'lag', 'sync', 'crash', 'bug', 'issue', 'problem', 'reliable', 'reliability', 'offline'],
  },
  {
    scene: 'pricing and value decision',
    sceneType: 'price',
    tokens: ['pricing', 'price', 'subscription', 'free tier', 'paid', 'worth it', 'value', 'cost', 'plan'],
  },
  {
    scene: 'privacy and account control',
    sceneType: 'privacy',
    tokens: ['privacy', 'permission', 'security', 'account', 'data', 'policy', 'tracking', 'sharing'],
  },
  {
    scene: 'collaboration and sharing',
    sceneType: 'sharing',
    tokens: ['team', 'collaboration', 'share', 'sharing', 'family', 'workspace', 'comment', 'invite'],
  },
  {
    scene: 'mobile or platform-specific use',
    sceneType: 'platform',
    tokens: ['android', 'ios', 'mobile', 'desktop', 'web app', 'browser', 'tablet', 'cross-platform'],
  },
  {
    scene: 'official feature verification',
    sceneType: 'verification',
    tokens: ['official', 'features', 'release notes', 'help center', 'documentation', 'support', 'changelog'],
  },
  {
    scene: 'learning curve and beginner friction',
    sceneType: 'learning',
    tokens: ['learning curve', 'beginner', 'confusing', 'tutorial', 'tips', 'hard to use', 'easy to use'],
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  const rows = [];

  raw.split(/\r?\n/).forEach((line, index) => {
    const text = normalizeText(line);
    if (!text) return;

    try {
      rows.push(JSON.parse(text));
    } catch (error) {
      rows.push({
        _parseError: true,
        line: index + 1,
        message: error.message || String(error),
        raw: text.slice(0, 300),
      });
    }
  });

  return rows;
}

function appendJsonl(filePath, rows) {
  if (!rows.length) return;

  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function buildSnapshotLedgerRows(snapshots, runId, generatedAt) {
  return snapshots.map((snapshot) => ({
    ledgerId: `snap-ledger:${sha1(`${runId}|${snapshot.snapshotId}`).slice(0, 24)}`,
    runId,
    recordedAt: generatedAt,
    snapshotId: snapshot.snapshotId,
    entityKey: snapshot.entityKey,
    canonicalName: snapshot.canonicalName,
    purpose: snapshot.purpose,
    query: snapshot.query,
    queryPriority: snapshot.queryPriority,
    planPriority: snapshot.planPriority,
    resultRank: snapshot.resultRank,
    title: snapshot.title,
    url: snapshot.url,
    host: snapshot.host,
    sourceType: snapshot.sourceType,
    snippet: snapshot.snippet,
    textSample: snapshot.textSample,
    fetchedAt: snapshot.fetchedAt,
    fetchMode: snapshot.fetchMode,
    evidenceType: snapshot.evidenceType,
    tags: snapshot.tags,
    meta: {
      schema: 'AOIA',
      layer: 'scenario-web-snapshot-ledger',
      writer: 'scenario-normalizer.cjs',
      collectorVersion: COLLECTOR_VERSION,
    },
  }));
}

function appendSnapshotLedger(filePath, snapshots, runId, generatedAt) {
  const existingRows = readJsonl(filePath);
  const existingIds = new Set(
    existingRows
      .filter((row) => row && !row._parseError && row.snapshotId)
      .map((row) => row.snapshotId)
  );

  const rows = buildSnapshotLedgerRows(snapshots, runId, generatedAt)
    .filter((row) => !existingIds.has(row.snapshotId));

  appendJsonl(filePath, rows);

  return {
    existingRows: existingRows.filter((row) => row && !row._parseError).length,
    parseErrors: existingRows.filter((row) => row && row._parseError).length,
    appendedRows: rows.length,
    ledgerRowsAfter: existingRows.filter((row) => row && !row._parseError).length + rows.length,
  };
}

function buildSceneLedgerRows(scenes, runId, recordedAt, existingRows) {
  const ledgerMap = new Map();

  for (const row of toArray(existingRows)) {
    if (!row || typeof row !== 'object') continue;

    const sceneKey = normalizeText(row.sceneKey);
    if (!sceneKey) continue;

    ledgerMap.set(sceneKey, {
      ledgerId: normalizeText(row.ledgerId) || `scene-ledger:${sha1(sceneKey).slice(0, 24)}`,
      sceneKey,
      entityKey: normalizeText(row.entityKey),
      canonicalName: normalizeText(row.canonicalName),
      scene: normalizeText(row.scene),
      sceneType: normalizeText(row.sceneType),
      firstSeenAt: normalizeText(row.firstSeenAt) || recordedAt,
      lastSeenAt: normalizeText(row.lastSeenAt) || recordedAt,
      occurrenceCount: Number.isFinite(Number(row.occurrenceCount)) ? Number(row.occurrenceCount) : 0,
      runCount: Number.isFinite(Number(row.runCount)) ? Number(row.runCount) : 0,
      lastRunId: normalizeText(row.lastRunId),
      sourceTypes: uniqueArray(row.sourceTypes),
      sourceHosts: uniqueArray(row.sourceHosts),
      purposes: uniqueArray(row.purposes),
      queries: uniqueArray(row.queries).slice(0, 24),
      confidenceLatest: Number.isFinite(Number(row.confidenceLatest)) ? Number(row.confidenceLatest) : 0,
      confidenceMax: Number.isFinite(Number(row.confidenceMax)) ? Number(row.confidenceMax) : 0,
      lastFrequency: Number.isFinite(Number(row.lastFrequency)) ? Number(row.lastFrequency) : 0,
      safety: row.safety && typeof row.safety === 'object' ? row.safety : {
        directClaimAllowed: false,
        recommendedWording: 'Use as a repeated experience pattern, not as a direct product claim.',
      },
      meta: {
        schema: 'AOIA',
        layer: 'scenario-scene-ledger',
        writer: 'scenario-normalizer.cjs',
        normalizerVersion: NORMALIZER_VERSION,
        ledgerHash: normalizeText(row.meta && row.meta.ledgerHash),
      },
    });
  }

  let updatedRows = 0;
  let createdRows = 0;

  for (const scene of toArray(scenes)) {
    if (!scene || typeof scene !== 'object') continue;

    const sceneKey = normalizeText(scene.sceneKey);
    if (!sceneKey) continue;

    const previous = ledgerMap.get(sceneKey);
    const frequency = Number.isFinite(Number(scene.frequency)) ? Number(scene.frequency) : 0;
    const confidence = Number.isFinite(Number(scene.confidence)) ? Number(scene.confidence) : 0;

    if (!previous) {
      const row = {
        ledgerId: `scene-ledger:${sha1(sceneKey).slice(0, 24)}`,
        sceneKey,
        entityKey: normalizeText(scene.entityKey),
        canonicalName: normalizeText(scene.canonicalName),
        scene: normalizeText(scene.scene),
        sceneType: normalizeText(scene.sceneType),
        firstSeenAt: recordedAt,
        lastSeenAt: recordedAt,
        occurrenceCount: frequency,
        runCount: 1,
        lastRunId: runId,
        sourceTypes: uniqueArray(scene.sourceTypes),
        sourceHosts: uniqueArray(scene.sourceHosts),
        purposes: uniqueArray(scene.purposes),
        queries: uniqueArray(scene.queries).slice(0, 24),
        confidenceLatest: confidence,
        confidenceMax: confidence,
        lastFrequency: frequency,
        safety: scene.safety && typeof scene.safety === 'object' ? scene.safety : {
          directClaimAllowed: false,
          recommendedWording: 'Use as a repeated experience pattern, not as a direct product claim.',
        },
        meta: {
          schema: 'AOIA',
          layer: 'scenario-scene-ledger',
          writer: 'scenario-normalizer.cjs',
          normalizerVersion: NORMALIZER_VERSION,
          ledgerHash: '',
        },
      };

      row.meta.ledgerHash = sha1(JSON.stringify({
        sceneKey: row.sceneKey,
        entityKey: row.entityKey,
        scene: row.scene,
        sceneType: row.sceneType,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        occurrenceCount: row.occurrenceCount,
        runCount: row.runCount,
        confidenceMax: row.confidenceMax,
      }));

      ledgerMap.set(sceneKey, row);
      createdRows += 1;
      continue;
    }

    previous.entityKey = previous.entityKey || normalizeText(scene.entityKey);
    previous.canonicalName = previous.canonicalName || normalizeText(scene.canonicalName);
    previous.scene = previous.scene || normalizeText(scene.scene);
    previous.sceneType = previous.sceneType || normalizeText(scene.sceneType);
    previous.lastSeenAt = recordedAt;
    previous.occurrenceCount += frequency;
    previous.runCount += 1;
    previous.lastRunId = runId;
    previous.sourceTypes = uniqueArray([...previous.sourceTypes, ...toArray(scene.sourceTypes)]);
    previous.sourceHosts = uniqueArray([...previous.sourceHosts, ...toArray(scene.sourceHosts)]);
    previous.purposes = uniqueArray([...previous.purposes, ...toArray(scene.purposes)]);
    previous.queries = uniqueArray([...previous.queries, ...toArray(scene.queries)]).slice(0, 24);
    previous.confidenceLatest = confidence;
    previous.confidenceMax = Math.max(previous.confidenceMax, confidence);
    previous.lastFrequency = frequency;
    previous.safety = scene.safety && typeof scene.safety === 'object' ? scene.safety : previous.safety;
    previous.meta.ledgerHash = sha1(JSON.stringify({
      sceneKey: previous.sceneKey,
      entityKey: previous.entityKey,
      scene: previous.scene,
      sceneType: previous.sceneType,
      firstSeenAt: previous.firstSeenAt,
      lastSeenAt: previous.lastSeenAt,
      occurrenceCount: previous.occurrenceCount,
      runCount: previous.runCount,
      confidenceMax: previous.confidenceMax,
    }));

    updatedRows += 1;
  }

  const rows = [...ledgerMap.values()].sort((a, b) => {
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    if (b.confidenceMax !== a.confidenceMax) return b.confidenceMax - a.confidenceMax;
    return a.sceneKey.localeCompare(b.sceneKey);
  });

  return {
    rows,
    createdRows,
    updatedRows,
  };
}

function writeSceneLedger(filePath, scenes, runId, recordedAt) {
  const existing = readJsonl(filePath);
  const built = buildSceneLedgerRows(scenes, runId, recordedAt, existing.rows);

  writeJsonl(filePath, built.rows);

  return {
    sceneLedgerRowsCreated: built.createdRows,
    sceneLedgerRowsUpdated: built.updatedRows,
    sceneLedgerRowsAfter: built.rows.length,
    sceneLedgerParseErrors: existing.errors.length,
  };
}


function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function uniqueArray(values) {
  return [...new Set(toArray(values).map(normalizeText).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeUrlHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
}

function detectSourceType(url, name) {
  const text = `${normalizeLower(url)} ${normalizeLower(name)}`;

  if (/official|help|support|docs|developer|release|changelog/.test(text)) return 'official';
  if (/reddit|forum|community|discourse|quora/.test(text)) return 'forum';
  if (/stackexchange|stackoverflow|superuser|answers/.test(text)) return 'qna';
  if (/youtube|youtu\.be|vimeo/.test(text)) return 'video';
  if (/play\.google|apps\.apple|appstore|microsoft\.com\/store|chromewebstore/.test(text)) return 'marketplace';
  if (/review|pcmag|techradar|wirecutter|cnet|tomsguide|theverge|androidauthority|makeuseof/.test(text)) return 'review';

  return 'unknown';
}

function loadCandidates() {
  const json = readJson(INPUT_JSON);
  if (Array.isArray(json.candidates)) return json.candidates;
  if (Array.isArray(json)) return json;
  return [];
}

function flattenQueries(candidate) {
  const rows = [];

  for (const plan of toArray(candidate.searchPlans)) {
    for (const item of toArray(plan.queries)) {
      const query = normalizeText(item && item.query ? item.query : item);
      if (!query) continue;

      rows.push({
        entityKey: candidate.entityKey,
        canonicalName: candidate.canonicalName || candidate.name,
        type: candidate.type || 'unknown',
        labels: toArray(candidate.labels),
        modes: toArray(candidate.modes),
        identityStatus: candidate.identityStatus || 'unknown',
        identityConflictCount: Number(candidate.identityConflictCount || 0),
        purpose: plan.purpose || 'unknown',
        planPriority: Number(plan.priority || 0),
        query,
        queryPriority: Number(item.priority || 0),
        tags: uniqueArray(item.tags || []),
        reason: normalizeText(item.reason),
      });
    }
  }

  return rows.sort((a, b) => {
    const pa = (a.planPriority * 1000) + a.queryPriority;
    const pb = (b.planPriority * 1000) + b.queryPriority;
    return pb - pa;
  });
}

function selectCandidateBatch(candidates) {
  return candidates
    .slice()
    .sort((a, b) => {
      const ac = Number(a.identityConflictCount || 0);
      const bc = Number(b.identityConflictCount || 0);
      if (ac !== bc) return ac - bc;
      return normalizeText(a.entityKey).localeCompare(normalizeText(b.entityKey));
    })
    .slice(0, MAX_CANDIDATES);
}

function selectQueryBatch(candidates) {
  const rows = [];
  const selectedCandidates = selectCandidateBatch(candidates);

  for (const candidate of selectedCandidates) {
    const perEntity = flattenQueries(candidate).slice(0, MAX_QUERIES_PER_ENTITY);
    rows.push(...perEntity);
  }

  return rows.slice(0, MAX_QUERIES_TOTAL);
}

function buildOfflineSnapshot(queryRow, index) {
  const resultTitle = `${queryRow.query} - scenario evidence`;
  const sourceType = inferOfflineSourceType(queryRow.purpose, queryRow.tags);
  const host = offlineHostBySourceType(sourceType);
  const url = `offline://${host}/${sha1(queryRow.query).slice(0, 16)}`;
  const snippet = buildOfflineSnippet(queryRow);

  return {
    snapshotId: `snap:${sha1(`${queryRow.entityKey}|${queryRow.query}|${index}`).slice(0, 20)}`,
    entityKey: queryRow.entityKey,
    canonicalName: queryRow.canonicalName,
    purpose: queryRow.purpose,
    query: queryRow.query,
    queryPriority: queryRow.queryPriority,
    planPriority: queryRow.planPriority,
    resultRank: 1,
    title: resultTitle,
    url,
    host,
    sourceType,
    snippet,
    textSample: snippet,
    fetchedAt: new Date().toISOString(),
    fetchMode: 'offline',
    evidenceType: 'synthetic-query-evidence',
    tags: queryRow.tags,
  };
}

function inferOfflineSourceType(purpose, tags) {
  const tagText = normalizeLower(toArray(tags).join(' '));

  if (purpose === 'official_context' || tagText.includes('official')) return 'official';
  if (purpose === 'comparison' || tagText.includes('comparison')) return 'review';
  if (purpose === 'pain_points' || tagText.includes('pain')) return 'forum';
  if (purpose === 'decision') return 'review';
  if (purpose === 'recommendation') return 'review';

  return 'unknown';
}

function offlineHostBySourceType(sourceType) {
  if (sourceType === 'official') return 'official.example';
  if (sourceType === 'review') return 'review.example';
  if (sourceType === 'forum') return 'forum.example';
  if (sourceType === 'qna') return 'qna.example';
  if (sourceType === 'marketplace') return 'marketplace.example';
  return 'scenario.example';
}

function buildOfflineSnippet(queryRow) {
  const name = queryRow.canonicalName || 'this entity';
  const purpose = queryRow.purpose;

  if (purpose === 'real_usage') {
    return `${name} appears in repeated workflow, daily use, platform, and use case queries. This offline row marks a candidate scene for later web verification.`;
  }

  if (purpose === 'comparison') {
    return `${name} appears in alternatives, comparison, switching, and vs queries. This offline row marks a candidate comparison scene for later web verification.`;
  }

  if (purpose === 'pain_points') {
    return `${name} appears in problems, limitations, complaints, and issue queries. This offline row marks a candidate pain-point scene for later web verification.`;
  }

  if (purpose === 'recommendation') {
    return `${name} appears in best features, why people use it, recommendation, and benefit queries. This offline row marks a candidate value scene for later web verification.`;
  }

  if (purpose === 'decision') {
    return `${name} appears in worth it, review, should I use, pros and cons, and decision queries. This offline row marks a candidate decision scene for later web verification.`;
  }

  if (purpose === 'official_context') {
    return `${name} appears in official features, pricing, release notes, documentation, and help center queries. This offline row marks a candidate verification scene for later web verification.`;
  }

  return `${name} appears in scenario candidate queries. This offline row marks a candidate scene for later web verification.`;
}

function fetchBing(queryRow) {
  return new Promise((resolve) => {
    const url = new URL(BING_SEARCH_ENDPOINT);
    url.searchParams.set('q', queryRow.query);
    url.searchParams.set('count', String(MAX_RESULTS_PER_QUERY));
    url.searchParams.set('responseFilter', 'Webpages');
    url.searchParams.set('textFormat', 'Raw');

    const req = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Ocp-Apim-Subscription-Key': BING_SEARCH_API_KEY,
          'User-Agent': 'AOIA-ScenarioNormalizer/3.1',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, statusCode: res.statusCode, rows: [], error: body.slice(0, 300) });
            return;
          }

          try {
            const parsed = JSON.parse(body);
            const values = parsed && parsed.webPages && Array.isArray(parsed.webPages.value)
              ? parsed.webPages.value
              : [];

            const rows = values.slice(0, MAX_RESULTS_PER_QUERY).map((item, index) => {
              const resultUrl = normalizeText(item.url);
              const host = safeUrlHost(resultUrl);
              const sourceType = detectSourceType(resultUrl, item.name);
              const snippet = normalizeText(item.snippet);

              return {
                snapshotId: `snap:${sha1(`${queryRow.entityKey}|${queryRow.query}|${resultUrl}`).slice(0, 20)}`,
                entityKey: queryRow.entityKey,
                canonicalName: queryRow.canonicalName,
                purpose: queryRow.purpose,
                query: queryRow.query,
                queryPriority: queryRow.queryPriority,
                planPriority: queryRow.planPriority,
                resultRank: index + 1,
                title: normalizeText(item.name),
                url: resultUrl,
                host,
                sourceType,
                snippet,
                textSample: snippet,
                fetchedAt: new Date().toISOString(),
                fetchMode: 'bing',
                evidenceType: 'search-result-snippet',
                tags: queryRow.tags,
              };
            });

            resolve({ ok: true, statusCode: res.statusCode, rows, error: '' });
          } catch (error) {
            resolve({ ok: false, statusCode: res.statusCode, rows: [], error: error.message || String(error) });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });

    req.on('error', (error) => {
      resolve({ ok: false, statusCode: 0, rows: [], error: error.message || String(error) });
    });
  });
}

async function collectScenarioSnapshots(queryRows, report) {
  const snapshots = [];

  if (FETCH_MODE === 'bing' && !BING_SEARCH_API_KEY) {
    report.errors.push({ stage: 'collector', message: 'BING_SEARCH_API_KEY is required when AOIA_SCENARIO_FETCH_MODE=bing.' });
    return snapshots;
  }

  for (let i = 0; i < queryRows.length; i += 1) {
    const queryRow = queryRows[i];

    if (FETCH_MODE === 'bing') {
      const result = await fetchBing(queryRow);
      report.fetchedQueries += 1;

      if (!result.ok) {
        report.fetchErrors += 1;
        report.errors.push({ stage: 'collector', query: queryRow.query, statusCode: result.statusCode, message: result.error });
        continue;
      }

      report.fetchedResults += result.rows.length;
      snapshots.push(...result.rows);
      continue;
    }

    snapshots.push(buildOfflineSnapshot(queryRow, i));
  }

  return dedupeSnapshots(snapshots);
}

function dedupeSnapshots(snapshots) {
  const map = new Map();

  for (const row of snapshots) {
    const key = row.url && !row.url.startsWith('offline://')
      ? `${row.entityKey}|${row.url}`
      : `${row.entityKey}|${row.query}|${row.purpose}|${row.sourceType}`;

    if (!map.has(key)) {
      map.set(key, row);
    }
  }

  return [...map.values()];
}

function scoreSceneEvidence(scenePattern, snapshot) {
  const haystack = normalizeLower(`${snapshot.title} ${snapshot.snippet} ${snapshot.textSample} ${snapshot.query}`);
  let hits = 0;

  for (const token of scenePattern.tokens) {
    if (haystack.includes(normalizeLower(token))) hits += 1;
  }

  if (hits === 0) return 0;

  const purposeWeight = PURPOSE_WEIGHT[snapshot.purpose] || 0.65;
  const sourceWeight = SOURCE_TYPE_WEIGHT[snapshot.sourceType] || SOURCE_TYPE_WEIGHT.unknown;
  const priorityWeight = clamp(Number(snapshot.queryPriority || 50) / 100, 0.4, 1.0);
  const rankWeight = clamp(1 - ((Number(snapshot.resultRank || 1) - 1) * 0.08), 0.55, 1.0);
  const hitWeight = clamp(hits / 3, 0.34, 1.0);

  return Number((purposeWeight * sourceWeight * priorityWeight * rankWeight * hitWeight).toFixed(4));
}

function fallbackSceneFromPurpose(snapshot) {
  if (snapshot.purpose === 'real_usage') {
    return { scene: 'real usage pattern', sceneType: 'workflow' };
  }

  if (snapshot.purpose === 'comparison') {
    return { scene: 'comparison and switching', sceneType: 'comparison' };
  }

  if (snapshot.purpose === 'pain_points') {
    return { scene: 'limitations and complaints', sceneType: 'risk' };
  }

  if (snapshot.purpose === 'recommendation') {
    return { scene: 'value and recommendation reason', sceneType: 'value' };
  }

  if (snapshot.purpose === 'decision') {
    return { scene: 'decision and fit question', sceneType: 'decision' };
  }

  if (snapshot.purpose === 'official_context') {
    return { scene: 'official verification point', sceneType: 'verification' };
  }

  return { scene: 'general scenario signal', sceneType: 'general' };
}

function extractEvidenceRows(snapshot) {
  const rows = [];

  for (const pattern of SCENE_PATTERNS) {
    const score = scoreSceneEvidence(pattern, snapshot);
    if (score <= 0) continue;

    rows.push({
      entityKey: snapshot.entityKey,
      canonicalName: snapshot.canonicalName,
      scene: pattern.scene,
      sceneType: pattern.sceneType,
      purpose: snapshot.purpose,
      sourceType: snapshot.sourceType,
      sourceHost: snapshot.host,
      sourceUrl: snapshot.url,
      query: snapshot.query,
      evidenceText: snapshot.snippet || snapshot.textSample || snapshot.title,
      evidenceScore: score,
      evidenceType: snapshot.evidenceType,
      fetchedAt: snapshot.fetchedAt,
    });
  }

  if (rows.length > 0) return rows;

  const fallback = fallbackSceneFromPurpose(snapshot);
  return [{
    entityKey: snapshot.entityKey,
    canonicalName: snapshot.canonicalName,
    scene: fallback.scene,
    sceneType: fallback.sceneType,
    purpose: snapshot.purpose,
    sourceType: snapshot.sourceType,
    sourceHost: snapshot.host,
    sourceUrl: snapshot.url,
    query: snapshot.query,
    evidenceText: snapshot.snippet || snapshot.textSample || snapshot.title,
    evidenceScore: 0.35,
    evidenceType: snapshot.evidenceType,
    fetchedAt: snapshot.fetchedAt,
  }];
}

function normalizeScenarioScenes(snapshots) {
  const evidenceRows = [];

  for (const snapshot of snapshots) {
    evidenceRows.push(...extractEvidenceRows(snapshot));
  }

  const sceneMap = new Map();

  for (const evidence of evidenceRows) {
    const key = `${evidence.entityKey}|${evidence.sceneType}|${evidence.scene}`;

    if (!sceneMap.has(key)) {
      sceneMap.set(key, {
        sceneKey: `scene:${sha1(key).slice(0, 20)}`,
        entityKey: evidence.entityKey,
        canonicalName: evidence.canonicalName,
        scene: evidence.scene,
        sceneType: evidence.sceneType,
        purposes: [],
        sourceTypes: [],
        sourceHosts: [],
        sourceUrls: [],
        queries: [],
        evidenceSamples: [],
        frequency: 0,
        evidenceScoreSum: 0,
        confidence: 0,
        safety: {
          directClaimAllowed: false,
          recommendedWording: 'Similar products or services are often evaluated in this scenario; treat it as a pattern to verify, not as a direct product claim.',
        },
        meta: {
          schema: 'AOIA',
          layer: 'scenario-normalized',
          normalizer: 'scenario-normalizer.cjs',
          normalizerVersion: NORMALIZER_VERSION,
          sceneHash: '',
        },
      });
    }

    const scene = sceneMap.get(key);
    scene.frequency += 1;
    scene.evidenceScoreSum += evidence.evidenceScore;
    scene.purposes = uniqueArray([...scene.purposes, evidence.purpose]);
    scene.sourceTypes = uniqueArray([...scene.sourceTypes, evidence.sourceType]);
    scene.sourceHosts = uniqueArray([...scene.sourceHosts, evidence.sourceHost]);
    scene.sourceUrls = uniqueArray([...scene.sourceUrls, evidence.sourceUrl]);
    scene.queries = uniqueArray([...scene.queries, evidence.query]).slice(0, 12);

    if (scene.evidenceSamples.length < 5) {
      scene.evidenceSamples.push({
        sourceType: evidence.sourceType,
        sourceHost: evidence.sourceHost,
        query: evidence.query,
        text: evidence.evidenceText,
        score: evidence.evidenceScore,
      });
    }
  }

  const scenes = [...sceneMap.values()].map((scene) => {
    const sourceDiversity = scene.sourceTypes.length;
    const avgScore = scene.frequency > 0 ? scene.evidenceScoreSum / scene.frequency : 0;
    const frequencyScore = clamp(scene.frequency / 5, 0.2, 1.0);
    const diversityScore = clamp(sourceDiversity / 3, 0.25, 1.0);
    scene.confidence = Number(clamp((avgScore * 0.55) + (frequencyScore * 0.25) + (diversityScore * 0.2), 0, 1).toFixed(3));
    scene.meta.sceneHash = sha1(JSON.stringify({
      entityKey: scene.entityKey,
      scene: scene.scene,
      sceneType: scene.sceneType,
      purposes: scene.purposes,
      sourceTypes: scene.sourceTypes,
      queries: scene.queries,
      confidence: scene.confidence,
    }));
    delete scene.evidenceScoreSum;
    return scene;
  });

  scenes.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    return a.entityKey.localeCompare(b.entityKey);
  });

  return { scenes, evidenceRows };
}

function groupScenesByEntity(scenes) {
  const map = new Map();

  for (const scene of scenes) {
    if (!map.has(scene.entityKey)) {
      map.set(scene.entityKey, {
        entityKey: scene.entityKey,
        canonicalName: scene.canonicalName,
        sceneCount: 0,
        topScenes: [],
        sceneTypes: [],
      });
    }

    const row = map.get(scene.entityKey);
    row.sceneCount += 1;
    row.sceneTypes = uniqueArray([...row.sceneTypes, scene.sceneType]);
    if (row.topScenes.length < 10) row.topScenes.push(scene);
  }

  return [...map.values()].sort((a, b) => a.entityKey.localeCompare(b.entityKey));
}

async function buildScenarioNormalized() {
  const generatedAt = new Date().toISOString();
  const runId = `scenario-run:${sha1(`${generatedAt}|${FETCH_MODE}|${INPUT_JSON}`).slice(0, 20)}`;
  const candidates = loadCandidates();
  const selectedCandidates = selectCandidateBatch(candidates);
  const queryRows = selectQueryBatch(candidates);

  const report = {
    schema: 'AOIA',
    builder: 'scenario-normalizer.cjs',
    generatedAt,
    runId,
    fetchMode: FETCH_MODE,
    inputJson: INPUT_JSON,
    snapshotJson: SNAPSHOT_JSON,
    snapshotJsonl: SNAPSHOT_JSONL,
    snapshotLedgerJsonl: SNAPSHOT_LEDGER_JSONL,
    sceneLedgerJsonl: SCENE_LEDGER_JSONL,
    outputJson: OUT_JSON,
    availableCandidates: candidates.length,
    checkedCandidates: selectedCandidates.length,
    selectedQueries: queryRows.length,
    snapshotRows: 0,
    snapshotLedgerRowsAppended: 0,
    snapshotLedgerRowsAfter: 0,
    snapshotLedgerParseErrors: 0,
    sceneLedgerRowsCreated: 0,
    sceneLedgerRowsUpdated: 0,
    sceneLedgerRowsAfter: 0,
    sceneLedgerParseErrors: 0,
    fetchedQueries: 0,
    fetchedResults: 0,
    fetchErrors: 0,
    evidenceRows: 0,
    normalizedScenes: 0,
    normalizedEntities: 0,
    errors: [],
    engines: {
      collector: {
        name: 'scenario-collector',
        version: COLLECTOR_VERSION,
        role: 'Collect web or offline snapshots from scenario candidate search plans.',
      },
      normalizer: {
        name: 'scenario-normalizer',
        version: NORMALIZER_VERSION,
        role: 'Convert snapshots into repeated scene patterns without making direct product claims.',
      },
    },
  };

  const snapshots = await collectScenarioSnapshots(queryRows, report);
  const { scenes, evidenceRows } = normalizeScenarioScenes(snapshots);
  const entities = groupScenesByEntity(scenes);

  report.snapshotRows = snapshots.length;
  report.evidenceRows = evidenceRows.length;
  report.normalizedScenes = scenes.length;
  report.normalizedEntities = entities.length;

  const snapshotOutput = {
    schema: 'AOIA',
    schemaVersion: '1.0.0',
    type: 'scenarioWebSnapshots',
    generatedAt,
    runId,
    fetchMode: FETCH_MODE,
    collector: 'scenario-normalizer.cjs#scenario-collector',
    collectorVersion: COLLECTOR_VERSION,
    snapshotCount: snapshots.length,
    snapshots,
  };

  const ledgerInfo = appendSnapshotLedger(SNAPSHOT_LEDGER_JSONL, snapshots, runId, generatedAt);

  report.snapshotLedgerRowsAppended = ledgerInfo.appendedRows;
  report.snapshotLedgerRowsAfter = ledgerInfo.ledgerRowsAfter;
  report.snapshotLedgerParseErrors = ledgerInfo.parseErrors;

  const sceneLedgerInfo = writeSceneLedger(SCENE_LEDGER_JSONL, scenes, runId, generatedAt);

  report.sceneLedgerRowsCreated = sceneLedgerInfo.sceneLedgerRowsCreated;
  report.sceneLedgerRowsUpdated = sceneLedgerInfo.sceneLedgerRowsUpdated;
  report.sceneLedgerRowsAfter = sceneLedgerInfo.sceneLedgerRowsAfter;
  report.sceneLedgerParseErrors = sceneLedgerInfo.sceneLedgerParseErrors;

  const output = {
    schema: 'AOIA',
    schemaVersion: '1.0.0',
    type: 'scenarioNormalized',
    generatedAt,
    runId,
    source: 'scenario-candidates',
    fetchMode: FETCH_MODE,
    sceneCount: scenes.length,
    entityCount: entities.length,
    scenes,
    entities,
    report: {
      availableCandidates: report.availableCandidates,
      checkedCandidates: report.checkedCandidates,
      selectedQueries: report.selectedQueries,
      snapshotRows: report.snapshotRows,
      snapshotLedgerRowsAppended: report.snapshotLedgerRowsAppended,
      snapshotLedgerRowsAfter: report.snapshotLedgerRowsAfter,
      snapshotLedgerParseErrors: report.snapshotLedgerParseErrors,
      sceneLedgerRowsCreated: report.sceneLedgerRowsCreated,
      sceneLedgerRowsUpdated: report.sceneLedgerRowsUpdated,
      sceneLedgerRowsAfter: report.sceneLedgerRowsAfter,
      sceneLedgerParseErrors: report.sceneLedgerParseErrors,
      evidenceRows: report.evidenceRows,
      normalizedScenes: report.normalizedScenes,
      normalizedEntities: report.normalizedEntities,
      fetchErrors: report.fetchErrors,
      errors: report.errors.length,
    },
  };

  writeJson(SNAPSHOT_JSON, snapshotOutput);
  writeJsonl(SNAPSHOT_JSONL, snapshots);
  writeJson(OUT_JSON, output);
  writeJsonl(OUT_JSONL, scenes);
  writeJson(REPORT_JSON, report);

  return { output, snapshotOutput, report };
}

async function main() {
  const { output, snapshotOutput, report } = await buildScenarioNormalized();

  console.log('────────────────────────────────────────────');
  console.log('[scenario-normalizer]');
  console.log('ROOT              =', ROOT);
  console.log('INPUT_JSON        =', INPUT_JSON);
  console.log('SNAPSHOT_JSON     =', SNAPSHOT_JSON);
  console.log('SNAPSHOT_LEDGER   =', SNAPSHOT_LEDGER_JSONL);
  console.log('SCENE_LEDGER      =', SCENE_LEDGER_JSONL);
  console.log('OUT_JSON          =', OUT_JSON);
  console.log('OUT_JSONL         =', OUT_JSONL);
  console.log('REPORT            =', REPORT_JSON);
  console.log('fetchMode         =', FETCH_MODE);
  console.log('availableCandidates=', report.availableCandidates);
  console.log('checkedCandidates =', report.checkedCandidates);
  console.log('selectedQueries   =', report.selectedQueries);
  console.log('snapshotRows      =', snapshotOutput.snapshotCount);
  console.log('ledgerAppended    =', report.snapshotLedgerRowsAppended);
  console.log('ledgerRowsAfter   =', report.snapshotLedgerRowsAfter);
  console.log('sceneLedgerCreated=', report.sceneLedgerRowsCreated);
  console.log('sceneLedgerUpdated=', report.sceneLedgerRowsUpdated);
  console.log('sceneLedgerRows   =', report.sceneLedgerRowsAfter);
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
  main().catch((error) => {
    console.error('[scenario-normalizer][FATAL]', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildScenarioNormalized,
  collectScenarioSnapshots,
  normalizeScenarioScenes,
  appendSnapshotLedger,
  writeSceneLedger,
  selectQueryBatch,
};
