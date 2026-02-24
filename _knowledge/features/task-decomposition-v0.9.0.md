---
date: 2026-02-23
category: feature-design
project: frasier
priority: P0
tags: [task-decomposition, v0.9.0, orchestration, project-management]
status: design-phase
---

# Task Decomposition Engine — v0.9.0

## Summary
Upgrade Frasier from handling simple tasks to orchestrating full end-to-end projects autonomously. When Dhroov says "build me a real estate speed-to-lead AI agent," Frasier should decompose it into a full project plan, sequence tasks, assign agents, and drive to completion — delivering a working prototype.

## Design Decisions (from conversation with Dhroov, 2026-02-23)

### 1. Autonomy Level
- **Default: Full autonomy (Option A)** — Frasier researches, plans, and executes without asking permission
- **Exception: Escalate when needed (Option B)** — pause and check in when genuine founder input is required (budget, strategic direction, brand preferences)
- Agents are SMEs in their roles — they know best. Frasier doesn't micromanage.

### 2. Who Orchestrates
- **Frasier (agent_type: chief_of_staff)** is the CEO/COO and project orchestrator
- Frasier receives the directive, decomposes it, assigns agents, oversees execution
- Frasier already holds this role in the codebase (`frasier-cos`) — we're upgrading capabilities, not replacing anyone

### 3. Decomposition Approach — Hybrid (Collaborative + Phase-Based)
- **Frasier** creates the high-level project plan with phases and assigns agents
- **Each expert agent** reviews and refines the tasks within their domain
- **When a phase begins**, the assigned agent does granular decomposition for their piece
- Two levels of hierarchy: **Project → Tasks** (not three)

### 4. Dependencies & Parallelism
- **Parallel where possible** — Frasier identifies which tasks have no dependencies and runs them simultaneously
- Dependency chains are respected — can't write PRD until research is done, can't build until design is approved
- This is how a real team operates

### 5. Quality Control
- **Two layers:** Self-assessment (agent reviews own work) + QA (Ein)
- Each agent is a SME — Ein does NOT review domain expertise quality (e.g., won't judge research quality)
- Ein handles what Ein is expert in: code quality, security audits, test coverage, bug detection
- Self-assessment is the primary quality gate for domain-specific work

### 6. Dynamic Hiring
- **Both proactive and reactive hiring:**
  - Frasier identifies capability gaps during decomposition (before execution)
  - Agents can flag gaps during execution ("I don't have the knowledge for this")
  - Frasier hires on the fly when needed
- **All hires are permanent** — no temp workers. If the role was worth hiring for, it's worth keeping.
- Frasier has full autonomy on personnel decisions (hiring, role reassignment)

### 7. Jet's Role
- Frasier reclaimed Chief of Staff from Jet
- Jet's new role is **Frasier's decision** — Frasier has autonomy on personnel matters
- This will be determined by Frasier during implementation

### 8. Trigger
- **Discord message** — Dhroov types a directive in Discord
- Frasier classifies the message: casual conversation, simple task, or full project
- Classification determines which pipeline activates

### 9. Visibility
- **Discord + Linear** — Linear is the project management backbone (full project structure, tasks, dependencies, status, assignments), Discord gets highlights and alerts (phase completions, blockers, deliverables, escalations)

### 10. Scope of "Build"
- End-to-end: research → financial analysis → planning → requirements → user stories → acceptance criteria → PRD → tech design → tech stack → test plan → specs → security → prototyping → working product
- "When I wake up in the morning I have a working prototype or product ready to use, sell, test"

## Current System State
- Frasier (`frasier-cos`) already exists as chief_of_staff
- Frasier already sees full roster, handles delegation, hiring proposals, routing
- Frasier cannot be fired (special protection)
- All Discord messages from Dhroov go through Frasier
- Current hierarchy: mission → mission_steps (two levels)
- Linear integration exists (v0.8.0)
- Auto-phase-progression exists: discovery → requirements → design → build → test → deploy → completed

## What Needs to Be Built
1. Message classification (simple task vs full project)
2. Project decomposition engine (Frasier creates high-level plan)
3. Agent-refined task breakdown (experts refine their domain tasks)
4. Dependency tracking and parallel execution orchestration
5. Self-assessment pipeline for task outputs
6. Integration with Linear for project tracking
7. Dynamic agent hiring during decomposition and execution
8. Escalation logic (when to pause and ask Dhroov)
