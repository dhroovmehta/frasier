// context.js — Task context enrichment pipeline
// WHY: Agents were receiving raw task descriptions with zero context about what
// Zero originally asked for, no output templates, and no quality mandates.
// This module builds a rich context for every task execution.
//
// Pipeline: original message + domain instructions + task + output template + quality standards

const supabase = require('./supabase');

// ============================================================
// OUTPUT TEMPLATES (structured deliverable formats)
// ============================================================

const OUTPUT_TEMPLATES = {
  research: `## OUTPUT FORMAT — Research Deliverable
Follow this structure:

### Executive Summary
(2-3 paragraphs: what you found, why it matters, what to do about it)

### Key Findings
(Numbered list with specific data points, named sources, and quantified claims)

### Competitive Landscape
(Named competitors with specific differentiators, market position, funding/revenue where available)

### Market Sizing
(TAM/SAM/SOM with methodology explained)

### Risk Assessment
(Risk matrix: each risk with probability, impact, and mitigation)

### Recommendations
(At least 3 specific, actionable recommendations with expected outcomes)`,

  strategy: `## OUTPUT FORMAT — Strategy Deliverable
Follow this structure:

### Strategic Overview
(Executive-level summary: the opportunity, the approach, expected ROI)

### Market Context
(Current landscape, trends, competitive dynamics with data)

### Strategy Framework
(Clear thesis with supporting evidence and assumptions stated explicitly)

### Implementation Roadmap
(90-day phased plan with milestones, owners, and dependencies)

### Resource Requirements
(Budget, tools, people — with specific estimates, not ranges)

### Success Metrics
(KPIs with specific targets and measurement timeframes)

### Risk Mitigation
(Top 3 risks with contingency plans)`,

  content: `## OUTPUT FORMAT — Content Deliverable
Follow this structure:

### Hook / Headline
(Must pass the "would I click this?" test)

### Core Message
(Clear, audience-specific language — not generic marketing speak)

### Supporting Points
(Each backed by a data point or real example)

### Call to Action
(Clear CTA with measurable expected outcome)

### Distribution Notes
(2-3 recommended channels with rationale for each)`,

  engineering: `## OUTPUT FORMAT — Engineering Deliverable
Follow this structure:

### Technical Approach
(Architecture decision with trade-offs stated explicitly)

### Implementation
(Working code with inline comments explaining non-obvious decisions)

### Testing
(Test cases covering happy path, edge cases, and error scenarios)

### Deployment Notes
(Steps to deploy, environment requirements, rollback plan)`,

  requirements: `## OUTPUT FORMAT — Requirements Deliverable
Follow this structure:

### Problem Statement
(What problem are we solving and for whom?)

### Functional Requirements
(Numbered list: "The system SHALL..." format)

### Non-Functional Requirements
(Performance, security, scalability constraints)

### User Stories
(As a [user], I want [action] so that [benefit])

### Acceptance Criteria
(Testable conditions for each requirement)

### Out of Scope
(Explicit list of what this does NOT include)`,

  default: `## OUTPUT FORMAT
Follow this structure:

### Summary
(Clear overview of what was done and key outcomes)

### Details
(Comprehensive breakdown with supporting evidence)

### Recommendations / Next Steps
(Specific, actionable items with expected outcomes)`
};

// ============================================================
// DOMAIN INSTRUCTIONS (role-specific quality mandates)
// ============================================================

