# VoxYZ Agent World — Completed Features

> Last updated: Feb 11, 2026

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
