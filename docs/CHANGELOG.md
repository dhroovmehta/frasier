# Frasier — Changelog

All notable changes to this project are documented here.

---

## [0.9.6] — 2026-02-24 (Discord Attachment Support)

### Added
- **Discord file attachment processing** — Bot now downloads text-based file attachments (.md, .txt, .json, .csv, .log, .yaml, .yml, .xml, .toml, .ini) from Discord messages and includes their content in the pipeline. Drop a roadmap into Discord and Frasier reads it.
- **`fetchAttachments()` in `web.js`** — Filters by file extension (primary) or content type (secondary), enforces 100KB pre-download and 50K char post-download limits, caps at 3 attachments per message. Skips binary files.
- **Attachment-only messages now work** — Previously, messages with no typed text were silently dropped. Now, text-based attachments are downloaded and used as the message body.
- **TDD Tests:** 14 new tests in `tests/v09/attachments.test.js` — 11 unit tests for `fetchAttachments()`, 3 integration tests for message handler.

### Fixed
- **ISS-025: Attachment-only Discord messages silently dropped** — Line 89-90 of discord_bot.js checked `message.content` before processing attachments. Empty text = early return, even when files were attached.

### Modified
- **`src/discord_bot.js`:** Message handler now calls `web.fetchAttachments()` before the empty-content guard. Combined text+attachment content flows through classify → Frasier → decompose unchanged.
- **`src/lib/web.js`:** Added `fetchAttachments()` function and exported it.
- **`tests/helpers.js`:** Added `makeAttachment()` and `makeAttachmentCollection()` factory functions.

### Notes
- All 462 tests pass (448 existing + 14 new, zero regressions).
- 33 test suites.
- Decision: D-040. Issue: ISS-025.
- Zero new dependencies.

---

## [0.9.5] — 2026-02-24 (MemoBot Integration Fixes)

### Fixed
- **ISS-021: Steps created with null fields — "mission #undefined" in logs** — `createStepsFromPlan()` in `decomposition.js` passed snake_case params (`mission_id`, `assigned_agent_id`, `model_tier`, `step_order`) to `createStep()`, which destructures camelCase (`missionId`, `assignedAgentId`, `modelTier`, `stepOrder`). JS destructuring silently returned `undefined` for all mismatched keys. Fixed by converting to camelCase.
- **ISS-022: Linear cache `initialized=true` set before cache populated** — `ensureInitialized()` set `initialized=true` unconditionally after calling `ensureWorkflowStatesExist()` + `ensureLabelsExist()`. When those HTTP calls failed (Supabase 500, network error), the cache stayed empty but `initialized` was already `true`, so subsequent calls skipped init entirely. Now validates that `cache.workflowStates` has entries before setting the flag.
- **ISS-023: model_usage FK violation on agentId='frasier'** — ISS-020 sanitized `agentId='system'` but missed `'frasier'` (passed from `classifyMessage()` in discord_bot.js). Broadened sanitization: `logModelUsage()` now rejects any agentId that doesn't start with `'agent-'`. Also fixed the caller in `discord_bot.js` to pass `null` instead of `'frasier'`.
- **ISS-024: approach_memory FK violation on missionStepId=0** — `decomposeProject()` saved approach memory with `missionStepId: 0`. Step #0 doesn't exist in `mission_steps` → FK constraint violation. Changed to `null` (decomposition-level memory isn't tied to a specific step).

### Added
- **TDD Tests:** 9 new tests in `tests/v09/bugfixes-v095.test.js` — 3 for camelCase params (Bug 1), 2 for Linear cache validation (Bug 2), 3 for agentId sanitization (Bug 3), 1 for approach_memory FK (Bug 4).

### Modified
- **`src/lib/decomposition.js`:** `createStepsFromPlan()` passes camelCase params to `createStep()`. `decomposeProject()` saves approach memory with `missionStepId: null`.
- **`src/lib/linear.js`:** `ensureInitialized()` validates cache has workflow states before setting `initialized=true`.
- **`src/lib/models.js`:** `logModelUsage()` sanitizes agentId via `startsWith('agent-')` check (replaces per-value `'system'` blocklist from v0.9.4).
- **`src/discord_bot.js`:** `classifyMessage()` passes `agentId: null` instead of `'frasier'`.
- **`tests/v09/decomposition.test.js`:** Updated 2 pre-existing tests to use camelCase param names (`stepOrder`, `assignedAgentId`).

