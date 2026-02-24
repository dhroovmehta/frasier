# Frasier — Issue Log

Bugs, incidents, and fixes. Most recent first.

---

## ISS-020: model_usage FK violation — agentId='system' not in agents table

**Date:** Feb 24, 2026 | **Severity:** Low | **Status:** Fixed (v0.9.4)

**Symptom:** `model_usage_agent_id_fkey` constraint failure during heartbeat's LLM title polishing. `logModelUsage()` insert rejected.

**Root Cause:** `polishTitleAndDescription()` in `linear.js` calls `callLLM` with `agentId: 'system'`. The `model_usage` table has a FK to `agents(id)`, but `'system'` doesn't exist in the agents table.

**Fix:** `logModelUsage()` now sanitizes `agentId` — converts `'system'` to `null` before insert.

**Files:** `src/lib/models.js`

---

## ISS-019: Linear custom field calls pollute logs with errors

**Date:** Feb 24, 2026 | **Severity:** Low | **Status:** Fixed (v0.9.4)

**Symptom:** Worker logs filled with `[linear] Unknown custom field: Started At`, `Completed At`, `Self-Critique Score` on every step execution.

**Root Cause:** `ensureCustomFieldsExist()` is a stub — initializes empty cache. Every `updateIssueCustomField()` call fails with "Unknown custom field" because the cache has no field IDs. Custom fields were never created in Linear.

**Fix:** Changed `console.error` to silent return. Known-unimplemented feature — no need for error logs on every invocation.

**Files:** `src/lib/linear.js`

---

## ISS-018: Linear project description exceeds 255 character limit

**Date:** Feb 24, 2026 | **Severity:** Medium | **Status:** Fixed (v0.9.4)

**Symptom:** `syncDecomposedProjectToLinear()` fails with "description must be shorter than or equal to 255 characters" from Linear API.

**Root Cause:** Description string concatenates LLM-polished description (~200 chars) + metadata suffix (end state, task count, parallel groups). Combined length regularly exceeds 255 chars. No truncation applied before API call.

**Fix:** Added `truncateForLinear()` helper — caps at 255 chars with `...` suffix. Applied to both `syncMissionToLinear()` and `syncDecomposedProjectToLinear()`.

**Files:** `src/lib/linear.js`

---

## ISS-017: Message classification built but never wired into message handler

**Date:** Feb 24, 2026 | **Severity:** Critical | **Status:** Fixed (v0.9.4)

**Symptom:** `classifyMessage()` (built in v0.9.0) never called. All Discord messages went directly to `handleFrasierMessage()`, bypassing the T1 classifier. Full projects could be misrouted as simple proposals if Frasier generated `[ACTION:PROPOSAL]` instead of `[ACTION:NEW_PROJECT]`.

**Root Cause:** `classifyMessage()` was implemented at lines 132-192 of discord_bot.js but the message handler at line 102 called `handleFrasierMessage()` directly without invoking it. The function was orphaned — built but never connected.

**Fix:** Three changes: (1) Message handler now calls `classifyMessage()` before `handleFrasierMessage()`. (2) New `resolveActionTag()` function overrides Frasier's ACTION tag when T1 says `full_project` with confidence ≥ 0.7. (3) Classification hint injected into Frasier's prompt for full_project messages.

**Decision:** D-038

**Files:** `src/discord_bot.js`

---

## ISS-016: Completion notification pipeline broken — race condition + missing events

**Date:** Feb 24, 2026 | **Severity:** Critical | **Status:** Fixed (v0.9.3)

**Symptoms:** Projects marked completed in Supabase but Dhroov never notified via Discord. Linear tickets stuck in Backlog despite missions being done.

**Root Cause:** 5 interconnected gaps:
1. **Race condition:** Worker calls `checkMissionCompletion()` → `completeMission()` sets mission to `completed`. Heartbeat's `checkMissions()` queries `getActiveMissions()` (filters for `in_progress`), so it never sees the completed mission — event logging, project phase advancement, and next-mission creation all skip.
2. **announceAlerts() deaf to completion events:** Only listened for `worker_error`, `tier3_escalation_needed`, `revision_cap_reached`, `agent_upskilled`. The `mission_completed` and `project_phase_advanced` events logged by heartbeat were never consumed.
3. **Dead code in heartbeat:** Gap #1 made the entire post-completion chain (event logging, project phase check, next-mission creation) unreachable for worker-completed missions.
4. **advanceProjectPhase() silent:** Logged to console but created no events — even if phase advancement worked, Discord couldn't announce it.
5. **No project_completed event:** The concept didn't exist in the codebase.

**Fix:** Moved post-completion logic INTO source functions: `completeMission()` logs events + checks project phases, `advanceProjectPhase()` logs phase/completion events, `announceAlerts()` handles new event types. Heartbeat simplified to safety net.

**Decision:** D-037

---

## ISS-015: Decomposition engine never called from runtime (built but not wired)

**Date:** Feb 24, 2026 | **Severity:** High | **Status:** Fixed (v0.9.2)

