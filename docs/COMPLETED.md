# Frasier — Completed Features

> Last updated: Feb 24, 2026 (v0.10.0)

---

## Capability-Aware Decomposition (v0.10.0)

### Capability Manifest
- **File:** `src/lib/capabilities.js` (new)
- `ROLE_CAPABILITIES` constant: structured data for 7 roles (research, engineering, content, strategy, marketing, qa, knowledge)
- Each role defines: `tools` (what agents can use), `strengths` (what they're good at), `cannot` (explicit hard limits)
- `GLOBAL_CONSTRAINTS` constant: system-wide limits (8 fetches/task, no headless browser, no auth, no file creation)
- `buildCapabilityManifest()` formats all of the above into a text block for prompt injection

### Decomposition Prompt Enhancement
- **File:** `src/lib/decomposition.js` — `buildDecompositionPrompt()`
- Capability manifest injected into the decomposition prompt alongside agent roster
- New `CRITICAL PLANNING RULES` section instructs the LLM to:
  - Only create tasks achievable with listed tools
  - Set realistic acceptance criteria
  - Adapt creatively when direct methods are unavailable (e.g., "mine Reddit threads" → "search for Reddit content via Brave")
- Supports `feasibilityFeedback` parameter for re-decomposition prompts

### Feasibility Validation Gate
- **File:** `src/lib/capabilities.js` — `validatePlanFeasibility()`
- Cheap T1 LLM call reviews each step against the capability manifest after decomposition
- Returns `{ feasible, issues }` where each issue has `taskId`, `issue`, and `suggestion`
- Fail-open: if validation breaks (bad JSON, LLM error), execution proceeds — QA pipeline is still a safety net
- On failure: one re-decomposition with specific issue feedback injected into the prompt
- After max retries: proceeds with best available plan (never blocks execution)
- Skipped for: fallback single-task plans, escalated plans

### Tests
- 26 new tests in `tests/v010/capability-aware-decomposition.test.js`
- 9 capability manifest tests (structure, content, constraints)
- 4 prompt injection tests (manifest present, CANNOT constraints, feasibility instruction)
- 7 feasibility validation tests (pass, fail, tier routing, fail-open, prompt content)
- 6 flow integration tests (validation after decomp, re-decomp, retry feedback, max retries, skip conditions)
- Total: 488 tests across 34 suites, zero regressions

---

## Integration Bug Fixes (v0.9.4)

### Classification Wiring
- **File:** `src/discord_bot.js` — `resolveActionTag()`
- `classifyMessage()` now called on every Discord message before Frasier responds
- `resolveActionTag()` overrides Frasier's ACTION tag when T1 classifier says `full_project` (confidence ≥ 0.7)
- Classification hint injected into Frasier's prompt for full_project messages
- Respects `[ACTION:RESPONSE]` — won't force work on casual messages

### Linear Description Truncation
- **File:** `src/lib/linear.js` — `truncateForLinear()`
- Caps descriptions at 255 chars with `...` suffix
- Applied to both `syncMissionToLinear()` and `syncDecomposedProjectToLinear()`

### Agent ID Sanitization
- **File:** `src/lib/models.js` — `logModelUsage()`
- Sanitizes `agentId` to `null` for non-agent callers (e.g., `'system'`)
- Prevents FK constraint violations on `model_usage` table

---

## Decomposition Wiring (v0.9.2)

### Runtime Decomposition
- **File:** `src/lib/decomposition.js` — `handleNewProjectDecomposition()`
- Orchestrates: create mission → link to project → decompose into DAG → return result
- Called from `discord_bot.js` `[ACTION:NEW_PROJECT]` handler
- Bypasses proposal→heartbeat→accept flow (saves ~30s per project)
- Fallback: if decomposition fails, creates a simple proposal (old behavior)
- Discord response shows task count and parallel groups

### Linear Idempotent Sync
- **File:** `src/lib/linear.js` — `syncMissionToLinear()`
- Checks `linear_sync` for existing records before creating a Linear project
- Prevents duplicate projects when both `createMission()` and `decomposeProject()` call sync

---

## Linear Status Sync + Revision Cap (v0.9.1)

See CHANGELOG.md for full details.

---

## Autonomous Team Execution (v0.9.0)

### Task Decomposition Engine
- **File:** `src/lib/decomposition.js`
- Frasier decomposes full-project directives into parallel/sequential task DAGs
- T2 LLM call with: directive, agent roster, approach memory hints
- Structured JSON output: tasks with IDs, dependencies, parallel groups, required roles, acceptance criteria
- `validateDependencyGraph()` — Kahn's algorithm topological sort rejects cyclic dependencies
- `createStepsFromPlan()` — two-pass: creates steps first, then dependency rows (maps task IDs to step IDs)
- Proactive hiring: `autoHireGapAgent()` per `hiring_needed` entry before creating steps
- Escalation: logs to `escalation_log` when founder input genuinely needed, halts step creation
- Approach memory: retrieves similar past approaches as decomposition hints, saves successful plans
- Fallback: invalid JSON → creates single-mission with full directive (never blocks execution)

### Message Classification
- **File:** `src/discord_bot.js` — `classifyMessage()`
- Dedicated T1 LLM call classifies every Discord message: `casual` / `simple_task` / `full_project`
- Separate from Frasier's response (clean separation of classification vs. conversation)
- Defaults to `simple_task` when confidence < 0.7
- Persisted to `message_classifications` table with reasoning
- Routing:
  - `casual` → conversational response (simplified prompt, ~400 tokens saved)
  - `simple_task` → existing proposal pipeline (backward compatible)
  - `full_project` → decomposition engine
- Replaces brittle action-tag parsing (`[ACTION:PROPOSAL]`, `[ACTION:NEW_PROJECT]`)

### DAG-Based Step Execution
- **File:** `src/lib/missions.js`, `src/worker.js`
- `step_dependencies` table tracks inter-step dependencies (replaces rigid `step_order`)
- `areAllDependenciesMet(stepId)` — tri-state return:
  - `true` → all DAG dependencies satisfied, step is eligible
  - `false` → at least one dependency unsatisfied, step is blocked
  - `null` → no DAG dependencies exist, use legacy `step_order` check
- `getPredecessorOutputs(stepId)` — fetches results from all completed dependencies (truncated to 6000 chars each)
- Worker claims up to 3 eligible steps per tick, executes sequentially (not `Promise.all` — 1GB RAM safety)
- Predecessor outputs injected as context: `## PREDECESSOR OUTPUT (from AgentName)`
- Full backward compatibility: legacy `step_order` chains work for existing missions

### Research Depth & Citation Enforcement
- **File:** `src/lib/pipeline.js` (research phase), `src/lib/context.js` (output templates)
- Research phase requires 3+ substantive sources (>500 chars of content)
- If < 3 sources: generates refined queries via T1, retries search (max 2 retries)
- Structured source list passed to synthesis: `[{ url, title, keyDataPoints, charCount }]`
- Synthesis prompt includes `## AVAILABLE SOURCES` + "Use ONLY these sources for factual claims"
- `validateSourceCitations(output, researchSources)` — string-matching citation validator (zero LLM cost)
- `citation_score` stored in critique phase metadata
- Every role's output template includes: "Every factual claim MUST include its source in [brackets]"

### Calibrated Self-Critique
- **File:** `src/lib/pipeline.js` (critique phase)
- 4-dimension rubric scoring with concrete anchors:
  - DEPTH: 1.0 (generic) → 5.0 (expert-level, novel connections)
  - ACCURACY: 1.0 (fabricated facts) → 5.0 (every claim cross-referenced)
  - ACTIONABILITY: 1.0 (vague advice) → 5.0 (ready-to-execute blueprint)
  - COMPLETENESS: 1.0 (<50% of request) → 5.0 (exhaustive)
- Calibration anchors: "3.0 is GOOD work. 5.0 is rare. Average = 2.5-3.0."
- `citation_score` from Phase 2 injected into accuracy dimension context
- Revision triggers: ANY dimension < 3.0 OR average < 3.5
- Max 2 revision attempts (up from 1)
- All 4 dimension scores stored in `pipeline_phases.metadata`

### Hybrid Skill Encoding (D-028)
- **File:** `src/lib/skill_encodings.js`
- 5 skill encodings from vetted Claude Code skills:
  - task-coordination-strategies → Frasier (orchestration)
  - design-orchestration → Frasier (risk, escalation)
  - task-execution-engine → All agents (task format, self-assessment)
  - writing-plans → Frasier + Engineering (plan structure)
  - dispatching-parallel-agents → Frasier (parallel dispatch)
- **Base layer:** ~100-200 token distilled instructions always in persona (role-filtered)
- **On-demand layer:** Full skill content injected when topic tags match trigger keywords
- 3000-token budget guard prevents prompt bloat
- Injected via `buildSkillInjection(role, topicTags)` in `buildAgentPrompt()`

### QA Scope Adjustment
- **File:** `src/lib/conversations.js` — `buildEnhancedReviewPrompt()`
- When QA (Ein) reviews non-engineering domain work:
  - Adds scope limitation: "Evaluate technical quality, completeness, and citation accuracy ONLY"
  - "Do not judge domain expertise — the assigned agent is the subject matter expert"
- Engineering tasks: Ein gets full review scope (domain + technical)
- Non-QA reviewers (team leads): always full scope regardless of task role
- Backward compatible via optional `options` parameter

### Decomposed Project Linear Sync
- **File:** `src/lib/linear.js` — `syncDecomposedProjectToLinear()`
- Creates 1 Linear project per decomposed plan
- Creates N Linear issues (one per task) with `[Wave X]` prefix
- Work type labels + frasier-managed label on each issue
- Sync records saved to `linear_sync` table
- Fire-and-forget — individual issue sync failure doesn't block others

### Database (SQL Migration 006)
- **File:** `sql/006_task_decomposition.sql`
- `message_classifications` — persists Discord message classification results
- `step_dependencies` — DAG dependency tracking between mission steps
- `decomposition_plans` — stores structured plans with task graphs
- `escalation_log` — tracks founder escalation requests and resolutions
- Decomposition policy row in `policy` table
- RLS + service_role policies, indexes on FKs and query patterns

### Tests
- 131 new tests across 8 suites in `tests/v09/`
- `schema.test.js` (6): new table helpers and factories
- `research-quality.test.js` (12): source depth, citation validation, anti-hallucination
- `critique-calibration.test.js` (10): rubric scoring, calibration anchors, revision triggers
- `classification.test.js` (8): message classification, routing, persistence
- `decomposition.test.js` (22): decompose, DAG validation, step creation, hiring, escalation, approach memory
- `dag-execution.test.js` (17): DAG eligibility, backward compat, context flow, chaining
- `skill-encoding.test.js` (7): distilled + on-demand injection, role filtering, token budget
- `linear-decomposition.test.js` (7): Linear sync, QA scope adjustment
- Total: 379 tests across 26 suites, zero regressions

---

## Deep Work Pipeline (v0.7.0)

### Multi-Phase Task Execution
- **File:** `src/lib/pipeline.js` (605 lines)
- Replaces single-shot LLM call with structured 5-phase pipeline
- **Phase 1 — DECOMPOSE (tier1):** Breaks task into 2-4 sub-questions + web search queries
- **Phase 2 — RESEARCH (no LLM):** Executes search queries via `web.searchWeb()` + fetches top pages via `web.fetchPage()`. Capped at 8 fetches per step (1GB VPS safe)
- **Phase 3 — SYNTHESIZE (step's tier):** Full agent prompt + memory + research data → actual deliverable with citations
- **Phase 4 — SELF-CRITIQUE (tier1):** Agent evaluates own work on 1-5 scale, identifies gaps, extracts lesson
- **Phase 5 — REVISE (conditional):** Only fires if critique < 3/5, capped at 1 attempt (prevents loops)
- Configurable per task type:
  - `skipPipeline: true` → simple/trivial tasks (legacy single-shot)
  - `skipResearch: true` → engineering/creative tasks (decompose + synthesize + critique)
  - Default: full pipeline for research/analysis/strategy
- All phases logged to `pipeline_phases` table with timing, tokens, and scores

### Approach Memory ("What Worked Before")
- **File:** `src/lib/approach_memory.js` (139 lines)
- After every completed step, saves: task summary, topic tags, decomposition, search queries, effective queries, critique score
- Before decomposing a new task, retrieves similar past approaches by topic tag overlap (PostgreSQL GIN index)
- Agents accumulate judgment about *how to approach* tasks, not just results
- Zero additional LLM calls — pure database retrieval
- Only retrieves own agent's approaches (no cross-agent contamination)

### Autonomous Step Approval
- **File:** `src/lib/autonomy.js` (135 lines)
- Policy-driven auto-approval at top of `processApprovals()` in heartbeat
- Critique score ≥ 4.0 on intermediate step → auto-approve (skip all review)
- Critique score ≥ 3.0 on intermediate step → QA-only (skip Team Lead)
- Final step → always full QA + Team Lead review
- Tier3 step → always full review
- Missing critique → full review (backward compatible)
- Configurable via `policy` table (`autonomy` row) — thresholds adjustable without code changes

### Database (SQL Migration 004)
- **File:** `sql/004_deep_work_pipeline.sql`
- `pipeline_phases` table: audit trail for every phase of every step execution
- `approach_memory` table: accumulated approach judgment per agent
- Autonomy policy row in existing `policy` table
- RLS + service_role policies on both tables

### Tests
- 41 new tests across 3 suites in `tests/deep-work/`
- `pipeline.test.js` (22 tests): full flow, skip configs, error handling, malformed JSON
- `approach-memory.test.js` (10 tests): save, find, format, agent isolation
- `autonomy.test.js` (9 tests): auto-approve, QA-only, full review, policy disabled, backward compat
- Total: 210 tests across 16 suites, zero regressions

---

## Core Pipeline

### Mission Lifecycle (proposal → mission → steps → result)
- **Files:** `heartbeat.js`, `worker.js`, `src/lib/missions.js`
- Zero sends request via Discord DM → `mission_proposals` row created
- Heartbeat polls proposals → creates mission + steps → routes to best agent via keyword matching
- Worker picks up pending steps → builds agent prompt (identity + memory + task) → calls LLM → saves result
- Step goes to `in_review` status for approval chain
- Mission completes when all steps are approved

### Approval Chain (QA → Team Lead)
- **Files:** `worker.js` (processNextReview), `heartbeat.js` (processApprovals), `src/lib/missions.js`
- Step completes → heartbeat assigns QA agent for review
- QA approves → heartbeat escalates to Team Lead
- Team Lead approves → step marked `completed`, mission checked for completion
- Rejection → step sent back to `pending` for revision by original agent

### Tiered LLM Routing
- **File:** `src/lib/models.js`
- Tier 1 (MiniMax via OpenRouter): default for all tasks, cheapest
- Tier 2 (Claude Sonnet 4.5 via OpenRouter): complex tasks detected by keywords (strategy, analysis, research, final steps)
- Tier 3 (Claude Opus via OpenRouter): high-stakes deliverables (PRDs, design docs, executive reports) — auto-routes by keyword, no approval needed
- Fallback chain: T3→T2→T1 if higher tier fails
- Auto-retry: Tier 1 retries once after 5s on failure

---

## Memory System

### Persistent Cumulative Memory
- **File:** `src/lib/memory.js`
- Hybrid retrieval: last 10 recent + 15 topic-matched + top 5 lessons = ~30 memories per prompt
- Every task, conversation, decision, and observation creates a memory row
- Memory never resets, never expires, never degrades
- `buildAgentPrompt()` combines: static persona + retrieved memories + skills + web/social instructions

### Lesson Generation
- **File:** `worker.js` (maybeGenerateLesson, generateLessonFromRejection)
- Every 5th completed task: agent reflects via Tier 1 LLM call → distills one lesson → saved permanently
- Every QA rejection: feedback saved directly as lesson (importance 8, no LLM call)
- Lessons always included in top 5 by importance in every future prompt

### Founder Conversation Memory
- **File:** `discord_bot.js`
- Each conversation turn saved as its own memory row (not combined)
- Real topic extraction via keyword matching + proper noun slugging (e.g., "Patrick Mahomes" → `patrick-mahomes`)
- Tags: `['founder-interaction', 'founder-request', ...contentTopics]` — consistent between save and retrieve
- Founder directives detected and saved as permanent lessons (importance 9)
- 14 topic categories: football, crypto, markets, ai, startups, music, movies, food, travel, gaming, fitness, politics, weather, tech

### Persona-Based Upskilling
- **File:** `worker.js` (maybeUpskillAgent)
- After 5th QA rejection on the same step:
  1. Fetches all 5 rejection feedbacks from `approval_chain`
  2. One Tier 1 LLM call analyzes patterns → identifies skill gap
  3. Appends `LEARNED EXPERTISE` block to agent's SEP persona prompt
  4. Saves as new persona row (old preserved as history)
  5. Logs `agent_upskilled` event → Discord notification to Zero
  6. Step already reset to pending → agent retries with upgraded persona
- Fires exactly once per step (only on 5th rejection, not 6th+)

---

## Skills System

### Skill Tracking & Growth
- **File:** `src/lib/skills.js`
- Agent skills stored in `agent_skills` table with proficiency level and usage count
- `trackSkillUsage()` called after every completed task
- Skills improve with use: more tasks → higher proficiency
- Cross-training: agents can learn adjacent skills at reduced proficiency
- `formatSkillsForPrompt()` injects skill context into agent's system prompt

### Expert Methodology Enrichment (v0.6.0)
- **File:** `scripts/enrich-personas.js` (migration), `src/lib/skills.js` (runtime)
- 48 skills sourced from Antigravity catalog, vetted through 3-scanner security pipeline + manual review
- Distilled expert methodologies injected into agent persona prompts:
  - **Strategy roles:** RICE prioritization, MoSCoW, ADRs, SaaS metrics, unit economics, three-scenario planning
  - **Research roles:** Multi-step research protocol, Porter's Five Forces, market sizing (TAM/SAM/SOM), data storytelling
  - **Content roles:** SEO content scoring, PLFS framework, content auditing rubrics, marketing psychology triggers
  - **Engineer roles:** Clean code principles, architecture patterns (SOLID, DRY, YAGNI), database design, API design scoring
  - **QA roles:** STRIDE threat modeling, test quality scoring, 80/20 coverage, systematic debugging protocol
  - **Growth roles:** Programmatic SEO, conversion optimization, A/B testing methodology, keyword strategy
  - **Knowledge roles:** Documentation architecture, wiki structure, decision records, prose quality scoring
- ROLE_SKILLS expanded from 3 to 9-11 skills per role with role aliases for flexible matching
- SKILL_KEYWORDS entries for all 48 new skills enable keyword-based growth tracking
- Migration is idempotent — checks `<!-- ENRICHED v0.6.0 -->` marker before appending

---

## Agent Management

### Dynamic Hiring System
- **File:** `src/lib/agents.js`, `heartbeat.js`, `discord_bot.js`
- When a task arrives that no agent can handle → hiring proposal created
- Zero approves via `!hire <id>` → heartbeat picks up → creates agent with random anime name from pool
- Persona generated via LLM (Persona Architect prompt)
- Name pool: Cowboy Bebop, Evangelion, Gundam Wing characters
- Duplicate detection prevents multiple proposals for same role+team

### Frasier (Chief of Staff)
- **File:** `scripts/setup_frasier.js`
- Full SEP prompt with $20k/month north star, PRIME DIRECTIVE, 5 CORE RESPONSIBILITIES
- Handles: Discord DM conversations, strategic delegation, approval decisions
- Persona verified in Supabase — matches spec

---

## Conversations

### Standup System
- **File:** `heartbeat.js` (checkDailyStandup)
- Triggers daily at 9:00am ET
- Each active agent gets standup prompt → responds with priorities, blockers, plans
- Responses saved to `conversation_history` and agent memory
- Event logged on completion

### Conversation Framework
- **File:** `src/lib/conversations.js`
- Types implemented: standup, handoff, work_review, delegation, report, brainstorm
- Turn-based: Agent A speaks → stored → Agent B reads + responds → stored
- Full conversation history in `conversation_history` table
- Review prompts, delegation prompts, handoff prompts all built

---

## Integrations

### Web Access (Zero Cost)
- **File:** `src/lib/web.js`
- DuckDuckGo HTML search (no API key needed)
- HTTP page fetch with `htmlToText()` conversion
- Agents embed `[WEB_SEARCH:query]` or `[WEB_FETCH:url]` tags in output
- Worker resolves tags → re-calls LLM with live data injected

### Social Media (Buffer)
- **File:** `src/lib/social.js`
- Buffer API integration for scheduling posts
- Agents embed `[SOCIAL_POST:content]` tags → worker resolves and queues to Buffer
- Free tier: 3 channels, 10 posts each

### Google Drive Backup
- **File:** `src/lib/google_drive.js`
- Daily backup at 3:00am ET (heartbeat scheduled)
- Exports 9 tables as JSON files to dated folder in Drive
- Service account + Workspace impersonation

### GitHub Daily State Push
- **File:** `src/lib/github.js`
- Daily push at 4:00am ET (heartbeat scheduled)
- Pushes: agents, personas, teams, policy, skills as JSON to `state/` directory
- GitHub Contents API (no extra dependencies)

### Notion Task Boards
- **File:** `src/lib/notion.js`
- Task board database with columns: To Do, In Progress, In Review, Done
- Supports Assignee, Priority, Mission ID, Due Date
- Mission creation syncs to Notion (non-blocking)

---

## Monitoring & Alerting

### Health Checks
- **File:** `src/lib/health.js`
- Checks: Supabase, OpenRouter, Discord, RAM, Bandwidth
- Runs every 10 minutes via heartbeat
- Results written to `health_checks` table
- Failures trigger alerts

### Cost Alerts
- **File:** `heartbeat.js` (runMonitoring)
- Checks daily LLM spend against policy threshold ($10/day default)
- Fires once per day max (deduplication)

### Daily Summary
- **File:** `heartbeat.js` (checkDailySummary)
- Triggers at 9:30am ET (30 min after standup)
- Compiles: costs, errors, health status, agent count, event summary
- Sent to both Discord AND email (drew@epyon.capital)

### Alert System
- **File:** `src/lib/alerts.js`
- Dual-channel: Discord + email (Gmail SMTP via nodemailer)
- Severity levels: info, warning, error, critical
- Fail-silent email (never blocks the system)

---

## Discord Bot Commands

| Command | Function |
|---------|----------|
| `!status` | System overview (agents, teams, missions) |
| `!teams` | List teams and agents per team |
| `!roster` | Full roster + pending hiring proposals |
| `!costs` | Today's LLM costs by tier |
| `!approve <step_id>` | Approve Tier 3 escalation |
| `!hire <id>` | Approve hiring proposal |
| `!reject <id>` | Reject hiring proposal |
| `!fire <name>` | Retire an agent |
| `!activate <team_id>` | Activate a team |
| `!deactivate <team_id>` | Deactivate a team |
| `!newbiz <name>` | Create a business unit |
| `!content list` | Show drafts waiting for review (top 10 by score) |
| `!content view <id>` | View full draft details (supports 8-char short IDs) |
| `!content approve <id>` | Approve a draft for publishing |
| `!content reject <id>` | Reject a draft permanently |
| `!content revise <id> [feedback]` | Send draft back for revision with optional feedback |
| `!content stats` | Pipeline statistics (counts by status, published last 7d, new research) |
| `!watchlist list` | Show current watchlist grouped by category |
| `!watchlist add topic "AI agents"` | Add a topic to Scout's watchlist |
| `!watchlist add account @handle` | Add a Twitter account to watchlist |
| `!watchlist remove <id or value>` | Remove a watchlist item |
| `!help` | Show available commands |
| DM to Frasier | Casual chat or task delegation |

---

## Contentron Integration (v0.5.0)

### Content Pipeline Commands
- **File created:** `src/lib/content.js`
- **File modified:** `src/discord_bot.js`
- **Tests:** 25 in `tests/contentron/content.test.js`
- **How it works:** Frasier writes to shared Supabase tables (`content_drafts`, `content_watchlist`). Contentron reads on its 2-hour tick. Zero direct communication.
- `!content list` — Top 10 queued drafts sorted by `score_overall` DESC, with remaining count
- `!content view <id>` — Full draft: content text, score breakdown, editor issues/suggestions, source topic. Supports 8-char short UUID.
- `!content approve <id>` — Sets `status='published'`, `published_at=NOW()`. Idempotent (no-op if already published).
- `!content reject <id>` — Sets `status='discarded'`. Idempotent (no-op if already discarded).
- `!content revise <id> [feedback]` — Sets `status='revision'`, appends feedback to `editor_suggestions`. Only works on queued drafts.
- `!content stats` — Counts by status + published last 7 days + new research items
- All mutations logged as events (`content_approved`, `content_rejected`, `content_revision_requested`)

### Watchlist Commands
- `!watchlist list` — All items grouped by category (Core Topics, Supporting Topics, Trending)
- `!watchlist add topic "multimodal AI"` — Inserts with `type='topic'`, `category='supporting'`, `added_by='dhroov'`
- `!watchlist add account @AnthropicAI` — Inserts with `type='twitter_account'`, `category='core'`
- `!watchlist remove <id or value>` — Deletes by UUID or by value string match
- Mutations logged as events (`watchlist_item_added`, `watchlist_item_removed`)

### Content Module (`src/lib/content.js`)
- 10 exported functions: `pillarName`, `listQueuedDrafts`, `viewDraft`, `approveDraft`, `rejectDraft`, `reviseDraft`, `getDraftStats`, `listWatchlist`, `addWatchlistItem`, `removeWatchlistItem`
- `resolveDraft(shortId)` helper: full UUID → exact match; < 36 chars → prefix match (fetch all, filter in JS)
- Pillar name mapping: 1="Idea to Shipped", 2="The Double-Click", 3="Live from the Workshop"
- All Supabase queries have error handling + console logging

---

## Policy Engine (Partial)
- **File:** `src/lib/policy.js`
- `ops_policy` table with versioned JSON rules
- Functions: `getPolicies()`, `getPolicy()`, `checkAuthorization()`, `checkTier3Authorization()`
- Tier 3 authorization enforced
- Spending limits, operating hours, cost alert threshold defined
- **Gap:** Agents don't proactively check policy before general actions

---

## System Overhaul (Feb 17, 2026) — 4 Critical Failures Fixed

> 84 unit tests added across 7 test files. All passing.

### Test Infrastructure (Phase 1)
- **Files:** `jest.config.js`, `tests/setup.js`, `tests/helpers.js`, `tests/mocks/supabase.js`, `tests/mocks/models.js`
- Jest configured for Node environment, `tests/**/*.test.js` pattern
- In-memory Supabase mock: full PostgREST query builder simulation (`.from().select().eq().single()`, `.insert()`, `.update()`, `.delete()`, `.overlaps()`, `.or()`, `.order()`, `.limit()`)
- Getter-based lazy resolution for select chains; dedicated `updateBuilder` for `.update().eq().select().single()` chains
- Mock utilities: `__setData(table, rows)`, `__getData(table)`, `__reset()`
- Factory helpers: `makeAgent()`, `makeTeam()`, `makeProposal()`, `makeMission()`, `makeStep()`, `makePersona()`
- Mock models.js: configurable `callLLM()`, `selectTier()`, `getModelCosts()`

### Roster Injection (Phase 2) — Fix: Frasier Doesn't Know Its Agents
- **Files modified:** `src/lib/agents.js`, `src/lib/memory.js`, `src/discord_bot.js`
- **Tests:** 7 in `tests/phase2/roster-injection.test.js`
- `buildRosterSection()` queries all teams + agents, formats as:
  ```
  ## Current Roster
  ### Team Research [active]
  - Gendo (Research Strategist) (Lead)
  - Edward (Research Analyst)
  ```
- Injected into `buildAgentPrompt()` only for `chief_of_staff` agents (Frasier)
- Naming convention enforced in `frasierInstructions`: "ALWAYS use Name (Role) format"
- Excludes retired agents, shows "No agents assigned" for empty teams

### Context Enrichment + Auto Tier Selection + Persona-as-Rubric (Phase 5) — Fix: Generic Deliverables
- **Files created:** `src/lib/context.js`
- **Files modified:** `src/lib/agents.js`, `src/lib/models.js`, `src/worker.js`, `src/heartbeat.js`
- **Tests:** 37 across `tests/phase5/context-enrichment.test.js`, `tier-selection.test.js`, `persona-rubric.test.js`

**Context Enrichment (`context.js`):**
- `buildTaskContext(step, agentRole)` constructs rich prompts combining:
  1. Zero's original message (traced via mission → proposal → raw_message)
  2. Domain-specific quality mandates (role-based instructions)
  3. Task description
  4. Structured output template (research, strategy, content, engineering, requirements, default)
  5. Quality standards block ("Never use filler phrases", "Always provide actionable recommendations")
- `selectOutputTemplate(taskDescription)` — keyword-based template selection with required sections (Executive Summary, Findings, Recommendations, etc.)
- `getDomainInstructions(agentRole)` — role-specific mandates (e.g., research must include "specific data points with sources", "TAM/SAM/SOM estimates", "risk matrix")

**Persona-as-Rubric (`agents.js`):**
- `QUALITY_RUBRICS` — Non-negotiable quality standards for: research, strategy, content, engineering, qa, marketing, knowledge
- `buildQualityRubric(role)` — returns role-specific rubric for persona injection
- `upgradePersonaWithRubric(agentId)` — appends `## Quality Standards (Non-Negotiable)` section to existing persona's `full_sep_prompt`
- Rubric is part of persona = 100% retrieval (always in system prompt, unlike lessons which compete for top 5 slots)

**Auto Tier Selection (`models.js` + `worker.js`):**
- Enhanced `selectTier(isComplex, taskDescription, stepContext)` — third parameter added
- Research/strategy/analysis/design/requirements keywords → auto-upgrade to tier2
- Final step in multi-step mission (`stepContext.isFinalStep`) → tier2
- `isLastStepInMission(step)` helper in worker.js queries highest step_order
- Only overrides if step had default tier1 (respects explicit tier assignments)

### Enhanced Reviews (Phase 6) — Fix: Weak Quality Gate
- **Files modified:** `src/lib/conversations.js`, `src/worker.js`
- **Tests:** 13 in `tests/phase6/enhanced-reviews.test.js`
- `buildEnhancedReviewPrompt()` — structured review with:
  - Zero's original message for context
  - 5-criterion rubric: Relevance (1-5), Depth (1-5), Actionability (1-5), Accuracy (1-5), Executive Quality (1-5)
  - Mandatory response format: SCORES → VERDICT ([APPROVE]/[REJECT]) → FEEDBACK
- `parseEnhancedReview(reviewContent)` — extracts scores, verdict, feedback
  - Auto-rejects on overall score < 3 (even if reviewer said APPROVE)
  - Returns `{ verdict, overallScore, scores, feedback, autoRejected }`
- Team Lead reviews use tier2; QA reviews use tier1
- Rejection feedback includes specific revision instructions

### Project Lifecycle (Phase 3) — Fix: No End-to-End Tracking
- **Files created:** `src/lib/projects.js`, `sql/003_projects.sql`
- **Files modified:** `src/heartbeat.js`, `src/discord_bot.js`
- **Tests:** 15 in `tests/phase3/projects.test.js`

**Database (`sql/003_projects.sql`):**
- `projects` table: name, description, status, phase, business_id, original_message, timestamps
- `project_missions` linking table: project_id, mission_id, phase (avoids ALTER TABLE on missions)
- `project_context` table: phase, context_type (deliverable/decision/requirement/note), content, source references
- Indexes on status, project_id, mission_id

**Projects module (`projects.js`):**
- Lifecycle phases: `discovery → requirements → design → build → test → deploy → completed`
- `createProject()`, `getProject()`, `getActiveProjects()`
- `advanceProjectPhase()` — strictly forward, no skipping/reversing
- `linkMissionToProject()`, `getProjectMissions()` (grouped by phase)
- `saveProjectContext()`, `getProjectContext()` — accumulate context across phases
- `detectExistingProject(message)` — keyword overlap matching (≥2 keywords) against active projects
- `buildProjectContextForPrompt(projectId)` — formats context for prompt injection
- `checkPhaseCompletion(projectId)` — auto-advances phase when all missions in current phase complete

**Integration:**
- Heartbeat: after mission creation, links to detected/tagged project. After mission completion, checks phase advancement.
- Discord bot: `[PROJECT:id]` tag support in proposal descriptions

### Smart Routing + Gap-Fill Hiring (Phase 4) — Fix: No Dynamic Team Assembly
- **Files modified:** `src/lib/agents.js`, `src/heartbeat.js`, `src/discord_bot.js`
- **Tests:** 12 in `tests/phase4/smart-routing.test.js`

**Cross-Team Agent Matching (`agents.js`):**
- `findBestAgentAcrossTeams(roleCategory)` — searches ALL active agents across ALL teams for role match
- `SMART_ROLE_KEYWORDS` — keyword patterns for matching (research, strategy, content, engineering, qa, marketing, knowledge)
- Only returns active agents; respects all teams

**Gap-Fill Hiring (`agents.js`):**
- `autoHireGapAgent(roleTitle, roleCategory)` — creates agent on correct standing team with no approval needed
- `getStandingTeamForRole(roleCategory)` — maps role to home team:
  - research/strategy/knowledge → team-research
  - engineering/content/qa/marketing → team-execution
- Uses name from `name_pool` (anime characters)
- Gap-fill agents stay on standing team permanently (available for future work)

**Project Assembly (`discord_bot.js`):**
- `[ACTION:NEW_PROJECT]` action type added to Frasier's instructions
- Response handler: parses `[PROJECT_DETAILS]` → creates project → `determineProjectRoles()` → finds/hires agents → creates first discovery mission
- `determineProjectRoles(description)` — keyword extraction to identify needed roles

**Smart Routing in Heartbeat:**
- Replaced default `team-research` routing with intelligent matching
- `findBestAgentAcrossTeams()` → if no match → `autoHireGapAgent()` → if pool empty → `createHiringProposal()` (fallback)
- Uses matched agent's actual team as target team

---

## Post-Overhaul Fixes (Feb 17, 2026)

### Clean Proposal Titles
- **File:** `src/discord_bot.js`
- **Problem:** Proposal titles were set to `content.substring(0, 200)` — the raw Discord message including `<@id>` mentions, URLs, and verbose instructions. This produced ugly announcement titles and Notion/Drive document names.
- **Fix:** `cleanProposalTitle(rawContent)` function:
  - Strips Discord mentions (`<@id>`)
  - Strips URLs
  - Strips `[PROJECT:N]` tags
  - Extracts first sentence
  - Caps at 120 chars on word boundary
  - Capitalizes first letter
  - Fallback: "Mission from Zero" if nothing meaningful remains
- Applied to all 4 proposal creation paths: `[ACTION:PROPOSAL]`, `[ACTION:MULTI_STEP_PROPOSAL]`, `[ACTION:NEW_PROJECT]` fallback, and error fallback

### Tier 2 → Tier 1 Fallback
- **File:** `src/lib/models.js`
- **Problem:** When tier2 (Manus) failed for any reason other than credit exhaustion (e.g., endpoint not configured), the step was marked `failed` with no recovery path. Auto-tier-selection could upgrade steps to tier2, making them permanently stuck.
- **Fix:** When tier2 fails and tier wasn't force-selected, automatically retry with tier1 (MiniMax via OpenRouter). Logged as `{ fallbackFrom: 'tier2' }` in model usage tracking.

### Announcement Error Logging
- **File:** `src/discord_bot.js`
- **Problem:** `announceCompletedSteps()` silently swallowed Supabase query errors — `if (error || !steps) return` with no logging. Made announcement failures invisible.
- **Fix:** Added explicit error logging: `console.error('[discord] announceCompletedSteps query error:', error.message)`

---

## Autonomous Lifecycle & Announcement Fixes (Feb 17, 2026)

### Auto-Phase-Progression
- **File modified:** `src/heartbeat.js`
- **Problem:** When a project advanced phases (e.g., discovery → requirements), `advanceProjectPhase()` only updated the phase label in the database. No mission was created for the new phase — projects stalled after every phase advancement until the founder manually triggered the next task.
- **Changes:**
  - `PHASE_TASKS` constant: maps each phase (requirements, design, build, test, deploy) to a description of what work the agent should produce
  - `createNextPhaseMission(project, completedMission)`: creates a mission proposal for the next phase, injecting the prior phase's deliverable output (truncated to 2000 chars) as context so the next agent builds on previous work
  - Called automatically from `checkMissions()` after phase advancement when the project isn't yet completed
  - Handles null `completedMission` gracefully (looks up latest project mission for catch-up scenarios)

### Stalled Project Detection
- **File modified:** `src/heartbeat.js`
- **Problem:** Projects that were already stuck (advanced to a phase before the auto-progression fix) would never recover. No mechanism to detect "active project in a phase with zero work happening."
- **Changes:**
  - `checkStalledProjects()`: runs every heartbeat tick, scans all active (non-completed) projects
  - For each project, checks if there are any pending proposals OR active missions (pending/in_progress steps)
  - If neither exists, auto-creates the missing phase mission via `createNextPhaseMission(project, null)`
  - Added as step 5 in the heartbeat `tick()` function

### Announcement Duplicate Prevention
- **File modified:** `src/discord_bot.js`
- **Problem:** `announceCompletedSteps()` set `announced = true` AFTER publishing to Notion/Google Drive. When Supabase returned Cloudflare 500 errors (intermittent on free tier), the flag never persisted. The step was re-published every 30-second poll cycle — creating infinite duplicate Notion pages and Google Docs.
- **Fix:** Mark `announced = true` BEFORE publishing. If the flag can't be set (Supabase error), skip the step entirely rather than risk duplicates. Added inner try/catch around Notion/Drive (still announces to Discord without links on publish failure) and outer try/catch per step (one failure doesn't block all announcements).

### OpenRouter Model ID Fix
- **File modified:** `src/lib/models.js`
- **Problem:** Model IDs used date-suffixed format (`anthropic/claude-sonnet-4-5-20250929`, `anthropic/claude-opus-4-20250514`) which OpenRouter rejected with API 400 errors. All T2/T3 tasks silently fell back to T1 MiniMax.
- **Fix:** Changed to short-form IDs: `anthropic/claude-sonnet-4.5` (T2), `anthropic/claude-opus-4` (T3).

---

## Quality Overhaul (Feb 17, 2026) — 5 Phases, 144 Tests

> Root cause: Agents produced generic, shallow deliverables. Five failures fixed:
> wrong LLM tier, meta-instructions instead of work, hardcoded roles, no industry expertise in personas, generalist reviews.

### Phase 1: Tier Restructure — Manus → Sonnet 4.5
- **Files modified:** `src/lib/models.js`, `src/worker.js`, `src/discord_bot.js`, `src/heartbeat.js`, `tests/mocks/models.js`
- **Tests:** 22 in `tests/tier-restructure.test.js`
- **Problem:** Tier 2 (Manus) was never configured — endpoint was `null`, API key `MANUS_API_KEY` never set. All tasks defaulted to Tier 1 (MiniMax), even research/strategy tasks that needed deeper reasoning.
- **Changes:**
  - T2 replaced: `manus` → `claude-sonnet-4.5` via OpenRouter (`anthropic/claude-sonnet-4.5`)
  - T2 now uses `OPENROUTER_API_KEY` (same key as T1/T3, no new config needed)
  - T2 cost tracking: $0.003/1K input, $0.015/1K output
  - T3 approval gate removed — auto-routes by keyword, info log only
  - New `TIER3_KEYWORDS` constant: `product requirements`, `product specification`, `design document`, `final deliverable`, `executive report`, `project plan`, `product roadmap`, `business case`, `investment memo`
  - `selectTier()` updated: checks T3 keywords first → T2 keywords → default T1
  - `isComplex=true` → T2 (overrides T3 keywords)
  - `isFinalStep` → T2
  - New T3→T2→T1 fallback chain: if Opus fails, try Sonnet, then MiniMax
  - Removed all Manus-specific code: `MANUS_CREDITS_EXHAUSTED` handling (worker.js + models.js), Manus endpoint check in `makeAPICall()`
  - `!costs` display: "Manus" → "Sonnet", "Claude" → "Opus", T2 now shows cost (was `$0`)
  - Cost alert display updated similarly

### Phase 2: "YOU ARE the Expert" Prompt Framing
- **File modified:** `src/lib/context.js`
- **Tests:** 21 in `tests/prompt-quality.test.js`
- **Problem:** Agents said "here's what a Business Analyst should do" instead of doing the work. Prompts lacked framing that forced the agent to BE the expert.
- **Changes:**
  - All 7 `DOMAIN_INSTRUCTIONS` (research, strategy, content, engineering, qa, marketing, knowledge) prefixed with: `YOU ARE the expert [Role]. You are doing the [work] yourself — not describing what someone else should do. Produce the ACTUAL deliverable.`
  - All 7 suffixed with: `CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`
  - Generic fallback (for dynamic roles) includes same framing + `CRITICAL: You are the DOER, not the ADVISOR. Deliver the WORK, not instructions for how to do it.`
  - Universal quality standards in `buildTaskContext()` include: `You are the DOER, not the ADVISOR. Produce the actual deliverable...`

### Phase 3: Dynamic Role Determination (LLM-Based)
- **Files modified:** `src/lib/agents.js`, `src/discord_bot.js`
- **Tests:** 8 in `tests/dynamic-roles.test.js`
- **Problem:** `determineProjectRoles()` used hardcoded `EXPERTISE_KEYWORDS` matching only 7 generic categories. Every project got the same roles regardless of industry.
- **Changes:**
  - New `determineDynamicProjectRoles(description)` — LLM-based, returns `{ title, category, reason }` objects
  - Uses T1 (cheap) LLM call to analyze project and suggest 2-5 specialist roles
  - Free-form titles: "Real Estate Market Analyst", "Healthcare Compliance Specialist", "AI Product Architect"
  - `category` field maps to 7 valid categories for team routing (research, strategy, content, engineering, qa, marketing, knowledge)
  - Invalid categories default to `research`
  - Strips markdown code blocks from LLM response before JSON parse
  - Falls back to keyword matching (`determineProjectRoles()`) when LLM fails or returns bad JSON
  - `discord_bot.js` `[ACTION:NEW_PROJECT]` handler switched from `determineProjectRoles()` to `determineDynamicProjectRoles()`
  - Old `determineProjectRoles()` preserved as backward-compatible deprecated export

### Phase 4: Industry-Specific Persona Generation
- **Files modified:** `src/lib/agents.js`, `src/heartbeat.js`, `src/discord_bot.js`
- **Tests:** 2 in `tests/industry-hiring.test.js`
- **Problem:** `autoHireGapAgent()` created agents with NO persona. `generatePersona()` only ran for approval-based hires. Gap-fill agents had no system prompt, no domain expertise.
- **Changes:**
  - `autoHireGapAgent(roleTitle, roleCategory, options)` — new optional `options` parameter with `projectDescription` and `projectName`
  - Attaches `_pendingPersonaContext` to agent when project context provided
  - `generatePersona(agent, hire, projectContext)` — new optional third parameter
  - When `projectContext` provided, injects `INDUSTRY/PROJECT CONTEXT` block into persona prompt: "Weave genuine domain expertise about this industry into the Skills and Identity sections"
  - `parsePersonaOutput()` now appends `## Quality Standards (Non-Negotiable)` to every generated persona: "You are the DOER. Produce actual deliverables, not instructions or frameworks."
  - `processProposals()` in heartbeat.js: after gap-fill agent is created, immediately generates persona with project context (extracted from `[PROJECT:N]` tag or task description)
  - `discord_bot.js` passes `{ projectDescription, projectName }` to `autoHireGapAgent()` in NEW_PROJECT handler

### Phase 5: Expert-Based Reviews (Domain Expert Routing)
- **File modified:** `src/heartbeat.js`
- **Tests:** 7 in `tests/expert-reviews.test.js`
- **Problem:** `processApprovals()` always routed reviews to generic QA (by `agent_type === 'qa'`) or Team Lead on the same team. A QA agent couldn't evaluate domain-specific quality (e.g., real estate market data accuracy).
- **Changes:**
  - `processApprovals()` now tries domain expert FIRST (before QA/Team Lead fallback)
  - Uses `routeByKeywords(step.description)` to determine domain category
  - Searches ALL active agents (across all teams) for role keyword match via `ROLE_KEYWORDS`
  - Domain expert cannot review their own work (`a.id !== step.assigned_agent_id`)
  - Domain expert gets `team_lead` review type (tier2 LLM for thorough review)
  - If no domain expert found → falls back to original QA → Team Lead chain (unchanged)
  - Fallback still auto-approves if no reviewers exist on the team
