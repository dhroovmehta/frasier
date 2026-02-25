# Frasier — Decision Log

All architectural and design decisions, with context and trade-offs.

---

## D-043: Zombie Step Cleanup — Queue Resilience + Auto-Fail Cascade

**Date:** Feb 25, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Project #8 stalled overnight despite a healthy worker process. Root cause: `getPendingSteps(3)` fetched at most 6 rows (`.limit(limit * 2)`). 17 zombie pending steps from dead missions 87 and 90 (Projects 6 and 7) occupied the entire fetch window. Each failed dependency checks and was skipped. The function returned empty. Mission #91's 13 pending steps were never reached. The worker had no work to do — not because there was none, but because it couldn't see it.

This is the 28th issue in the log. The pattern is consistent: individually correct functions compose into a broken pipeline because upstream failures leave orphaned state that poisons downstream consumers.

**Decision:** Two changes:

1. **Remove `.limit(limit * 2)` from `getPendingSteps()`** — Fetch all pending unprocessed steps, check dependencies in the existing JS loop, return up to `limit` eligible ones. The existing `if (eligible.length >= limit) break` already caps output. No performance concern: pending steps in a healthy system number in the tens, not thousands.
2. **New `failBlockedSteps(missionId)`** — For each active mission, find all pending steps permanently blocked by a failed predecessor (step_order > min failed step_order). Auto-fail them with a clear error message. Called from `checkMissions()` in heartbeat, before `checkMissionCompletion()`, so the completion check sees the updated statuses and can properly fail/complete the mission.

**Alternatives Considered:**
1. Increase the limit multiplier (e.g., `limit * 10`) — Band-aid. Would still fail with enough dead missions. Doesn't clean up zombies.
2. Add a `mission.status = 'in_progress'` filter to the SQL query — Already exists (via `missions!inner(status)`), but missions 87 and 90 were still `in_progress` because nobody had marked them failed. The zombie steps kept the missions alive.
3. Filter by mission creation date — Fragile. Legitimate old missions could be slow but valid.

**Trade-offs:**
- (+) Worker can always reach live mission steps regardless of dead mission count
- (+) Zombie steps are cleaned up automatically — no manual intervention needed
- (+) Failed missions cascade correctly: blocked steps fail → mission completes as failed → stalled project detector can re-plan
- (+) Zero performance impact: pending step count is bounded by active missions × steps per mission
- (-) Fetching all pending rows instead of 6 — negligible cost, rows are small (status + id)
- (-) `failBlockedSteps` runs every heartbeat tick for every active mission — but exits early (0 cost) when no failed steps exist

---

## D-042: Autonomous Delivery — Iterative Research + Budget-Aware Execution

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Despite 26 issues fixed across v0.1.0 through v0.10.0, zero projects have completed end-to-end autonomously. Analysis of the full issue log revealed a pattern: individual pipeline links are fixed in isolation, but the chain never works as a whole. Three structural problems remained:

1. **Research too shallow:** 4 queries × 2 URLs = 8 max fetches per step. A task like "analyze 15 niches" needs 30+ fetches. Single-pass research with no iteration produces thin results.
2. **Decomposition ignores tool budgets:** The capability manifest (v0.10.0) told the planner what agents *can* do, but not *how much*. Tasks like "analyze 10 competitors in one step" still exceeded per-step budgets.
3. **Test agent leak:** test-memory-agent (team_id: null) appeared in review rotation because `processApprovals()` and `findBestAgentAcrossTeams()` use different code paths — the former lacked team_id filtering.

Benchmark: Manus AI produces 18-page research reports by iterating (search → analyze gaps → search more → synthesize). Our agents did one pass and stopped.

**Decision:** Seven coordinated changes:

1. **Expand research limits** — 4→6 queries, 8→16 fetches, 2→3 URLs per query. Combined with iterative deepening, sufficient for substantive research.
2. **Iterative research loop** — After initial search, T1 LLM identifies gaps in collected data. Up to 3 gap-analysis → targeted follow-up cycles before synthesis.
3. **Quantitative tool budgets in decomposition prompt** — Exact numeric limits plus MapReduce guidance ("10 competitors → 5 parallel steps of 2 + synthesis").
4. **Budget tracker injection** — `budgetUsed` object passed to synthesis prompt so agents know their remaining capacity and cite what they actually found.
5. **Centralized `RESEARCH_LIMITS` constant** — Single source of truth consumed by both the decomposition prompt and the pipeline execution engine. No more hardcoded values.
6. **Budget-aware acceptance criteria** — GLOBAL_CONSTRAINTS now includes: "Acceptance criteria MUST be achievable within one step's budget."
7. **Team_id filter in review rotation** — Excludes test agents from `processApprovals()` domain expert selection.

**Alternatives Considered:**
1. Just increase fetch limits without iteration — more data but still no depth. Would waste tokens on broad-but-shallow results.
2. Add a dedicated "research planner" agent — over-engineering. The gap analysis LLM call achieves the same result at ~200 tokens.
3. Make QA more lenient on thin research — wrong fix. QA was right to reject shallow work. The fix belongs in the research pipeline.
4. Switch to a headless browser for deeper scraping — violates VPS RAM constraints (1GB). Brave API + iteration is sufficient.

