#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/scripts/build/entity-profile-builder.cjs
 * Role : Build Entity Profiles from SeedPool Warehouse
 * Root : C:\google-blog\System_files
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "../..");

const WAREHOUSE_DIR = path.join(ROOT, "seedpool", "warehouse");
const OUT_DIR = path.join(ROOT, "seedpool", "profiles");
const OUT_JSON = path.join(OUT_DIR, "entity-profiles.json");
const OUT_JSONL = path.join(OUT_DIR, "entity-profiles.jsonl");
const REPORT_JSON = path.join(ROOT, "logs", "entity-profile-builder-report.json");

const WAREHOUSE_GROUPS = ["evergreen", "trend", "first-gate"];

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
  fs.writeFileSync(
    filePath,
    rows.map(row => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function normText(value) {
  return String(value || "").trim();
}

function normLower(value) {
  return normText(value).toLowerCase();
}

function slugify(value) {
  return normLower(value)
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function uniqueArray(values) {
  return [...new Set(toArray(values).map(normText).filter(Boolean))];
}

function detectGroup(filePath) {
  const rel = path.relative(WAREHOUSE_DIR, filePath).replace(/\\/g, "/");
  return rel.split("/")[0] || "";
}

function detectLabel(filePath, json) {
  if (json && typeof json.label === "string" && json.label.trim()) {
    return json.label.trim();
  }

  const base = path.basename(filePath, ".json");

  return base
    .replace(/-(trend|evergreen|firstgate|first-gate)$/i, "")
    .trim();
}

function detectMode(filePath) {
  const group = detectGroup(filePath);
  if (group === "first-gate") return "firstgate";
  return group || "unknown";
}

function extractSeedItems(json) {
  const keys = [
    "trend",
    "evergreen",
    "firstgate",
    "firstGate",
    "items",
    "seeds"
  ];

  for (const key of keys) {
    if (Array.isArray(json[key])) return json[key];
  }

  if (Array.isArray(json)) return json;

  return [];
}

function pickEntityName(seed) {
  const reviewEntity = seed.reviewEntity || {};
  const entity = seed.entity || {};

  return (
    normText(entity.name) ||
    normText(reviewEntity.name) ||
    normText(reviewEntity.appName) ||
    normText(reviewEntity.service) ||
    normText(reviewEntity.model) ||
    normText(reviewEntity.productName) ||
    normText(reviewEntity.title) ||
    normText(seed.name) ||
    normText(seed.title)
  );
}

function pickEntityType(seed, label) {
  const reviewEntity = seed.reviewEntity || {};
  const entity = seed.entity || {};

  return (
    normText(entity.type) ||
    normText(reviewEntity.type) ||
    inferTypeFromLabel(label)
  );
}

function inferTypeFromLabel(label) {
  const v = normLower(label);

  if (v === "app-reviews") return "app";
  if (v === "device-reviews") return "device";
  if (v === "subscription-services") return "subscription";
  if (v === "how-to-playbooks") return "problem";
  if (v === "smart-savings") return "cost-category";
  if (v === "templates-checklists") return "template-use-case";

  return "unknown";
}

function pickCategory(seed) {
  const reviewEntity = seed.reviewEntity || {};
  const entity = seed.entity || {};
  const hints = seed.classificationHints || {};

  return (
    normText(entity.category) ||
    normText(reviewEntity.category) ||
    normText(hints.category) ||
    normText(hints.primaryCategory) ||
    normText(hints.categoryHints && hints.categoryHints.primaryCategory)
  );
}

function buildEntityKey(name, type, label) {
  const raw = [type, label, name].map(slugify).filter(Boolean).join(":");
  return raw || `unknown:${sha1(JSON.stringify({ name, type, label })).slice(0, 12)}`;
}

function compactSeed(seed) {
  return {
    id: seed.id || null,
    title: seed.title || null,
    intent: seed.intent || null,
    angle: seed.angle || null,
    audience: seed.audience || null,
    environment: seed.environment || null,
    timing: seed.timing || null,
    goal: seed.goal || null,
    fingerprint: seed.fingerprint || null
  };
}

function mergeObjectList(list, item) {
  if (!item || typeof item !== "object") return list;

  const hash = sha1(JSON.stringify(item));
  if (!list.some(existing => sha1(JSON.stringify(existing)) === hash)) {
    list.push(item);
  }

  return list;
}

function addSource(profile, source) {
  const key = [
    source.mode,
    source.label,
    source.file,
    source.seedId || "",
    source.fingerprint || ""
  ].join("|");

  if (!profile._sourceKeys.has(key)) {
    profile._sourceKeys.add(key);
    profile.sources.push(source);
  }
}

function createProfile({ entityKey, name, type, category, label }) {
  return {
    entityKey,
    name,
    type,
    category: category || "",
    labels: uniqueArray([label]),
    modes: [],
    platforms: [],
    sources: [],
    reviewEntities: [],
    entities: [],
    classificationHints: [],
    seedSamples: [],
    stats: {
      seedCount: 0,
      sourceFileCount: 0,
      firstSeenAt: "",
      lastSeenAt: ""
    },
    meta: {
      schema: "AOIA",
      layer: "entity-profile",
      builder: "entity-profile-builder.cjs",
      profileHash: ""
    },
    _sourceKeys: new Set(),
    _fileKeys: new Set()
  };
}

function updateProfile(profile, context) {
  const {
    seed,
    label,
    mode,
    file,
    nowIso
  } = context;

  const reviewEntity = seed.reviewEntity || null;
  const entity = seed.entity || null;
  const classificationHints = seed.classificationHints || null;

  profile.labels = uniqueArray([...profile.labels, label]);
  profile.modes = uniqueArray([...profile.modes, mode]);

  if (entity && Array.isArray(entity.platform)) {
    profile.platforms = uniqueArray([...profile.platforms, ...entity.platform]);
  } else if (entity && entity.platform) {
    profile.platforms = uniqueArray([...profile.platforms, entity.platform]);
  } else if (reviewEntity && reviewEntity.platform) {
    profile.platforms = uniqueArray([...profile.platforms, reviewEntity.platform]);
  }

  mergeObjectList(profile.reviewEntities, reviewEntity);
  mergeObjectList(profile.entities, entity);
  mergeObjectList(profile.classificationHints, classificationHints);

  if (profile.seedSamples.length < 5) {
    profile.seedSamples.push(compactSeed(seed));
  }

  addSource(profile, {
    mode,
    label,
    file,
    seedId: seed.id || null,
    fingerprint: seed.fingerprint || null
  });

  profile._fileKeys.add(file);
  profile.stats.seedCount += 1;
  profile.stats.sourceFileCount = profile._fileKeys.size;

  if (!profile.stats.firstSeenAt) profile.stats.firstSeenAt = nowIso;
  profile.stats.lastSeenAt = nowIso;
}

function finalizeProfile(profile) {
  delete profile._sourceKeys;
  delete profile._fileKeys;

  profile.meta.profileHash = sha1(JSON.stringify({
    entityKey: profile.entityKey,
    name: profile.name,
    type: profile.type,
    category: profile.category,
    labels: profile.labels,
    modes: profile.modes,
    sources: profile.sources
  }));

  return profile;
}

function listWarehouseFiles() {
  const files = [];

  for (const group of WAREHOUSE_GROUPS) {
    const dir = path.join(WAREHOUSE_DIR, group);
    if (!fs.existsSync(dir)) continue;

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      if (name.includes(".backup-")) continue;

      files.push(path.join(dir, name));
    }
  }

  return files.sort();
}

function buildEntityProfiles() {
  const nowIso = new Date().toISOString();
  const files = listWarehouseFiles();

  const profiles = new Map();

  const report = {
    schema: "AOIA",
    builder: "entity-profile-builder.cjs",
    generatedAt: nowIso,
    warehouseDir: WAREHOUSE_DIR,
    outputJson: OUT_JSON,
    outputJsonl: OUT_JSONL,
    checkedFiles: 0,
    checkedSeeds: 0,
    profiles: 0,
    skippedSeeds: 0,
    errors: [],
    skipped: []
  };

  for (const file of files) {
    report.checkedFiles += 1;

    let json;

    try {
      json = readJson(file);
    } catch (error) {
      report.errors.push({
        file,
        message: error.message || String(error)
      });
      continue;
    }

    const label = detectLabel(file, json);
    const mode = detectMode(file);
    const items = extractSeedItems(json);

    for (const seed of items) {
      report.checkedSeeds += 1;

      const name = pickEntityName(seed);
      const type = pickEntityType(seed, label);
      const category = pickCategory(seed);
      const entityKey = buildEntityKey(name, type, label);

      if (!name) {
        report.skippedSeeds += 1;
        report.skipped.push({
          file,
          label,
          mode,
          seedId: seed && seed.id ? seed.id : null,
          title: seed && seed.title ? seed.title : null,
          reason: "entity name not found"
        });
        continue;
      }

      if (!profiles.has(entityKey)) {
        profiles.set(
          entityKey,
          createProfile({
            entityKey,
            name,
            type,
            category,
            label
          })
        );
      }

      updateProfile(profiles.get(entityKey), {
        seed,
        label,
        mode,
        file: path.relative(ROOT, file).replace(/\\/g, "/"),
        nowIso
      });
    }
  }

  const rows = [...profiles.values()]
    .map(finalizeProfile)
    .sort((a, b) => a.entityKey.localeCompare(b.entityKey));

  report.profiles = rows.length;

  const output = {
    schema: "AOIA",
    schemaVersion: "1.0.0",
    type: "entityProfiles",
    generatedAt: nowIso,
    source: "seedpool/warehouse",
    profileCount: rows.length,
    profiles: rows,
    report: {
      checkedFiles: report.checkedFiles,
      checkedSeeds: report.checkedSeeds,
      skippedSeeds: report.skippedSeeds,
      errors: report.errors.length
    }
  };

  writeJson(OUT_JSON, output);
  writeJsonl(OUT_JSONL, rows);
  writeJson(REPORT_JSON, report);

  return {
    output,
    report
  };
}

function main() {
  const { output, report } = buildEntityProfiles();

  console.log("────────────────────────────────────────────");
  console.log("[entity-profile-builder]");
  console.log("ROOT          =", ROOT);
  console.log("WAREHOUSE     =", WAREHOUSE_DIR);
  console.log("OUT_JSON      =", OUT_JSON);
  console.log("OUT_JSONL     =", OUT_JSONL);
  console.log("REPORT        =", REPORT_JSON);
  console.log("checkedFiles  =", report.checkedFiles);
  console.log("checkedSeeds  =", report.checkedSeeds);
  console.log("profiles      =", output.profileCount);
  console.log("skippedSeeds  =", report.skippedSeeds);
  console.log("errors        =", report.errors.length);
  console.log("────────────────────────────────────────────");

  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildEntityProfiles,
  buildEntityKey,
  pickEntityName,
  pickEntityType
};
