#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/tools/patch/normalize-howto-trend.cjs
 * Role : Normalize Trend How-To Playbook Seed Structure
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
  "how-to-playbooks-trend.json"
);

const DEFAULT_USE_CASES = [
  "step-by-step troubleshooting",
  "safe beginner repair",
  "current workflow adjustment"
];

const RULES = [
  {
    match: ["battery", "charging"],
    problemType: "device-power-issue",
    solutionType: "diagnose-and-fix",
    whyNow: "Battery and charging failures become more visible during seasonal temperature changes and heavier mobile use.",
    changeSignal: "seasonal temperature change",
    riskIfIgnored: "Ignoring the issue can shorten battery life or hide a charger, cable, or power-management problem.",
    useCases: ["laptop charging failure", "battery health check", "charger and cable diagnosis"]
  },
  {
    match: ["windows startup", "startup processes"],
    problemType: "system-performance-issue",
    solutionType: "safe-optimization",
    whyNow: "More AI tools, sync apps, and background utilities make startup clutter easier to accumulate.",
    changeSignal: "background app growth",
    riskIfIgnored: "Ignoring startup clutter can slow boot time and make the computer feel older than it is.",
    useCases: ["slow boot cleanup", "beginner PC optimization", "startup app review"]
  },
  {
    match: ["ai study", "exams", "research"],
    problemType: "study-workflow-issue",
    solutionType: "workflow-setup",
    whyNow: "Students are using AI more often, but many still lack a repeatable study workflow.",
    changeSignal: "AI study adoption",
    riskIfIgnored: "Using AI without structure can create scattered notes, weak recall, and unreliable exam preparation.",
    useCases: ["exam preparation", "research note workflow", "AI-assisted study planning"]
  },
  {
    match: ["usb", "corrupted"],
    problemType: "storage-recovery-issue",
    solutionType: "recover-and-protect",
    whyNow: "USB drives remain common for school, office, and transfer work, so corruption problems keep recurring.",
    changeSignal: "portable storage dependence",
    riskIfIgnored: "Rushing recovery can overwrite files or reduce the chance of restoring important data.",
    useCases: ["USB file recovery", "drive error diagnosis", "safe data backup"]
  },
  {
    match: ["multi-cloud", "icloud", "google drive", "dropbox"],
    problemType: "cloud-sync-workflow-issue",
    solutionType: "workflow-configuration",
    whyNow: "Hybrid cloud use is increasing as users split files across multiple ecosystems.",
    changeSignal: "multi-cloud workflow growth",
    riskIfIgnored: "Poor sync design can create duplicate files, missing versions, and account confusion.",
    useCases: ["multi-cloud sync setup", "cross-platform file management", "backup workflow planning"]
  },
  {
    match: ["apple id", "payment"],
    problemType: "account-payment-issue",
    solutionType: "account-check-and-fix",
    whyNow: "Payment failures become more disruptive as subscriptions and app purchases depend on account billing.",
    changeSignal: "subscription renewal pressure",
    riskIfIgnored: "Unresolved payment issues can interrupt app access, iCloud storage, or subscription renewals.",
    useCases: ["Apple ID billing check", "subscription payment fix", "account renewal troubleshooting"]
  },
  {
    match: ["windows update"],
    problemType: "system-update-issue",
    solutionType: "safe-update-repair",
    whyNow: "Update failures remain common as Windows receives frequent security and feature changes.",
    changeSignal: "frequent OS update cycle",
    riskIfIgnored: "Ignoring update failures can leave security patches missing or cause repeated installation loops.",
    useCases: ["Windows update repair", "safe system troubleshooting", "patch failure diagnosis"]
  },
  {
    match: ["privacy settings", "tiktok", "instagram", "meta"],
    problemType: "privacy-control-issue",
    solutionType: "settings-hardening",
    whyNow: "Privacy settings need more frequent review as social platforms add AI, tracking, and account controls.",
    changeSignal: "privacy policy and app setting changes",
    riskIfIgnored: "Old settings may expose more personal activity, recommendations, or account data than intended.",
    useCases: ["social privacy check", "account safety review", "teen and family privacy setup"]
  },
  {
    match: ["printer"],
    problemType: "connection-troubleshooting-issue",
    solutionType: "connectivity-fix",
    whyNow: "Home and office printers still fail often because Wi-Fi, LAN, and driver setups remain fragile.",
    changeSignal: "hybrid home-office device use",
    riskIfIgnored: "Unfixed printer issues can block urgent documents and cause repeated driver or network confusion.",
    useCases: ["Wi-Fi printer repair", "home office setup", "USB and LAN diagnosis"]
  },
  {
    match: ["clean uninstall", "uninstall"],
    problemType: "software-removal-issue",
    solutionType: "safe-cleanup",
    whyNow: "More users test apps, AI tools, and utilities, making clean removal more important.",
    changeSignal: "rapid app testing and replacement",
    riskIfIgnored: "Leftover files and services can waste storage, slow startup, or create app conflicts.",
    useCases: ["app cleanup", "leftover file removal", "Windows and macOS maintenance"]
  },
  {
    match: ["youtube", "not loading"],
    problemType: "streaming-access-issue",
    solutionType: "network-and-browser-fix",
    whyNow: "Streaming interruptions remain common as browsers, DNS, extensions, and networks change.",
    changeSignal: "browser and network environment changes",
    riskIfIgnored: "Ignoring the cause can lead to repeated playback failures across devices.",
    useCases: ["YouTube loading fix", "browser troubleshooting", "network playback diagnosis"]
  },
  {
    match: ["photo library", "photos"],
    problemType: "media-organization-issue",
    solutionType: "AI-assisted-workflow",
    whyNow: "AI photo tools are becoming more common as phone storage and photo libraries keep growing.",
    changeSignal: "AI photo organization adoption",
    riskIfIgnored: "Unorganized photos become harder to search, back up, and preserve over time.",
    useCases: ["photo cleanup", "AI album sorting", "smartphone storage organization"]
  },
  {
    match: ["audio not working", "audio"],
    problemType: "device-audio-issue",
    solutionType: "diagnose-and-fix",
    whyNow: "Audio issues remain common as users switch between Bluetooth, conferencing apps, and system devices.",
    changeSignal: "multi-device audio use",
    riskIfIgnored: "Ignoring the issue can disrupt calls, recordings, classes, or work meetings.",
    useCases: ["speaker and microphone fix", "Bluetooth audio diagnosis", "meeting audio setup"]
  },
  {
    match: ["time blocking", "calendar"],
    problemType: "productivity-planning-issue",
    solutionType: "AI-assisted-scheduling",
    whyNow: "AI calendar and planning tools are making time-blocking easier for ordinary users.",
    changeSignal: "AI productivity workflow growth",
    riskIfIgnored: "Without a clear schedule, tasks spread across the week and become harder to finish.",
    useCases: ["weekly planning", "AI calendar setup", "task prioritization"]
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
    id.startsWith("how-to-playbooks-trend-");

  if (isAuto) {
    removedAutoGenerated++;
    return false;
  }

  return true;
});

