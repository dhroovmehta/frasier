# Frasier — Changelog

All notable changes to this project are documented here.

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
