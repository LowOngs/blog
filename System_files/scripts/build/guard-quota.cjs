// System_files/scripts/build/guard-quota.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const LOGS_DIR = path.join(ROOT, 'logs');
const GUARD_LOG = path.join(LOGS_DIR, 'publish-guard.json');
const SKIP_FLAG = path.join(process.cwd(), 'skip-publish'); // repo 루트 기준

// 정책
const TIME_ZONE = process.env.TIME_ZONE || 'America/Los_Angeles';
const DAILY_TOTAL_LIMIT = Number(process.env.DAILY_TOTAL_LIMIT || 4);
const DAILY_PER_LABEL_LIMIT = Number(process.env.DAILY_PER_LABEL_LIMIT || 1);
const MAIN_LABEL_FIELD = 'label'; // 각 JSON에 main 라벨 저장 필드 (예: app-reviews 등)

function todayKey(tz=TIME_ZONE){
  // 간단 TZ 보정: LA=UTC-8/UTC-7 근사. 정확 TZ는 상수로 일자키만 필요 → UTC-8로 고정.
  const now = new Date();
  const ms = now.getTime() - (8 * 3600 * 1000);
  const d = new Date(ms);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

function readJSON(p, fallback){ try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJSON(p, obj){ fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// 1) 대상 포스트 스캔
if (!fs.existsSync(POSTS_DIR)) {
  console.log(`ℹ️ no posts dir: ${POSTS_DIR}`);
  process.exit(0);
}
const files = fs.readdirSync(POSTS_DIR).filter(f => /\.json$/i.test(f));
if (!files.length) process.exit(0);

// 2) 로그 로드
const log = readJSON(GUARD_LOG, { days:{} });
const key = todayKey();
log.days[key] = log.days[key] || { total:0, byLabel:{}, slugs:[] };

// 3) 후보 읽어 규칙 체크(선발행 상태 가정: 렌더 전이므로 JSON 기준)
let willPublish = [];
for (const f of files) {
  const abs = path.join(POSTS_DIR, f);
  const j = readJSON(abs, null); if (!j) continue;

  const slug = (j.slug || path.basename(f, path.extname(f))).toLowerCase();
  const label = String(j[MAIN_LABEL_FIELD] || j.mainLabel || j.labelMain || '').trim();
  if (!label) {
    console.log(`⚠️ ${f}: main label 미설정 → 스킵`);
    continue;
  }
  // 중복(slug) 차단
  if (log.days[key].slugs.includes(slug)) {
    console.log(`⛔ 중복 slug(today): ${slug} → 스킵`);
    continue;
  }
  // 카테고리 일일 상한
  const usedLabel = log.days[key].byLabel[label] || 0;
  if (usedLabel >= DAILY_PER_LABEL_LIMIT) {
    console.log(`⛔ 라벨 일일 상한 초과: ${label} (limit=${DAILY_PER_LABEL_LIMIT})`);
    continue;
  }
  // 총량 상한(임계 체크는 누적 계산으로 아래서)
  willPublish.push({ slug, label });
}

// 총량 상한 적용
const remaining = Math.max(0, DAILY_TOTAL_LIMIT - (log.days[key].total || 0));
if (willPublish.length > remaining) {
  willPublish = willPublish.slice(0, remaining);
  console.log(`ℹ️ 총량 제한으로 ${remaining}건만 허용`);
}

if (!willPublish.length) {
  fs.writeFileSync(SKIP_FLAG, '1'); // 이후 단계 스킵 신호
  console.log('🛑 오늘 발행 가능 슬롯 없음 → skip-publish 생성');
  process.exit(0);
}

// 4) 로그 예약 반영(멱등성: 중복 방지)
for (const it of willPublish) {
  log.days[key].total += 1;
  log.days[key].byLabel[it.label] = (log.days[key].byLabel[it.label] || 0) + 1;
  log.days[key].slugs.push(it.slug);
}
writeJSON(GUARD_LOG, log);

console.log(`✅ 오늘 예약: ${willPublish.length}건`);
process.exit(0);
