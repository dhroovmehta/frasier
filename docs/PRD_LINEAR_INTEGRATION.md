# PRD: Linear Integration — Mission Control

**Version:** 2.0
**Date:** February 23, 2026
**Author:** Dhroov (Product Visionary) with Frasier (Lead Engineer)
**Status:** Requirements Refined — Ready for implementation planning

---

## Executive Summary

Integrate Frasier with Linear as a two-way project management layer. Frasier autonomously creates projects, tickets, assigns agent labels, and updates status as work progresses. Dhroov can also create projects in Linear that Frasier picks up as new missions. Both Discord and Linear stay in sync regardless of where work originates.

**Before:** Dhroov has no visibility into what Frasier is doing. Discord is the only interface — commands in, deliverables out. No project-level tracking.

**After:** Dhroov opens Linear in the morning and sees exactly what every agent worked on overnight, what's in progress, what's blocked. He can also create projects in Linear for Frasier to pick up — and Discord stays in the loop either way.

---

## Problem Statement

1. **No visibility** — Frasier runs 24/7/365 but Dhroov has no dashboard showing project status, who's working on what, or what got done
2. **No project-level workflow** — Discord works for ad-hoc tasks but doesn't support structured flows (research → PRD → build → QA → deploy)
3. **One-way communication** — Dhroov can only issue commands via Discord; no way to queue up structured work

---

## Solution Architecture

### Design Principles

1. **Mirror, don't replace** — Linear reflects Frasier's existing mission/step lifecycle. It does NOT replace the internal task system.
2. **Labels, not members** — Single API key, agents represented as labels. Zero extra seat cost.
3. **Frasier decides structure** — Frasier autonomously assigns agents via EXPERTISE_MAP. Dhroov describes what he wants; Frasier handles who and how.
4. **Graceful degradation** — If Linear API is down or unconfigured, Frasier operates normally. Linear is an output channel, not a dependency.
5. **Both channels always in sync** — Discord and Linear both receive updates regardless of where the request originated.

### Data Flow

```
Direction 1: Frasier → Linear (automatic sync)
──────────────────────────────────────────────
Mission created     → Linear Project created (LLM-polished title + description)
Step created        → Linear Issue created under Project (LLM-polished title + description)
Step assigned       → Issue labeled with agent name + work type
Step claimed        → Issue status → "In Progress", Started At field set
Step sent to review → Issue status → "In Review"
Step approved       → Issue status → "Done", Completed At field set, self-critique score set
Step deliverable    → Google Drive link posted as comment on Issue
Step rejected       → Issue status → "Backlog"
Mission completed   → Project marked completed, Completion Date set
Mission failed      → Project marked canceled

Direction 2: Linear → Frasier (webhook-driven)
──────────────────────────────────────────────
Dhroov creates Project + first Issue in Linear
  → Webhook fires on Issue creation
  → Frasier creates mission_proposal with LLM-polished title/description
  → Frasier announces new mission in Discord (with Linear project link)
  → Frasier assigns agent via EXPERTISE_MAP and begins execution
```

---

## Ticket Specifications

### Linear Issue (= Frasier Mission Step)

Each issue represents a single task assigned to one agent.

**Native Fields:**
| Field | Source |
|-------|--------|
| Title | LLM-rewritten (tier-1/MiniMax) from raw task description |
| Description | LLM-rewritten (tier-1/MiniMax) into organized, legible format |
| Status | Auto-synced: Backlog → In Progress → In Review → Done / Canceled |
| Labels | Agent name + work type + `frasier-managed` |

**Custom Fields:**
| Field | Type | When Set |
|-------|------|----------|
| Self-Critique Score | Number (1-5) | When step completes (from deep work pipeline) |
| Discord Link | URL | When step is created |
| Notion Link | URL | When step is created (if Notion page exists) |
| Started At | Date/Time | When agent claims the step |
| Completed At | Date/Time | When step is approved/done |