### Notes
- All 448 tests pass (439 existing + 9 new, zero regressions).
- 32 test suites.
- Decision: D-039.

---

## [0.9.4] — 2026-02-24 (Integration Bug Fixes)

### Fixed
- **ISS-017: Message classification never wired in** — `classifyMessage()` (built in v0.9.0) was never called from the message handler. All messages bypassed the T1 classifier and relied solely on Frasier's ACTION tags. Now wired into the handler with a `resolveActionTag()` override that forces `[ACTION:NEW_PROJECT]` when the T1 classifier says `full_project` with confidence ≥ 0.7.
- **ISS-018: Linear project description > 255 chars** — `syncDecomposedProjectToLinear()` concatenated polished description + metadata, often exceeding Linear's 255-character limit. Added `truncateForLinear()` helper applied to both `syncMissionToLinear()` and `syncDecomposedProjectToLinear()`.
- **ISS-019: Linear custom field log noise** — `updateIssueCustomField()` logged `console.error` for every call because custom fields were never created in Linear. Changed to silent return (known-unimplemented feature).
- **ISS-020: model_usage FK violation on agentId='system'** — `polishTitleAndDescription()` called `callLLM` with `agentId: 'system'`, which doesn't exist in the `agents` table. `logModelUsage()` now sanitizes `agentId` to `null` for non-agent callers.

### Added
- **`resolveActionTag()` in `discord_bot.js`:** Pure function that resolves the effective action from Frasier's response + T1 classification. Overrides Frasier's tag when the classifier disagrees on `full_project` (confidence ≥ 0.7), but respects `[ACTION:RESPONSE]` to avoid forcing work on casual messages.
- **`truncateForLinear()` in `linear.js`:** Caps strings at 255 chars with `...` suffix for Linear API compliance.
- **Classification context injection:** When T1 says `full_project`, Frasier's prompt now includes a hint to use `[ACTION:NEW_PROJECT]`, reducing misclassification.
- **TDD Tests:** 23 new tests in `tests/v09/bugfixes-v094.test.js` — 11 for resolveActionTag, 3 for classifyMessage export, 4 for truncation, 5 for agent ID sanitization.

### Modified
- **`src/discord_bot.js`:** Message handler now calls `classifyMessage()` before `handleFrasierMessage()`. Action tag parsing replaced with `resolveActionTag()`. Frasier instructions include classification hint for full_project.
- **`src/lib/linear.js`:** Added `truncateForLinear()`. Applied to both sync functions. Custom field error log silenced.
- **`src/lib/models.js`:** `logModelUsage()` sanitizes `agentId` — converts `'system'` to `null` before insert.

### Notes
- All 439 tests pass (416 existing + 23 new, zero regressions).
- 31 test suites.

---

## [0.9.3] — 2026-02-24 (Completion Notification Pipeline)

### Fixed
- **ISS-016: Race condition in mission completion** — The worker completed missions before the heartbeat could detect them, causing event logging, project phase advancement, and Discord notifications to never fire. Moved all post-completion logic into `completeMission()` and `advanceProjectPhase()` so it triggers regardless of who calls it.
- **5 gaps in notification pipeline:** (1) Race condition between worker and heartbeat, (2) `announceAlerts()` didn't listen for mission/project events, (3) Heartbeat's project phase chain was dead code, (4) `advanceProjectPhase()` logged no events, (5) No `project_completed` event existed.

### Added
- **`completeMission()` enriched:** Now logs `mission_completed` event, checks for project link, and triggers `checkPhaseCompletion()`. Idempotent — skips if already completed.
- **`failMission()` enriched:** Now logs `mission_failed` event with reason.
- **`advanceProjectPhase()` enriched:** Now logs `project_phase_advanced` or `project_completed` events.
- **Discord notifications:** `announceAlerts()` now handles `project_phase_advanced` and `project_completed` events.
- **TDD Tests:** 10 new tests — 6 in `completion-pipeline.test.js` + 4 in `phase-advancement.test.js`.