**Trade-offs:**
- (+) Agents can now iterate and deepen research — matches Manus/Step-DeepResearch quality patterns
- (+) Budget tracker prevents agents from hallucinating sources they didn't fetch
- (+) MapReduce guidance right-sizes decomposed plans to tool budgets
- (+) Centralized limits constant prevents drift between planning and execution
- (+) Low cost: gap analysis uses T1 (cheapest tier), ~200-400 tokens per call
- (-) Up to 3 extra T1 LLM calls per research step (minimal cost, ~$0.001 per call)
- (-) Research steps take longer due to iteration (acceptable — quality > speed)
- (-) RESEARCH_LIMITS must be updated in one place when adding tools (by design — single source of truth)

**Research:** Google Budget Tracker pattern (inject remaining budget into prompts, 40% fewer wasted searches), Manus iterative research loop (search → gap analysis → targeted follow-up), MapReduce decomposition pattern (parallel research + synthesis step).

---

## D-041: Capability-Aware Decomposition — Manifest + Feasibility Gate

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Projects were yielding incomplete results because the decomposition engine created tasks with acceptance criteria that agents couldn't fulfill. Example: "Mine 50 Reddit threads per niche" when agents have Brave Search (4 queries/task, 8 page fetches) and no headless browser. QA correctly rejected the work, agents couldn't fix it, steps hit the 3-strike cap, missions failed.

The root cause: the decomposition prompt only received agent names and roles — no awareness of tools, constraints, or limits. All capability information was injected at execution time, after the plan was already locked in.

**Decision:** Two changes to the decomposition engine:

1. **Capability Manifest** — A structured text block (`capabilities.js`) listing each role's tools, strengths, and explicit CANNOT constraints, plus global execution limits. Injected into the decomposition prompt alongside the agent roster.

2. **Feasibility Validation Gate** — After decomposition, a cheap T1 LLM call reviews each step against the manifest. If infeasible steps found, one re-decomposition with specific issue feedback. Fail-open on errors.

**Alternatives Considered:**
1. Fix at QA level (make reviewers more lenient) — wrong fix. QA was correct, the plan was bad.
2. Let agents push back during execution — too late; plan is committed, steps exist, resources allocated.
3. Add a separate "planner agent" — over-engineering; same LLM with better context solves it.
4. Hard-code capability checks (no LLM) — too rigid; can't evaluate creative task descriptions programmatically.

**Trade-offs:**
- (+) Solves the root cause at the planning layer, not downstream
- (+) Minimal cost: ~500-800 extra prompt tokens + 1 cheap T1 call per project
- (+) Fail-open: broken validation doesn't block execution
- (+) Static manifest is easy to extend when new tools are added
- (-) Manifest must be manually maintained when agent capabilities change
- (-) LLM-based feasibility check is probabilistic, not deterministic

**Research:** Based on industry patterns — CrewAI role-based matching, LangGraph plan-and-execute with replanning, Microsoft AutoGen ledger-based orchestration, ChatHTN hybrid LLM+symbolic verification, Anthropic's capability manifest pattern.

---

## D-040: Discord Attachment Processing — Extension-First Filtering

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Dhroov wants to drop `.md` roadmap files into Discord and have Frasier process them as project directives. The bot only reads `message.content` (typed text) and ignores `message.attachments`. Attachment-only messages are silently dropped.

**Decision:** Process text-based attachments in the message handler BEFORE the empty-content guard. Use a two-check filter: file extension allowlist (primary) OR contentType prefix match (secondary).

Extension-first because Discord often sends `application/octet-stream` for `.md` and `.txt` files — relying on contentType alone would miss them.

**Implementation:**
- New `fetchAttachments()` function in `web.js` (follows existing `prefetchUrls()` enrichment pattern)
- Message handler: `let content` + attachment fetch + combine BEFORE `if (!content) return`
- Combined content flows through classify → Frasier → decompose pipeline unchanged

**Alternatives Considered:**
1. Process attachments inside `handleFrasierMessage()` — doesn't fix the empty-check blocker at line 90
2. Use contentType only — Discord sends `application/octet-stream` for text files, too unreliable
3. Add a file-parsing library (pdf-parse) — unnecessary for text files, adds dependency
4. Store attachments in Supabase — over-engineering for the use case

**Trade-offs:**
- (+) Zero new dependencies
- (+) Follows existing `prefetchUrls()` enrichment pattern — consistent architecture
- (+) No downstream changes — classify, Frasier, decompose all receive a string
- (-) Cannot process binary formats (PDF, DOCX, images). Acceptable — text is the 80% case, PDF can be added later.

---

## D-039: Broad AgentId Sanitization — Allowlist Over Blocklist

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** ISS-020 (v0.9.4) fixed `agentId='system'` by converting it to `null` in `logModelUsage()`. But ISS-023 revealed `agentId='frasier'` from a different caller (`classifyMessage()` in discord_bot.js). The per-value blocklist approach was fundamentally flawed — any new internal caller passing a non-agent string would trigger the same FK violation.

**Decision:** Replace per-value sanitization with an allowlist pattern:
```javascript
const sanitizedAgentId = (agentId && agentId.startsWith('agent-')) ? agentId : null;
```
Only agent IDs matching the `agent-*` naming convention (used by `autoHireGapAgent()` and all seed data) are kept. Everything else — `'system'`, `'frasier'`, `'frasier-cos'`, arbitrary strings from future callers — is sanitized to `null`.

**Also fixed the caller:** `discord_bot.js` `classifyMessage()` now passes `agentId: null` instead of `'frasier'`, fixing the issue at the source.

