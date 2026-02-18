# Frasier — Issue Log

Bugs, incidents, and fixes. Most recent first.

---

## ISS-011: Completed steps not announced to Discord (Notion/Drive error blocks loop)

**Date:** Feb 17, 2026 | **Severity:** High | **Status:** Fixed

**Symptom:** Step #50 completed and was auto-approved, but never posted to Discord. Steps #48 and #49 from the same project were posted successfully.

**Root Cause:** `announceCompletedSteps()` had no try/catch around individual step processing. If the Notion or Google Drive publish call for one step threw an error, the entire loop aborted — that step was never marked `announced = true`, and no subsequent steps were announced either. On the next poll, the failed step would retry and fail again (infinite loop).

**Fix:** Two layers of error handling:
1. Inner try/catch around Notion/Drive publish — if publish fails, still announce to Discord (just without links)
2. Outer try/catch around each step — if anything fails, log the error and continue to the next step

**Files:** `src/discord_bot.js`

---

## ISS-010: COMPLEX_KEYWORDS accidentally dropped during tier restructure

**Date:** Feb 17, 2026 | **Severity:** Medium | **Status:** Fixed

**Symptom:** Test failure — `'Define detailed requirements for the user dashboard'` routed to T1 instead of T2.

**Root Cause:** When editing the `COMPLEX_KEYWORDS` array to add `TIER3_KEYWORDS` below it, `'requirements'` and `'specification'` were accidentally deleted from the array.

**Fix:** Re-added `'requirements'` and `'specification'` to `COMPLEX_KEYWORDS`. Note: `'design document'` was intentionally left only in `TIER3_KEYWORDS` since T3 is checked first.

**Files:** `src/lib/models.js`

---

## ISS-009: Memory tag mismatch — founder directives not retrieved

**Date:** Feb 16, 2026 | **Severity:** High | **Status:** Fixed

**Symptom:** Founder directives saved to memory but never retrieved when agents needed them.

**Root Cause:** Save tags were `['founder-interaction', 'discord']` but retrieval queried `['founder-request', 'delegation']`. Tags must match exactly.

**Fix:** Aligned save and retrieval tags.

**Files:** `src/lib/memory.js`

---

## ISS-008: Manus T2 never worked — all tasks ran on cheapest tier

**Date:** Feb 17, 2026 | **Severity:** Critical | **Status:** Fixed (v0.4.0)

**Symptom:** All agent deliverables were shallow and generic, regardless of task complexity.

**Root Cause:** Manus was configured as T2 but never had `endpoint` or `MANUS_API_KEY` set. The `selectTier()` function had a guard: `if (!MODELS.tier2.endpoint || !process.env[MODELS.tier2.apiKeyEnv]) return 'tier1'`. This always returned false, so every task defaulted to MiniMax (T1, cheapest, lowest quality).

**Fix:** Replaced Manus with Claude Sonnet 4.5 via OpenRouter. Same API key as T1/T3. Removed all Manus-specific code. Added T3 keyword routing for high-stakes deliverables.

**Files:** `src/lib/models.js`, `src/worker.js`, `src/discord_bot.js`, `src/heartbeat.js`

---

## ISS-007: Agents produce meta-instructions instead of deliverables

**Date:** Feb 17, 2026 | **Severity:** High | **Status:** Fixed (v0.4.0)

**Symptom:** Asked agent to "research the real estate market" → got "here's what a research analyst should do" instead of actual findings.

**Root Cause:** Domain instructions in `context.js` didn't explicitly frame agents as DOERs. LLMs default to "helpful assistant" mode when not explicitly told to produce the work themselves.

**Fix:** Added "YOU ARE the expert" prefix and anti-meta suffix to all 7 domain instructions + generic fallback. Added "DOER, not ADVISOR" to universal quality standards.

**Files:** `src/lib/context.js`

---

## ISS-006: Gap-fill agents hired with no persona or domain expertise

