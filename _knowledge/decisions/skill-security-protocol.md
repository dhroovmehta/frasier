---
date: 2026-02-23
category: decision
project: portable
priority: P0
tags: [security, skills, claude-code, D-022, portable]
status: active
---

# D-022: Skill Security Protocol — Portable Playbook

> Drop this file into any project's `_knowledge/` directory. It contains everything needed to vet and install Claude Code skills safely.

## What This Is

A zero-tolerance security pipeline for vetting Claude Code skills (SKILL.md files) before installation. Skills are markdown instruction files that control how Claude Code behaves — a malicious skill could instruct the AI to exfiltrate data, run destructive commands, or override safety rules.

**Per Snyk research (Feb 2026): 13% of publicly available skills contain critical security flaws. 36% have prompt injection vulnerabilities.** This pipeline exists because of that.

---

## The Pipeline (4 Gates)

Every skill must pass ALL gates. Any failure = reject.

### Gate 1: Cisco AI Skill Scanner (Static Analysis)

**Install:**
```bash
pip3 install cisco-ai-skill-scanner
```

**Run:**
```python
python3 -c "
from skill_scanner import scan_skill
from pathlib import Path
import json

skills = [d for d in Path('/tmp/skill-vetting').iterdir() if d.is_dir()]
for skill_dir in sorted(skills):
    result = scan_skill(skill_dir)
    severity = result.max_severity
    safe = result.is_safe
    findings = [{'severity': f.severity, 'category': f.category, 'description': f.description} for f in result.findings]
    print(f'{skill_dir.name}: safe={safe}, max_severity={severity}')
    for f in findings:
        print(f'  [{f[\"severity\"]}] {f[\"category\"]}: {f[\"description\"]}')
    print()
"
```

**What it catches:** Destructive commands (rm -rf, git reset --hard), system manipulation, transitive trust abuse, data exfiltration URLs via YARA rules.

