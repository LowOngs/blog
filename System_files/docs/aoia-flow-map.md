# AOIA Blog Operation Flow Map (v1.0)

> This is the single blueprint (SSOT) of how the blog pipeline flows.
> When something breaks, start here.

---

## Core principles (non-negotiable)

- Every loop must be driven by a SSOT file, not by directory scanning.
- Publish must never scan "all dist/posts" by default.
- If SSOT says "0 items", the correct behavior is "do nothing safely".

---

## SSOT Index

### Queue SSOT
- `System_files/dist/queue/today.json`  
  - Meaning: today’s publishable targets for the normal pipeline
- `System_files/dist/queue/firstgate.json`  
  - Meaning: today’s single first-gate target

### Content SSOT
- `System_files/content/posts/*.json`  
  - Meaning: source-of-truth for each post (slug-based)

### Review SSOT
- `System_files/content/reviews/review-ratings.json` (and related insight files if separated)  
  - Meaning: ratings/insights by slug (review labels)

### Safety/Control SSOT
- `System_files/manifests/auto-enable.json`  
  - Meaning: schedule auto-run switch (when used)
- `System_files/logs/seed-ledger.jsonl`  
  - Meaning: immutable publish/assign ledger (pageId↔seedId↔slug↔status)

---

## Loop A — Normal Publish (New Content)

### Goal
Create and publish new posts using today.json as the only publish scope.

### Flow
1) `seed-scheduler.cjs`
2) `queue-to-posts.cjs`
3) `ids.cjs`
4) `generate-body.cjs`
5) `review-resolver.cjs` (if needed)
6) `render-posts.cjs` → `normalize-body.cjs` → `review-meta-block.cjs`
7) images: renew → build og → upload → rewrite
8) render again (after rewrite)
9) `validate-repair.cjs` → `qa-check.cjs`
10) `build-feed.cjs` → `validate-feed.cjs` → tools/trust
11) `publish/blogger.cjs` (SSOT: today.json)

### Publish scope rule
- Default: publish only the slugs listed in `dist/queue/today.json`.

---

## Loop B — Firstgate Daily

### Goal
Pick exactly 1 unused first-gate seed, generate 1 post, publish at most 1.

### Flow
1) `firstgate-pick.cjs` → writes `dist/queue/firstgate.json`
2) `firstgate-queue-to-post.cjs` → writes `content/posts/*.json`
3) the same build chain as Loop A
4) publish with `MAX_POSTS=1`

### Label rule
- Do NOT force a label at the workflow level.
- Use the label that the picked seed already has.

---

## Loop C — Review Freshness (90days)

### Goal
Refresh ratings/insights for review labels and update affected posts.

### Flow
1) `review-due-90days.cjs`
2) `review-next-from-due.cjs`
3) `review-diff-update.cjs`
4) `review-resolver.cjs` (inject SSOT data into posts)
5) render → validate → QA → (optional) publish

### Important
- This loop is NOT for generating new posts.
- If SSOT review data is missing, the target should be excluded or safely skipped.

---

## Loop D — Origin / Verify / Trust (optional but recommended)

### Goal
Maintain “trust / policy / authority” pillar posts as a controlled list.

### Planned SSOT
- `System_files/content/posts/origin-verify-updates.json`

### Behavior
- A curated list of slugs and intended operations (verify, refresh, enforce schema, etc.)
- Runs at low frequency, separately from 90days freshness.

---

## Publish gates (must be enforced)

- `PUBLISH_MODE !== "enable"` → never call external APIs (hard stop)
- `DRY_RUN === true` → never call external APIs (log only)
- Default scope is SSOT-based (today.json / firstgate.json), never directory-based
- Optional safety: MAX_POSTS limit + backoff/retry policy

---

## When something breaks — where to look first

1) Identify the loop: Normal / Firstgate / 90days / Origin
2) Open the SSOT of that loop
3) Follow only the next script in that loop (no random repo scanning)

---

## Version
- v1.0 (2026-01-10 KST)