**Symptom:** `decomposeProject()` was fully built and tested (v0.9.0) but the `[ACTION:NEW_PROJECT]` handler in discord_bot.js still created a simple proposal → heartbeat picks up → one step per phase → sequential execution. No DAG, no parallel tasks, no Linear project sync for new projects.

**Root Cause:** Scope management during v0.9.0 build. The decomposition engine was built bottom-up (engine → tests → helpers), but the top-level wiring (discord_bot calls decomposition) was never connected. The build moved on to skill encoding and Linear sync before completing the integration.

**Fix:** Added `handleNewProjectDecomposition()` to `decomposition.js` — creates mission directly, links to project, calls `decomposeProject()`. Wired into `[ACTION:NEW_PROJECT]` handler in discord_bot.js with fallback to proposal on failure. Also made `syncMissionToLinear` idempotent to prevent double Linear projects (D-036).

**Files:** `src/lib/decomposition.js`, `src/discord_bot.js`, `src/lib/linear.js`

---

## ISS-014: Infinite review loop — Mission #75 stuck in reject/revise cycle

**Date:** Feb 24, 2026 | **Severity:** High | **Status:** Fixed (v0.9.1)

**Symptom:** Mission #75 entered an infinite loop: Sahaquiel produced work → Toji rejected → Sahaquiel revised → Toji rejected again → repeat. Scores hovered at 3.8–4.25 (decent but never passing Toji's threshold). No cap existed to break the cycle.

**Root Cause:** `processNextReview()` in `worker.js` always called `sendBackForRevision()` on rejection, with no limit on how many times a step could be rejected. The rejection/revision loop had no exit condition.

**Fix:** 3-strike revision cap (D-035). `countStepRejections()` queries `approval_chain` for past rejections. On the 3rd rejection, `failStep()` is called instead of `sendBackForRevision()`, a `revision_cap_reached` event is logged, and the founder is alerted via Discord.

**Files:** `src/worker.js`, `src/lib/missions.js`, `src/discord_bot.js`

---

## ISS-013: Linear tickets stuck in Backlog — worker never initializes cache

**Date:** Feb 24, 2026 | **Severity:** Critical | **Status:** Fixed (v0.9.1)

**Symptom:** All Linear tickets created by `syncDecomposedProjectToLinear()` stayed in "Backlog" status. `updateIssueStatus()` and `updateIssueCustomField()` calls silently failed because the workflow state/label cache was empty.

**Root Cause:** `linear.initialize()` is only called in `heartbeat.js`. The `worker.js` process (separate PM2 process) never calls it, so the module-level cache (`workflowStates`, `labels`) is always empty. Every status update silently returned early with "workflow state not found".

**Fix:** Lazy initialization pattern (D-034). Added `ensureInitialized()` with a boolean flag, called at the top of `syncStepToLinear()`, `updateIssueStatus()`, `updateIssueCustomField()`, `addIssueComment()`, and `syncDecomposedProjectToLinear()`. First call from any process auto-populates the cache; subsequent calls are no-ops.

**Files:** `src/lib/linear.js`

---

## ISS-012: OpenRouter rejects date-suffixed model IDs (T2/T3 always fall back to T1)

**Date:** Feb 17, 2026 | **Severity:** Critical | **Status:** Fixed

**Symptom:** Worker logs: `[models] Tier 2 (claude-sonnet-4.5) failed: API 400: anthropic/claude-sonnet-4-5-20250929 is not a valid model ID`. All T2/T3 tasks silently degraded to T1 MiniMax, producing shallow output.

**Root Cause:** Model IDs used OpenRouter's date-suffixed format (`anthropic/claude-sonnet-4-5-20250929`, `anthropic/claude-opus-4-20250514`) which is not accepted by OpenRouter. OpenRouter uses short-form IDs.

**Fix:** Changed to short-form IDs: `anthropic/claude-sonnet-4.5` (T2), `anthropic/claude-opus-4` (T3).

**Files:** `src/lib/models.js`, `docs/CHANGELOG.md`, `docs/COMPLETED.md`, `docs/PRD.md`

---

## ISS-011: Completed steps not announced to Discord (Notion/Drive error blocks loop)

**Date:** Feb 17, 2026 | **Severity:** High | **Status:** Fixed

**Symptom:** Step #50 completed and was auto-approved, but never posted to Discord. Steps #48 and #49 from the same project were posted successfully.

**Root Cause:** Two compounding issues:
1. `announceCompletedSteps()` had no try/catch — one Notion/Drive error aborted the entire loop
2. `announced = true` was set AFTER publishing — so when Supabase returned Cloudflare 500 errors after Notion/Drive succeeded, the flag never persisted. Next poll cycle, the step was re-published (duplicate Notion pages + Google Docs every 30 seconds).

**Fix:** Three changes:
1. Mark `announced = true` BEFORE publishing — prevents infinite duplicate Notion pages/Google Docs
2. Inner try/catch around Notion/Drive publish — if publish fails, still announce to Discord (without links)
3. Outer try/catch around each step — if anything fails, log and continue to next step

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
