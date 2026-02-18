# Frasier — Decision Log

All architectural and design decisions, with context and trade-offs.

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