**Date:** Feb 17, 2026 | **Severity:** High | **Status:** Fixed (v0.4.0)

**Symptom:** Auto-hired agents produced worse output than existing agents because they had no system prompt context.

**Root Cause:** `autoHireGapAgent()` created the database record but never called `generatePersona()`. The persona generation only ran for manually approved hires.

**Fix:** `autoHireGapAgent()` now accepts project context. `processProposals()` generates persona immediately after auto-hiring with industry-specific context injected.

**Files:** `src/lib/agents.js`, `src/heartbeat.js`

---

## ISS-005: QA/Team Lead reviews rubber-stamp everything

**Date:** Feb 17, 2026 | **Severity:** Medium | **Status:** Fixed (v0.4.0)

**Symptom:** Low-quality deliverables passed review because QA agents lacked domain knowledge to evaluate them.

**Root Cause:** Reviews always routed to QA → Team Lead on the same team. No domain expertise matching.

**Fix:** `processApprovals()` now searches ALL active agents for a domain expert (matching role keywords) before falling back to QA→Team Lead. Expert cannot review own work.

**Files:** `src/heartbeat.js`

---

## ISS-004: T2→T1 fallback stuck steps permanently

**Date:** Feb 17, 2026 | **Severity:** High | **Status:** Fixed (v0.3.1)

**Symptom:** When Manus (T2) failed for non-credit reasons, steps were permanently stuck in `in_progress`.

**Root Cause:** Only `MANUS_CREDITS_EXHAUSTED` triggered T1 fallback. Other Manus errors had no retry path.

**Fix:** Added generic T2→T1 fallback for all T2 failures.

**Files:** `src/worker.js`

---

## ISS-003: Announcement errors silently swallowed

**Date:** Feb 17, 2026 | **Severity:** Low | **Status:** Fixed (v0.3.1)

**Symptom:** Steps completed but never posted to Discord. No error in logs.

**Root Cause:** `announceCompletedSteps()` had a try/catch that logged nothing on Supabase query errors.

**Fix:** Added error logging to the catch block.

**Files:** `src/discord_bot.js`

---

## ISS-002: Discord message spam (same result posted 3+ times)

**Date:** Feb 14, 2026 | **Severity:** Medium | **Status:** Fixed (v0.1.0)

**Symptom:** Bot posted the same completed task multiple times to #updates.

**Root Cause:** No `announced` boolean flag. Worker marked task `completed` multiple times, bot polled and posted each time.

**Fix:** Added `announced` column to `ops_mission_steps`. Bot now queries `WHERE announced = false` and sets `announced = true` after posting.

**Files:** `discord_bot.js`, DB migration

---

## ISS-001: Supabase PostgREST schema cache bug (PGRST204)

**Date:** Feb 14, 2026 | **Severity:** Critical | **Status:** Workaround applied

**Symptom:** `PGRST204: "Could not find the 'description' column of 'ops_missions' in the schema cache"` — column exists in DB but API can't see it.

**Root Cause:** Known Supabase bug (GitHub issue #42183). PostgREST caches stale schema. Cache refresh unreliable on free tier.

**Workaround:** Removed `description` from mission INSERT. Store description only in `ops_mission_steps`.

**Prevention:** Create all tables/columns before starting application development. If adding columns later, wait 10-60 minutes for cache refresh or use direct SQL via RPC.

**Files:** `heartbeat.js`

---

## ISS-000: Missing npm install took down production for hours

**Date:** Feb 16, 2026 | **Severity:** Critical | **Status:** Fixed

**Symptom:** discord_bot and heartbeat crashed immediately after deploy. PM2 showed rapid restart loops.

**Root Cause:** Deployed with `git pull && pm2 restart all` but skipped `npm install`. New code required `nodemailer` which wasn't installed.

**Fix:** Created `deploy.sh` script that always runs `npm install` before `pm2 restart all`. Memory note added: never deploy without `npm install`.

**Files:** `deploy.sh`
