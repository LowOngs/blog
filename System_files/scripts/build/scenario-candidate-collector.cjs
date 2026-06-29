#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/scripts/build/scenario-candidate-collector.cjs
 * Role : Build Scenario Candidate Search Plans from Entity Profiles
 * Root : C:\\google-blog\\System_files
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "../..");

const INPUT_JSON = path.join(ROOT, "seedpool", "profiles", "entity-profiles.json");
const OUT_DIR = path.join(ROOT, "seedpool", "profiles");
const OUT_JSON = path.join(OUT_DIR, "scenario-candidates.json");
const OUT_JSONL = path.join(OUT_DIR, "scenario-candidates.jsonl");
const REPORT_JSON = path.join(ROOT, "logs", "scenario-candidate-collector-report.json");

const SCHEMA_VERSION = "1.0.0";
const MAX_QUERIES_PER_PURPOSE = 8;
const MAX_TOTAL_QUERIES_PER_ENTITY = 36;
const DEFAULT_ENTITY_LIMIT = Number.parseInt(process.env.SCENARIO_ENTITY_LIMIT || "0", 10);

const PURPOSES = Object.freeze({
  REAL_USAGE: "real_usage",
  COMPARISON: "comparison",
  PAIN_POINTS: "pain_points",
  RECOMMENDATION: "recommendation",
  DECISION: "decision",
  OFFICIAL_CONTEXT: "official_context",
});

const PURPOSE_PRIORITY = Object.freeze({
  [PURPOSES.REAL_USAGE]: 100,
  [PURPOSES.COMPARISON]: 90,
  [PURPOSES.PAIN_POINTS]: 85,
  [PURPOSES.RECOMMENDATION]: 80,
  [PURPOSES.DECISION]: 75,
  [PURPOSES.OFFICIAL_CONTEXT]: 70,
});

const LABEL_HINTS = Object.freeze({
  "app-reviews": {
    usage: ["workflow", "daily use", "use cases", "tips"],
    comparison: ["alternatives", "vs", "comparison"],
    pain: ["problems", "limitations", "complaints", "issues"],
    decision: ["worth it", "should I use", "review"],
    official: ["features", "pricing", "release notes", "help center"],
  },
  "device-reviews": {
    usage: ["real world use", "hands on", "daily use", "setup"],
    comparison: ["alternatives", "vs", "comparison"],
    pain: ["problems", "limitations", "complaints", "issues"],
    decision: ["worth it", "should I buy", "review"],
    official: ["specs", "support", "manual", "release notes"],
  },
  "subscription-services": {
    usage: ["use cases", "family plan", "daily use", "workflow"],
    comparison: ["alternatives", "vs", "comparison", "plans"],
    pain: ["pricing complaints", "limitations", "cancellation", "issues"],
    decision: ["worth it", "should I subscribe", "review"],
    official: ["pricing", "plans", "terms", "support"],
  },
  "how-to-playbooks": {
    usage: ["how to", "fix", "setup", "troubleshooting"],
    comparison: ["best way", "alternatives", "tools"],
    pain: ["not working", "problem", "error", "issue"],
    decision: ["what to do", "steps", "checklist"],
    official: ["support", "documentation", "help"],
  },
  "smart-savings": {
    usage: ["save money", "budget", "cost", "monthly cost"],
    comparison: ["cheapest", "plans", "alternatives", "comparison"],
    pain: ["hidden fees", "price increase", "unused subscription", "overpaying"],
    decision: ["worth it", "best value", "should I pay"],
    official: ["pricing", "plans", "terms"],
  },
  "templates-checklists": {
    usage: ["template", "checklist", "workflow", "example"],
    comparison: ["best template", "alternatives", "examples"],
    pain: ["mistakes", "missing steps", "problems"],
    decision: ["how to organize", "what to include", "checklist"],
    official: ["guide", "documentation", "help"],
  },
});

const TYPE_HINTS = Object.freeze({
  app: ["app", "mobile app", "web app"],
  device: ["device", "hardware", "gadget"],
  subscription: ["subscription", "service", "plan"],
  problem: ["problem", "troubleshooting", "fix"],
  "cost-category": ["cost", "budget", "saving"],
  "template-use-case": ["template", "checklist", "workflow"],
});

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const body = rows.map(row => JSON.stringify(row)).join("\n");
  fs.writeFileSync(filePath, body ? body + "\n" : "", "utf8");
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function unique(values) {
  const seen = new Set();
  const out = [];

  toArray(values).forEach(value => {
    const text = normalizeText(value);
    const key = normalizeLower(text);
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });

  return out;
}

