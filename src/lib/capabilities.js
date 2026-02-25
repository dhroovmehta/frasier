// capabilities.js — Agent Capability Manifest & Feasibility Validation (v0.10.0)
// WHY: The decomposition engine was planning blind — creating tasks with acceptance criteria
// that agents couldn't fulfill (e.g., "mine 50 Reddit threads" when agents can only search
// via Brave). This module provides capability awareness to the planning layer so tasks are
// scoped to what agents can actually do.
//
// Two responsibilities:
// 1. buildCapabilityManifest() — static text injected into the decomposition prompt
// 2. validatePlanFeasibility() — T1 LLM check that each step is achievable before execution

const models = require('./models');

// ============================================================
// ROLE CAPABILITIES — What each agent role can and cannot do
// ============================================================

// WHY structured data: The manifest is built from this constant so we can
// (a) test it independently, (b) extend it when we add tools, and
// (c) use it in both the decomposition prompt and the feasibility validator.

const ROLE_CAPABILITIES = {
  research: {
    tools: [
      'Web search via Brave API (up to 4 queries per task, 2 results per query)',
      'Web search via DuckDuckGo (fallback when Brave unavailable)',
      'URL fetching — read static web pages (max 8 pages per task, 8000 chars each)',
      'Twitter/X reading via fxtwitter proxy (given a tweet URL)',
      'Agent-initiated web access via [WEB_SEARCH:query] and [WEB_FETCH:url] tags',
      'LLM-powered analysis, synthesis, and report writing'
    ],
    strengths: [
      'Market analysis and competitive intelligence',
      'Synthesizing multiple web sources into structured reports',
      'Trend identification from available data',
      'Quantitative analysis of publicly available information'
    ],
    cannot: [
      'Browse JavaScript-heavy sites (no headless browser — Reddit, Twitter timelines, SPAs won\'t render)',
      'Scrape at scale — limited to 8 page fetches per task, not hundreds',
      'Access Google Trends API, SEMrush, Ahrefs, or any paid research tool',
      'Log into any website or handle authentication/CAPTCHAs',
      'Download or process images, PDFs, or binary files',
      'Access paywalled content (WSJ, FT, etc.)',
      'Run programmatic data collection scripts or database queries',
      'Post to or interact with any external service'
    ]
  },

  engineering: {
    tools: [
      'Code generation in any programming language',
      'Architecture and system design documentation',
      'Code review and debugging analysis',
      'Technical specification writing',
      'Web search for documentation and technical references (same limits as research)',
      'URL fetching for API docs and technical resources'
    ],
    strengths: [
      'Full-stack development (frontend, backend, database)',
      'System architecture and design patterns',
      'Code quality review and optimization',
      'Technical documentation'
    ],
    cannot: [
      'Execute or run code in any environment',
      'Deploy to servers, cloud platforms, or any infrastructure',
      'Access databases, APIs, or external services directly',
      'Test code in a real runtime environment',
      'Create or modify actual files on disk',
      'Install packages or manage dependencies',
      'Access private repositories or proprietary codebases'
    ]
  },

  content: {
    tools: [
      'Text generation and copywriting',
      'Social media post drafting (queued via [SOCIAL_POST:] tag)',
      'Web search for topic research (same limits as research)',
      'URL fetching for reference material'
    ],
    strengths: [
      'Copywriting and brand storytelling',
      'Social media content (tweets, posts, threads)',
      'Blog articles and long-form content',
      'Audience-specific messaging and tone'
    ],
    cannot: [
      'Create images, graphics, thumbnails, or visual content',
      'Record or edit audio or video',
      'Upload content to any platform directly',
      'Access analytics dashboards (YouTube, Twitter, Instagram analytics)',
      'Schedule or publish posts (can only draft via [SOCIAL_POST:] tag)',
      'Design layouts, slides, or visual presentations'
    ]
  },

  strategy: {
    tools: [
      'Strategic analysis and framework application',
      'Business model and revenue modeling (text-based)',
      'Web search for market data (same limits as research)',
      'URL fetching for industry reports and public data'
    ],
    strengths: [
      'Go-to-market strategy and business planning',
      'Pricing and monetization strategy',
      'Competitive positioning',
      'Implementation roadmaps with milestones'
    ],
    cannot: [
      'Access financial databases, Bloomberg, or market data APIs',
      'Run financial models in spreadsheets or code',
      'Access CRM or customer data systems',
      'Conduct surveys or user interviews',
      'Access internal company metrics or dashboards'
    ]
  },

  marketing: {
    tools: [
      'Marketing strategy and campaign planning (text-based)',
      'SEO analysis from publicly available information',
      'Social media post drafting (queued via [SOCIAL_POST:] tag)',
      'Web search for competitor marketing tactics (same limits as research)',
      'URL fetching for marketing examples and case studies'
    ],
    strengths: [
      'Growth strategy and funnel optimization',
      'SEO and content distribution planning',
      'A/B test design and success metrics',
      'Channel-specific marketing tactics'
    ],
    cannot: [
      'Access Google Analytics, Search Console, or any analytics platform',
      'Run ads on any platform (Google, Facebook, Twitter)',
      'Access email marketing platforms (Mailchimp, SendGrid)',
      'Track real conversion data or campaign performance',
      'Create ad creatives, landing pages, or visual assets',
      'Manage social media accounts directly'
    ]
  },

  qa: {
    tools: [
      'Code review and security analysis (text-based)',
      'Test case design and specification',
      'Quality rubric-based evaluation',
      'Web search for security best practices and vulnerability references'
    ],
    strengths: [
      'Quality assessment against acceptance criteria',
      'Security audit and vulnerability identification',
      'Test planning and edge case identification',
      'Code review for correctness and maintainability'
    ],
    cannot: [
      'Execute test suites or run automated tests',
      'Access CI/CD pipelines or build systems',
      'Penetration test live systems',
      'Access production logs or monitoring dashboards',
      'Run static analysis tools or linters'
    ]
  },

  knowledge: {
    tools: [
      'Documentation writing and knowledge curation',
      'Information synthesis and summarization',
      'Web search for reference materials (same limits as research)',
      'URL fetching for external documentation'
    ],
    strengths: [
      'Knowledge organization and categorization',
      'Cross-referencing and gap identification',
      'Technical writing and documentation',
      'Summary and digest creation'
    ],
    cannot: [
      'Access internal knowledge bases or wikis directly',
      'Manage document storage systems (Google Drive, Notion) directly',
      'Create diagrams, charts, or visual documentation',
      'Access version control history or diff tools directly'
    ]
  }
};

