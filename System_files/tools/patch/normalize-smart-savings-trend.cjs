#!/usr/bin/env node
/**
 * ============================================================================
 * AOIA
 * File : System_files/tools/patch/normalize-smart-savings-trend.cjs
 * Role : Normalize Trend Smart Savings Seed Structure
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
  "smart-savings-trend.json"
);

const DEFAULT_USE_CASES = [
  "compare current cost options",
  "avoid new spending traps",
  "choose a lower-cost setup"
];

const RULES = [
  {
    match: ["ai writing", "ai tools", "chatgpt", "gemini", "claude"],
    trendDriver: "technology-shift",
    costChange: "AI tools created overlapping paid features across writing, research, and productivity apps.",
    savingStrategy: "consolidate overlapping AI subscriptions and keep only the tools that cover repeated work.",
    savingPotential: "medium-to-high",
    riskIfIgnored: "Users may keep paying for multiple AI tools that solve the same task.",
    useCases: ["AI subscription audit", "tool consolidation", "paid plan decision"]
  },
  {
    match: ["bundle", "bundles", "cloud + ai", "cloud + vpn", "security bundles"],
    trendDriver: "bundle-shift",
    costChange: "More platforms now sell bundled services that may replace separate subscriptions.",
    savingStrategy: "compare bundle coverage against the total cost of separate tools before switching.",
    savingPotential: "medium",
    riskIfIgnored: "A bundle can either reduce overlap or create a larger recurring bill.",
    useCases: ["bundle comparison", "family plan review", "subscription consolidation"]
  },
  {
    match: ["cloud gaming", "gaming"],
    trendDriver: "market-shift",
    costChange: "Gaming access is moving between hardware, cloud access, rotation libraries, and subscription plans.",
    savingStrategy: "compare hardware cost, monthly access cost, and actual play frequency.",
    savingPotential: "medium",
    riskIfIgnored: "Users may pay monthly for games they rarely play or buy hardware they no longer need.",
    useCases: ["cloud gaming comparison", "monthly gaming budget", "hardware replacement decision"]
  },
  {
    match: ["credit card", "rewards", "banking", "international fees"],
    trendDriver: "policy-change",
    costChange: "Payment fees, rewards, and cross-border app usage are becoming more important in digital spending.",
    savingStrategy: "match payment methods to recurring digital purchases and travel use.",
    savingPotential: "medium",
    riskIfIgnored: "Small fees and missed rewards can quietly reduce the value of frequent digital purchases.",
    useCases: ["digital purchase rewards", "travel payment setup", "fee avoidance"]
  },
  {
    match: ["travel", "esim", "roaming", "region-specific"],
    trendDriver: "consumer-shift",
    costChange: "Travel apps, eSIMs, regional pricing, and hidden fees changed how travelers spend.",
    savingStrategy: "compare regional fees, data limits, and app charges before travel.",
    savingPotential: "medium-to-high",
    riskIfIgnored: "Travelers may pay avoidable roaming, booking, or platform fees.",
    useCases: ["travel app fee check", "eSIM plan selection", "regional discount planning"]
  },
  {
    match: ["subscription software", "saas", "productivity software", "notion", "evernote", "todoist", "obsidian"],
    trendDriver: "price-change",
    costChange: "Software plans and SaaS subscriptions keep changing prices, limits, and feature tiers.",
    savingStrategy: "review current plan limits, downgrade options, and cheaper replacement stacks.",
    savingPotential: "medium-to-high",
    riskIfIgnored: "Old plans may become overpriced compared with newer alternatives.",
    useCases: ["SaaS price review", "productivity stack cleanup", "plan downgrade decision"]
  },
  {
    match: ["password manager"],
    trendDriver: "price-change",
    costChange: "Password manager plans increasingly differ by device support, family sharing, and region pricing.",
    savingStrategy: "compare free, family, and cross-device plans against real household needs.",
    savingPotential: "low-to-medium",
    riskIfIgnored: "Users may overpay for security features they do not use or choose a plan that lacks needed coverage.",
    useCases: ["family security plan", "cross-device password setup", "free plan comparison"]
  },
  {
    match: ["data usage", "data overage", "mobile data"],
    trendDriver: "usage-shift",
    costChange: "Apps, video, cloud sync, and AI features can increase mobile data use silently.",
    savingStrategy: "reduce background data, monitor high-use apps, and match the plan to actual usage.",
    savingPotential: "medium",
    riskIfIgnored: "Users may face data overage charges or upgrade plans unnecessarily.",
    useCases: ["mobile data audit", "overage prevention", "low-data setup"]
  },
  {
    match: ["smart home", "electricity", "energy"],
    trendDriver: "technology-shift",
    costChange: "Smart devices and automation can either reduce energy use or add new subscription costs.",
    savingStrategy: "use automation only where it reduces repeat energy waste or replaces manual routines.",
    savingPotential: "medium",
    riskIfIgnored: "Users may buy devices that add cost without reducing the utility bill.",
    useCases: ["home energy automation", "smart device value check", "electricity cost review"]
  },
  {
    match: ["grocery", "food"],
    trendDriver: "price-pressure",
    costChange: "Food and grocery prices make app-based planning and price comparison more valuable.",
    savingStrategy: "use grocery apps to compare repeat purchases, reduce waste, and avoid impulse orders.",
    savingPotential: "medium",
    riskIfIgnored: "Small weekly food overspending can become a large monthly leak.",
    useCases: ["grocery app planning", "food budget control", "waste reduction"]
  },
  {
    match: ["storage", "ssd", "sd card", "cloud mix", "local storage"],
    trendDriver: "market-shift",
    costChange: "Storage costs change across SSDs, phones, laptops, and cloud plans.",
    savingStrategy: "compare local upgrade cost against monthly cloud storage before buying more capacity.",
    savingPotential: "medium",
    riskIfIgnored: "Users may keep paying for cloud storage when a one-time upgrade is cheaper, or buy hardware too early.",
    useCases: ["storage upgrade decision", "cloud vs local comparison", "device capacity planning"]
  },
  {
    match: ["app features", "upgrade traps", "premium apps", "app upgrade"],
    trendDriver: "policy-change",
    costChange: "Apps increasingly move small features behind premium tiers or upsell flows.",
    savingStrategy: "identify the exact feature needed before upgrading or renewing.",
    savingPotential: "low-to-medium",
    riskIfIgnored: "Users may pay extra for features they rarely use.",
    useCases: ["premium feature check", "upgrade decision", "unused feature audit"]
  },
  {
    match: ["note-taking", "cross-device note"],
    trendDriver: "market-shift",
    costChange: "Note apps now overlap across sync, AI, collaboration, and storage features.",
    savingStrategy: "combine free and paid tools only where the workflow clearly needs them.",
    savingPotential: "low-to-medium",
    riskIfIgnored: "Students and creators may pay for multiple note apps that duplicate each other.",
    useCases: ["note app stack review", "student tool budget", "cross-device workflow"]
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
    id.startsWith("smart-savings-trend-");

  if (isAuto) {
    removedAutoGenerated++;
    return false;
  }

  return true;
});

for (const item of json.trend) {
  const rule = findRule(item);

  item.intent ||= "savings/trend";

  item.trendMode ||= "cost-change-response";

  item.entity ||= {
    type: "cost-category",
    name: String(item.title || "smart savings topic")
      .replace(/^How to\s+/i, "")
      .replace(/^Which\s+/i, "")
      .replace(/^2025 Guide:\s*/i, "")
      .replace(/^2025\s+/i, "")
      .trim(),
    intentFamily: "trend-saving"
  };

  item.trendDriver = rule
    ? rule.trendDriver
    : "market-shift";

  item.costChange = rule
    ? rule.costChange
    : "A recent market, technology, pricing, or consumer behavior change may affect everyday spending.";

  item.savingStrategy = rule
    ? rule.savingStrategy
    : "Compare the new cost structure against the current setup before adding or renewing paid options.";

  item.savingPotential = rule
    ? rule.savingPotential
    : "medium";

  item.riskIfIgnored = rule
    ? rule.riskIfIgnored
    : "Users may keep paying under an outdated cost structure or miss a cheaper practical option.";

  item.decisionFrame ||= {
    primaryQuestion: "Does this new cost change require a different spending choice?",
    compareBy: ["current cost", "replacement cost", "usage frequency", "practical value"],
    avoid: ["duplicate payments", "unused upgrades", "hidden recurring costs"]
  };

  item.useCases =
    Array.isArray(item.useCases) && item.useCases.length > 0
      ? item.useCases
      : rule
        ? [...rule.useCases]
        : [...DEFAULT_USE_CASES];

  item.selectionCriteria ||= {
    costChangeRelevant: true,
    trendDependent: true,
    savingDecision: true,
    practicalComparison: true,
    notPureEvergreen: true,
    smartSavingsTrend: true
  };

  item.selectionMeta ||= {
    schema: "AOIA",
    mode: "trend",
    sourceType: "smart-savings trend normalization",
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
  label: "smart-savings",
  mode: "trend",
  requiredConcept: "cost change response",
  requiredFields: [
    "title",
    "angle",
    "audience",
    "intent",
    "entity",
    "trendMode",
    "trendDriver",
    "costChange",
    "savingStrategy",
    "savingPotential",
    "riskIfIgnored",
    "decisionFrame",
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
console.log("[normalize-smart-savings-trend]");
console.log("target =", TARGET);
console.log("backup =", backup);
console.log("before =", beforeCount);
console.log("after  =", json.trend.length);
console.log("removedAutoGenerated =", removedAutoGenerated);
console.log("normalized =", normalized);
console.log("matchedRules =", matchedRules);
console.log("defaulted =", defaulted);
console.log("────────────────────────────");