function compact(values, limit) {
  return unique(values).slice(0, limit);
}

function hasConflict(profile) {
  return Array.isArray(profile.identityConflicts) && profile.identityConflicts.length > 0;
}

function pickName(profile) {
  return normalizeText(profile.canonicalName) || normalizeText(profile.name);
}

function primaryLabel(profile) {
  return normalizeText(toArray(profile.labels)[0]);
}

function labelHints(label) {
  return LABEL_HINTS[label] || {
    usage: ["use cases", "workflow", "daily use"],
    comparison: ["alternatives", "comparison", "vs"],
    pain: ["problems", "limitations", "issues"],
    decision: ["worth it", "should I use", "review"],
    official: ["official", "support", "documentation"],
  };
}

function typeHints(type) {
  return TYPE_HINTS[normalizeLower(type)] || [];
}

function extractCategories(profile) {
  const values = [];

  values.push(profile.category);

  toArray(profile.entities).forEach(entity => {
    if (!entity || typeof entity !== "object") return;
    values.push(entity.category);
    values.push(entity.deviceClass);
    values.push(entity.intentFamily);
  });

  toArray(profile.reviewEntities).forEach(entity => {
    if (!entity || typeof entity !== "object") return;
    values.push(entity.category);
    values.push(entity.deviceClass);
  });

  toArray(profile.classificationHints).forEach(hints => {
    if (!hints || typeof hints !== "object") return;
    values.push(hints.category);
    values.push(hints.primaryCategory);
    if (hints.categoryHints && typeof hints.categoryHints === "object") {
      values.push(hints.categoryHints.primaryCategory);
      values.push(hints.categoryHints.secondaryCategory);
      values.push(hints.categoryHints.emergingCategory);
    }
    if (Array.isArray(hints.productTypeWords)) {
      values.push(...hints.productTypeWords);
    }
  });

  return compact(values, 8);
}

function extractPlatforms(profile) {
  const values = [...toArray(profile.platforms)];

  toArray(profile.entities).forEach(entity => {
    if (!entity || typeof entity !== "object") return;
    values.push(...toArray(entity.platform));
  });

  toArray(profile.reviewEntities).forEach(entity => {
    if (!entity || typeof entity !== "object") return;
    values.push(...toArray(entity.platform));
  });

  return compact(values, 6);
}

function extractSeedSignals(profile) {
  const values = [];

  toArray(profile.seedSamples).forEach(seed => {
    if (!seed || typeof seed !== "object") return;
    values.push(seed.intent);
    values.push(seed.environment);
    values.push(seed.timing);
    values.push(seed.goal);
    values.push(seed.angle);
    values.push(seed.audience);
  });

  return compact(values, 14);
}

function extractUseCaseLikeSignals(profile) {
  const values = [];

  toArray(profile.entities).forEach(entity => {
    if (!entity || typeof entity !== "object") return;
    values.push(entity.category);
    values.push(entity.deviceClass);
    values.push(entity.interactionModel);
  });

  toArray(profile.classificationHints).forEach(hints => {
    if (!hints || typeof hints !== "object") return;
    values.push(...toArray(hints.productTypeWords));
    if (hints.categoryHints && typeof hints.categoryHints === "object") {
      values.push(hints.categoryHints.primaryCategory);
      values.push(hints.categoryHints.secondaryCategory);
      values.push(hints.categoryHints.emergingCategory);
    }
    if (hints.interactionHints && typeof hints.interactionHints === "object") {
      values.push(hints.interactionHints.interactionModel);
      values.push(hints.interactionHints.inputMethod);
      values.push(hints.interactionHints.controlSurface);
    }
    if (hints.maturityHints && typeof hints.maturityHints === "object") {
      values.push(hints.maturityHints.marketStage);
      values.push(hints.maturityHints.adoptionRisk);
    }
  });

  toArray(profile.seedSamples).forEach(seed => {
    if (!seed || typeof seed !== "object") return;
    values.push(seed.environment);
    values.push(seed.goal);
  });

  return compact(values, 12);
}

