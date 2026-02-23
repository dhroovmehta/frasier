// skills.js — Agent capability system (Pillar 4)
// WHY: Agents should develop expertise through work. A new hire starts at Lv.1,
// but after 50 research tasks their market_research skill is Lv.6 — and their
// prompts reflect that specialization. Skills grow by doing, not by configuration.
//
// Uses the existing agent_skills table (001_initial_schema.sql).
// No new tables, no SQL migration needed.

const supabase = require('./supabase');
const events = require('./events');

// ============================================================
// ROLE → INITIAL SKILLS MAP
// ============================================================
// When a new agent is hired, they get 3 starter skills at proficiency 1.
// Role matching is case-insensitive substring match.

const ROLE_SKILLS = {
  'research':    ['market_research', 'data_analysis', 'competitive_intel',
                  'deep_research', 'competitive_analysis', 'market_sizing', 'data_storytelling',
                  'pricing_research', 'analytics_design', 'research_methodology'],
  'strategy':    ['strategic_planning', 'business_modeling', 'leadership',
                  'product_management', 'planning_execution', 'decision_frameworks',
                  'startup_analysis', 'metrics_kpi', 'business_analysis'],
  'content':     ['copywriting', 'social_media', 'brand_storytelling',
                  'seo_content_writing', 'marketing_psychology', 'content_planning',
                  'content_marketing', 'email_marketing', 'content_auditing'],
  'engineer':    ['software_engineering', 'system_architecture', 'debugging',
                  'fullstack_development', 'architecture_patterns', 'backend_architecture',
                  'clean_code', 'error_handling', 'database_architecture', 'api_design', 'code_review'],
  'qa':          ['quality_assurance', 'security_auditing', 'test_design',
                  'tdd', 'systematic_debugging', 'bug_detection', 'threat_modeling',
                  'e2e_testing', 'code_review_excellence'],
  'growth':      ['seo_optimization', 'campaign_management', 'funnel_design',
                  'programmatic_seo', 'growth_tooling', 'pricing_strategy',
                  'ab_testing', 'launch_strategy', 'keyword_strategy', 'conversion_optimization'],
  'marketing':   ['seo_optimization', 'campaign_management', 'funnel_design',
                  'programmatic_seo', 'growth_tooling', 'pricing_strategy',
                  'ab_testing', 'launch_strategy', 'keyword_strategy', 'conversion_optimization'],
  'knowledge':   ['documentation', 'knowledge_synthesis', 'information_architecture',
                  'docs_architecture', 'wiki_architecture', 'wiki_research',
                  'doc_templates', 'data_storytelling', 'decision_records', 'prose_quality'],
  'curator':     ['documentation', 'knowledge_synthesis', 'information_architecture',
                  'docs_architecture', 'wiki_architecture', 'wiki_research',
                  'doc_templates', 'data_storytelling', 'decision_records', 'prose_quality']
};

// ============================================================
// SKILL → KEYWORD MAP (for detecting which skills a task exercises)
// ============================================================
// Same pattern as routeByKeywords() and extractTopicTags().
// Zero extra LLM cost — pure keyword matching.

