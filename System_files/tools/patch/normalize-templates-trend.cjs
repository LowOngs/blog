#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/tools/patch/normalize-templates-trend.cjs
 * Role : Normalize Trend Templates & Checklists Seed Structure
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../");

const TARGET = path.join(
  ROOT,
  "seedpool",
  "warehouse",
  "trend",
  "templates-checklists-trend.json"
);

const DEFAULT_TEMPLATE_FIELDS = [
  "task",
  "status",
  "owner",
  "notes",
  "review date"
];

const DEFAULT_USE_CASES = [
  "current workflow setup",
  "repeatable task execution",
  "AI-assisted organization"
];

const RULES = [
  {
    match: ["ai", "prompt", "research", "content review", "ai-ready"],
    templateType: "ai-workflow-template",
    trendTrigger: "AI tools are now used in everyday research, writing, planning, and review workflows.",
    currentUseCase: "Help users make AI-assisted work more structured, reusable, and easier to verify.",
    riskIfIgnored: "AI output may become inconsistent, hard to check, or difficult to reuse.",
    templateFields: ["goal", "input", "constraints", "output format", "verification"],
    useCases: ["AI prompt setup", "research validation", "content review"]
  },
  {
    match: ["privacy", "permission", "security", "safety", "recovery", "password"],
    templateType: "digital-safety-checklist",
    trendTrigger: "Account security, app permissions, device recovery, and privacy controls change frequently.",
    currentUseCase: "Help users review digital safety settings across apps, accounts, and devices.",
    riskIfIgnored: "Old permissions or weak recovery settings can expose accounts, data, or devices.",
    templateFields: ["item", "current setting", "risk level", "action needed", "review date"],
    useCases: ["permission audit", "account recovery setup", "device security review"]
  },
  {
    match: ["device", "migration", "reset", "older devices"],
    templateType: "device-transition-checklist",
    trendTrigger: "Users frequently move between devices, reset phones, or extend the life of older hardware.",
    currentUseCase: "Help users avoid missing backups, sync steps, account logouts, and setup checks.",
    riskIfIgnored: "Device changes can cause data loss, login problems, or unfinished setup.",
    templateFields: ["device", "backup status", "account status", "transfer step", "final check"],
    useCases: ["phone migration", "factory reset preparation", "old device safety"]
  },
  {
    match: ["workspace", "browser", "inbox", "photo", "note audit", "cleanup"],
    templateType: "digital-cleanup-template",
    trendTrigger: "Digital clutter grows faster as users rely on more apps, cloud folders, AI tools, and browsers.",
    currentUseCase: "Help users clean and organize files, notes, inboxes, photos, browsers, and workspaces.",
    riskIfIgnored: "Clutter can slow work, hide important files, and increase repeated searching.",
    templateFields: ["area", "problem found", "cleanup action", "keep/delete/archive", "review date"],
    useCases: ["file cleanup", "browser cleanup", "photo and note organization"]
  },
  {
    match: ["calendar", "time blocking", "productivity", "remote work", "weekly", "task prioritization"],
    templateType: "productivity-planning-template",
    trendTrigger: "Hybrid work, AI reminders, and multi-app task systems make planning more complex.",
    currentUseCase: "Help users turn scattered tasks into a repeatable weekly or daily planning structure.",
    riskIfIgnored: "Tasks may remain scattered across apps, causing missed work and weak follow-through.",
    templateFields: ["task", "priority", "time block", "tool/app", "follow-up"],
    useCases: ["weekly planning", "remote work routine", "task prioritization"]
  },
  {
    match: ["subscription", "finance", "budget", "value audit"],
    templateType: "spending-review-template",
    trendTrigger: "Subscription, software, and digital spending decisions change as prices and bundles shift.",
    currentUseCase: "Help users review recurring costs, value, usage, and cancellation decisions.",
    riskIfIgnored: "Recurring costs may continue without clear value or review.",
    templateFields: ["service", "cost", "usage", "value score", "next action"],
    useCases: ["subscription audit", "weekly finance review", "value decision"]
  },
  {
    match: ["project", "brainstorming", "knowledge", "notetaking", "writing workflow"],
    templateType: "knowledge-work-template",
    trendTrigger: "Creators, students, and analysts increasingly use AI and structured notes to manage knowledge work.",
    currentUseCase: "Help users capture ideas, organize references, and turn information into useful outputs.",
    riskIfIgnored: "Ideas and research may remain scattered, duplicated, or hard to turn into action.",
    templateFields: ["idea", "source", "insight", "next action", "output"],
    useCases: ["project planning", "knowledge review", "creative workflow"]
  },
  {
    match: ["team communication", "multi-app workflow", "workflow sync"],
    templateType: "team-workflow-template",
    trendTrigger: "Teams now work across async updates, shared tools, chat, documents, and task apps.",
    currentUseCase: "Help teams align updates, responsibilities, status, and next actions.",
    riskIfIgnored: "Work can split across apps without clear ownership or status.",
    templateFields: ["topic", "owner", "status", "blocker", "next action"],
    useCases: ["async update", "team workflow sync", "multi-app coordination"]
  },
  {
    match: ["troubleshooting", "error diagnosis"],
    templateType: "diagnosis-checklist",
    trendTrigger: "Users face more cross-device and cross-app issues as digital systems become more connected.",
    currentUseCase: "Help users identify symptoms, isolate causes, and record attempted fixes.",
    riskIfIgnored: "Users may repeat random fixes without finding the real cause.",
    templateFields: ["symptom", "environment", "possible cause", "test result", "next fix"],
    useCases: ["tech troubleshooting", "error diagnosis", "support preparation"]
  }
];

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function findRule(item) {
  const sourceText = normalizeText(
    [
      item.title,
      item.angle,
      item.audience,
      item.intent
    ].join(" ")
  );

  return RULES.find(rule =>
    rule.match.some(keyword => sourceText.includes(keyword))
  );
}