// ============================================================
// GLOBAL EXECUTION CONSTRAINTS
// ============================================================

// WHY separate: These apply to ALL agents regardless of role.
// Keeping them explicit prevents the planner from designing tasks
// that exceed system-wide limits.

const GLOBAL_CONSTRAINTS = `## GLOBAL EXECUTION CONSTRAINTS (Apply to ALL agents)
- Web search: max 4 queries per task, 2 results per query (8 page fetches total)
- Page content: max 8000 characters extracted per page (larger pages truncated)
- No headless browser: JavaScript-heavy pages (Reddit, Twitter feeds, SPAs) won't render properly
- No authentication: agents cannot log into any website or service
- No file creation: agents produce text output only, cannot create files on disk
- No direct database access: agents cannot query databases or APIs directly
- No real-time data: agents get a snapshot via web search, not live streaming data
- LLM knowledge cutoff: agents have general knowledge but must verify current data via web search
- Each task is executed independently: agents do not share state between tasks (only predecessor outputs in DAG)`;

// ============================================================
// BUILD CAPABILITY MANIFEST (for decomposition prompt)
// ============================================================

/**
 * Build the full capability manifest as a text block for injection into
 * the decomposition prompt.
 *
 * @returns {string} Formatted capability manifest
 */
function buildCapabilityManifest() {
  let manifest = '## AGENT CAPABILITIES AND CONSTRAINTS\n';
  manifest += 'Each agent role has specific tools and hard limits. Every task MUST be achievable\n';
  manifest += 'using ONLY the assigned role\'s listed tools. Be creative — find alternative paths\n';
  manifest += 'to the same outcome when direct methods are unavailable.\n\n';

  for (const [role, cap] of Object.entries(ROLE_CAPABILITIES)) {
    manifest += `### ${role.toUpperCase()}\n`;
    manifest += `TOOLS:\n${cap.tools.map(t => `  - ${t}`).join('\n')}\n`;
    manifest += `STRENGTHS: ${cap.strengths.join(', ')}\n`;
    manifest += `CANNOT:\n${cap.cannot.map(c => `  - ${c}`).join('\n')}\n\n`;
  }

  manifest += `${GLOBAL_CONSTRAINTS}\n`;

  return manifest;
}