### Modified
- **`src/lib/missions.js`:** Added `events` and `projects` imports. `completeMission()` and `failMission()` now log events and trigger project phase checks.
- **`src/lib/projects.js`:** Added `events` import. `advanceProjectPhase()` now logs phase transition events.
- **`src/discord_bot.js`:** `announceAlerts()` handles `project_phase_advanced` and `project_completed` events.
- **`src/heartbeat.js`:** `checkMissions()` simplified to safety-net only — event logging and phase checks moved to source functions. `checkStalledProjects()` handles next-phase mission creation.

### Data Flow Change
**Before (v0.9.2):** Worker completes mission → nobody notified, project stuck in current phase.
**After (v0.9.3):** Worker completes mission → event logged → project phase checked → Discord notified → `checkStalledProjects()` creates next-phase mission.

### Notes
- All 416 tests pass (406 existing + 10 new, zero regressions).
- 30-second delay between phase advancement and next-phase mission creation (via `checkStalledProjects()` on next heartbeat tick) — acceptable trade-off for architectural simplicity.

---

## [0.9.2] — 2026-02-24 (Decomposition Wiring)

### Added
- **`handleNewProjectDecomposition()` in `decomposition.js`:** Orchestrates the full decomposition flow for new projects — creates mission directly, links to project, decomposes into DAG, returns result for Discord response. Called from `[ACTION:NEW_PROJECT]` handler.
- **Decomposition wiring in `discord_bot.js`:** The `[ACTION:NEW_PROJECT]` handler now calls `handleNewProjectDecomposition()` instead of creating a simple proposal. Projects are intelligently decomposed into parallel/sequential task DAGs with full Linear sync.
- **Fallback to proposal:** If decomposition fails (LLM error, validation failure), the handler falls back to creating a discovery-phase proposal (old behavior). Project creation is never blocked by decomposition failure.
- **`syncMissionToLinear` idempotency:** Checks `linear_sync` for existing records before creating a Linear project. Prevents duplicate projects when both `createMission()` and `decomposeProject()` call `syncMissionToLinear`.
- **TDD Tests:** 12 new tests — 11 in `tests/v09/decomposition-wiring.test.js` + 1 idempotency test in `tests/linear/linear.test.js`.

### Modified
- **`src/lib/decomposition.js`:** Added `handleNewProjectDecomposition()` export, added `projects` import.
- **`src/discord_bot.js`:** `[ACTION:NEW_PROJECT]` handler rewired from proposal → decomposition. Added `decomposition` import. Discord messages now show task count and parallel groups.
- **`src/lib/linear.js`:** `syncMissionToLinear()` checks for existing sync record before creating Linear project (idempotent).

### Data Flow Change
**Before (v0.9.1):**
```
Discord → classifyMessage → full_project → Frasier response → createProposal
→ [wait for heartbeat] → acceptProposal → createMission → 1 step → worker
```

**After (v0.9.2):**
```
Discord → classifyMessage → full_project → Frasier response → createMission
→ linkMissionToProject → decomposeProject → N steps with DAG → worker
→ Linear project + issues + dependency relations (all immediate)
```

### Cost Impact
- One additional T2 (Sonnet) LLM call per new project for decomposition (~$0.03)
- Linear API calls: 1 project + N issues + dependency relations per project

### Notes
- All 406 tests pass (394 existing + 12 new, zero regressions).
- No SQL migration needed — uses existing tables.
- Decision: D-036.

---

## [0.9.1] — 2026-02-24 (Linear Status Sync + Revision Cap)