**Comments:**
| Event | Comment Content |
|-------|----------------|
| Deliverable ready | Google Drive link to the deliverable |

### Linear Project (= Frasier Mission)

Each project represents a full mission containing one or more issues.

**Native Fields:**
| Field | Source |
|-------|--------|
| Title | LLM-rewritten (tier-1/MiniMax) from raw mission description |
| Description | Mission summary, agents involved, Discord link (in body text) |
| Status/Progress | Native Linear project tracking (auto from child issues) |

**Custom Fields:**
| Field | Type | When Set |
|-------|------|----------|
| Start Date | Date | When mission is created |
| Completion Date | Date | When mission completes or fails |

---

## Labels (Created Programmatically on First Run)

### Agent Labels (12 — one per active agent)

| Label | Team | Role |
|-------|------|------|
| `Frasier` | Leadership | Chief of Staff / COO |
| `Gendo` | Research | Research Strategist & Team Lead |
| `Sahaquiel` | Research | Research Analyst |
| `Toji` | Research | Financial & Business Analyst |
| `Kaworu` | Execution | Full-Stack Engineer |
| `Ritsuko` | Execution | Growth Marketer |
| `Armisael` | Content | Content Scout |
| `Shamshel` | Content | Content Writer |
| `Zechs` | Content | Content Editor |
| `Zeruel` | Content | Content Archivist |
| `Jet` | Content | Newsletter Editor |
| `Rei` | Special | Memory System Tester |

### Work Type Labels (7 — derived from EXPERTISE_MAP)

`Research`, `Strategy`, `Content`, `Engineering`, `QA`, `Marketing`, `Knowledge`

### System Labels (1)

`frasier-managed` — Applied to all Frasier-created issues (distinguishes from Dhroov-created issues)

---

## Workflow States

Frasier creates the team and custom workflow states programmatically on first run:

| Frasier Status | Linear State | Notes |
|---------------|--------------|-------|
| `pending` | Backlog | Default for new issues |
| `in_progress` | In Progress | Agent has claimed the step |
| `in_review` | In Review | Custom state, created programmatically |
| `completed` | Done | Step approved |
| `failed` | Canceled | Step or mission failed |

---

## Title & Description Rewriting

When creating Linear Projects or Issues, Frasier makes a tier-1 (MiniMax) LLM call to transform raw input into polished, professional titles and descriptions.

**Input:** Raw mission/step text (from Discord command or Linear issue created by Dhroov)
**Output:** Clean, concise title + organized description

**Example:**
- Raw: "look into what newsletters are doing well in the ai space and what tools they use"
- Title: "AI Newsletter Landscape Analysis"
- Description: "Research the top-performing newsletters in the AI/ML space. Identify key players, their tools and platforms, content strategies, audience sizes, and monetization approaches."

