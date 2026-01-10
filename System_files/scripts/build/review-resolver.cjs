*** a/System_files/scripts/build/review-resolver.cjs
--- b/System_files/scripts/build/review-resolver.cjs
@@
 'use strict';
 
 /**
  * System_files/scripts/build/review-resolver.cjs
  * - render-posts.cjs에서 호출하는 "resolveReviewData"를 제공하는 모듈
  *
  * ✅ 정책
- * - 리뷰 SSOT(단일 소스) 우선: content/reviews/review-ratings.json
- * - 없으면 postJson.review / postJson.reviews (있을 때만) fallback
+ * - 리뷰 SSOT(단일 소스) 우선: content/reviews/review-ratings.json
+ * - SSOT 스키마(스냅샷형): ratingCurrent/votesCurrent/ratingPrevious/.../histogram/insights
+ * - 없으면 postJson.review / postJson.reviews (있을 때만) fallback
  * - 리뷰 라벨이 아니면 null 반환(리뷰 블록 미출력)
+ *
+ * ✅ insights 규칙(확정)
+ * - "총 12개 고정" (12개 미만이면 리뷰 대상 아님 → null 처리)
  */
 
 const fs = require('fs');
 const path = require('path');
 
 function readJsonSafe(p) {
@@
 function asArray(v) {
   if (!v) return [];
   return Array.isArray(v) ? v : [v];
 }
 
 function toNumberOrNull(v) {
   const n = Number(v);
   return Number.isFinite(n) ? n : null;
 }
 
-function normalizeReview(obj) {
-  if (!obj || typeof obj !== 'object') return null;
-
-  // 허용 필드(필요 최소)
-  const rating = toNumberOrNull(obj.rating ?? obj.score ?? obj.stars);
-  const scale = toNumberOrNull(obj.scale ?? obj.outOf ?? 5) ?? 5;
-
-  const summary = (obj.summary || obj.oneLine || obj.verdict || '').toString().trim();
-  const pros = asArray(obj.pros).map(String).map(s => s.trim()).filter(Boolean);
-  const cons = asArray(obj.cons).map(String).map(s => s.trim()).filter(Boolean);
-
-  // insights: 문자열 배열로만 통일
-  const insights = asArray(obj.insights).flatMap((x) => {
-    if (!x) return [];
-    if (typeof x === 'string') return [x.trim()];
-    if (typeof x === 'object') {
-      // { text } 또는 { note } 같은 흔한 형태를 흡수
-      const t = (x.text || x.note || x.value || '').toString().trim();
-      return t ? [t] : [];
-    }
-    return [];
-  }).filter(Boolean).slice(0, 12);
-
-  // sources: URL 배열 또는 {name,url} 배열이 섞여도 URL만 추출
-  const sources = asArray(obj.sources).flatMap((x) => {
-    if (!x) return [];
-    if (typeof x === 'string') return [x.trim()];
-    if (typeof x === 'object') {
-      const u = (x.url || x.href || '').toString().trim();
-      return u ? [u] : [];
-    }
-    return [];
-  }).filter(Boolean).slice(0, 20);
-
-  // rating이 아예 없고, summary/insights/pros/cons도 없으면 "없음" 취급
-  if (rating === null && !summary && pros.length === 0 && cons.length === 0 && insights.length === 0) {
-    return null;
-  }
-
-  return {
-    rating,     // number|null
-    scale,      // number (default 5)
-    summary,    // string
-    pros,       // string[]
-    cons,       // string[]
-    insights,   // string[]
-    sources,    // string[]
-  };
-}
+function normalizeInsightsStrict12(v) {
+  const insights = asArray(v)
+    .flatMap((x) => {
+      if (!x) return [];
+      if (typeof x === 'string') return [x.trim()];
+      if (typeof x === 'object') {
+        const t = (x.text || x.note || x.value || x.title || '').toString().trim();
+        return t ? [t] : [];
+      }
+      return [];
+    })
+    .map(s => String(s).trim())
+    .filter(Boolean)
+    .slice(0, 12);
+
+  // ✅ "총 12개 고정": 12개 미만이면 리뷰 무효
+  if (insights.length !== 12) return null;
+  return insights;
+}
+
+function clampHistogramPctObject(hist) {
+  if (!hist || typeof hist !== 'object') return null;
+  const out = {};
+  for (const k of ['5','4','3','2','1']) {
+    const raw = Number(hist[k] ?? hist[String(k)] ?? 0);
+    if (!Number.isFinite(raw)) continue;
+    const pct = Math.max(0, Math.min(100, raw));
+    out[String(k)] = pct;
+  }
+  return Object.keys(out).length ? out : null;
+}
+
+function isSsotSnapshotShape(obj) {
+  if (!obj || typeof obj !== 'object') return false;
+  // SSOT 스냅샷형 키
+  return (
+    Object.prototype.hasOwnProperty.call(obj, 'ratingCurrent') ||
+    Object.prototype.hasOwnProperty.call(obj, 'votesCurrent') ||
+    Object.prototype.hasOwnProperty.call(obj, 'ratingPrevious') ||
+    Object.prototype.hasOwnProperty.call(obj, 'histogram')
+  );
+}
+
+function normalizeFromSsotSnapshot(obj) {
+  if (!obj || typeof obj !== 'object') return null;
+
+  const insights = normalizeInsightsStrict12(obj.insights);
+  if (!insights) return null; // ✅ 12개 미만이면 리뷰 대상 아님
+
+  const ratingCurrent  = toNumberOrNull(obj.ratingCurrent);
+  const votesCurrent   = toNumberOrNull(obj.votesCurrent);
+  const ratingPrevious = toNumberOrNull(obj.ratingPrevious);
+  const votesPrevious  = toNumberOrNull(obj.votesPrevious);
+  const ratingDiff     = toNumberOrNull(obj.ratingDiff);
+  const votesDiff      = toNumberOrNull(obj.votesDiff);
+
+  // rating/votes 둘 다 없으면 무효
+  if (ratingCurrent === null && votesCurrent === null && ratingPrevious === null && votesPrevious === null) {
+    return null;
+  }
+
+  return {
+    // blocks가 테이블/히스토그램에 쓰기 쉬운 "스냅샷형"으로 반환
+    lastChecked: obj.lastChecked ? String(obj.lastChecked) : null,
+    status: obj.status ? String(obj.status) : 'ok',
+    store: obj.store ? String(obj.store) : 'multi',
+
+    ratingCurrent,
+    votesCurrent,
+    ratingPrevious,
+    votesPrevious,
+    ratingDiff,
+    votesDiff,
+
+    histogram: clampHistogramPctObject(obj.histogram),
+    insights, // ✅ 정확히 12개
+  };
+}
+
+function normalizeFromFallbackReview(obj) {
+  // postJson.review/reviews 쪽 "간단형"도 흡수하되,
+  // insights는 동일하게 12개 고정 규칙 적용
+  if (!obj || typeof obj !== 'object') return null;
+
+  const insights = normalizeInsightsStrict12(obj.insights);
+  if (!insights) return null; // ✅ 12개 미만이면 리뷰 무효
+
+  const ratingCurrent = toNumberOrNull(obj.rating ?? obj.score ?? obj.stars ?? obj.overall);
+  const votesCurrent  = toNumberOrNull(obj.votes ?? obj.ratingsCount ?? obj.count);
+
+  if (ratingCurrent === null && votesCurrent === null) return null;
+
+  return {
+    lastChecked: obj.lastChecked ? String(obj.lastChecked) : null,
+    status: obj.status ? String(obj.status) : 'ok',
+    store: obj.store ? String(obj.store) : 'multi',
+
+    ratingCurrent,
+    votesCurrent,
+    ratingPrevious: null,
+    votesPrevious: null,
+    ratingDiff: null,
+    votesDiff: null,
+
+    histogram: clampHistogramPctObject(obj.histogram),
+    insights, // ✅ 정확히 12개
+  };
+}
 
 function isReviewLabel(label) {
   const v = String(label || '').trim().toLowerCase();
   return v === 'app-reviews' || v === 'device-reviews' || v === 'subscription-services';
 }
 
+// SSOT 캐시(프로세스 내 1회 로드)
+let _ssotCache = null;
+let _ssotCachePath = null;
+
+function readSsotOnce(ROOT) {
+  const p = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
+  if (_ssotCache && _ssotCachePath === p) return _ssotCache;
+  _ssotCachePath = p;
+  _ssotCache = readJsonSafe(p);
+  return _ssotCache;
+}
+
 /**
  * ✅ render-posts.cjs에서 호출하는 함수
  * @param {object} ctx
  * @param {string} ctx.ROOT - System_files 절대 경로
  * @param {object} ctx.postJson - content/posts/*.json 파싱 객체
  * @returns {object|null} normalized review object
  */
 function resolveReviewData({ ROOT, postJson }) {
   try {
     if (!postJson || typeof postJson !== 'object') return null;
 
     const label = (postJson.label || postJson.mainLabel || (postJson.labels && postJson.labels[0]) || '').toString();
     if (!isReviewLabel(label)) return null;
 
     const slug = (postJson.slug || '').toString().trim();
     if (!slug) {
       // slug 없으면 fallback review만 시도
-      const fallback = normalizeReview(postJson.review || postJson.reviews || null);
-      return fallback;
+      return normalizeFromFallbackReview(postJson.review || postJson.reviews || null);
     }
 
     // 1) SSOT 파일: content/reviews/review-ratings.json
-    const ssotPath = path.join(ROOT, 'content', 'reviews', 'review-ratings.json');
-    const ssot = readJsonSafe(ssotPath);
+    const ssot = readSsotOnce(ROOT);
 
     // 기대 형태:
     //  - { bySlug: { [slug]: {...} } }  또는
     //  - { [slug]: {...} }
     let found = null;
     if (ssot && typeof ssot === 'object') {
       if (ssot.bySlug && typeof ssot.bySlug === 'object' && ssot.bySlug[slug]) found = ssot.bySlug[slug];
       else if (ssot[slug]) found = ssot[slug];
     }
 
-    const normalized = normalizeReview(found);
-    if (normalized) return normalized;
+    // ✅ SSOT 스냅샷형 우선 처리
+    if (found && isSsotSnapshotShape(found)) {
+      const normalized = normalizeFromSsotSnapshot(found);
+      if (normalized) return normalized;
+      // (insights 12개 미만 등) → 리뷰 대상 아님
+      return null;
+    }
 
     // 2) fallback: postJson에 리뷰가 직접 들어있는 경우
-    return normalizeReview(postJson.review || postJson.reviews || null);
+    return normalizeFromFallbackReview(postJson.review || postJson.reviews || null);
   } catch {
     return null;
   }
 }
 
 module.exports = { resolveReviewData };