function makeQuery(parts) {
  return unique(parts)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function addQuery(bucket, query, purpose, priority, tags, reason) {
  const clean = normalizeText(query);
  if (!clean) return;

  const key = normalizeLower(clean);
  if (bucket._seen.has(key)) return;

  bucket._seen.add(key);
  bucket.items.push({
    query: clean,
    purpose,
    priority,
    tags: unique(tags),
    reason: normalizeText(reason),
  });
}

function planRealUsage(profile, context) {
  const { name, label, categories, platforms, useCaseSignals } = context;
  const hints = labelHints(label);
  const bucket = { _seen: new Set(), items: [] };

  hints.usage.forEach((hint, index) => {
    addQuery(
      bucket,
      makeQuery([name, categories[index % Math.max(categories.length, 1)], hint]),
      PURPOSES.REAL_USAGE,
      PURPOSE_PRIORITY[PURPOSES.REAL_USAGE] - index,
      ["usage", "experience", label],
      "Find repeated real-use situations and practical contexts."
    );
  });

  platforms.slice(0, 3).forEach((platform, index) => {
    addQuery(
      bucket,
      makeQuery([name, platform, "workflow"]),
      PURPOSES.REAL_USAGE,
      PURPOSE_PRIORITY[PURPOSES.REAL_USAGE] - 5 - index,
      ["usage", "platform", platform],
      "Find platform-specific usage patterns."
    );
  });

  useCaseSignals.slice(0, 4).forEach((signal, index) => {
    addQuery(
      bucket,
      makeQuery([name, signal, "use case"]),
      PURPOSES.REAL_USAGE,
      PURPOSE_PRIORITY[PURPOSES.REAL_USAGE] - 10 - index,
      ["usage", "seed-signal"],
      "Expand entity signals into scenario candidates."
    );
  });

  return bucket.items.slice(0, MAX_QUERIES_PER_PURPOSE);
}

function planComparison(profile, context) {
  const { name, label, categories } = context;
  const hints = labelHints(label);
  const bucket = { _seen: new Set(), items: [] };

  addQuery(
    bucket,
    makeQuery([name, "alternatives"]),
    PURPOSES.COMPARISON,
    PURPOSE_PRIORITY[PURPOSES.COMPARISON],
    ["comparison", "alternatives", label],
    "Find common alternatives and comparison angles."
  );

  categories.slice(0, 4).forEach((category, index) => {
    addQuery(
      bucket,
      makeQuery([name, category, "alternatives"]),
      PURPOSES.COMPARISON,
      PURPOSE_PRIORITY[PURPOSES.COMPARISON] - 2 - index,
      ["comparison", "category"],
      "Find comparison candidates inside the same category."
    );
  });

  hints.comparison.slice(0, 4).forEach((hint, index) => {
    addQuery(
      bucket,
      makeQuery([name, hint]),
      PURPOSES.COMPARISON,
      PURPOSE_PRIORITY[PURPOSES.COMPARISON] - 8 - index,
      ["comparison", "intent"],
      "Find comparison and switching frames."
    );
  });

  return bucket.items.slice(0, MAX_QUERIES_PER_PURPOSE);
}

function planPainPoints(profile, context) {
  const { name, label, categories } = context;
  const hints = labelHints(label);
  const bucket = { _seen: new Set(), items: [] };

  hints.pain.forEach((hint, index) => {
    addQuery(
      bucket,
      makeQuery([name, hint]),
      PURPOSES.PAIN_POINTS,
      PURPOSE_PRIORITY[PURPOSES.PAIN_POINTS] - index,
      ["pain", "risk", label],
      "Find repeated complaints, limits, and failure patterns."
    );
  });

  categories.slice(0, 3).forEach((category, index) => {
    addQuery(
      bucket,
      makeQuery([name, category, "limitations"]),
      PURPOSES.PAIN_POINTS,
      PURPOSE_PRIORITY[PURPOSES.PAIN_POINTS] - 6 - index,
      ["pain", "category"],
      "Find category-specific limitation patterns."
    );
  });

  return bucket.items.slice(0, MAX_QUERIES_PER_PURPOSE);
}

function planRecommendation(profile, context) {
  const { name, label, categories } = context;
  const bucket = { _seen: new Set(), items: [] };

  addQuery(
    bucket,
    makeQuery(["why people use", name]),
    PURPOSES.RECOMMENDATION,
    PURPOSE_PRIORITY[PURPOSES.RECOMMENDATION],
    ["recommendation", "benefit", label],
    "Find positive usage reasons without inventing product claims."
  );

  addQuery(
    bucket,
    makeQuery([name, "best features"]),
    PURPOSES.RECOMMENDATION,
    PURPOSE_PRIORITY[PURPOSES.RECOMMENDATION] - 1,
    ["recommendation", "features"],
    "Find common value points and benefit patterns."
  );

  categories.slice(0, 4).forEach((category, index) => {
    addQuery(
      bucket,
      makeQuery(["best", category, name]),
      PURPOSES.RECOMMENDATION,
      PURPOSE_PRIORITY[PURPOSES.RECOMMENDATION] - 4 - index,
      ["recommendation", "category"],
      "Find category fit and audience reasons."
    );
  });

  return bucket.items.slice(0, MAX_QUERIES_PER_PURPOSE);
}

function planDecision(profile, context) {
  const { name, label } = context;
  const hints = labelHints(label);
  const bucket = { _seen: new Set(), items: [] };

  hints.decision.forEach((hint, index) => {
    addQuery(
      bucket,
      makeQuery([name, hint]),
      PURPOSES.DECISION,
      PURPOSE_PRIORITY[PURPOSES.DECISION] - index,
      ["decision", "intent", label],
      "Find decision-oriented questions and current user choice frames."
    );
  });

  addQuery(
    bucket,
    makeQuery([name, "pros and cons"]),
    PURPOSES.DECISION,
    PURPOSE_PRIORITY[PURPOSES.DECISION] - 5,
    ["decision", "pros-cons"],
    "Find balanced decision criteria."
  );

  return bucket.items.slice(0, MAX_QUERIES_PER_PURPOSE);
}

function planOfficialContext(profile, context) {
  const { name, label } = context;
  const hints = labelHints(label);
  const bucket = { _seen: new Set(), items: [] };

  hints.official.forEach((hint, index) => {
    addQuery(
      bucket,
      makeQuery([name, "official", hint]),
      PURPOSES.OFFICIAL_CONTEXT,
      PURPOSE_PRIORITY[PURPOSES.OFFICIAL_CONTEXT] - index,
      ["official", "verification", label],
      "Find official context for verification and safety locking."
    );
  });

  return bucket.items.slice(0, MAX_QUERIES_PER_PURPOSE);
}

function flattenSearchPlans(searchPlans) {
  const rows = [];

  searchPlans.forEach(plan => {
    plan.queries.forEach(query => {
      rows.push({ ...query, purpose: plan.purpose });
    });
  });

  return rows
    .sort((a, b) => b.priority - a.priority || a.query.localeCompare(b.query))
    .slice(0, MAX_TOTAL_QUERIES_PER_ENTITY);
}

function groupSearchPlans(rows) {
  const byPurpose = new Map();

  rows.forEach(row => {
    if (!byPurpose.has(row.purpose)) byPurpose.set(row.purpose, []);
    byPurpose.get(row.purpose).push({
      query: row.query,
      priority: row.priority,
      tags: row.tags,
      reason: row.reason,
    });
  });

  return [...byPurpose.entries()].map(([purpose, queries]) => ({
    purpose,
    priority: PURPOSE_PRIORITY[purpose] || 0,
    queries,
  }));
}

function buildCandidate(profile) {
  const name = pickName(profile);
  const label = primaryLabel(profile);
  const type = normalizeText(profile.type) || "unknown";
  const categories = compact([...extractCategories(profile), ...typeHints(type)], 10);
  const platforms = extractPlatforms(profile);
  const seedSignals = extractSeedSignals(profile);
  const useCaseSignals = extractUseCaseLikeSignals(profile);
  const conflict = hasConflict(profile);

  const context = {
    name,
    label,
    type,
    categories,
    platforms,
    seedSignals,
    useCaseSignals,
  };

  const plannedRows = [
    ...planRealUsage(profile, context),
    ...planComparison(profile, context),
    ...planPainPoints(profile, context),
    ...planRecommendation(profile, context),
    ...planDecision(profile, context),
    ...planOfficialContext(profile, context),
  ];

  const dedupedRows = [];
  const seen = new Set();

  plannedRows.forEach(row => {
    const key = normalizeLower(row.query);
    if (!key || seen.has(key)) return;
    seen.add(key);
    dedupedRows.push(row);
  });

  const finalRows = flattenSearchPlans(groupSearchPlans(dedupedRows));
  const searchPlans = groupSearchPlans(finalRows);

  return {
    entityKey: profile.entityKey,
    name: profile.name,
    canonicalName: name,
    type,
    labels: toArray(profile.labels),
    modes: toArray(profile.modes),
    categories,
    platforms,
    identityStatus: conflict ? "conflict" : "clean",
    identityConflictCount: toArray(profile.identityConflicts).length,
    queryCount: finalRows.length,
    searchPlans,
    sourceProfile: {
      profileHash: profile.meta && profile.meta.profileHash ? profile.meta.profileHash : "",
      seedCount: profile.stats && profile.stats.seedCount ? profile.stats.seedCount : 0,
      sourceFileCount: profile.stats && profile.stats.sourceFileCount ? profile.stats.sourceFileCount : 0,
    },
    meta: {
      schema: "AOIA",
      layer: "scenario-candidate",
      collector: "scenario-candidate-collector.cjs",
      candidateHash: sha1(JSON.stringify({
        entityKey: profile.entityKey,
        canonicalName: name,
        searchPlans,
      })),
    },
  };
}

function loadProfiles() {
  const input = readJson(INPUT_JSON);
  if (!input || !Array.isArray(input.profiles)) {
    throw new Error(`Invalid entity profile input: ${INPUT_JSON}`);
  }
  return input.profiles;
}

function shouldIncludeProfile(profile) {
  const name = pickName(profile);
  if (!name) return false;
  if (!profile.entityKey) return false;
  return true;
}

function buildScenarioCandidates(options = {}) {
  const nowIso = new Date().toISOString();
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_ENTITY_LIMIT;
  const profiles = loadProfiles();

  const report = {
    schema: "AOIA",
    collector: "scenario-candidate-collector.cjs",
    generatedAt: nowIso,
    inputJson: INPUT_JSON,
    outputJson: OUT_JSON,
    outputJsonl: OUT_JSONL,
    checkedProfiles: 0,
    candidates: 0,
    skippedProfiles: 0,
    cleanProfiles: 0,
    conflictProfiles: 0,
    totalQueries: 0,
    purposeCounts: {},
    errors: [],
    skipped: [],
  };

  const candidates = [];

  for (const profile of profiles) {
    report.checkedProfiles += 1;

    if (!shouldIncludeProfile(profile)) {
      report.skippedProfiles += 1;
      report.skipped.push({
        entityKey: profile && profile.entityKey ? profile.entityKey : null,
        name: profile && profile.name ? profile.name : null,
        reason: "missing entityKey or canonical name",
      });
      continue;
    }

    if (limit > 0 && candidates.length >= limit) continue;

    const candidate = buildCandidate(profile);
    candidates.push(candidate);

    if (candidate.identityStatus === "conflict") {
      report.conflictProfiles += 1;
    } else {
      report.cleanProfiles += 1;
    }

    report.totalQueries += candidate.queryCount;

    candidate.searchPlans.forEach(plan => {
      report.purposeCounts[plan.purpose] =
        (report.purposeCounts[plan.purpose] || 0) + plan.queries.length;
    });
  }

  candidates.sort((a, b) => {
    if (a.identityStatus !== b.identityStatus) {
      return a.identityStatus === "clean" ? -1 : 1;
    }
    return a.entityKey.localeCompare(b.entityKey);
  });

  report.candidates = candidates.length;

  const output = {
    schema: "AOIA",
    schemaVersion: SCHEMA_VERSION,
    type: "scenarioCandidates",
    generatedAt: nowIso,
    source: "seedpool/profiles/entity-profiles.json",
    candidateCount: candidates.length,
    candidates,
    report: {
      checkedProfiles: report.checkedProfiles,
      skippedProfiles: report.skippedProfiles,
      cleanProfiles: report.cleanProfiles,
      conflictProfiles: report.conflictProfiles,
      totalQueries: report.totalQueries,
      purposeCounts: report.purposeCounts,
      errors: report.errors.length,
    },
  };

  writeJson(OUT_JSON, output);
  writeJsonl(OUT_JSONL, candidates);
  writeJson(REPORT_JSON, report);

  return { output, report };
}

function main() {
  let result;

  try {
    result = buildScenarioCandidates();
  } catch (error) {
    console.error("[scenario-candidate-collector][ERROR]", error.message || error);
    process.exitCode = 1;
    return;
  }

  const { output, report } = result;

  console.log("────────────────────────────────────────────");
  console.log("[scenario-candidate-collector]");
  console.log("ROOT             =", ROOT);
  console.log("INPUT_JSON       =", INPUT_JSON);
  console.log("OUT_JSON         =", OUT_JSON);
  console.log("OUT_JSONL        =", OUT_JSONL);
  console.log("REPORT           =", REPORT_JSON);
  console.log("checkedProfiles  =", report.checkedProfiles);
  console.log("candidates       =", output.candidateCount);
  console.log("skippedProfiles  =", report.skippedProfiles);
  console.log("cleanProfiles    =", report.cleanProfiles);
  console.log("conflictProfiles =", report.conflictProfiles);
  console.log("totalQueries     =", report.totalQueries);
  console.log("errors           =", report.errors.length);
  console.log("────────────────────────────────────────────");
}

if (require.main === module) {
  main();
}

module.exports = {
  buildScenarioCandidates,
  buildCandidate,
  extractCategories,
  extractPlatforms,
  extractSeedSignals,
  extractUseCaseLikeSignals,
};
