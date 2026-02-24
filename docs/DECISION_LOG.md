# Frasier — Decision Log

All architectural and design decisions, with context and trade-offs.

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