This rewriting applies to both directions:
- Discord → Frasier → Linear (Frasier polishes Discord input)
- Linear → Frasier → Discord (Frasier polishes Dhroov's Linear input)

---

## Discord Integration Updates

When a mission is created (from either direction), the Discord announcement includes a link to the Linear project:

```
New mission created: AI Newsletter Landscape Analysis
Assigned to: Sahaquiel (Research Analyst)
Linear: https://linear.app/frasier/project/fra-42
```

When a deliverable is complete, Discord announcement continues as normal — Linear is an additional channel, not a replacement.

---

## Integration Points (Where to Hook In)

### Frasier → Linear

| Event | Current Code Location | Linear Action |
|-------|----------------------|---------------|
| Mission created | `missions.js:createMission()` | Create Linear Project (LLM-polished) + set Start Date |
| Step created | `missions.js:createStep()` | Create Linear Issue (LLM-polished) + agent/work-type labels + custom fields |
| Step claimed by worker | `missions.js:claimStep()` | Update Issue status → "In Progress" + set Started At |
| Step sent to review | `missions.js:completeStep()` | Update Issue status → "In Review" |
| Step approved (completed) | `missions.js:approveStep()` | Update Issue status → "Done" + set Completed At + set Self-Critique Score |
| Step rejected | `missions.js:sendBackForRevision()` | Update Issue status → "Backlog" |
| Step deliverable ready | After Google Drive upload | Post Google Drive link as comment on Issue |
| Mission completed | `missions.js:completeMission()` | Mark Project completed + set Completion Date |
| Mission failed | `missions.js:failMission()` | Mark Project canceled + set Completion Date |

### Linear → Frasier

| Event | Webhook Trigger | Frasier Action |
|-------|----------------|----------------|
| Issue created by Dhroov | `action: "create", type: "Issue"` | Create `mission_proposal` with LLM-polished title/description, announce in Discord with Linear link |

**How to distinguish Dhroov-created vs Frasier-created issues:** Check the `actor` field in the webhook payload. If the actor is Dhroov's Linear user ID, process it. If it's the API key's user, ignore it (prevents infinite loop).

---

## New Files

### `src/lib/linear.js` — Linear API Client + Sync Logic

Follow the same pattern as `notion.js`:
- `linearRequest(query, variables)` — raw GraphQL via `fetch()` (NOT the `@linear/sdk` npm package — keep dependencies zero, match existing pattern)
- `syncMissionToLinear(mission)` — creates Project + custom fields
- `syncStepToLinear(step, missionLinearId)` — creates Issue under Project + labels + custom fields
- `updateIssueStatus(linearIssueId, newState)` — updates workflow state
- `updateIssueCustomField(linearIssueId, field, value)` — updates custom fields (Started At, Completed At, Self-Critique Score)
- `addIssueLabel(linearIssueId, labelName)` — adds agent/work-type label
- `addIssueComment(linearIssueId, text)` — posts deliverable link
- `ensureLabelsExist()` — idempotently creates all agent + work-type + system labels on startup
- `ensureCustomFieldsExist()` — idempotently creates all custom fields on startup
- `ensureWorkflowStatesExist()` — creates "In Review" custom state if missing
- `ensureTeamExists()` — creates the Frasier team if it doesn't exist
- `getOrCreateProject(title, description)` — finds existing or creates new
- `polishTitleAndDescription(rawText)` — tier-1 LLM call to rewrite raw input

**API Pattern** (matching notion.js):
```javascript
const LINEAR_API_URL = 'https://api.linear.app/graphql';

async function linearRequest(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.log('[linear] LINEAR_API_KEY not set, skipping sync');
    return null;
  }

  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey  // No "Bearer" prefix for Linear API keys
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`[linear] API ${response.status}: ${error}`);
    return null;
  }

  const result = await response.json();
  if (result.errors) {
    console.error('[linear] GraphQL errors:', JSON.stringify(result.errors));
    return null;
  }

  return result.data;
}
```

### SQL Migration: `sql/005_linear_integration.sql`

Follow the existing sync table pattern (notion_sync, gdrive_sync, github_sync):

```sql
-- Linear sync tracking table
CREATE TABLE IF NOT EXISTS linear_sync (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,           -- 'project' | 'issue'
  entity_id TEXT NOT NULL,             -- Linear project/issue UUID
  entity_identifier TEXT,              -- Human-readable ID like "FRA-123"
  entity_url TEXT,                     -- Full Linear URL
  mission_id BIGINT REFERENCES missions(id),
  mission_step_id BIGINT REFERENCES mission_steps(id),
  sync_type TEXT NOT NULL,             -- 'mission_to_project' | 'step_to_issue' | 'inbound_issue'
  status TEXT DEFAULT 'synced',        -- 'synced' | 'error'
  error_message TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_linear_mission ON linear_sync(mission_id);
CREATE INDEX IF NOT EXISTS idx_linear_step ON linear_sync(mission_step_id);
CREATE INDEX IF NOT EXISTS idx_linear_entity ON linear_sync(entity_id);

-- RLS
ALTER TABLE linear_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_linear_sync" ON linear_sync
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

---

## Modified Files

### `src/heartbeat.js`

1. **Add webhook endpoint** to the existing health HTTP server (port 8787):
   - `POST /webhooks/linear` — receives Linear webhook payloads
   - Validate HMAC-SHA256 signature from `Linear-Signature` header
   - On `Issue.create` by Dhroov → LLM-polish title/description → call `missions.createProposal()` → announce in Discord with Linear link
   - Store `LINEAR_WEBHOOK_SECRET` in env for signature validation

2. **Add startup initialization** (once, not every tick):
   - `ensureTeamExists()`
   - `ensureLabelsExist()`
   - `ensureCustomFieldsExist()`
   - `ensureWorkflowStatesExist()`

### `src/lib/missions.js`

Add Linear sync calls at the end of each lifecycle function (after the Supabase operations succeed):

- `createMission()` → `linear.syncMissionToLinear(mission)`
- `createStep()` → `linear.syncStepToLinear(step, missionId)`
- `claimStep()` → `linear.updateIssueStatus(stepId, 'In Progress')` + `linear.updateIssueCustomField(stepId, 'Started At', timestamp)`
- `completeStep()` → `linear.updateIssueStatus(stepId, 'In Review')`
- `approveStep()` → `linear.updateIssueStatus(stepId, 'Done')` + `linear.updateIssueCustomField(stepId, 'Completed At', timestamp)` + `linear.updateIssueCustomField(stepId, 'Self-Critique Score', score)`
- `sendBackForRevision()` → `linear.updateIssueStatus(stepId, 'Backlog')`
- `completeMission()` → `linear.completeProject(missionId)`
- `failMission()` → `linear.cancelProject(missionId)`

### `src/discord_bot.js`

- Update mission announcement messages to include Linear project link (fetched from `linear_sync` table)

**Pattern:** Each sync call is fire-and-forget with try/catch. Linear sync failure must NEVER block mission execution. Log errors, continue.

```javascript
// Example pattern for every sync point:
try {
  await linear.updateIssueStatus(stepId, 'In Progress');
} catch (err) {
  console.error('[linear] Sync failed (non-blocking):', err.message);
}
```

---

## Environment Variables

Add to `.env`:

```
# Linear (v0.8.0 — Mission Control)
LINEAR_API_KEY=              # Personal API key from Linear Settings > Security > API Keys
LINEAR_TEAM_ID=              # Team ID for "Frasier" team (UUID) — can be auto-resolved by name
LINEAR_WEBHOOK_SECRET=       # Signing secret for webhook validation (generated by Linear when creating webhook)
```

---

## Webhook Setup

Frasier creates its own webhook via the API on first startup:

```graphql
mutation {
  webhookCreate(
    input: {
      url: "http://157.245.12.220:8787/webhooks/linear"
      resourceTypes: ["Issue"]
      teamId: "FRASIER_TEAM_ID"
    }
  ) {
    success
    webhook { id, enabled }
  }
}
```

**Important:** The VPS must have port 8787 accessible from the internet for webhooks to reach it. It already serves health checks on this port, so it should be open. Verify with: `curl http://157.245.12.220:8787/health`

**Note:** Only `Issue` resource type is needed (not `IssueComment` — comment sync is deferred).

---

## Error Handling & Graceful Degradation

1. **No LINEAR_API_KEY set** → All linear.js functions return null silently. Log once on startup: `[linear] LINEAR_API_KEY not set, Linear sync disabled`
2. **Linear API returns error** → Log error, continue mission execution. Never block.
3. **Webhook signature invalid** → Return 401, log warning. Don't process.
4. **Webhook payload missing expected fields** → Return 200 (acknowledge), log warning, skip processing.
5. **Duplicate sync** → Check `linear_sync` table before creating. If entity already exists, update instead of create.
6. **Rate limiting (429)** → Back off. Linear allows 5,000 requests/hour — we'll use maybe 50/hour at peak.

---

## Testing Plan

### Unit Tests (`tests/linear/`)

1. **linear.test.js** — Test all linear.js functions with mocked fetch:
   - `linearRequest()` handles auth, errors, GraphQL errors
   - `syncMissionToLinear()` creates project with custom fields
   - `syncStepToLinear()` creates issue with labels and custom fields
   - `updateIssueStatus()` sends correct mutation
   - `updateIssueCustomField()` sends correct mutation
   - `ensureLabelsExist()` is idempotent (doesn't duplicate)
   - `ensureCustomFieldsExist()` is idempotent
   - `polishTitleAndDescription()` calls tier-1 LLM and returns clean output
   - All functions return null gracefully when API key missing

2. **webhook.test.js** — Test webhook handling:
   - Valid signature → processes correctly
   - Invalid signature → rejects with 401
   - Issue created by Dhroov → creates mission_proposal with polished title/description
   - Issue created by Frasier → ignored (no infinite loop)
   - Missing fields → acknowledged but skipped

### Integration Test

After deployment, send a test mission via Discord and verify:
1. Linear Project appears with polished title and description
2. Linear Issues appear for each step with agent labels and custom fields
3. Issue status updates as step progresses through pipeline
4. Self-critique score appears on completed issues
5. Google Drive link posted as comment on completed issues
6. Discord announcement includes Linear project link
7. Final deliverable announced in both Discord and Linear

Then test the reverse direction:
1. Create a Project + first Issue in Linear
2. Verify Frasier picks it up via webhook
3. Verify mission_proposal is created with polished title/description
4. Verify Discord announcement with Linear link
5. Verify Frasier assigns agent and begins execution

---

## Cost Impact

| Item | Cost |
|------|------|
| Linear API | Free (included in all plans) |
| Linear plan | Free tier (250 active issues, unlimited members) |
| Additional API calls | ~50-200/day at current mission volume |
| New npm dependencies | Zero (raw fetch, matching existing pattern) |
| Additional LLM calls | ~$0.01-0.05/week (tier-1 MiniMax for title/description polishing) |
| VPS memory impact | Negligible (no new process, adds routes to existing server) |

**Total additional cost: ~$0.02-0.20/month**

---

## Implementation Order

1. Write tests (TDD)
2. Create `src/lib/linear.js` with core API functions + LLM polishing
3. Create SQL migration `sql/005_linear_integration.sql`
4. Add webhook endpoint to `heartbeat.js`
5. Add startup initialization (team, labels, custom fields, workflow states)
6. Add sync calls to `missions.js`
7. Update Discord announcements to include Linear links
8. Add env vars to `.env.example`
9. Run all tests (new + existing)
10. Deploy: migration → code → verify

---

## What Dhroov Needs to Do (Before or During Deploy)

1. **Create Linear API Key:**
   - Go to Linear → Settings → Security → API Keys
   - Create a personal API key
   - Save to 1Password and add to VPS `.env` as `LINEAR_API_KEY`

2. **Get Linear Team ID:**
   - Frasier can query this via API using the team name "Frasier"
   - Or find in Linear URL: `linear.app/frasier/team/FRA/active` → Frasier will resolve the ID

3. **Verify port 8787 is accessible:**
   - Run: `curl http://157.245.12.220:8787/health`
   - Should return JSON with status "ok"

---

## Out of Scope (Deferred to Future Versions)

- **Task decomposition** — Frasier autonomously breaking a high-level request into ordered sub-steps. Currently Dhroov describes the full scope in the first task.
- **Comment sync** — Dhroov adding comments on Linear issues that Frasier picks up as context. Currently only issue creation triggers a webhook.
- **Cycle management** — Linear cycles (sprints) are not mapped.
- **Priority sync** — Frasier priority ↔ Linear priority mapping.
- **Attachments** — Uploading deliverable files to Linear issues. Google Drive links in comments for now.
- **Multiple teams in Linear** — Everything goes to one "Frasier" team.