const DOMAIN_INSTRUCTIONS = {
  research: `YOU ARE the expert Research Analyst. You are doing the research yourself — not describing what someone else should do. Produce the ACTUAL deliverable.

Your output MUST include:
- Specific data points with named sources (not vague claims like "the market is growing")
- Named competitors with market share, funding, or revenue data where available
- TAM/SAM/SOM estimates with methodology explained
- Risk matrix with probability and impact ratings
- At least 3 specific, actionable recommendations
- NEVER use filler phrases like "in today's fast-paced world" or "it's important to note"

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`,

  strategy: `YOU ARE the expert Strategy Lead. You are building the strategy yourself — not describing what someone else should do. Produce the ACTUAL deliverable.

Your output MUST include:
- Market sizing with defensible methodology
- 90-day implementation roadmap with milestones and owners
- Resource requirements (budget, tools, people) with specific estimates
- Success metrics with specific KPI targets and measurement timeframes
- Risk mitigation plan for top 3 risks with contingency actions
- NEVER deliver strategy without quantified projections and measurable outcomes

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`,

  content: `YOU ARE the expert Content Creator. You are writing the content yourself — not describing what someone else should write. Produce the ACTUAL deliverable.

Your output MUST include:
- A hook/headline that passes the "would I click this?" test
- Audience-specific language (not generic marketing speak)
- Clear CTA with measurable expected outcome
- At least one data point or real example per key claim
- 2-3 distribution channel recommendations with rationale

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`,

  engineering: `YOU ARE the expert Engineer. You are writing the code yourself — not describing what someone else should build. Produce the ACTUAL deliverable.

Your output MUST include:
- Working, production-ready code (not pseudocode)
- Error handling at every external boundary
- Inline comments explaining WHY, not WHAT
- Test cases for happy path and edge cases
- Deployment instructions and rollback plan

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`,

  qa: `YOU ARE the expert QA Engineer. You are performing the testing yourself — not describing what someone else should test. Produce the ACTUAL deliverable.

Your output MUST include:
- Specific pass/fail criteria for each test
- Edge cases and boundary conditions tested
- Security considerations reviewed
- Performance implications noted
- Clear verdict with evidence for each finding

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`,

  marketing: `YOU ARE the expert Growth Marketer. You are building the marketing plan yourself — not describing what someone else should do. Produce the ACTUAL deliverable.

Your output MUST include:
- Channel-specific tactics with expected conversion rates
- Budget allocation with ROI projections
- A/B test recommendations with success metrics
- Competitive positioning analysis
- 30/60/90 day implementation timeline

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`,

  knowledge: `YOU ARE the expert Knowledge Curator. You are curating the knowledge yourself — not describing what someone else should organize. Produce the ACTUAL deliverable.

Your output MUST include:
- Clear categorization and tagging
- Cross-references to related documents
- Summary of key insights (not just raw data)
- Identified gaps in existing knowledge
- Recommended next steps for knowledge improvement

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: Do NOT produce instructions, meta-commentary, or frameworks for how someone else should do this work. YOU are the one doing it. Deliver the RESULTS.`
};

// Map agent role strings to domain categories
const ROLE_TO_DOMAIN = {
  'research analyst': 'research',
  'research': 'research',
  'analyst': 'research',
  'intelligence': 'research',
  'strategy lead': 'strategy',
  'strategist': 'strategy',
  'strategy': 'strategy',
  'content creator': 'content',
  'content writer': 'content',
  'copywriter': 'content',
  'content': 'content',
  'full-stack engineer': 'engineering',
  'engineer': 'engineering',
  'developer': 'engineering',
  'architect': 'engineering',
  'engineering': 'engineering',
  'qa engineer': 'qa',
  'qa': 'qa',
  'quality assurance': 'qa',
  'tester': 'qa',
  'growth marketer': 'marketing',
  'marketing': 'marketing',
  'seo': 'marketing',
  'knowledge curator': 'knowledge',
  'knowledge': 'knowledge',
  'documentation': 'knowledge'
};

// ============================================================
// TEMPLATE SELECTION (keyword-based)
// ============================================================

// Keywords that map to template types
const TEMPLATE_KEYWORDS = {
  research: ['research', 'analyze', 'analysis', 'competitive', 'market', 'trends', 'intelligence', 'study', 'investigate'],
  strategy: ['strategy', 'strategic', 'business plan', 'go-to-market', 'roadmap', 'pricing', 'growth plan'],
  content: ['write', 'blog', 'article', 'content', 'copy', 'post', 'tweet', 'social', 'storytelling'],
  engineering: ['code', 'build', 'api', 'deploy', 'architecture', 'database', 'backend', 'frontend', 'endpoint'],
  requirements: ['requirements', 'define', 'specification', 'user stories', 'acceptance criteria', 'scope']
};

/**
 * Select the appropriate output template based on task description keywords.
 * @param {string} taskDescription
 * @returns {string} Output template markdown
 */
function selectOutputTemplate(taskDescription) {
  const lower = taskDescription.toLowerCase();
  let bestMatch = 'default';
  let bestScore = 0;

  for (const [type, keywords] of Object.entries(TEMPLATE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = type;
    }
  }

  return OUTPUT_TEMPLATES[bestMatch];
}

// ============================================================
// DOMAIN INSTRUCTIONS LOOKUP
// ============================================================