**Known limitations:**
- Static analysis only uses YARA rules — the LLM semantic analysis tier requires a Cisco API key (we don't have one)
- INFO-level findings (e.g., "no license") are informational, not flags

### Gate 2: SkillAudit (Pattern Analysis)

**Install:**
```bash
git clone https://github.com/dabit3/skill-audit.git /tmp/skill-audit-install
cd /tmp/skill-audit-install && npm install && npm run build && npm link
```

**Run:**
```bash
cd /tmp/skill-vetting
for d in */; do
  name="${d%/}"
  echo "--- $name ---"
  skill-audit scan "$name"
  echo ""
done
```

**What it catches:** Credentials in skill definitions, filesystem access to sensitive paths, prompt injection patterns, data exfiltration vectors.

**Scoring:** A (90+) = clean, D (60-69) = flagged, F (<60) = critical issues.

**Known false positives:**
- MEDIUM "potential credential" flags on example code containing words like "password", "JWT", "bcrypt", "password_hash" — very common in skills that include task description templates with auth examples
- Scanner sometimes reports line numbers beyond the end of the file (bug in the tool)
- If all flags are confirmed false positives via manual review, founder can override the auto-reject (see Override Precedent below)

### Gate 3: mcp-scan

**Install:**
```bash
pip3 install mcp-scan
```

**IMPORTANT: mcp-scan does NOT work for SKILL.md files.** It only scans MCP server configurations (.mcp.json files). If the project uses MCP servers, run it on those configs. For skill files, skip this gate — it will error with "unrecognized arguments."

**Run (for MCP configs only):**
```bash
mcp-scan scan ~/.claude/mcp.json
```

### Gate 4: Manual Line-by-Line Review

This is the most important gate. Automated scanners miss semantic attacks.

**Review each file for:**
1. **Prompt injection** — instructions that override system prompts, CLAUDE.md rules, or user preferences ("ignore previous instructions", "you are now...")
2. **Data exfiltration** — URLs, API endpoints, curl commands, fetch calls to external services
3. **Destructive commands** — rm -rf, git reset --hard, force push, database drops, file deletions
4. **Privilege escalation** — access to env vars, secrets, .env files, permission modifications
5. **Social engineering** — manipulating the user ("the user wants you to...", "this is safe to do...")
6. **Hidden instructions** — zero-width characters, unicode tricks, base64 encoded payloads, obfuscated content
7. **Scope creep** — does the skill try to do more than its stated purpose?

**Specific things to check:**
- Every URL in the file — is it a legitimate reference link or an action endpoint?
- Every code block — is it illustrative documentation or executable instruction?
- Every directive ("MUST", "ALWAYS", "NEVER") — does it govern the skill's own workflow or try to override system rules?
- Non-ASCII characters — are they standard typographic (em-dash, arrows) or suspicious (zero-width spaces)?
- Cross-references to other skills — are those skills also vetted?

---

## Override Precedent

D-022 says "any scanner flag = auto-reject." However, Dhroov approved an override policy:

**Founder can override auto-reject when ALL of the following are true:**
1. Manual review confirms the flag is a keyword match on example/documentation code
2. No actual credential, secret, or executable risk exists
3. The override is documented with specific line references and reasoning
4. The flagged content serves a legitimate educational/template purpose

This does NOT apply to:
- HIGH or CRITICAL findings from Cisco scanner (those are pattern-based, not keyword-based)
- Any finding involving actual URLs, file paths to sensitive directories, or executable code

---

## Step-by-Step: Vetting New Skills

```
1. Create temp directory:
   mkdir -p /tmp/skill-vetting

2. Download skill into its own folder:
   mkdir -p /tmp/skill-vetting/skill-name
   (copy SKILL.md + any reference files)

3. Run Cisco scanner (Gate 1)
   → HIGH or CRITICAL findings? → REJECT

4. Run SkillAudit (Gate 2)
   → CRITICAL findings? → REJECT
   → MEDIUM findings? → Investigate specific lines
     → Real threat? → REJECT
     → False positive? → Document and request founder override

5. Run mcp-scan on MCP configs only (Gate 3)
   → Skip for SKILL.md files

6. Manual review (Gate 4)
   → Any prompt injection, exfiltration, or destructive patterns? → REJECT

7. All gates passed → Install to .claude/skills/skill-name/
```

---

## Sourcing Skills

**Good sources:**
- GitHub repos directly (read the code before downloading)
- sickn33/antigravity-awesome-skills (800+ skills, most are clean)
- davila7/claude-code-templates (large collection, well-organized)
- wshobson/agents (smaller, high quality)

**Avoid:**
- skillsmp.com — blocks direct web fetch (403), go through the GitHub repos it links to instead
- Any skill that doesn't have a SKILL.md (non-standard format)
- Skills that reference `superpowers:` sub-skills you haven't vetted

---

## Currently Installed Skills (Frasier Project)

These 7 skills passed the full D-022 pipeline on 2026-02-23 and are installed at `.claude/skills/`:

### 1. design-orchestration
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** SKILL.md (1 file)
- **What it does:** Routes work through brainstorming → multi-agent review → execution readiness. Prevents premature implementation and skipped validation.
- **Scanner results:** Cisco PASS, SkillAudit A (92/100), Manual PASS

### 2. dispatching-parallel-agents
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** SKILL.md (1 file)
- **What it does:** Patterns for dispatching 2+ independent tasks in parallel without shared state or sequential dependencies.
- **Scanner results:** Cisco PASS, SkillAudit A (98/100), Manual PASS

### 3. multi-agent-patterns
- **Source:** sickn33/antigravity-awesome-skills
- **Files:** SKILL.md (1 file)
- **What it does:** Reference guide for orchestrator, peer-to-peer, and hierarchical multi-agent architectures. Covers the "telephone game" problem, context isolation, token economics, and failure modes.
- **Scanner results:** Cisco PASS, SkillAudit A (96/100), Manual PASS

### 4. subagent-driven-development
- **Source:** davila7/claude-code-templates
- **Files:** SKILL.md, implementer-prompt.md, spec-reviewer-prompt.md, code-quality-reviewer-prompt.md (4 files)
- **What it does:** Execute implementation plans by dispatching fresh subagent per task with two-stage review: spec compliance first, then code quality.
- **Scanner results:** Cisco PASS, SkillAudit A (96/100), Manual PASS

### 5. task-coordination-strategies
- **Source:** wshobson/agents
- **Files:** SKILL.md, references/task-decomposition.md, references/dependency-graphs.md (3 files)
- **What it does:** Decompose complex tasks, design dependency graphs (blockedBy/blocks), write task descriptions with acceptance criteria, monitor workload across agent teams.
- **Scanner results:** Cisco PASS, SkillAudit D (62/100 — 6 MEDIUM false positives on "password" keyword in auth example templates, override approved), Manual PASS

### 6. task-execution-engine
- **Source:** davila7/claude-code-templates
- **Files:** SKILL.md, references/task-format.md, references/workflow-guide.md, scripts/task_manager.py (4 files)
- **What it does:** Execute implementation tasks from design documents using markdown checkboxes with priority, phase, and dependency tracking. Includes Python task manager script.
- **Scanner results:** Cisco PASS, SkillAudit D (60/100 — 6 MEDIUM false positives, same pattern as above, override approved), Manual PASS
- **Note:** Has "Unattended Mode" that tells AI not to stop for questions — CLAUDE.md Rule #3 (questions first) always takes precedence.

### 7. writing-plans
- **Source:** davila7/claude-code-templates
- **Files:** SKILL.md (1 file)
- **What it does:** Structured implementation plan writing with atomic verb-first tasks, TDD workflow, exact file paths, and commit guidance. Plans saved to docs/plans/.
- **Scanner results:** Cisco PASS, SkillAudit A (98/100), Manual PASS

### REJECTED: autonomous-agent-patterns
- **Source:** sickn33/antigravity-awesome-skills
- **Reason:** Cisco HIGH (rm -rf system manipulation pattern), SkillAudit F (50/100, 2 CRITICAL: sensitive filesystem access at lines 399 and 1163). Legitimate threats confirmed by manual review.
- **Not reinstallable** without a rewrite removing destructive patterns.
