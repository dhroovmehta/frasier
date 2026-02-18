# Frasier — Completed Features

> Last updated: Feb 17, 2026 (v0.4.1)

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
- Tier 2 (Manus): complex tasks detected by keywords (strategy, analysis, etc.)
- Tier 3 (Claude Opus via OpenRouter): emergency only, requires Zero's approval via `!approve`
- Auto-retry: Tier 1 retries once after 5s on failure
- Manus credit exhaustion triggers Tier 3 escalation event → Discord alert to Zero

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
| `!help` | Show available commands |
| DM to Frasier | Casual chat or task delegation |

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