**Alternatives Considered:**
1. Keep expanding the blocklist (`if (id === 'system' || id === 'frasier' || ...)`) — fragile, guaranteed to miss future callers
2. Create rows in `agents` table for non-agent callers ('system', 'frasier') — pollutes agent data, confuses queries
3. Remove FK constraint from `model_usage.agent_id` — loses data integrity

**Trade-offs:**
- (+) Future-proof — any new non-agent caller is automatically sanitized
- (+) Simple — one line of code, no maintenance
- (-) Agent IDs that don't follow the `agent-*` convention would be silently dropped. Acceptable because all agents are created via `autoHireGapAgent()` which enforces this convention.

---

## D-038: Wire Classification Into Message Handler with Override Logic

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** `classifyMessage()` (v0.9.0) was built and tested but never called from the message handler. All messages went directly to `handleFrasierMessage()`, relying entirely on Frasier's `[ACTION:*]` tags for routing. During integration testing, this meant full projects could be misclassified as simple proposals.

**Decision:** Wire `classifyMessage()` into the handler with a `resolveActionTag()` override:
1. Call `classifyMessage()` BEFORE `handleFrasierMessage()` on every Discord message
2. Pass classification to `handleFrasierMessage()` — inject hint into Frasier's prompt when T1 says `full_project`
3. After Frasier responds, `resolveActionTag()` resolves disagreements:
   - T1 says `full_project` (confidence ≥ 0.7) + Frasier says anything except `RESPONSE` → force `NEW_PROJECT`
   - T1 says `full_project` but Frasier says `RESPONSE` → trust Frasier (don't force work on casual messages)
   - All other cases → trust Frasier's tag

**Alternatives Considered:**
1. Replace Frasier's ACTION tags entirely with classifier → loses Frasier's conversational context and PROJECT_DETAILS extraction
2. Only use classifier, skip Frasier call for casual messages → breaks the "always talk to Frasier" UX
3. Add classifier as post-hoc validation only → still misses cases where Frasier wrong-tags on first pass

**Trade-offs:**
- (+) Full projects always get decomposed, regardless of Frasier's tag
- (+) Classification is cheap (T1, ~100 tokens) — negligible cost
- (+) Classification persisted for audit trail
- (+) Backward compatible — `resolveActionTag` gracefully handles null classification
- (-) Extra T1 LLM call per message (~$0.001 each, ~50 messages/day = $0.05/day)
- (-) Slight latency increase (~500ms for classification before Frasier responds)

---

## D-037: Fix Completion Notification Pipeline (Move Post-Completion to Source)

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Worker completes missions before heartbeat detects them (race condition). Events, phase advancement, and Discord notifications never fire. 5 gaps in the pipeline.

**Decision:** Move post-completion logic from heartbeat into source functions:
- `completeMission()` → logs `mission_completed` event, checks project link, triggers `checkPhaseCompletion()`
- `failMission()` → logs `mission_failed` event
- `advanceProjectPhase()` → logs `project_phase_advanced` or `project_completed` events
- Heartbeat's `checkMissions()` simplified to safety net (just calls `checkMissionCompletion()`)
- `checkStalledProjects()` handles next-phase mission creation (30s delay, acceptable)

**Alternatives Considered:**
1. Fix heartbeat to detect already-completed missions → fragile, still relies on polling timing
2. Add event queue/callback from worker → over-engineered for our polling architecture
3. Move everything to worker.js → duplicates heartbeat logic, violates single responsibility

**Trade-offs:**
- (+) Events fire immediately when mission completes, regardless of caller
- (+) Idempotent — safe for both worker and heartbeat to trigger
- (+) Simpler heartbeat code (47 → 7 lines)
- (-) 30s delay for next-phase mission creation (via checkStalledProjects instead of inline)
- (-) missions.js now imports events + projects (2 new dependencies, but no circular)

---

## D-036: Wire Decomposition Into Runtime (Direct Mission, No Proposal)

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** `decomposeProject()` was built and tested in v0.9.0 but never called from any runtime code path. The `[ACTION:NEW_PROJECT]` handler in discord_bot.js created a simple proposal for heartbeat to pick up → one step per lifecycle phase → sequential execution. The decomposition engine (DAG, parallel groups, dependency tracking, Linear sync) sat unused.

**Decision:** Wire decomposition into `[ACTION:NEW_PROJECT]` by creating a mission directly (bypassing the proposal→heartbeat→accept flow), linking it to the project, then calling `decomposeProject()` which creates steps + dependencies + Linear sync. Added `handleNewProjectDecomposition()` to `decomposition.js` as the orchestration function.

**Key design choices:**
- **Direct mission creation** (not proposal): Decomposed projects don't need heartbeat arbitration. Frasier already classified the message as `full_project` and the LLM responded with `[ACTION:NEW_PROJECT]`. Creating the mission immediately saves one heartbeat cycle (~30s).
- **Team defaults to `team-research`**: The mission-level teamId is for organizational grouping. Per-step agent assignment handles actual routing via `findBestAgentAcrossTeams`.
- **Fallback to proposal on failure**: If decomposition fails (LLM error, JSON parse failure, Supabase error), fall back to the old proposal-based flow. Never block project creation on decomposition failure.
- **`syncMissionToLinear` made idempotent**: Both `createMission()` and `decomposeProject()` call `syncMissionToLinear`. Added a check for existing `linear_sync` record to prevent duplicate Linear projects.

**Trade-offs:** Bypassing proposals means decomposed projects skip heartbeat's team validation and gap detection. Acceptable because `decomposeProject()` handles its own gap detection + hiring. The heartbeat still handles phase progression for subsequent lifecycle phases.

---

## D-035: 3-Strike Revision Cap

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Zero + Frasier

**Context:** Mission #75 entered an infinite review loop — Sahaquiel's work was rejected by Toji repeatedly (3+ times observed, would continue indefinitely). Scores were 3.8-4.25 but Toji kept rejecting. No cap existed. The existing `maybeUpskillAgent()` at 5 rejections would never stop the loop.

**Decision:** After 3 total rejections on the same step, fail the step and escalate to the founder via Discord with Linear ticket links. Each rejection is also posted as a comment on the Linear ticket for full audit trail.

**Rationale:** 3 strikes is enough signal that the agent cannot self-correct for this task. Founder intervention is needed — either the task is wrong, the agent isn't suited, or the QA criteria are miscalibrated. Better to stop and surface the problem than waste LLM budget on infinite loops.

**Trade-offs:** `maybeUpskillAgent` (threshold 5) naturally never triggers with cap at 3. Left in place for safety in case the cap is raised later. One extra DB write when cap is reached (sendBackForRevision then failStep override), but correctness > efficiency for a 30s poll loop.

---

## D-034: Lazy Linear Cache Initialization

**Date:** Feb 24, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Worker.js is a separate PM2 process from heartbeat.js. Heartbeat calls `linear.initialize()` on startup which populates `cache.workflowStates`. Worker never calls initialize, so every `updateIssueStatus()` from worker fails with "Unknown workflow state: In Progress." All Linear status updates (In Progress, In Review, Done) silently failed.

**Decision:** Added `ensureInitialized()` as a lazy init guard at the top of every cache-reading function. Uses a boolean flag — first call does the full initialization, subsequent calls are no-ops. Both `initialize()` (heartbeat) and `__setCache()` (tests) set the flag.

**Rationale:** Simpler than requiring worker.js to call initialize() on startup (which would duplicate the heartbeat's initialization logic and add startup latency). Lazy init means any process that touches Linear gets initialized automatically, including future processes.

**Trade-offs:** First Linear API call from worker has ~500ms extra latency for initialization. Subsequent calls are instant. Acceptable for a 10-second poll loop.

---

## D-001: Minimalist Architecture (PostgreSQL + Node.js Workers)

**Date:** Feb 11, 2026 | **Status:** Active | **Author:** Zero + Kai

**Context:** Three architecture options: OpenAI Assistants API (managed), LangChain/AutoGPT (framework), or custom PostgreSQL + Node.js (minimalist).

**Decision:** Custom minimalist architecture. No frameworks. PostgreSQL is the orchestration layer.

**Rationale:** Full control, no vendor lock-in, $8/month infra, matches founder's vision.

**Trade-offs:** More initial development, no pre-built agent collaboration.

---

## D-002: Discord as Primary Interface

**Date:** Feb 11, 2026 | **Status:** Active | **Author:** Zero + Kai

**Context:** Need a communication layer for founder-agent and agent-agent interaction.

**Decision:** Discord for v1.0. Pixel-art frontend deferred.

**Rationale:** Familiar, real-time, free, rich formatting, mobile app.

---

## D-003: Supabase Free Tier

**Date:** Feb 11, 2026 | **Status:** Active | **Author:** Zero + Kai

**Context:** Need managed PostgreSQL.

**Decision:** Supabase free tier (500MB storage, 2GB bandwidth).

**Rationale:** $0 cost, sufficient for current scale, easy upgrade path.

**Risk:** Storage/bandwidth limits. Monitor via `!costs`.

---

## D-004: PM2 Process Management

**Date:** Feb 11, 2026 | **Status:** Active | **Author:** Kai

**Context:** Need to run 3 Node.js processes continuously on VPS.

**Decision:** PM2 with auto-restart, log management, `pm2 save` for persistence.

---

## D-005: Persona Modification Over Lessons for Upskilling

**Date:** Feb 15, 2026 | **Status:** Active | **Author:** Zero

**Context:** Two approaches to make agents smarter: modify their persona (always in system prompt) or add lessons (top 5 retrieved per call).

**Decision:** Persona is the primary vehicle. 100% retrieval rate. Lessons are supplementary.

**Rationale:** Persona is always present in every LLM call. Lessons compete for limited slots.

---

## D-006: Frasier as Chief of Staff (Not Jet)

**Date:** Feb 15, 2026 | **Status:** Active | **Author:** Zero

**Context:** Original spec named the CoS agent "Jet" (Cowboy Bebop). Founder preferred "Frasier" — the system's namesake.

**Decision:** Renamed to Frasier. Has $20k/month north star revenue goal in SEP.

---

## D-007: No Firing — Only Upskilling

**Date:** Feb 15, 2026 | **Status:** Active | **Author:** Zero

**Context:** When agents perform poorly, should they be fired or upskilled?

**Decision:** No firing for now. After 5 QA rejections, agents get persona-based upskilling.

---

## D-008: Full Conversation Recall

**Date:** Feb 15, 2026 | **Status:** Active | **Author:** Zero

**Context:** How to store agent conversations — summarize or keep full turns?

**Decision:** Each conversation turn saved as its own memory row with real topic tags. Full recall.

---

## D-009: Founder Directives as Permanent Lessons

**Date:** Feb 15, 2026 | **Status:** Active | **Author:** Zero

**Context:** When founder gives a directive, how should it be stored?

**Decision:** Saved as permanent lessons with importance 9 (near-max). Always retrieved.

---

## D-010: Tiered LLM Routing (MiniMax → Sonnet 4.5 → Opus)

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** Manus (T2) was never configured. Everything ran on MiniMax (cheapest, lowest quality). Research/strategy tasks produced shallow, generic results.

**Decision:** 3-tier routing via keyword matching:
- **T1 (Default):** MiniMax — simple tasks
- **T2 (Complex):** Claude Sonnet 4.5 — research, strategy, analysis, final steps
- **T3 (High-Stakes):** Claude Opus — PRDs, design docs, executive reports

Fallback chain: T3→T2→T1 if higher tier fails.

**Rationale:** 80% of tasks still use cheap T1. Only complex/high-stakes work uses expensive models. Cost-optimized.

**Files changed:** `models.js`, `worker.js`, `discord_bot.js`, `heartbeat.js`

---

## D-011: Remove Manus, Replace with Sonnet 4.5

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** Manus was listed as T2 but never had endpoint/key configured. `MANUS_CREDITS_EXHAUSTED` error handling existed but Manus was never called.

**Decision:** Replace Manus entirely with Claude Sonnet 4.5 via OpenRouter. Same API key as T1/T3. Remove all Manus-specific code.

**Rationale:** One API provider (OpenRouter), one API key, no dead code.

---

## D-012: Remove T3 Founder Approval Gate

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Zero + Kael

**Context:** T3 (Opus) required founder approval before use. Bottleneck — founder had to be online.

**Decision:** T3 auto-routes by keyword. No approval needed.

**Rationale:** Founder wants autonomous operation. T3 keywords are well-defined. Cost is predictable.

---

## D-013: Dynamic LLM-Based Role Determination

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** `determineProjectRoles()` used hardcoded 7-category keyword matching. Every new project type needed code changes. Founder explicitly rejected hardcoded BA/PO/PM roles.

**Decision:** `determineDynamicProjectRoles()` uses a T1 LLM call to return 2-5 industry-specific role titles (e.g., "Real Estate Market Analyst", "Healthcare Compliance Specialist") with a `category` field for team routing. Falls back to keyword matching if LLM fails.

**Rationale:** Any project, any industry — zero code changes. The category field maps to existing team routing infrastructure.

**Trade-offs:** Extra T1 LLM call (~$0.01) per project creation.

---

## D-014: Industry-Specific Persona Generation

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** Gap-fill agents (auto-hired when no existing agent matches a needed role) got bare database records with no persona, no domain expertise.

**Decision:** Generate persona immediately after auto-hiring. Inject project context (name, description) into the persona generation prompt. Bake quality standards into every persona.

**Rationale:** Agents need domain knowledge to produce quality work. Persona is always in system prompt (100% retrieval). Quality standards are non-negotiable.

**Files changed:** `agents.js` (autoHireGapAgent accepts options), `heartbeat.js` (generatePersona accepts projectContext, processProposals generates persona for gap-fills)

---

## D-015: Domain Expert Reviews

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** QA and Team Lead agents reviewed all work regardless of domain. A QA Engineer can't evaluate real estate market analysis quality.

**Decision:** `processApprovals()` searches ALL active agents for a domain expert (matching role keywords) before falling back to QA→Team Lead. Expert cannot review own work.

**Rationale:** A "Real Estate Market Analyst" reviewing market research catches domain errors a generalist QA agent would miss.

---

## D-016: "YOU ARE the Expert" Prompt Framing

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** Agents produced meta-instructions ("here's what a BA should do") instead of actual deliverables ("here is the market analysis").

**Decision:** All 7 domain instructions + generic fallback + universal quality standards now enforce agents as DOERs. Every prompt prefixed with "YOU ARE the expert [Role]. You are doing the work yourself." Every prompt suffixed with anti-meta directive.

**Rationale:** Without explicit framing, LLMs default to "helpful assistant" mode = meta-advice. Explicit DOER framing produces actual deliverables.

---

## D-017: Deploy Script Required (Not Just git pull)

**Date:** Feb 16, 2026 | **Status:** Active | **Author:** Zero (learned the hard way)

**Context:** Deployed with `git pull && pm2 restart all` but forgot `npm install`. Missing `nodemailer` dependency took down discord_bot + heartbeat for hours.

**Decision:** Always use `./deploy.sh` which includes `npm install`. Never skip dependency installation.

---

## D-018: Auto-Phase-Progression (No Manual Intervention)

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Zero + Kael

**Context:** When a project advanced phases (e.g., discovery → requirements), `advanceProjectPhase()` only updated the phase label. No mission was created for the new phase. Projects stalled after every phase until the founder manually triggered the next task. Zero explicitly rejected requiring manual intervention: "why do I need to manually trigger it?"

**Decision:** Heartbeat automatically creates a mission proposal for the next phase after each phase advancement. The proposal includes the prior phase's deliverable output (truncated to 2000 chars) as context so work builds incrementally. `PHASE_TASKS` constant defines what each phase should produce.

**Rationale:** The system should be fully autonomous. Founder oversight is for direction, not for pushing each phase forward manually.

**Files changed:** `src/heartbeat.js`

---

## D-019: Stalled Project Detection (Autonomous Catch-Up)

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** Projects that were already stuck in a phase (before D-018 was implemented) had no recovery path. Also covers edge cases where a phase mission fails or gets lost.

**Decision:** `checkStalledProjects()` runs every heartbeat tick. Scans active projects for any that have no pending proposals AND no active missions. Auto-creates the missing phase mission when detected.

**Rationale:** Defense-in-depth for autonomous operation. Even if auto-phase-progression fails or misses a case, stalled detection catches it on the next tick. Cost: one DB query per tick.

**Files changed:** `src/heartbeat.js`

---

## D-020: Optimistic Announcement Flagging (Mark Before Execute)

**Date:** Feb 17, 2026 | **Status:** Active | **Author:** Kael

**Context:** `announceCompletedSteps()` published to Notion/Google Drive, then set `announced = true`. When Supabase returned intermittent Cloudflare 500 errors, the flag never persisted — causing infinite duplicate Notion pages and Google Docs every 30-second poll cycle.

**Decision:** Mark `announced = true` BEFORE publishing. If the flag can't be set (Supabase error), skip the step entirely. A missed announcement is recoverable (check DB); infinite duplicate documents are not.

**Rationale:** Reusable pattern for all side-effect operations: set the "processed" flag first, execute second. The cost of a missed execution (can retry manually) is far lower than infinite duplicate executions. Applies to any polling-based system with external side effects.

**Trade-offs:** If the system crashes between marking and publishing, the step is never announced. Acceptable — the data exists in the DB and can be re-announced manually.

---

## D-021: Persona Enrichment over Lessons for Upskilling

**Date:** Feb 22, 2026 | **Status:** Active | **Author:** Frasier

**Context:** All 7 agents produced generic, surface-level output. Two upskilling approaches considered: (A) save skill methodologies as lessons (retrieved top-5 by importance, may be displaced), or (B) inject distilled methodologies directly into agent persona prompts (100% retrieval, always present in every LLM call).

**Decision:** Persona enrichment (B) as primary. Also add skill tracking to ROLE_SKILLS/SKILL_KEYWORDS for growth measurement.

**Rationale:** Persona modifications have 100% retrieval — they're part of the system prompt on every call. Lessons compete for top-5 slots and can be displaced by newer lessons. Expert frameworks need to be consistently present, not intermittently recalled.

**Trade-offs:** Larger system prompts (more tokens per call). Persona is harder to modify surgically than individual lessons. Acceptable because expert methodology is foundational, not situational.

---

## D-022: Skill Security Protocol (4-Scanner Pipeline)

**Date:** Feb 22, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Skills sourced from public GitHub repos could contain malicious code, prompt injection, or data exfiltration. Need a repeatable process to vet skills before installation.

**Decision:** Zero-tolerance 4-scanner pipeline: (1) Snyk mcp-scan, (2) Cisco AI Skill Scanner, (3) SkillAudit API, (4) manual line-by-line review. Any scanner flag = auto-reject.

**Rationale:** Defense in depth — no single scanner catches everything. Manual review as final gate catches semantic attacks that automated tools miss. Protocol documented at `_knowledge/decisions/skill-security-protocol.md`.

**Trade-offs:** Slower skill adoption (each skill takes ~2 min to fully vet). Acceptable — security over speed for code that runs in agent system prompts.

---

## D-023: Role Aliases for Flexible Skill Matching

**Date:** Feb 22, 2026 | **Status:** Active | **Author:** Frasier

**Context:** `initializeSkills()` matched roles via substring against ROLE_SKILLS keys. Roles like "Chief of Staff / COO" and "Memory System Tester" didn't match `strategy` or `qa` keys, falling back to a single `general_task_execution` skill.

**Decision:** Add role aliases — multiple ROLE_SKILLS keys (`chief`, `coo`, `business`, `test`, `writer`, `editor`, `archivist`, etc.) mapping to the same skill arrays via shared constants.

**Rationale:** Simple, zero-cost, DRY (shared arrays avoid duplication). Works for both `initializeSkills()` in runtime and `enrich-personas.js` migration script.

**Trade-offs:** ROLE_SKILLS object is larger but still a static lookup map. No performance impact.

---

## D-024: Deep Work Pipeline — Multi-Phase Execution Over Single-Shot LLM

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Agents made exactly 1 LLM call per task with no mandatory web research, no self-critique, and no revision loop. Research tasks produced shallow, un-cited deliverables. Worker had no mechanism to verify or improve its own output before submitting.

**Decision:** Replace single-shot LLM call with a structured 5-phase pipeline: decompose → research → synthesize → self-critique → revise (conditional). Configurable per task type.

**Rationale:**
- Decompose breaks complex tasks into sub-questions + search queries (cheaper tier1 call)
- Research phase uses web search + page fetch (no LLM cost, real data)
- Synthesize produces deliverable with full agent persona + research context
- Self-critique evaluates on 1-5 scale and extracts a lesson (tier1, no extra prompt engineering)
- Revise only fires if critique < 3/5, capped at 1 attempt (prevents infinite loops)
- Simple tasks skip pipeline entirely (`skipPipeline: true`)
- Engineering/creative tasks skip research (`skipResearch: true`)

**Trade-offs:** 3-4 LLM calls per step instead of 1. Per-step cost: $0.001-0.02 → $0.004-0.05. Web fetches capped at 8 per step for 1GB VPS safety. Phases run sequentially (no parallelism).

**Files:** `src/lib/pipeline.js`, `src/worker.js`

---

## D-025: Approach Memory — Agents Accumulate Judgment

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Every task decomposition started from scratch. An agent that had successfully researched "AI tutoring platforms" last week would decompose a similar task identically to an agent with zero experience. No mechanism to learn *how to approach* tasks, only *what* the results were.

**Decision:** `approach_memory` table stores completed approaches (task summary, topic tags, decomposition, search queries, effective queries, critique score). Before decomposing a new task, the pipeline retrieves similar past approaches by topic tag overlap and injects them as hints.

**Rationale:** Zero additional LLM calls — pure PostgreSQL retrieval via GIN-indexed array overlap. Agents accumulate judgment about *how to think about* tasks, not just task results. Only the agent's own approaches are retrieved (no cross-agent contamination).

**Trade-offs:** Additional DB query per decompose phase. Approach quality depends on critique accuracy. GIN index adds slight write overhead.

**Files:** `src/lib/approach_memory.js`, `sql/004_deep_work_pipeline.sql`

---

## D-026: Autonomous Step Approval — Policy-Driven Auto-Approve

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Every completed step went through full QA → Team Lead review, regardless of quality or importance. Intermediate steps in a 5-step mission created 10 review cycles, even when the step was clearly high-quality. This bottlenecked throughput and wasted LLM budget on unnecessary reviews.

**Decision:** Policy-driven autonomy in `processApprovals()`:
- Critique score ≥ 4.0 on intermediate step → auto-approve (skip all review)
- Critique score ≥ 3.0 on intermediate step → QA-only (skip Team Lead)
- Final step → always full QA + Team Lead review
- Tier3 step → always full review
- Missing critique → full review (backward compatible)
- Configurable via `policy` table row (thresholds, enable/disable)

**Rationale:** High-quality intermediate work doesn't need human review. Final deliverables always get full scrutiny. Policy-driven means thresholds are adjustable without code changes.

**Trade-offs:** Risk of auto-approving a step that looks good by score but has domain errors. Mitigated: final step always reviewed, and approach memory captures quality trends over time.

**Files:** `src/lib/autonomy.js`, `src/heartbeat.js`, `sql/004_deep_work_pipeline.sql`

---

## D-027: Linear as Mission Control — Labels Not Members

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Dhroov had no visibility into what Frasier's agents were doing. Discord was the only interface — commands in, deliverables out. No dashboard, no project-level tracking, no way to see progress at a glance.

**Decision:** Integrate Linear as a two-way project management layer:
- Single API key, agents represented as labels (not individual accounts). Zero extra seat cost.
- Frasier → Linear: missions become projects, steps become issues, status auto-syncs.
- Linear → Frasier: Dhroov creates project + first task, Frasier picks it up via webhook.
- Discord stays as real-time channel — both channels always in sync.
- LLM polishes titles/descriptions (tier-1 MiniMax) for clean presentation.
- All sync is fire-and-forget — Linear failure never blocks mission execution.

**Rationale:** Linear is purpose-built for project/ticket workflows. Custom Mission Control app would take weeks to replicate what Linear does out of the box. Labels avoid per-seat costs and fake email complexity.

**Rejected:** Custom NextJS+Convex dashboard (over-engineered), individual agent Linear accounts (unnecessary cost), Notion (already used for deliverables, not ideal for ticket workflows).

**Trade-offs:** Depends on Linear's free tier (250 active issues). At current throughput (~5-10 missions/week) this is fine. Custom fields require Linear UI or API setup.

**Files:** `src/lib/linear.js`, `src/lib/missions.js`, `src/heartbeat.js`, `src/discord_bot.js`, `sql/005_linear_integration.sql`

---

## D-028: Hybrid Skill Encoding — Lean Personas + On-Demand Full Injection

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** 5 of 7 installed Claude Code skills contain patterns applicable to runtime agents (task decomposition, dependency tracking, design orchestration, etc.). Need to decide how to embed this knowledge into agent system prompts for LLM calls. Three options: (A) full skill content always in prompt, (B) distilled bullet points only, (C) hybrid.

**Decision:** Hybrid approach (Option C):
- **Base layer:** Distill each skill's key patterns into ~100-200 token compact instructions. These live in the agent's persona and are always present — low cost, always available.
- **On-demand layer:** Full skill content injected into the prompt only when the agent is actively performing that specific task type (e.g., full decomposition skill loads only when Frasier is decomposing a project).

**Applicable skills and targets:**
- task-coordination-strategies → Frasier (decomposition, dependency graphs)
- design-orchestration → Frasier (risk assessment, escalation logic)
- task-execution-engine → All agents (task format, acceptance criteria, self-assessment)
- writing-plans → Frasier + Spike (plan structure, TDD)
- dispatching-parallel-agents → Frasier (parallel task dispatch prompts)

**Rationale:** Agents make many LLM calls daily. Stacking 3-4 full skills (500-2,000 tokens each) onto every call wastes budget. But distilled-only loses nuance when the agent genuinely needs the full methodology. Hybrid gives lean-by-default, comprehensive-when-it-matters.

**Trade-offs:** Slightly more complex prompt construction — worker must detect task type and conditionally inject full skill content. Manageable within existing `buildAgentPrompt()` pattern.

**Files:** `src/lib/skill_encodings.js`, `src/lib/memory.js`

---

## D-029: Message Classification Replaces Action-Tag Parsing

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Frasier's response was parsed for action tags (`[ACTION:PROPOSAL]`, `[ACTION:NEW_PROJECT]`, `[PHASES]`) using fragile regex. The LLM had to simultaneously converse AND embed machine-readable tags. Tags were frequently malformed, missed, or hallucinated.

**Decision:** Separate classification from conversation. A dedicated T1 LLM call classifies the Discord message (`casual`/`simple_task`/`full_project`) before Frasier responds. Classification drives routing; Frasier focuses on conversation. Default to `simple_task` when confidence < 0.7.

**Rationale:** Single-responsibility principle. Classification is cheap (T1, ~$0.001). Frasier's prompt is simpler without action-tag instructions (~400 fewer tokens for casual messages). `simple_task` routes to the exact same proposal pipeline — zero breakage for existing flows.

**Trade-offs:** Extra T1 LLM call per Discord message. Acceptable — classification is the gateway to all subsequent work.

**Files:** `src/discord_bot.js`, `sql/006_task_decomposition.sql`

---

## D-030: Frasier as Sole Decomposer — No Plan Approval Gate

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** When Dhroov sends a full-project directive ("build me a real estate AI agent"), someone needs to break it into tasks, assign agents, and manage dependencies. Two options: (A) Frasier proposes a plan, waits for Dhroov's approval, then executes. (B) Frasier decomposes and executes autonomously — Dhroov sees progress in Linear.

**Decision:** Option B — full autonomy. Frasier decomposes via T2 LLM call, validates the dependency graph, hires agents if needed, creates all steps, and begins execution immediately. Dhroov tracks progress in Linear. Escalation to founder only for: budget decisions, strategic ambiguity, brand/reputation risk, or capability gaps that can't be hired for.

**Rationale:** Dhroov explicitly wants autonomous operation (D-018, D-012). A plan-approval gate defeats the purpose — it's just a more elaborate version of manual phase triggering. Linear provides full visibility without blocking execution.

**Trade-offs:** If Frasier misinterprets the directive, work is wasted before Dhroov notices. Mitigated by escalation logic for genuine ambiguity, and Linear visibility for early course-correction.

**Files:** `src/lib/decomposition.js`

---

## D-031: DAG Dependencies Over Step-Order Chains

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** Step execution was controlled by `step_order` — a linear chain where step N+1 couldn't start until step N completed. This meant all tasks within a mission ran sequentially, even when they had no actual dependency (e.g., two independent research tasks).

**Decision:** `step_dependencies` table tracks explicit dependencies between steps. `areAllDependenciesMet()` returns tri-state: `true` (all deps satisfied), `false` (blocked), `null` (no deps exist — use legacy step_order). Worker claims up to 3 eligible steps per tick, executes sequentially to stay within 1GB RAM.

**Rationale:** Real projects have diamond dependencies, parallel workstreams, and fan-in patterns that a linear chain can't express. DAG + parallel_group gives Frasier the vocabulary to decompose projects realistically. Tri-state return preserves backward compatibility for all existing missions.

**Trade-offs:** More complex eligibility checking. Extra DB queries per step (check deps table). Sequential execution within a tick means "parallelism" is tick-level, not true concurrency — acceptable given 1GB RAM constraint.

**Files:** `src/lib/missions.js`, `src/worker.js`, `sql/006_task_decomposition.sql`

---

## D-032: Calibrated Self-Critique — "3.0 Is GOOD"

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier

**Context:** The original self-critique scored on a generic 1-5 scale with no anchors. LLMs defaulted to scoring everything 4/5 ("above average") because they're trained to be positive. A 4/5 score on mediocre work meant revision never triggered, and the quality gate was effectively disabled.

**Decision:** 4-dimension rubric (depth, accuracy, actionability, completeness) with concrete anchors at each level. Explicit calibration: "3.0 is GOOD work. 4.0 is EXCELLENT. 5.0 is rare." Revision triggers on ANY dimension < 3.0 or average < 3.5 (was: overall < 3.0). Max 2 revision attempts (was: 1). Citation score from research phase injected into accuracy context.

**Rationale:** LLMs need explicit scoring calibration or they default to inflated scores. Dimension-level scoring prevents a high score in one area from hiding a critical gap in another. "Be BRUTALLY HONEST" instruction counters the LLM's tendency toward politeness.

**Trade-offs:** Stricter criteria may increase revision rate and LLM cost. Mitigated by max 2 attempts and the "proceed with what's available" fallback.

**Files:** `src/lib/pipeline.js`

---

## D-033: QA Agents Are SMEs in Quality, Not Domain

**Date:** Feb 23, 2026 | **Status:** Active | **Author:** Frasier (per Zero's directive)

**Context:** Ein (QA) reviewed all deliverables with the same full-scope rubric. This meant Ein was judging whether Edward's market research showed "genuine domain expertise" — but Ein is a QA specialist, not a research expert. When QA rejects domain work for "insufficient depth," the feedback is uninformed.

**Decision:** When QA reviews non-engineering domain work, scope is limited to technical quality only: structure, professionalism, citation accuracy, acceptance criteria. Domain expertise judgment is left to the assigned SME agent (self-assessment) and domain expert reviewers. Engineering tasks: Ein gets full scope (QA IS the domain expert for code quality).

**Rationale:** Zero's directive: "Agents are SMEs — QA doesn't judge domain expertise, only technical quality." Each agent is hired for their domain — the QA agent's value is in catching technical/structural issues, not second-guessing domain conclusions.

**Trade-offs:** Reduces QA's ability to catch domain errors in non-engineering work. Mitigated by calibrated self-critique (D-032) and domain expert review routing (D-015).

**Files:** `src/lib/conversations.js`