### Fixed
- **Linear cache empty in Worker:** Worker process never called `linear.initialize()`, so every `updateIssueStatus()` from worker failed with "Unknown workflow state." Added `ensureInitialized()` lazy init that auto-populates the Linear cache on first use from any process. Called at top of `updateIssueStatus()`, `syncStepToLinear()`, `updateIssueCustomField()`, `addIssueComment()`, `syncDecomposedProjectToLinear()`.
- **Infinite review loop (Mission #75 bug):** No revision cap existed — QA could reject indefinitely, creating loops. Added 3-strike cap: after 3 rejections, step is failed and founder is alerted via Discord with Linear ticket links. Each rejection posted as a comment on the Linear ticket.
- **Linear issues stuck in Backlog:** All status updates (In Progress, In Review, Done, Canceled) now work because worker auto-initializes the Linear cache.
- **Failed steps not synced to Linear:** `failStep()` now syncs "Canceled" status to the Linear issue (fire-and-forget).

### Added
- **Dependency linking in Linear (`createDependencyRelations()`):** After syncing a decomposed project, Linear issues are linked with blocking/blocked-by relations matching the DAG dependencies. Called automatically at end of `syncDecomposedProjectToLinear()`.
- **Revision cap alert handler (`discord_bot.js`):** `announceAlerts()` now processes `revision_cap_reached` events — posts to #alerts with the step description and Linear ticket URL.
- **`countStepRejections()` in `missions.js`:** Counts past rejections for a step from `approval_chain`. Used by worker for the 3-strike cap check.
- **TDD Tests:** 10 new tests in `tests/linear/linear-status-sync.test.js`.

### Modified
- **`src/lib/linear.js`:** Lazy init (`ensureInitialized()`), dependency relations (`createDependencyRelations()`), `__setCache()` sets initialized flag, new exports.
- **`src/worker.js`:** 3-strike revision cap in `processNextReview()` rejection block. Each rejection posted as Linear comment. Cap reached → `failStep()` + event log.
- **`src/discord_bot.js`:** `announceAlerts()` handles `revision_cap_reached` events with Linear URL lookup.
- **`src/lib/missions.js`:** `failStep()` syncs Canceled to Linear. New `countStepRejections()` export.

### Cost Impact
- Zero additional LLM cost (all changes are API calls + DB queries)
- Linear API calls: ~1-2 per rejection (comment + status), ~N per decomposed project (dependency relations)

### Notes
- All 394 tests pass (384 existing + 10 new, zero regressions).
- No SQL migration needed — uses existing tables (`approval_chain`, `linear_sync`, `step_dependencies`, `events`).
- Decisions: D-034, D-035.

---

## [0.9.0] — 2026-02-23 (Autonomous Team Execution)

### Added
- **Task Decomposition Engine (`src/lib/decomposition.js`):** Frasier breaks full-project directives into parallel/sequential task DAGs via T2 LLM call. Validates dependency graph (Kahn's algorithm cycle detection), creates mission steps with proper dependencies, triggers proactive hiring for missing roles, and escalates to founder only when genuinely needed. Approach memory from prior decompositions injected as hints.
- **Message Classification (`src/discord_bot.js`):** Dedicated T1 LLM call classifies every Discord message as `casual`, `simple_task`, or `full_project` before routing. Replaces brittle action-tag parsing (`[ACTION:PROPOSAL]`, `[ACTION:NEW_PROJECT]`). Defaults to `simple_task` at confidence < 0.7. Persisted to `message_classifications` table.
- **DAG-Based Step Execution (`src/lib/missions.js`, `src/worker.js`):** Steps now track dependencies via `step_dependencies` table instead of rigid `step_order` chains. `areAllDependenciesMet()` returns tri-state (true/false/null) for DAG vs legacy fallback. Worker claims up to 3 eligible steps per tick, executes sequentially (1GB RAM safe). Predecessor outputs from all dependencies injected as context.
- **Research Depth & Citation Enforcement (`src/lib/pipeline.js`):** Research phase requires 3+ substantive sources (retries with refined queries, max 2 retries). Structured source list passed to synthesis. `validateSourceCitations()` computes citation_score via string matching (zero LLM cost). Every role's output template includes citation requirement.
- **Calibrated Self-Critique (`src/lib/pipeline.js`):** Replaced generic 1-5 rating with rubric-based 4-dimension scoring (depth, accuracy, actionability, completeness) with concrete anchors. Calibration: "3.0 is GOOD, 5.0 is rare." Revision triggers when ANY dimension < 3.0 or average < 3.5. Max 2 revision attempts (up from 1).
- **Hybrid Skill Encoding (`src/lib/skill_encodings.js`):** D-028 implementation. 5 skill encodings with distilled instructions always in persona + full content injected on-demand when topic tags match trigger keywords. Role-based applicability. 3000-token budget guard.
- **Decomposed Project Linear Sync (`src/lib/linear.js`):** `syncDecomposedProjectToLinear()` creates 1 Linear project + N issues (one per task) with wave/work-type labels. Fire-and-forget — sync failure never blocks execution.
- **QA Scope Adjustment (`src/lib/conversations.js`):** When Ein (QA) reviews non-engineering domain work, review prompt limits scope to technical quality, completeness, and citation accuracy. Domain expertise judgment left to the assigned SME agent.
- **SQL Migration:** `sql/006_task_decomposition.sql` — `message_classifications`, `step_dependencies`, `decomposition_plans`, `escalation_log` tables + decomposition policy row.
- **TDD Tests:** 131 new tests across 8 test suites (`tests/v09/`).

### Modified
- **`src/discord_bot.js`:** Message classification replaces action-tag parsing. `classifyMessage()` as separate T1 call before Frasier response. Casual messages get simplified prompt (saves ~400 tokens).
- **`src/lib/missions.js`:** `getPendingSteps()` now checks DAG dependencies first, falls back to legacy `step_order` for backward compatibility. New exports: `areAllDependenciesMet()`, `getPredecessorOutputs()`.
- **`src/worker.js`:** Claims up to 3 steps per tick. Extracted `executeStep()` function. DAG context injection from all predecessor outputs, legacy single-parent fallback preserved.
- **`src/lib/pipeline.js`:** Research depth enforcement (3+ sources, retry logic), citation validation, calibrated 4-dimension critique rubric, max 2 revision attempts.
- **`src/lib/context.js`:** Citation requirement added to all output templates.
- **`src/lib/memory.js`:** Skill encoding injection in `buildAgentPrompt()`.
- **`src/lib/conversations.js`:** `buildEnhancedReviewPrompt()` accepts `options` param for QA scope limitation (backward compatible).
- **`src/lib/linear.js`:** New `syncDecomposedProjectToLinear()` for decomposed project sync.

### Cost Impact
- Message classification: ~$0.001 per Discord message (T1 MiniMax)
- Decomposition: ~$0.01-0.05 per project (T2 Sonnet)
- Research retries: ~$0.002-0.01 per step (T1 MiniMax for refined queries)
- Skill encoding: 0-3000 extra tokens per prompt (on-demand only)
- Zero new npm dependencies, zero new PM2 processes

### Notes
- All 379 tests pass (248 existing + 131 new, zero regressions).
- Backward compatible: legacy `step_order` chains still work for existing missions.
- `simple_task` classification routes to exact same proposal pipeline — existing flow unchanged.
- Decomposition fallback: if LLM returns invalid JSON, creates single-mission with full directive.

---

## [0.8.0] — 2026-02-23 (Linear Integration — Mission Control)

### Added
- **Linear API Client (`src/lib/linear.js`):** Two-way sync between Frasier missions and Linear projects/issues. Raw GraphQL via `fetch()` — no SDK, zero new dependencies.
- **LLM Title Polishing:** Tier-1 (MiniMax) rewrites raw task descriptions into clean, professional Linear ticket titles and descriptions.
- **Webhook Handler:** `POST /webhooks/linear` on port 8787. HMAC-SHA256 signature validation. Dhroov creates a project + issue in Linear → Frasier picks it up as a new mission.
- **12 Agent Labels + 7 Work Type Labels + 1 System Label:** Created programmatically on startup. All 12 active agents represented: Frasier, Gendo, Sahaquiel, Toji, Kaworu, Ritsuko, Armisael, Shamshel, Zechs, Zeruel, Jet, Rei.
- **Custom Fields on Issues:** Self-Critique Score, Discord Link, Notion Link, Started At, Completed At.
- **Custom Fields on Projects:** Start Date, Completion Date.
- **Deliverable Comments:** Google Drive links posted as comments on Linear issues when work completes.
- **PRD:** `docs/PRD_LINEAR_INTEGRATION.md` (v2.0) — full requirements, ticket specs, data flow.
- **SQL Migration:** `sql/005_linear_integration.sql` — `linear_sync` tracking table.
- **TDD Tests:** 38 new tests across 2 test suites (`tests/linear/`).

### Modified
- **`src/lib/missions.js`:** 8 fire-and-forget Linear sync calls added to lifecycle functions (createMission, createStep, claimStep, completeStep, approveStep, sendBackForRevision, completeMission, failMission).
- **`src/heartbeat.js`:** Linear initialization on startup + webhook route added to health server.
- **`src/discord_bot.js`:** Discord announcements now include Linear project link. Deliverable Google Drive links posted as comments on Linear issues.

### Cost Impact
- Linear: $0/month (free tier API)
- LLM title polishing: ~$0.02-0.20/month (tier-1 MiniMax)
- Zero new npm dependencies, zero new PM2 processes

### Notes
- All 248 tests pass (210 existing + 38 new, zero regressions).
- Graceful degradation: if LINEAR_API_KEY is unset, all sync functions return null silently.
- Both entry points work: Discord → Frasier → Linear, and Linear → Frasier → Discord.

---

## [0.7.0] — 2026-02-23 (Deep Work Pipeline)

### Added
- **Deep Work Pipeline (`src/lib/pipeline.js`):** Multi-phase execution engine replacing single-shot LLM calls. Every task now follows: decompose → web research → synthesize → self-critique → (revise if score < 3/5). Configurable per task type.
- **Approach Memory (`src/lib/approach_memory.js`):** "What worked before" — agents accumulate judgment. Past decompositions and search queries that scored well are injected into future task breakdowns. Zero additional LLM calls.
- **Autonomous Approval (`src/lib/autonomy.js`):** Policy-driven auto-approval. Intermediate steps with critique score ≥ 4.0 auto-approve; ≥ 3.0 get QA-only review; final steps always get full QA → Team Lead review.
- **PRD:** `docs/PRD_DEEP_WORK_PIPELINE.md` — full requirements, architecture, cost impact.
- **SQL Migration:** `sql/004_deep_work_pipeline.sql` — `pipeline_phases` and `approach_memory` tables + autonomy policy.
- **TDD Tests:** 41 new tests across 3 test suites (`tests/deep-work/`).

### Modified
- **`src/worker.js`:** Single LLM call replaced with `pipeline.execute()`. Lesson generation now extracts from self-critique (every task, no extra LLM call). Approach memory saved after every step.
- **`src/heartbeat.js`:** Autonomy check at top of `processApprovals()` — auto-approves intermediate steps with high critique scores.

### Cost Impact
- Per-step cost: $0.001-0.02 → $0.004-0.05 (3-4 LLM calls instead of 1)
- Weekly cost: $0.03-0.30 → $0.15-0.75 (at 2-5 missions/week)
- Brave Search: ~240 queries/month (free tier allows 2,000)

### Notes
- No new PM2 processes, no new npm dependencies, 1GB VPS safe.
- All 210 existing tests continue to pass (zero regressions).
- Pipeline modules designed for extraction to other projects (Phase 6).

---

## [0.6.0] — 2026-02-22 (Agent Upskilling)

### Added
- **Persona enrichment migration:** `scripts/enrich-personas.js` injects expert methodologies (RICE, MoSCoW, Porter's Five Forces, STRIDE, PLFS, etc.) directly into agent system prompts. Idempotent — safe to re-run.
- **Expanded skill tracking:** `ROLE_SKILLS` expanded from 3 to 9-11 skills per role (48 security-vetted skills sourced from Antigravity catalog). All skills have `SKILL_KEYWORDS` for keyword-based growth detection.
- **Role aliases:** `ROLE_SKILLS` keys now include aliases (`chief`, `coo`, `business`, `analyst`, `writer`, `editor`, `test`, `archivist`, etc.) so roles like "Chief of Staff / COO" and "Memory System Tester" match correctly.
- **Security pipeline:** All 48 candidate skills passed 3-scanner pipeline (Snyk mcp-scan, Cisco AI Skill Scanner, SkillAudit API) + manual line-by-line review before installation.

### Enriched Agents
- **Frasier** (Chief of Staff): RICE prioritization, MoSCoW, ADRs, SaaS metrics, unit economics
- **Gendo** (Research Lead): Multi-step research protocol, Porter's Five Forces, market sizing, data storytelling
- **Sahaquiel** (Research Analyst): Same research methodologies
- **Toji** (Financial Analyst): Strategy & business analysis frameworks
- **Rei** (QA Tester): STRIDE threat modeling, test quality scoring, 80/20 coverage, systematic debugging

### Notes
- 7 agents without personas (Contentron agents + Ritsuko, Kaworu) skipped — script auto-enriches on re-run once personas exist.
- Skill initialization uses upsert — no duplicate rows if run multiple times.

---

## [0.5.0] — 2026-02-22 (Contentron Integration)

### Added
- **`!content` command family:** 6 subcommands for managing the Contentron content pipeline from Discord — `list`, `view`, `approve`, `reject`, `revise`, `stats`
- **`!watchlist` command family:** 3 subcommands for managing Scout's monitoring targets — `list`, `add`, `remove`
- **`src/lib/content.js`:** New module with all content pipeline and watchlist Supabase queries, decoupled from Discord I/O
- **Short UUID support:** Draft IDs can be referenced by first 8 characters for convenience
- **Idempotent mutations:** Approving an already-published draft or rejecting an already-discarded draft returns a friendly no-op message
- **25 new tests:** `tests/contentron/content.test.js` — full coverage of content pipeline + watchlist CRUD (total: 169 tests passing)
- **Updated `!help`:** Now includes Content Pipeline and Watchlist command sections

### Notes
- Frasier writes to shared Supabase tables; Contentron reads on its 2-hour tick. Zero direct communication.
- All status changes are logged as events (`content_approved`, `content_rejected`, `content_revision_requested`, `watchlist_item_added`, `watchlist_item_removed`)

---

## [0.4.1] — 2026-02-17 (Autonomous Lifecycle + Announcement Fix)

### Added
- **Auto-phase-progression:** When a project completes a phase, heartbeat automatically creates a mission proposal for the next phase with prior phase output as context. No manual intervention needed. (`PHASE_TASKS` constant defines work for each phase.)
- **Stalled project detection:** `checkStalledProjects()` runs every heartbeat tick — detects active projects stuck in a phase with no active missions or pending proposals, and auto-creates the missing phase mission.

### Fixed
- **OpenRouter model IDs:** Changed `anthropic/claude-sonnet-4-5-20250929` → `anthropic/claude-sonnet-4.5` and `anthropic/claude-opus-4-20250514` → `anthropic/claude-opus-4`. Old date-suffixed IDs returned API 400 errors, causing all T2/T3 tasks to fall back to T1 MiniMax.
- **Announcement duplicate spam:** `announced = true` was set AFTER Notion/Drive publishing. When Supabase returned Cloudflare 500 errors after publish succeeded, the flag never persisted — steps were re-published every 30-second poll cycle (infinite duplicate Notion pages + Google Docs). Fix: mark `announced = true` BEFORE publishing.
- **Announcement loop crash:** No try/catch around individual step processing in `announceCompletedSteps()`. One Notion/Drive error aborted announcements for all remaining steps. Fix: inner try/catch around Notion/Drive (still announces to Discord without links) + outer try/catch per step (skips failed step, continues loop).

---

## [0.4.0] — 2026-02-17 (Quality Overhaul)

### Added
- **Tier 3 keyword routing:** New `TIER3_KEYWORDS` constant routes high-stakes deliverables (product requirements, design documents, executive reports, business cases, investment memos) to Claude Opus automatically
- **T3→T2→T1 fallback chain:** If Opus fails, degrades to Sonnet, then MiniMax — never fails silently
- **"YOU ARE the expert" prompt framing:** All 7 domain instructions + generic fallback + universal quality standards now enforce agents as DOERs, not ADVISORs
- **Dynamic role determination:** `determineDynamicProjectRoles()` uses T1 LLM call to identify industry-specific specialist roles (e.g., "Real Estate Market Analyst", "Healthcare Compliance Specialist") instead of hardcoded 7-category keyword matching
- **Industry-specific persona generation:** Gap-fill agents now get personas immediately upon hiring, with project context injected for domain expertise. Quality standards baked into every persona.
- **Domain expert reviews:** `processApprovals()` searches ALL active agents for a domain expert before falling back to QA/Team Lead. Expert cannot review own work.
- **5 new test suites:** `tier-restructure` (22), `prompt-quality` (21), `dynamic-roles` (8), `industry-hiring` (2), `expert-reviews` (7) — total 144 tests passing

### Changed
- **Tier 2 model:** Manus (never configured) → Claude Sonnet 4.5 via OpenRouter (`anthropic/claude-sonnet-4.5`)
- **Tier 2 API key:** `MANUS_API_KEY` → `OPENROUTER_API_KEY` (same key as T1/T3)
- **`selectTier()` routing:** Now 3-tier (T3 keywords → T2 keywords → T1 default). Previously only T1/T2 with Manus availability check that always returned false.
- **`autoHireGapAgent()` signature:** Now accepts optional `options` parameter with `{ projectDescription, projectName }`
- **`generatePersona()` signature:** Now accepts optional `projectContext` parameter
- **`!costs` display:** "Manus" → "Sonnet", "Claude" → "Opus", T2 now shows cost
- **Cost alert display:** Same naming updates as `!costs`
- **`discord_bot.js` NEW_PROJECT handler:** Uses `determineDynamicProjectRoles()` (async, LLM-based) instead of `determineProjectRoles()` (sync, keyword-based)

### Removed
- **Manus-specific code:** `MANUS_CREDITS_EXHAUSTED` error handling in models.js and worker.js
- **Manus endpoint check:** `makeAPICall()` no longer checks for Manus endpoint configuration
- **Manus availability guard:** `selectTier()` no longer checks `MODELS.tier2.endpoint && process.env[MODELS.tier2.apiKeyEnv]`
- **T3 approval gate:** Tier 3 no longer requires founder approval — auto-routes by keyword

---

## [0.3.1] — 2026-02-17 (Post-Overhaul Fixes)

### Fixed
- **Clean proposal titles:** `cleanProposalTitle()` strips Discord mentions, URLs, `[PROJECT:N]` tags; extracts first sentence; caps at 120 chars
- **T2→T1 fallback:** When Manus (T2) failed for non-credit reasons, steps were permanently stuck. Now auto-retries with T1.
- **Announcement error logging:** `announceCompletedSteps()` no longer silently swallows Supabase query errors

---

## [0.3.0] — 2026-02-17 (System Overhaul)

### Added
- **Test infrastructure:** Jest + in-memory Supabase mock + factory helpers. 84 tests across 7 suites.
- **Roster injection:** Frasier now sees all teams + agents in system prompt. Uses "Name (Role)" format.
- **Context enrichment pipeline:** `buildTaskContext()` combines original message + domain mandates + output template + quality standards
- **Auto tier selection:** `selectTier()` with keyword-based T2 upgrades + final step detection
- **Persona-as-rubric:** `QUALITY_RUBRICS` baked into agent personas (100% retrieval)
- **Enhanced reviews:** 5-criterion rubric scoring, auto-reject on score < 3, structured feedback
- **Project lifecycle:** Discovery → Requirements → Design → Build → Test → Deploy → Completed
- **Smart routing:** Cross-team agent matching via `findBestAgentAcrossTeams()`
- **Gap-fill hiring:** `autoHireGapAgent()` for instant agent creation when no match found

---

## [0.2.0] — 2026-02-15

### Added
- Full memory system (persistent cumulative, lesson generation, founder conversation memory)
- Skills tracking and growth
- Dynamic hiring with anime name pool
- Standup system (daily at 9am ET)
- Web access (DuckDuckGo search, HTTP fetch)
- Buffer social media integration
- Google Drive backup (daily at 3am ET)
- GitHub daily state push (4am ET)
- Notion task boards
- Health checks and cost alerts
- Daily summary (Discord + email)
- Persona-based upskilling (after 5 QA rejections)

---

## [0.1.0] — 2026-02-14

### Added
- Core pipeline: mission proposals → missions → steps → LLM execution → Discord output
- 3 PM2 processes: discord_bot, heartbeat, worker
- 7 agents deployed (Jet, Edward, Faye, Spike, Ein, Vicious, Julia)
- Tiered LLM routing (MiniMax T1, Manus T2 placeholder, Opus T3)
- Approval chain (QA → Team Lead)
- Discord bot with founder commands (!status, !teams, !costs, etc.)
- PostgreSQL (Supabase) as sole orchestration layer