function cleanName(title) {
  return String(title || "template checklist topic")
    .replace(/\(2025\)/gi, "")
    .replace(/2025/gi, "")
    .replace(/^Universal\s+/i, "")
    .replace(/^Daily\s+/i, "")
    .replace(/^Weekly\s+/i, "")
    .replace(/^AI-Assisted\s+/i, "AI-assisted ")
    .trim();
}

if (!fs.existsSync(TARGET)) {
  console.error("[ERROR] file not found");
  console.error(TARGET);
  process.exit(1);
}

const raw = fs.readFileSync(TARGET, "utf8");
const json = JSON.parse(raw);

if (!Array.isArray(json.trend)) {
  console.error("[ERROR] json.trend is not an array");
  process.exit(1);
}

const beforeCount = json.trend.length;

let removedAutoGenerated = 0;
let normalized = 0;
let matchedRules = 0;
let defaulted = 0;

json.trend = json.trend.filter(item => {
  const title = String(item.title || "");
  const id = String(item.id || "");

  const isAuto =
    title.includes("AUTO GENERATED:") ||
    id.startsWith("templates-checklists-trend-");

  if (isAuto) {
    removedAutoGenerated++;
    return false;
  }

  return true;
});

for (const item of json.trend) {
  const rule = findRule(item);

  item.intent ||= "template/trend";

  item.trendMode ||= "current-workflow-template";

  item.entity ||= {
    type: "template-use-case",
    name: cleanName(item.title),
    intentFamily: "trend-template"
  };

  item.templateType = rule
    ? rule.templateType
    : "current-use-template";

  item.trendTrigger = rule
    ? rule.trendTrigger
    : "Users need a reusable structure for a current digital task, workflow, or decision.";

  item.currentUseCase = rule
    ? rule.currentUseCase
    : "Help users complete a modern task with fewer missed steps and clearer review points.";

  item.riskIfIgnored = rule
    ? rule.riskIfIgnored
    : "Without a clear template, users may repeat the same task inconsistently or miss important steps.";

  item.templateFields =
    Array.isArray(item.templateFields) && item.templateFields.length > 0
      ? item.templateFields
      : rule
        ? [...rule.templateFields]
        : [...DEFAULT_TEMPLATE_FIELDS];

  item.useCases =
    Array.isArray(item.useCases) && item.useCases.length > 0
      ? item.useCases
      : rule
        ? [...rule.useCases]
        : [...DEFAULT_USE_CASES];

  item.expectedOutcome ||= "the user can complete a current digital task with a reusable and reviewable structure";

  item.selectionCriteria ||= {
    trendTemplate: true,
    reusableStructure: true,
    currentWorkflowRelevant: true,
    actionableFields: true,
    beginnerFriendly: true,
    notPureEvergreen: true,
    hasReviewStep: true
  };

  item.selectionMeta ||= {
    schema: "AOIA",
    mode: "trend",
    sourceType: "templates-checklists trend normalization",
    selectedAt: new Date().toISOString()
  };

  if (rule) {
    matchedRules++;
  } else {
    defaulted++;
  }

  normalized++;
}

json.schema ||= "AOIA";
json.mode ||= "trend";
json.updatedAt = new Date().toISOString();

json.trendSchema ||= {
  schema: "AOIA",
  label: "templates-checklists",
  mode: "trend",
  requiredConcept: "current reusable execution tool",
  requiredFields: [
    "title",
    "angle",
    "audience",
    "intent",
    "entity",
    "trendMode",
    "templateType",
    "trendTrigger",
    "currentUseCase",
    "riskIfIgnored",
    "templateFields",
    "useCases",
    "expectedOutcome",
    "selectionCriteria",
    "selectionMeta",
    "fingerprint"
  ]
};

const backup = TARGET.replace(
  ".json",
  `.backup-${Date.now()}.json`
);

fs.copyFileSync(TARGET, backup);

fs.writeFileSync(
  TARGET,
  JSON.stringify(json, null, 2),
  "utf8"
);

console.log("────────────────────────────");
console.log("[normalize-templates-trend]");
console.log("target =", TARGET);
console.log("backup =", backup);
console.log("before =", beforeCount);
console.log("after  =", json.trend.length);
console.log("removedAutoGenerated =", removedAutoGenerated);
console.log("normalized =", normalized);
console.log("matchedRules =", matchedRules);
console.log("defaulted =", defaulted);
console.log("────────────────────────────");