for (const item of json.trend) {
  const rule = findRule(item);

  item.intent ||= "howto";

  item.trendMode ||= "problem-solution-with-current-context";

  item.problemType ||= rule
    ? rule.problemType
    : "howto-problem";

  item.solutionType ||= rule
    ? rule.solutionType
    : "step-by-step-solution";

  item.whyNow ||= rule
    ? rule.whyNow
    : "This topic remains useful because users continue to face the problem in current tools and workflows.";

  item.changeSignal ||= rule
    ? rule.changeSignal
    : "recurring user need";

  item.riskIfIgnored ||= rule
    ? rule.riskIfIgnored
    : "Ignoring the issue can waste time, create repeated errors, or make the workflow less reliable.";

  item.futureOutlook ||= "This guide should remain useful as a current troubleshooting and workflow reference, but details may need review when platforms, devices, or app settings change.";

  item.useCases =
    Array.isArray(item.useCases) && item.useCases.length > 0
      ? item.useCases
      : rule
        ? [...rule.useCases]
        : [...DEFAULT_USE_CASES];

  item.selectionCriteria ||= {
    problemSolving: true,
    currentRelevance: true,
    actionRequired: true,
    beginnerSafe: true,
    trendHowTo: true,
    notPureEvergreen: true
  };

  item.selectionMeta ||= {
    schema: "AOIA",
    mode: "trend",
    sourceType: "how-to trend normalization",
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
  label: "how-to-playbooks",
  mode: "trend",
  requiredConcept: "problem solution with current context",
  requiredFields: [
    "title",
    "angle",
    "audience",
    "intent",
    "problemType",
    "solutionType",
    "whyNow",
    "changeSignal",
    "riskIfIgnored",
    "futureOutlook",
    "useCases",
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
console.log("[normalize-howto-trend]");
console.log("target =", TARGET);
console.log("backup =", backup);
console.log("before =", beforeCount);
console.log("after  =", json.trend.length);
console.log("removedAutoGenerated =", removedAutoGenerated);
console.log("normalized =", normalized);
console.log("matchedRules =", matchedRules);
console.log("defaulted =", defaulted);
console.log("────────────────────────────");
