---
date: 2026-02-23
category: feature-design
project: frasier
priority: P1
tags: [skills, security, v0.9.0, claude-code, agent-encoding]
status: completed
---

# Skill Vetting & Installation — v0.9.0

## Purpose
Evaluate and install external Claude Code skills to: (A) accelerate v0.9.0 development workflow, and (B) extract patterns for encoding into Frasier's runtime agent system prompts.

## Security Pipeline (D-022)

### Scanners Used
| Scanner | Method | Result |
|---------|--------|--------|
| Cisco AI Skill Scanner | Static YARA rules (LLM tier requires API key) | Flagged autonomous-agent-patterns (HIGH: rm -rf) |
| SkillAudit | Keyword + pattern analysis | Flagged autonomous-agent-patterns (CRITICAL: filesystem access). False positives on task-coordination-strategies and task-execution-engine (MEDIUM: "password" keyword in auth example code — 12 flags, all false positives) |
| mcp-scan | MCP config analysis | **Not applicable** — only scans .mcp.json, not SKILL.md files |
| Manual review | Line-by-line read of all files | Confirmed automated findings, cleared false positives |

### Key Findings
- mcp-scan is useless for skill files — D-022 should note this limitation
- SkillAudit has high false-positive rate on docs containing auth example code ("password", "JWT", "bcrypt")
- Cisco scanner static tier only uses YARA rules — semantic LLM analysis needs API key we don't have
- skillsmp.com blocks direct web fetch (403) — source skills from GitHub repos directly

### Override Precedent
D-022 says "any scanner flag = auto-reject." Dhroov approved an override for documented false positives where manual review confirms the flag is a keyword match on example/documentation code, not executable risk. This precedent applies going forward.

## Installed Skills (7 approved, 1 rejected)

### 1. design-orchestration (1 file)
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** `SKILL.md`
- **Purpose:** Routes work through brainstorming, multi-agent review, and execution readiness in correct order. Prevents premature implementation.
- **Agent encoding:** Yes — Frasier (escalation risk assessment, design workflow sequencing)

### 2. dispatching-parallel-agents (1 file)
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** `SKILL.md`
- **Purpose:** Patterns for dispatching 2+ independent tasks without shared state
- **Agent encoding:** Yes — Frasier (prompt construction for parallel task assignment)

### 3. multi-agent-patterns (1 file)
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** `SKILL.md`
- **Purpose:** Orchestrator, peer-to-peer, and hierarchical multi-agent architectures
- **Agent encoding:** No — Claude Code development workflow only

### 4. subagent-driven-development (4 files)
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** `SKILL.md`, `implementer-prompt.md`, `spec-reviewer-prompt.md`, `code-quality-reviewer-prompt.md`
- **Purpose:** Implementation plans with independent tasks using subagents
- **Agent encoding:** No — Claude Code development workflow only

### 5. task-coordination-strategies (3 files)
- **Source:** wshobson/agents
- **Files:** `SKILL.md`, `references/task-decomposition.md`, `references/dependency-graphs.md`
- **Purpose:** Task decomposition, dependency graphs, workload balancing for multi-agent teams
- **Security notes:** 12 SkillAudit MEDIUM flags — all false positives (auth example code). Override approved.
- **Agent encoding:** Yes — Frasier (decomposition logic, dependency tracking)

### 6. task-execution-engine (4 files, includes Python)
- **Source:** wshobson/agents
- **Files:** `SKILL.md`, `references/task-format.md`, `references/workflow-guide.md`, `scripts/task_manager.py`
- **Purpose:** Execute implementation tasks using markdown checkboxes, resume interrupted work
- **Security notes:** SkillAudit false positives (same auth example pattern). Override approved.
- **Agent encoding:** Yes — All agents (task format, acceptance criteria, self-assessment pattern)

### 7. writing-plans (1 file)
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** `SKILL.md`
- **Purpose:** Structured plan writing from specs/requirements before code
- **Agent encoding:** Yes — Frasier + Spike (plan structure, TDD approach)

### REJECTED: autonomous-agent-patterns
- **Source:** sickn33/antigravity-awesome-skills
- **Reason:** Cisco HIGH (rm -rf pattern), SkillAudit CRITICAL (filesystem access). Legitimate findings, not false positives.
- **Not reinstallable** without rewrite of the skill content.

## Agent Encoding Summary

5 of 7 skills contain patterns applicable to runtime agents:

| Skill | Target Agent(s) | Key Patterns to Extract |
|-------|-----------------|------------------------|
| task-coordination-strategies | Frasier | Decomposition methodology, dependency graph construction, workload balancing |
| design-orchestration | Frasier | Risk assessment for escalation, design phase sequencing |
| task-execution-engine | All agents | Task format spec, acceptance criteria structure, self-assessment prompts |
| writing-plans | Frasier, Spike | Plan document structure, TDD integration |
| dispatching-parallel-agents | Frasier | Parallel task dispatch patterns, prompt construction for independent work |

**Decision (D-028):** Hybrid approach — distilled ~100-200 token instructions in base persona (always loaded) + full skill content injected on-demand when agent is actively performing that task type. See [[task-decomposition-v0.9.0]] for v0.9.0 context.

## File Inventory
- Location: `.claude/skills/` (7 directories, 15 files total)
- 14 Markdown files (.md) + 1 Python script (task_manager.py)
- Total skills evaluated: 8 (7 approved, 1 rejected)
- Sources: 3 GitHub repos (wshobson/agents, sickn33/antigravity-awesome-skills, davila7/claude-code-templates)