// ============================================================
// FEASIBILITY VALIDATION
// ============================================================

/**
 * Validate that every task in a decomposed plan is achievable given agent capabilities.
 * Uses a cheap T1 LLM call to review each task against the manifest.
 *
 * WHY fail-open: If the validator itself breaks (LLM error, bad JSON), we proceed
 * with the plan rather than blocking execution. The QA pipeline downstream is still
 * a safety net — this gate reduces waste, it doesn't need to be bulletproof.
 *
 * @param {Object} plan — The decomposed task plan
 * @param {string} agentId — Frasier's agent ID for LLM tracking
 * @returns {{ feasible: boolean, issues: Array<{ taskId: string, issue: string, suggestion: string }> }}
 */
async function validatePlanFeasibility(plan, agentId) {
  try {
    const manifest = buildCapabilityManifest();

    const taskList = plan.tasks.map(t =>
      `- [${t.id}] (${t.required_role}): ${t.description}\n  Acceptance Criteria: ${t.acceptance_criteria}`
    ).join('\n');

    const userMessage = `## FEASIBILITY CHECK — Review this task plan against agent capabilities

${manifest}

## PROPOSED TASKS
${taskList}

For each task, determine if the assigned role's tools can realistically achieve the acceptance criteria.

Respond with ONLY a JSON object:
{
  "feasible": true/false,
  "issues": [
    {
      "taskId": "T1",
      "issue": "What makes this infeasible — be specific about which capability is missing",
      "suggestion": "How to achieve the same goal using available tools"
    }
  ]
}

Rules:
- "feasible" is true ONLY if ALL tasks are achievable
- An empty issues array means all tasks pass
- Be strict: if acceptance criteria require a tool the role doesn't have, flag it
- Be constructive: every issue MUST include a practical suggestion for an alternative approach`;

    const result = await models.callLLM({
      systemPrompt: 'You are a capability auditor. Check task feasibility against agent tool constraints. Respond with valid JSON only.',
      userMessage,
      agentId,
      forceTier: 'tier1'
    });

    if (result.error) {
      console.log(`[capabilities] Feasibility check LLM error, fail-open: ${result.error}`);
      return { feasible: true, issues: [] };
    }

    let content = result.content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(content);
    return {
      feasible: parsed.feasible === true,
      issues: Array.isArray(parsed.issues) ? parsed.issues : []
    };
  } catch (err) {
    // WHY fail-open: A broken validator shouldn't block project execution.
    // The downstream QA pipeline is still the safety net.
    console.log(`[capabilities] Feasibility validation failed, proceeding: ${err.message}`);
    return { feasible: true, issues: [] };
  }
}

module.exports = {
  ROLE_CAPABILITIES,
  GLOBAL_CONSTRAINTS,
  buildCapabilityManifest,
  validatePlanFeasibility
};