const SKILL_KEYWORDS = {
  market_research:           ['research', 'market', 'industry', 'trends', 'landscape', 'survey'],
  data_analysis:             ['analysis', 'data', 'metrics', 'statistics', 'numbers', 'quantitative'],
  competitive_intel:         ['competitive', 'competitor', 'comparison', 'benchmark', 'rival'],
  strategic_planning:        ['strategy', 'plan', 'roadmap', 'vision', 'objective', 'goal'],
  business_modeling:         ['business model', 'revenue', 'pricing', 'financial', 'unit economics'],
  leadership:                ['lead', 'delegate', 'coordinate', 'manage', 'oversee', 'standup'],
  copywriting:               ['write', 'copy', 'blog', 'article', 'content', 'draft', 'headline'],
  social_media:              ['tweet', 'post', 'social', 'instagram', 'linkedin', 'thread', 'engagement'],
  brand_storytelling:        ['brand', 'story', 'narrative', 'voice', 'messaging', 'tone'],
  software_engineering:      ['code', 'build', 'implement', 'develop', 'program', 'function', 'api'],
  system_architecture:       ['architecture', 'design', 'schema', 'infrastructure', 'deploy', 'scale'],
  debugging:                 ['debug', 'fix', 'bug', 'error', 'troubleshoot', 'diagnose'],
  quality_assurance:         ['test', 'quality', 'review', 'qa', 'validate', 'verify', 'check'],
  security_auditing:         ['security', 'audit', 'vulnerability', 'penetration', 'risk'],
  test_design:               ['test case', 'test plan', 'coverage', 'regression', 'acceptance'],
  seo_optimization:          ['seo', 'search', 'ranking', 'keyword', 'organic', 'serp'],
  campaign_management:       ['campaign', 'ads', 'advertising', 'promotion', 'launch'],
  funnel_design:             ['funnel', 'conversion', 'landing page', 'cta', 'onboarding'],
  documentation:             ['document', 'wiki', 'readme', 'guide', 'manual', 'reference'],
  knowledge_synthesis:       ['summarize', 'synthesize', 'distill', 'overview', 'digest', 'briefing'],
  information_architecture:  ['organize', 'catalog', 'index', 'taxonomy', 'structure', 'categorize'],
  general_task_execution:    ['task', 'execute', 'complete', 'deliver', 'work'],

  // === NEW SKILLS (v0.6.0 — Agent Upskill) ===

  // Jet (Strategy/COO)
  product_management:        ['product', 'prioritize', 'backlog', 'feature', 'user story', 'rice', 'moscow'],
  planning_execution:        ['checkpoint', 'milestone', 'scope', 'action item', 'deliverable', 'blocker'],
  decision_frameworks:       ['decision', 'adr', 'trade-off', 'pros cons', 'evaluate', 'option'],
  startup_analysis:          ['startup', 'tam', 'sam', 'som', 'unit economics', 'cac', 'ltv', 'payback'],
  metrics_kpi:               ['kpi', 'dashboard', 'okr', 'north star', 'burn rate', 'rule of 40'],
  business_analysis:         ['cohort', 'retention', 'churn', 'arpu', 'balanced scorecard', 'scenario'],

  // Edward (Research)
  deep_research:             ['investigation', 'citation', 'source', 'evidence', 'primary source', 'due diligence'],
  competitive_analysis:      ['porter', 'five forces', 'positioning', 'differentiation', 'moat'],
  market_sizing:             ['market size', 'addressable market', 'bottom-up', 'top-down', 'triangulation'],
  pricing_research:          ['willingness to pay', 'van westendorp', 'conjoint', 'value metric', 'tier design'],
  analytics_design:          ['event taxonomy', 'measurement', 'attribution', 'tracking plan', 'funnel analysis'],
  research_methodology:      ['methodology', 'rigor', 'hypothesis', 'systematic', 'academic', 'peer review'],

  // Faye (Content)
  seo_content_writing:       ['e-e-a-t', 'keyword density', 'readability', 'search intent', 'serp feature'],
  marketing_psychology:      ['loss aversion', 'anchoring', 'social proof', 'scarcity', 'ikea effect', 'behavioral'],
  content_planning:          ['content pillar', 'topic cluster', 'editorial calendar', 'internal linking'],
  content_marketing:         ['distribution', 'omnichannel', 'content roi', 'attribution', 'repurpose'],
  email_marketing:           ['email sequence', 'drip', 'nurture', 'open rate', 'click rate', 'subject line'],
  content_auditing:          ['content audit', 'content score', 'freshness', 'thin content', 'content gap'],

  // Spike (Engineering)
  fullstack_development:     ['fullstack', 'frontend', 'backend', 'next.js', 'react', 'node', 'supabase'],
  architecture_patterns:     ['clean architecture', 'hexagonal', 'ddd', 'domain driven', 'bounded context'],
  backend_architecture:      ['circuit breaker', 'saga', 'cqrs', 'bulkhead', 'strangler', 'microservice'],
  clean_code:                ['srp', 'solid', 'code smell', 'refactor', 'maintainability', 'demeter'],
  error_handling:            ['retry', 'graceful degradation', 'fallback', 'either type', 'result type'],
  database_architecture:     ['normalization', 'denormalization', 'indexing', 'migration', 'cache strategy'],
  api_design:                ['rest', 'graphql', 'versioning', 'pagination', 'rate limit', 'openapi'],
  code_review:               ['code review', 'pull request', 'static analysis', 'sonarqube', 'semgrep'],

  // Ein (QA)
  tdd:                       ['red green refactor', 'test first', 'tdd', 'test driven'],
  systematic_debugging:      ['root cause', 'bisect', 'reproduce', 'isolate', 'hypothesis testing'],
  bug_detection:             ['attack surface', 'edge case', 'boundary', 'race condition', 'null check'],
  threat_modeling:           ['stride', 'pasta', 'attack tree', 'threat model', 'cvss', 'dread'],
  e2e_testing:               ['playwright', 'cypress', 'e2e', 'end to end', 'browser test', 'smoke test'],
  code_review_excellence:    ['blocking', 'nit', 'suggestion', 'approval', 'request changes'],

  // Vicious (Growth)
  programmatic_seo:          ['programmatic', 'template page', 'dynamic page', 'head term', 'long tail'],
  growth_tooling:            ['free tool', 'lead magnet', 'calculator', 'generator', 'gated content'],
  pricing_strategy:          ['freemium', 'value based', 'usage based', 'per seat', 'good better best'],
  ab_testing:                ['a/b test', 'experiment', 'hypothesis', 'statistical significance', 'mde', 'control'],
  launch_strategy:           ['product hunt', 'beta', 'early access', 'waitlist', 'go to market', 'gtm'],
  keyword_strategy:          ['keyword cluster', 'entity', 'lsi', 'search volume', 'difficulty', 'intent'],
  conversion_optimization:   ['cro', 'form optimization', 'friction', 'drop-off', 'field validation'],

  // Julia (Knowledge)
  docs_architecture:         ['doc structure', 'reading path', 'progressive disclosure', 'audience level'],
  wiki_architecture:         ['wiki', 'hierarchy', 'navigation', 'cross-reference', 'onboarding path'],
  wiki_research:             ['investigate', 'trace', 'dependency map', 'pattern identification'],
  doc_templates:             ['template', 'jsdoc', 'tsdoc', 'api docs', 'keep a changelog', 'llms.txt'],
  decision_records:          ['adr', 'madr', 'rfc', 'y-statement', 'deprecation', 'status lifecycle'],
  prose_quality:             ['prose', 'clarity', 'concise', 'active voice', 'ai tics', 'filler words']
};

