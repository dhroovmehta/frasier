# PRD: Deep Work Pipeline

**Version:** 1.0
**Date:** February 23, 2026
**Author:** Zero (Product Visionary) with Claude (Lead Engineer)
**Status:** Approved — Implementation in progress

---

## Executive Summary

Upgrade Frasier's task execution from single-shot LLM calls to a multi-phase deep work pipeline. This transforms agent output from shallow, hallucination-prone deliverables into research-backed, self-reviewed work — and makes the entire mission pipeline fully autonomous (Dhroov only sees the final deliverable).

**Before:** Agent gets task → 1 LLM call → submit → wait for manual approval → next step
**After:** Agent gets task → decompose → web research → synthesize → self-critique → (revise if needed) → auto-approve intermediate steps → next step flows automatically

---

## Problem Statement

### Evidence (from `/Users/dhroov/Downloads/Research_Team/` review)

| Deliverable | Agent | Problem |
|------------|-------|---------|
| YouTube Shorts research (Mission #21) | Sahaquiel | Revenue projections based on nothing, fake sources, generic platitudes |
| Real Estate pain points (Mission #28) | Sahaquiel | Wikipedia-quality, no links, possibly hallucinated statistics |
| Team spinup (Mission #27) | Sahaquiel | Pricing pulled from thin air, generic blog-post-level research |
| Deployment plan (Mission #59) | Toji | **100% fiction** — described $408K MRR, $66K/month infra, AWS ARNs for a product that doesn't exist |
| Speed-to-lead TAM (Mission #63) | Toji | Fantasy math (3M agents × $99 × 12 × 10% = $3.564B), no bottom-up validation |

### Root Causes (code-traced)

1. **Single-shot execution** — `worker.js:122-128` makes exactly 1 LLM call per step
2. **No mandatory web research** — Brave Search API exists in `web.js` but only fires if agent embeds `[WEB_SEARCH:]` tags (they rarely do)
3. **No self-review** — agents never evaluate their own work before submitting
4. **Approval chain blocks autonomy** — every step requires QA → Team Lead review, forcing Dhroov to shepherd missions
5. **No agent collaboration** — `conversations.js:161-169` has `buildHandoffPrompt()` but it's never called
6. **Learning is sparse** — lessons only every 5th task (`worker.js:378-428`), no approach memory

---

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|------------|----------|
| FR-1 | Every research/analysis step MUST execute web searches before producing output | P0 |
| FR-2 | Every step MUST self-critique and score its own output (1-5 scale) | P0 |
| FR-3 | Steps scoring < 3/5 MUST revise once before submitting | P0 |
| FR-4 | Intermediate steps with critique score ≥ 4.0 auto-approve (skip all review) | P0 |
| FR-5 | Intermediate steps with score ≥ 3.0 get QA-only review (skip Team Lead) | P1 |
| FR-6 | Final steps always get full QA → Team Lead review chain | P0 |
| FR-7 | Chained steps receive structured handoff dialogue from parent step's agent | P1 |
| FR-8 | Every completed step saves approach memory (what worked) | P1 |
| FR-9 | Every completed step extracts a lesson from its self-critique (no extra LLM call) | P1 |
| FR-10 | Pipeline is configurable per step type (research, engineering, creative, simple) | P1 |

### Non-Functional Requirements

| ID | Requirement |
|----|------------|
| NFR-1 | No new PM2 processes — pipeline runs inside existing worker |
| NFR-2 | No new npm dependencies |
| NFR-3 | Must work on 1GB RAM VPS (phases run sequentially, bounded web fetches) |
| NFR-4 | Brave Search free tier safe: ≤240 queries/month at current mission volume |
| NFR-5 | Supabase free tier safe: new tables only, no ALTER TABLE |
| NFR-6 | Pipeline modules must be extractable for use in other projects |

---

## Pipeline Architecture

### Phase Flow

```
DECOMPOSE (tier1, cheap)
  → Break task into 2-4 sub-questions
  → Generate web search queries for each
  → Identify key requirements for quality deliverable

RESEARCH (no LLM, pure web)
  → Execute 2-4 search queries via web.searchWeb()
  → Fetch top 2 pages per query via web.fetchPage()
  → Cap: 8 web fetches max per step

SYNTHESIZE (step's assigned tier)
  → Full agent prompt (persona + memory + skills)
  → Task + research data + quality mandates from context.js
  → Produces the actual deliverable

SELF-CRITIQUE (tier1, cheap)
  → Score 1-5 on: completeness, data-backed claims, actionability, depth
  → Identify specific gaps
  → Extract lesson (saved to memory, no extra LLM call)

REVISE (conditional, step's tier)
  → Only fires if critique score < 3/5
  → Gets critique feedback + original research data
  → Produces improved deliverable
  → Cap: 1 revision max
```

### Configuration Per Step Type

| Step Type | Decompose | Research | Synthesize | Critique | Revise |
|-----------|-----------|----------|------------|----------|--------|
| Research/Analysis | Yes | Yes | Yes | Yes | If < 3/5 |
| Engineering | Yes | Skip | Yes | Yes | If < 3/5 |
| Creative | Yes | Skip | Yes | Yes | If < 3/5 |
| Simple/Trivial | Skip entire pipeline — legacy single-shot |

---

## Data Model

### New Table: `pipeline_phases`

Audit trail for every phase of every step execution.

```sql
CREATE TABLE pipeline_phases (
  id BIGSERIAL PRIMARY KEY,
  mission_step_id BIGINT NOT NULL REFERENCES mission_steps(id),
  phase_name TEXT NOT NULL,        -- decompose | research | synthesize | critique | revise
  phase_order INT NOT NULL,
  output_content TEXT,
  model_tier TEXT,
  tokens_used INT DEFAULT 0,
  duration_ms INT DEFAULT 0,
  score DECIMAL(3,1),              -- critique phase: 1.0-5.0
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### New Table: `approach_memory`

"What worked before" — agents accumulate judgment, not just facts.

```sql
CREATE TABLE approach_memory (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mission_step_id BIGINT REFERENCES mission_steps(id),
  task_summary TEXT NOT NULL,
  topic_tags TEXT[] DEFAULT '{}',
  decomposition JSONB,
  search_queries TEXT[] DEFAULT '{}',
  effective_queries TEXT[] DEFAULT '{}',
  critique_score DECIMAL(3,1),
  approach_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### New Policy Row: `autonomy`

```sql
INSERT INTO policy (policy_type, name, rules) VALUES (
  'autonomy', 'Step Auto-Approval',
  '{"auto_approve_threshold": 4.0, "qa_only_threshold": 3.0,
    "always_review_final": true, "always_review_tier3": true, "enabled": true}'
);
```

---

## Integration Points

| File | What Changes | Lines Affected |
|------|-------------|----------------|
| `src/worker.js` | Replace single LLM call with `pipeline.execute()` | 122-164 |
| `src/worker.js` | Lesson generation uses critique output | 378-428 |
| `src/heartbeat.js` | Autonomy check at top of `processApprovals()` | 614-618 (insert ~15 lines) |

### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/lib/pipeline.js` | Deep work execution engine | ~300 |
| `src/lib/approach_memory.js` | Approach retrieval + saving | ~150 |
| `src/lib/autonomy.js` | Policy-driven auto-approval | ~120 |

### Unchanged Files

All existing modules remain untouched: `memory.js`, `context.js`, `missions.js`, `web.js`, `conversations.js`, `skills.js`, `models.js`, `agents.js`, `discord_bot.js`, `ecosystem.config.js`.

---

## Cost Impact

| Metric | Before | After |
|--------|--------|-------|
| LLM calls per step | 1 | 3-4 (2 cheap tier1 + 1-2 main tier) |
| Cost per step | $0.001-0.02 | $0.004-0.05 |
| Weekly cost (2-5 missions) | $0.03-0.30 | $0.15-0.75 |
| Brave Search queries/month | ~0 | ~240 (free tier allows 2,000) |

---

## Acceptance Criteria

### Pipeline (Phase 1)
- [ ] Research steps execute 2-4 web searches before producing output
- [ ] Every step produces a self-critique with a 1-5 score
- [ ] Steps scoring < 3 revise once, capped at 1 revision
- [ ] `pipeline_phases` table has 3-5 rows per completed step
- [ ] Output contains real web-sourced data with cited sources
- [ ] PM2 logs show phase progression: Decompose → Research → Synthesize → Critique

### Approach Memory (Phase 2)
- [ ] After step completion, approach saved to `approach_memory` table
- [ ] Similar past approaches injected into decompose prompt via topic tag overlap
- [ ] Zero additional LLM calls for approach retrieval

### Autonomy (Phase 3)
- [ ] Intermediate steps with critique ≥ 4.0 auto-approve without review
- [ ] Intermediate steps with critique ≥ 3.0 get QA-only review
- [ ] Final steps always get full QA → Team Lead review
- [ ] Dhroov only receives Discord notification on final deliverable completion

### Collaboration (Phase 4)
- [ ] Chained steps receive structured handoff from parent agent
- [ ] Handoff saved as conversation turn in existing `conversation_history`
- [ ] Step 2's output demonstrably builds on Step 1's findings

### Learning (Phase 5)
- [ ] Every completed step extracts a lesson from critique output
- [ ] Every completed step saves approach memory
- [ ] No additional LLM calls for lesson extraction (parsed from critique text)

### Reusability (Phase 6)
- [ ] Pipeline modules have no Frasier-specific references
- [ ] Configuration via dependency injection
- [ ] Each module includes `createTables()` for self-setup

---

## Verification Plan

1. **Smoke test:** Create mission via Discord — "Research the viability of an AI tutoring platform for K-12 students"
2. **Check PM2 logs:** `pm2 logs worker` — phases should be visible
3. **Check database:** `pipeline_phases` table should have 4-5 rows per step
4. **Compare quality:** Output should contain real data, cited sources, specific numbers (vs. old hallucinated deliverables)
5. **Autonomy test:** Create 3+ step mission — intermediate steps should auto-approve, only final step waits for review
6. **End-to-end:** Give complex research mission, walk away, come back to completed deliverable

---

## Build Order

Each phase is independently deployable:

1. **Phase 1:** `pipeline.js` + `worker.js` modification (the critical fix)
2. **Phase 2:** `approach_memory.js` (zero-cost learning)
3. **Phase 3:** `autonomy.js` + `heartbeat.js` modification (full autonomy)
4. **Phase 4:** Handoff dialogues via existing `conversations.js`
5. **Phase 5:** Lesson generation from every critique
6. **Phase 6:** Extract reusable interfaces
