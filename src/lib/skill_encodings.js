// skill_encodings.js — Hybrid skill encoding for runtime agents (D-028)
// WHY: Agents need Claude Code skill knowledge during task execution.
// Distilled summaries are always present in the prompt (cheap, ~1 sentence each).
// Full content injects only when topic tags match trigger keywords, keeping
// prompts lean while giving agents deep knowledge exactly when they need it.
//
// This is separate from skills.js (Pillar 4 — capability growth tracking).
// skills.js tracks what agents CAN do and how proficient they are.
// skill_encodings.js injects HOW to do specific types of work.

// ============================================================
// SKILL ENCODING DEFINITIONS
// ============================================================
// Each encoding has:
//   distilled: 1-2 sentence summary (always injected for applicable agents)
//   full: detailed protocol (injected on-demand when topic tags match)
//   triggerKeywords: topic tags that activate full injection
//   applicableRoles: which agent_types receive this skill ('all' = everyone)

const SKILL_ENCODINGS = {
  'task-execution-engine': {
    distilled: 'Execute implementation tasks systematically: read the spec, check off completed items, work through remaining items in order, verify each step before marking complete.',
    full: `## Task Execution Protocol
When executing implementation tasks:
1. Parse the design document for checkboxes/tasks
2. Identify completed vs remaining items
3. For each remaining task: read context → implement → verify → mark complete
4. If blocked, document the blocker and move to next unblocked task
5. After all tasks: run verification, report results`,
    triggerKeywords: ['implement', 'build', 'execute', 'task', 'code', 'deploy'],
    applicableRoles: ['all']
  },
  'design-orchestration': {
    distilled: 'Route design work through brainstorming → multi-agent review → execution readiness in the correct order. Never skip validation or jump to implementation.',
    full: `## Design Orchestration Protocol
1. BRAINSTORM: Generate multiple approaches (minimum 3)
2. EVALUATE: Score each approach on feasibility, cost, timeline, risk
3. REVIEW: Get input from relevant domain experts
4. VALIDATE: Ensure design is complete and unambiguous before execution
5. HANDOFF: Create clear execution spec with acceptance criteria
Never skip steps. Premature implementation is the #1 cause of rework.`,
    triggerKeywords: ['design', 'architect', 'plan', 'brainstorm', 'review'],
    applicableRoles: ['chief_of_staff']
  },
  'task-coordination-strategies': {
    distilled: 'Decompose complex tasks into dependency graphs. Identify parallel work, sequence dependent tasks, and balance workload across agents.',
    full: `## Task Coordination Protocol
1. DECOMPOSE: Break project into atomic tasks (each completable by one agent)
2. MAP DEPENDENCIES: Identify which tasks block others (DAG structure)
3. GROUP PARALLELS: Tasks with no shared dependencies can run simultaneously
4. ASSIGN: Match tasks to agents by expertise, balance workload
5. MONITOR: Track progress, unblock stalled tasks, reassign if needed
Key principle: maximize parallelism while respecting dependency order.`,
    triggerKeywords: ['decompose', 'coordinate', 'parallel', 'dependency', 'assign', 'delegate'],
    applicableRoles: ['chief_of_staff']
  },
  'multi-agent-patterns': {
    distilled: 'Use orchestrator pattern for complex work: one coordinator assigns, monitors, and synthesizes results from specialist agents.',
    full: `## Multi-Agent Orchestration
Pattern: ORCHESTRATOR (Frasier) → SPECIALISTS (domain agents)
- Orchestrator decomposes work and assigns to specialists
- Specialists execute independently, report results back
- Orchestrator synthesizes, resolves conflicts, ensures coherence
- QA reviews individual outputs; orchestrator reviews the whole
Anti-patterns to avoid: peer-to-peer without coordinator, agents duplicating work, circular dependencies.`,
    triggerKeywords: ['multi-agent', 'orchestrate', 'coordinate', 'team', 'delegate', 'assign'],
    applicableRoles: ['chief_of_staff']
  },
  'subagent-driven-development': {
    distilled: 'Dispatch independent tasks to parallel agents. Each agent works autonomously on their piece; results are merged by the orchestrator.',
    full: `## Parallel Dispatch Protocol
1. Identify independent tasks (no shared state or sequential dependency)
2. Dispatch each to a specialist agent with clear scope and acceptance criteria
3. Agents work autonomously — no cross-agent communication during execution
4. Collect results, verify completeness, merge into unified deliverable
5. If any agent is blocked or fails, reassign or adjust scope
Maximize throughput by keeping agents working in parallel whenever possible.`,
    triggerKeywords: ['parallel', 'dispatch', 'independent', 'concurrent', 'batch'],
    applicableRoles: ['chief_of_staff']
  }
};

// Token budget guard: prevent prompt bloat from full skill injection
const MAX_SKILL_INJECTION_CHARS = 3000;

// ============================================================
// BUILD SKILL INJECTION
// ============================================================

/**
 * Build the skill knowledge section for an agent's system prompt.
 *
 * @param {string} role - Agent's role string (e.g. "Research Analyst", "Full-Stack Engineer")
 * @param {string} agentType - Agent type: 'chief_of_staff', 'sub_agent', 'qa', etc.
 * @param {string[]} topicTags - Topic tags from the current task context
 * @returns {string} Formatted skill knowledge section, or empty string if none applicable
 */
function buildSkillInjection(role, agentType, topicTags) {
  const safeTags = Array.isArray(topicTags) ? topicTags : [];
  // WHY: Case-insensitive matching so tags like 'IMPLEMENT' still trigger skills
  const lowerTags = safeTags.map(t => t.toLowerCase());

  // Step 1: Filter to skills applicable for this agent type
  const applicableSkills = Object.entries(SKILL_ENCODINGS).filter(([name, encoding]) => {
    return encoding.applicableRoles.includes('all') ||
           encoding.applicableRoles.includes(agentType);
  });

  if (applicableSkills.length === 0) {
    return '';
  }

  // Step 2: Build sections with distilled + conditionally full content
  const sections = applicableSkills.map(([name, encoding]) => {
    const triggered = lowerTags.some(tag =>
      encoding.triggerKeywords.some(kw => kw.toLowerCase() === tag)
    );

    let section = `## ${name}\n${encoding.distilled}`;
    if (triggered) {
      section += `\n\n${encoding.full}`;
    }
    return section;
  });

  const header = '# SKILL KNOWLEDGE (from organizational training)';
  const fullResult = `${header}\n\n${sections.join('\n\n')}`;

  // Step 3: Budget guard — if full result exceeds limit, fall back to distilled only
  if (fullResult.length > MAX_SKILL_INJECTION_CHARS) {
    const distilledSections = applicableSkills.map(([name, encoding]) => {
      return `## ${name}\n${encoding.distilled}`;
    });
    return `${header}\n\n${distilledSections.join('\n\n')}`;
  }

  return fullResult;
}

module.exports = {
  buildSkillInjection,
  SKILL_ENCODINGS,
  MAX_SKILL_INJECTION_CHARS
};