// ============================================================
// LEVEL-UP THRESHOLDS (diminishing returns curve)
// ============================================================
// Proficiency 1→10. Cumulative usage_count required for each level.
// Early levels come fast so agents feel responsive. Later levels take sustained work.

const LEVEL_THRESHOLDS = [
  0,    // Lv.1 (start)
  5,    // Lv.2
  12,   // Lv.3
  22,   // Lv.4
  35,   // Lv.5
  52,   // Lv.6
  73,   // Lv.7
  100,  // Lv.8
  135,  // Lv.9
  180   // Lv.10 (max)
];

// ============================================================
// SKILL INITIALIZATION (called when agent is hired)
// ============================================================

/**
 * Seed initial skills for a newly hired agent based on their role.
 * Skills start at proficiency 1, usage_count 0.
 * Safe to call multiple times — uses upsert on UNIQUE(agent_id, skill_name).
 *
 * @param {string} agentId - The agent's ID
 * @param {string} role - The agent's role string (e.g. "Research Analyst")
 */
async function initializeSkills(agentId, role) {
  const roleLower = (role || '').toLowerCase();

  // Find matching skill set by checking if role contains any ROLE_SKILLS key
  let skillNames = null;
  for (const [key, skills] of Object.entries(ROLE_SKILLS)) {
    if (roleLower.includes(key)) {
      skillNames = skills;
      break;
    }
  }

  // Fallback for roles that don't match any key
  if (!skillNames) {
    skillNames = ['general_task_execution'];
  }

  const rows = skillNames.map(name => ({
    agent_id: agentId,
    skill_name: name,
    proficiency: 1,
    usage_count: 0
  }));

  const { error } = await supabase
    .from('agent_skills')
    .upsert(rows, { onConflict: 'agent_id,skill_name' });

  if (error) {
    console.error(`[skills] Failed to initialize skills for ${agentId}:`, error.message);
    return;
  }

  console.log(`[skills] Initialized ${skillNames.length} skills for ${agentId}: ${skillNames.join(', ')}`);
}

// ============================================================
// SKILL TRACKING (called after task completion)
// ============================================================

/**
 * Track which skills an agent exercised during a task.
 * Increments usage_count for matching skills, creates new skills via cross-training,
 * and checks for level-ups.
 *
 * @param {string} agentId - The agent's ID
 * @param {string} taskDescription - The task description (used for keyword matching)
 */