/**
 * Get role-specific quality mandates based on agent role string.
 * @param {string} agentRole - e.g. "Research Analyst", "Strategy Lead"
 * @returns {string} Domain-specific quality instructions
 */
function getDomainInstructions(agentRole) {
  const lower = (agentRole || '').toLowerCase();

  // Try exact match first
  if (ROLE_TO_DOMAIN[lower]) {
    return DOMAIN_INSTRUCTIONS[ROLE_TO_DOMAIN[lower]];
  }

  // Try partial match
  for (const [roleKey, domain] of Object.entries(ROLE_TO_DOMAIN)) {
    if (lower.includes(roleKey) || roleKey.includes(lower)) {
      return DOMAIN_INSTRUCTIONS[domain];
    }
  }

  // Generic fallback — handles all dynamic roles (Real Estate Market Analyst, AI Product Architect, etc.)
  return `YOU ARE the expert. You are performing the actual work yourself — not describing what someone else should do. Produce the ACTUAL deliverable.

Your output MUST be:
- Specific and actionable (not vague or generic)
- Backed by evidence, data, or clear reasoning
- Structured with clear sections and headings
- Professional and executive-ready
- NEVER use filler phrases or AI slop

CITATION REQUIREMENT: Every factual claim, statistic, product name, pricing, and market data MUST include its source in [brackets]. Unsourced claims will fail review.

CRITICAL: You are the DOER, not the ADVISOR. Deliver the WORK, not instructions for how to do it.`;
}

// ============================================================
// ORIGINAL MESSAGE RETRIEVAL
// ============================================================

/**
 * Trace mission → proposal → raw_message to get Zero's original request.
 * @param {number} missionId
 * @returns {string|null} The original message, or null if not found
 */
async function getOriginalMessage(missionId) {
  // Get the mission to find its proposal_id
  const { data: mission } = await supabase
    .from('missions')
    .select('proposal_id')
    .eq('id', missionId)
    .single();

  if (!mission || !mission.proposal_id) return null;

  // Get the proposal to find raw_message
  const { data: proposal } = await supabase
    .from('mission_proposals')
    .select('raw_message')
    .eq('id', mission.proposal_id)
    .single();

  if (!proposal || !proposal.raw_message) return null;

  return proposal.raw_message;
}

// ============================================================
// MAIN CONTEXT BUILDER
// ============================================================

/**
 * Build enriched task context for an agent's LLM call.
 * Combines: original message + domain mandates + task description + output template + quality standards.
 *
 * @param {Object} step - The mission step being executed
 * @param {string} agentRole - The assigned agent's role (e.g. "Research Analyst")
 * @returns {string} Enriched user message for the LLM call
 */
async function buildTaskContext(step, agentRole) {
  const parts = [];

  // 1. Zero's original request (traces mission → proposal → raw_message)
  const originalMessage = await getOriginalMessage(step.mission_id);
  if (originalMessage) {
    parts.push(`## ZERO'S ORIGINAL REQUEST\n"${originalMessage}"\n`);
  }

  // 2. Domain-specific quality mandates
  const domainInstructions = getDomainInstructions(agentRole);
  parts.push(`## QUALITY MANDATES (Your Role-Specific Standards)\n${domainInstructions}\n`);

  // 3. The actual task description
  parts.push(`## YOUR TASK\n${step.description}\n`);

  // 4. Output template
  const template = selectOutputTemplate(step.description);
  parts.push(`${template}\n`);

  // 5. Quality standards (universal)
  parts.push(`## QUALITY STANDARDS (Non-Negotiable)
- Every claim must be backed by specific data, a named source, or clear reasoning
- No filler phrases: "in today's fast-paced world", "it's important to note", "as we all know"
- No vague qualifiers: "significant growth", "substantial market" — use numbers
- If you lack data on something, STATE what's missing rather than filling with generic text
- The output must be executive-ready: a senior leader should be able to act on this immediately
- NEVER produce generic, surface-level content. Depth and specificity are non-negotiable.
- CRITICAL: You are the DOER, not the ADVISOR. Produce the actual deliverable, not instructions for how someone else should produce it. If asked to "research X", deliver the research findings. If asked to "write requirements", deliver the requirements document. Never describe what should be done — DO IT.`);

  return parts.join('\n');
}

module.exports = {
  selectOutputTemplate,
  getDomainInstructions,
  getOriginalMessage,
  buildTaskContext,
  OUTPUT_TEMPLATES,
  DOMAIN_INSTRUCTIONS
};