async function trackSkillUsage(agentId, taskDescription) {
  const lower = (taskDescription || '').toLowerCase();
  const matchedSkills = [];

  for (const [skillName, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      matchedSkills.push(skillName);
    }
  }

  if (matchedSkills.length === 0) return;

  const now = new Date().toISOString();

  for (const skillName of matchedSkills) {
    // Upsert: increment if exists, create at proficiency 1 if new (cross-training)
    const { data: existing } = await supabase
      .from('agent_skills')
      .select('*')
      .eq('agent_id', agentId)
      .eq('skill_name', skillName)
      .maybeSingle();

    if (existing) {
      // Increment usage
      await supabase
        .from('agent_skills')
        .update({
          usage_count: existing.usage_count + 1,
          last_used_at: now,
          updated_at: now
        })
        .eq('id', existing.id);

      // Check for level-up
      await checkSkillGrowth(agentId, skillName, existing.usage_count + 1, existing.proficiency);
    } else {
      // Cross-training: agent encounters a skill outside their initial set
      await supabase
        .from('agent_skills')
        .insert({
          agent_id: agentId,
          skill_name: skillName,
          proficiency: 1,
          usage_count: 1,
          last_used_at: now
        });

      console.log(`[skills] ${agentId} cross-trained: ${skillName} (new skill at Lv.1)`);
    }
  }
}

// ============================================================
// SKILL GROWTH (level-up check)
// ============================================================

/**
 * Check if an agent's skill should level up based on cumulative usage.
 * Proficiency caps at 10.
 *
 * @param {string} agentId
 * @param {string} skillName
 * @param {number} newUsageCount - The updated usage count
 * @param {number} currentProficiency - Current proficiency level
 */
async function checkSkillGrowth(agentId, skillName, newUsageCount, currentProficiency) {
  if (currentProficiency >= 10) return; // Already maxed

  const nextLevel = currentProficiency + 1;
  const threshold = LEVEL_THRESHOLDS[nextLevel - 1]; // -1 because array is 0-indexed

  if (threshold === undefined || newUsageCount < threshold) return;

  // Level up!
  const { error } = await supabase
    .from('agent_skills')
    .update({
      proficiency: nextLevel,
      updated_at: new Date().toISOString()
    })
    .eq('agent_id', agentId)
    .eq('skill_name', skillName);

  if (error) {
    console.error(`[skills] Failed to level up ${skillName} for ${agentId}:`, error.message);
    return;
  }

  console.log(`[skills] LEVEL UP! ${agentId} ${skillName}: Lv.${currentProficiency} → Lv.${nextLevel} (${newUsageCount} uses)`);

  await events.logEvent({
    eventType: 'skill_level_up',
    agentId,
    severity: 'info',
    description: `${skillName} leveled up to Lv.${nextLevel} (${newUsageCount} uses)`,
    data: { skillName, oldLevel: currentProficiency, newLevel: nextLevel, usageCount: newUsageCount }
  });
}

// ============================================================
// SKILL RETRIEVAL (for prompt injection)
// ============================================================

/**
 * Get all skills for an agent, ordered by proficiency (highest first).
 *
 * @param {string} agentId
 * @returns {Array} Agent's skills sorted by proficiency desc
 */
async function getAgentSkills(agentId) {
  const { data, error } = await supabase
    .from('agent_skills')
    .select('*')
    .eq('agent_id', agentId)
    .order('proficiency', { ascending: false })
    .order('usage_count', { ascending: false });

  if (error) {
    console.error(`[skills] Failed to get skills for ${agentId}:`, error.message);
    return [];
  }
  return data || [];
}

// ============================================================
// PROMPT FORMATTING (injected into agent system prompts)
// ============================================================

/**
 * Format an agent's skills into a readable prompt section.
 * Returns empty string if agent has no skills (backwards-compatible).
 *
 * @param {Array} skills - From getAgentSkills()
 * @returns {string} Formatted skills section for LLM prompt
 */
function formatSkillsForPrompt(skills) {
  if (!skills || skills.length === 0) return '';

  const lines = skills.map(s => {
    const filled = Math.round(s.proficiency);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const label = s.skill_name.replace(/_/g, ' ');
    return `- ${label.padEnd(28)} [${bar}] Lv.${s.proficiency} (${s.usage_count} uses)`;
  });

  return [
    '# YOUR SKILLS (Developed through experience)',
    ...lines,
    '',
    'Your skills influence your work. Lean into your strengths when approaching tasks.'
  ].join('\n');
}

module.exports = {
  // Lifecycle
  initializeSkills,
  trackSkillUsage,
  checkSkillGrowth,
  // Retrieval
  getAgentSkills,
  formatSkillsForPrompt,
  // Maps (exported for testing/reuse)
  ROLE_SKILLS,
  SKILL_KEYWORDS,
  LEVEL_THRESHOLDS
};
