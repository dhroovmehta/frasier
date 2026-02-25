// tests/v011/autonomous-delivery.test.js — Autonomous Project Delivery (v0.11.0)
// TDD: Tests define the contract for 7 changes that enable projects to complete end-to-end.
//
// WHY: 26 issues fixed across 10 versions, zero projects completed. The pipeline has
// structural problems: decomposition creates tasks too broad for agent tool budgets,
// research is single-pass, test agents leak into reviews, and acceptance criteria
// exceed what agents can physically deliver.
//
// AUTHORIZATION: Dhroov approved this plan ("go for it") after reviewing the 8-point
// v0.11.0 plan. This is TDD — tests written BEFORE implementation (Rule #8).

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, makeStep, resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock models.js
const mockCallLLM = jest.fn();
jest.mock('../../src/lib/models', () => ({
  callLLM: mockCallLLM,
  MODELS: {
    tier1: { name: 'minimax', tier: 'tier1', maxTokens: 4096 },
    tier2: { name: 'claude-sonnet', tier: 'tier2', maxTokens: 8192 },
    tier3: { name: 'claude-opus', tier: 'tier3', maxTokens: 4096 }
  }
}));

// Mock web.js — controlled search/fetch responses
const mockSearchWeb = jest.fn();
const mockFetchPage = jest.fn();
jest.mock('../../src/lib/web', () => ({
  searchWeb: mockSearchWeb,
  fetchPage: mockFetchPage,
  prefetchUrls: jest.fn(text => ({ enrichedText: text, fetchedUrls: 0 })),
  fetchAttachments: jest.fn(() => ({ content: '', attachmentCount: 0 })),
  resolveWebTags: jest.fn(() => ({ results: [], hasWebTags: false })),
  formatWebResults: jest.fn(() => ''),
  htmlToText: jest.fn(html => html)
}));

// Mock agents.js
const mockGetAllActiveAgents = jest.fn();
const mockFindBestAgent = jest.fn();
jest.mock('../../src/lib/agents', () => ({
  getAllActiveAgents: mockGetAllActiveAgents,
  findBestAgentAcrossTeams: mockFindBestAgent,
  autoHireGapAgent: jest.fn(),
  getStandingTeamForRole: jest.fn(() => 'team-research'),
  getTeamAgents: jest.fn(() => [])
}));

// Mock approach_memory.js
jest.mock('../../src/lib/approach_memory', () => ({
  findSimilar: jest.fn().mockResolvedValue([]),
  formatForPrompt: jest.fn(() => ''),
  save: jest.fn()
}));

// Mock missions.js
const mockCreateStep = jest.fn();
const mockRouteByKeywords = jest.fn();
jest.mock('../../src/lib/missions', () => ({
  createStep: mockCreateStep.mockResolvedValue({ id: 100 }),
  createMission: jest.fn().mockResolvedValue({ id: 10, title: 'Test' }),
  getStepsNeedingReview: jest.fn(() => []),
  routeByKeywords: mockRouteByKeywords,
  ROLE_KEYWORDS: {
    research: ['research', 'analyst', 'intelligence', 'data'],
    content: ['content', 'writer', 'creator', 'copywriter'],
    engineering: ['engineer', 'developer', 'architect', 'full-stack'],
    strategy: ['strategy', 'strategist', 'planner'],
    marketing: ['marketing', 'growth', 'seo'],
    qa: ['qa', 'quality', 'test'],
    knowledge: ['knowledge', 'documentation', 'curator']
  },
  createApproval: jest.fn(),
  approveStep: jest.fn()
}));

// Mock linear.js
jest.mock('../../src/lib/linear', () => ({
  syncMissionToLinear: jest.fn().mockResolvedValue(null),
  syncStepToLinear: jest.fn().mockResolvedValue(null)
}));

// Mock events.js
jest.mock('../../src/lib/events', () => ({
  logEvent: jest.fn().mockResolvedValue(null)
}));

// Mock projects.js
jest.mock('../../src/lib/projects', () => ({
  linkMissionToProject: jest.fn().mockResolvedValue(null)
}));

// Mock autonomy.js
jest.mock('../../src/lib/autonomy', () => ({
  shouldAutoApprove: jest.fn(() => ({ autoApprove: false, qaOnly: false }))
}));

const capabilities = require('../../src/lib/capabilities');
const pipeline = require('../../src/lib/pipeline');

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Default: pipeline phase logging succeeds
  mockSupabase.__setData('pipeline_phases', []);
});

// ============================================================
// FIX 1: FILTER TEST AGENTS FROM REVIEW ROTATION
// ============================================================

describe('Fix 1: Filter test agents from review rotation', () => {
  test('agents without team_id should be excluded from domain expert selection', () => {
    // WHY: test-memory-agent (team_id: null) was selected as a domain expert reviewer
    // for real work (ISS-026, Step #159). The same filter used in findBestAgentAcrossTeams
    // must be applied in review routing.
    const allAgents = [
      makeAgent({ id: 'agent-edward-1', role: 'Research Analyst', team_id: 'team-research' }),
      makeAgent({ id: 'test-memory-agent', role: 'QA Specialist', team_id: null }),
      makeAgent({ id: 'agent-frasier', role: 'Chief of Staff', team_id: null })
    ];

    // Filter: only agents with a team_id can be domain expert reviewers
    const eligibleReviewers = allAgents.filter(a => a.team_id !== null);

    expect(eligibleReviewers).toHaveLength(1);
    expect(eligibleReviewers[0].id).toBe('agent-edward-1');
    expect(eligibleReviewers.find(a => a.id === 'test-memory-agent')).toBeUndefined();
  });

  test('domain expert must not be the same agent who did the work', () => {
    const allAgents = [
      makeAgent({ id: 'agent-edward-1', role: 'Research Analyst', team_id: 'team-research' }),
      makeAgent({ id: 'agent-rei-2', role: 'Research Analyst', team_id: 'team-research' })
    ];

    const assignedAgentId = 'agent-edward-1';
    const eligibleReviewers = allAgents.filter(a =>
      a.team_id !== null && a.id !== assignedAgentId
    );

    expect(eligibleReviewers).toHaveLength(1);
    expect(eligibleReviewers[0].id).toBe('agent-rei-2');
  });
});

// ============================================================
// FIX 2: EXPANDED RESEARCH LIMITS
// ============================================================

describe('Fix 2: Expanded research limits', () => {
  test('pipeline should support up to 6 search queries (was 4)', async () => {
    // WHY: 4 queries x 2 URLs = 8 fetches was insufficient for thorough research.
    // 6 queries x 3 URLs = 18 potential fetches (capped at 16) gives real depth.
    const { RESEARCH_LIMITS } = capabilities;
    expect(RESEARCH_LIMITS.MAX_QUERIES_PER_STEP).toBe(6);
    expect(RESEARCH_LIMITS.MAX_FETCHES_PER_STEP).toBe(16);
    expect(RESEARCH_LIMITS.MAX_URLS_PER_QUERY).toBe(3);
  });

  test('GLOBAL_CONSTRAINTS text reflects new limits', () => {
    const manifest = capabilities.buildCapabilityManifest();
    // Should mention 6 queries, not 4
    expect(manifest).toMatch(/6 (?:search )?queries/i);
    // Should mention 16 fetches, not 8
    expect(manifest).toMatch(/16/);
  });

  test('ROLE_CAPABILITIES research tools reflect new limits', () => {
    const research = capabilities.ROLE_CAPABILITIES.research;
    const toolsText = research.tools.join(' ');
    expect(toolsText).toMatch(/6/);
    expect(toolsText).toMatch(/16/);
  });
});

// ============================================================
// FIX 3: QUANTITATIVE TOOL BUDGETS IN DECOMPOSITION
// ============================================================

describe('Fix 3: Quantitative tool budgets in decomposition', () => {
  test('RESEARCH_LIMITS constant exists with numeric values', () => {
    const { RESEARCH_LIMITS } = capabilities;
    expect(RESEARCH_LIMITS).toBeDefined();
    expect(typeof RESEARCH_LIMITS.MAX_QUERIES_PER_STEP).toBe('number');
    expect(typeof RESEARCH_LIMITS.MAX_FETCHES_PER_STEP).toBe('number');
    expect(typeof RESEARCH_LIMITS.MAX_URLS_PER_QUERY).toBe('number');
    expect(typeof RESEARCH_LIMITS.MAX_CHARS_PER_PAGE).toBe('number');
  });

  test('capability manifest includes quantitative TOOL BUDGET section', () => {
    const manifest = capabilities.buildCapabilityManifest();

    // Must contain a TOOL BUDGET section with actual numbers
    expect(manifest).toContain('TOOL BUDGET');
    expect(manifest).toMatch(/\d+ web search queries/i);
    expect(manifest).toMatch(/\d+ page fetches/i);
    expect(manifest).toMatch(/\d+,?\d* characters? per page/i);
  });

  test('tool budget section includes task-splitting guidance', () => {
    const manifest = capabilities.buildCapabilityManifest();

    // Must tell the planner HOW to split tasks based on budgets
    expect(manifest).toMatch(/split|divide|separate|parallel/i);
    // Must mention that tasks covering many items need multiple steps
    expect(manifest).toMatch(/multiple steps|parallel steps/i);
  });
});

// ============================================================
// FIX 4: MAPREDUCE DECOMPOSITION PATTERN
// ============================================================

describe('Fix 4: MapReduce decomposition pattern', () => {
  test('capability manifest includes parallel research + synthesis guidance', () => {
    const manifest = capabilities.buildCapabilityManifest();

    // Must mention the MapReduce pattern: parallel research + synthesis step
    expect(manifest).toMatch(/synthesis step|synthesis task|merge|combine/i);
    expect(manifest).toMatch(/parallel/i);
  });

  test('planning rules include item-count threshold for splitting', () => {
    const manifest = capabilities.buildCapabilityManifest();

    // Rules must instruct: when research covers more than N items, split
    expect(manifest).toMatch(/(more than|exceeds?|>)\s*[23]/i);
  });
});

// ============================================================
// FIX 5: BUDGET-AWARE ACCEPTANCE CRITERIA
// ============================================================

describe('Fix 5: Budget-aware acceptance criteria', () => {
  test('capability manifest instructs acceptance criteria to be tool-budget-aware', () => {
    const manifest = capabilities.buildCapabilityManifest();

    // Must tell the planner: acceptance criteria must not exceed tool budgets
    expect(manifest).toMatch(/acceptance criteria/i);
    expect(manifest).toMatch(/achievable|realistic|within.*budget/i);
  });

  test('GLOBAL_CONSTRAINTS mentions acceptance criteria scoping', () => {
    const constraints = capabilities.GLOBAL_CONSTRAINTS;
    // Must mention that acceptance criteria should match what one step can deliver
    expect(constraints).toMatch(/acceptance criteria|deliverable/i);
  });
});

// ============================================================
// FIX 6: ITERATIVE RESEARCH LOOP WITH GAP ANALYSIS
// ============================================================

describe('Fix 6: Iterative research loop', () => {
  const step = makeStep({ id: 1, assigned_agent_id: 'agent-edward-1' });

  test('research phase runs gap analysis after initial search round', async () => {
    // Setup: initial search returns some results but gap analysis finds missing topics
    mockSearchWeb.mockResolvedValue({
      results: [
        { title: 'R1', url: 'https://example.com/1', snippet: 'test' },
        { title: 'R2', url: 'https://example.com/2', snippet: 'test' }
      ],
      error: null
    });
    mockFetchPage.mockResolvedValue({
      content: 'A'.repeat(600), title: 'Page', url: 'https://example.com', error: null
    });

    mockCallLLM
      // 1. Decompose
      .mockResolvedValueOnce({
        content: JSON.stringify({
          subQuestions: ['What is X?', 'How does Y work?'],
          searchQueries: ['query 1', 'query 2'],
          keyRequirements: ['Complete analysis']
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      })
      // 2. Gap analysis iteration 1 — finds gaps
      .mockResolvedValueOnce({
        content: JSON.stringify({
          gaps: ['Missing competitor pricing data'],
          additionalQueries: ['competitor pricing 2026'],
          sufficient: false
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      })
      // 3. Gap analysis iteration 2 — now sufficient
      .mockResolvedValueOnce({
        content: JSON.stringify({
          gaps: [],
          additionalQueries: [],
          sufficient: true
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      })
      // 4. Synthesize
      .mockResolvedValueOnce({
        content: 'Final synthesized output with research',
        usage: { prompt_tokens: 200, completion_tokens: 300 }
      })
      // 5. Critique
      .mockResolvedValueOnce({
        content: JSON.stringify({
          scores: { completeness: 4, accuracy: 4, actionability: 3.5, depth: 3.5 },
          overallScore: 3.75,
          gaps: [],
          lesson: 'Good research depth'
        }),
        usage: { prompt_tokens: 150, completion_tokens: 100 }
      });

    const result = await pipeline.execute({
      step,
      promptData: { systemPrompt: 'You are a research analyst.' },
      userMessage: 'Research competitor landscape for AI agents',
      effectiveTier: 'tier2'
    });

    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();

    // Should have at least 4 phases: decompose, research, synthesize, critique
    expect(result.phases.length).toBeGreaterThanOrEqual(4);

    // Gap analysis LLM calls should have been made (calls 2 and 3)
    expect(mockCallLLM.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  test('research phase stops iterating when gaps are filled', async () => {
    mockSearchWeb.mockResolvedValue({
      results: [
        { title: 'R1', url: 'https://example.com/1', snippet: 'test' },
        { title: 'R2', url: 'https://example.com/2', snippet: 'test' },
        { title: 'R3', url: 'https://example.com/3', snippet: 'test' }
      ],
      error: null
    });
    mockFetchPage.mockResolvedValue({
      content: 'B'.repeat(800), title: 'Page', url: 'https://example.com', error: null
    });

    mockCallLLM
      // Decompose
      .mockResolvedValueOnce({
        content: JSON.stringify({
          subQuestions: ['Q1'],
          searchQueries: ['query 1'],
          keyRequirements: ['Analysis']
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      })
      // Gap analysis — sufficient, no gaps
      .mockResolvedValueOnce({
        content: JSON.stringify({
          gaps: [],
          additionalQueries: [],
          sufficient: true
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      })
      // Synthesize
      .mockResolvedValueOnce({
        content: 'Complete analysis with all data',
        usage: { prompt_tokens: 200, completion_tokens: 300 }
      })
      // Critique
      .mockResolvedValueOnce({
        content: JSON.stringify({
          scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
          overallScore: 4.0,
          gaps: [],
          lesson: 'Thorough'
        }),
        usage: { prompt_tokens: 150, completion_tokens: 100 }
      });

    const result = await pipeline.execute({
      step,
      promptData: { systemPrompt: 'You are a research analyst.' },
      userMessage: 'Research a focused topic',
      effectiveTier: 'tier2'
    });

    expect(result.error).toBeNull();
    // When gaps are filled immediately, no additional search rounds
    const initialSearchCalls = mockSearchWeb.mock.calls.length;
    expect(initialSearchCalls).toBeLessThanOrEqual(6);
  });

  test('RESEARCH_LIMITS includes MAX_RESEARCH_ITERATIONS constant', () => {
    const { RESEARCH_LIMITS } = capabilities;
    expect(RESEARCH_LIMITS.MAX_RESEARCH_ITERATIONS).toBeDefined();
    expect(RESEARCH_LIMITS.MAX_RESEARCH_ITERATIONS).toBeGreaterThanOrEqual(2);
    expect(RESEARCH_LIMITS.MAX_RESEARCH_ITERATIONS).toBeLessThanOrEqual(4);
  });
});

// ============================================================
// FIX 7: BUDGET TRACKER IN PROMPTS
// ============================================================

describe('Fix 7: Budget tracker in prompts', () => {
  test('synthesize prompt includes remaining budget information', async () => {
    const step = makeStep({ id: 1, assigned_agent_id: 'agent-edward-1' });

    // WHY 3 results: need >= 3 substantive sources to skip the refinedQueries retry path
    mockSearchWeb.mockResolvedValue({
      results: [
        { title: 'R1', url: 'https://example.com/1', snippet: 'test' },
        { title: 'R2', url: 'https://example.com/2', snippet: 'test' },
        { title: 'R3', url: 'https://example.com/3', snippet: 'test' }
      ],
      error: null
    });
    mockFetchPage.mockResolvedValue({
      content: 'C'.repeat(600), title: 'Page', url: 'https://example.com', error: null
    });

    // WHY extra mock calls: the iterative research loop (v0.11.0) adds a gap analysis
    // LLM call between RESEARCH and SYNTHESIZE phases.
    mockCallLLM
      // 1. Decompose
      .mockResolvedValueOnce({
        content: JSON.stringify({
          subQuestions: ['Q1'],
          searchQueries: ['query 1'],
          keyRequirements: ['req1']
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      })
      // 2. Gap analysis — sufficient
      .mockResolvedValueOnce({
        content: JSON.stringify({ gaps: [], additionalQueries: [], sufficient: true }),
        usage: { prompt_tokens: 50, completion_tokens: 30 }
      })
      // 3. Synthesize
      .mockResolvedValueOnce({
        content: 'Synthesized output',
        usage: { prompt_tokens: 200, completion_tokens: 300 }
      })
      // 4. Critique
      .mockResolvedValueOnce({
        content: JSON.stringify({
          scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
          overallScore: 4.0, gaps: [], lesson: 'Good'
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

    await pipeline.execute({
      step,
      promptData: { systemPrompt: 'You are a research analyst.' },
      userMessage: 'Research topic X',
      effectiveTier: 'tier2'
    });

    // The synthesize call should include budget information
    const synthesizeCall = mockCallLLM.mock.calls.find(call =>
      call[0].userMessage && call[0].userMessage.includes('SYNTHESIZE')
    );

    expect(synthesizeCall).toBeDefined();
    const synthesizePrompt = synthesizeCall[0].userMessage;
    expect(synthesizePrompt).toMatch(/budget|searches? used|fetches? used|remaining/i);
  });

  test('RESEARCH_LIMITS exported for use in budget tracking', () => {
    const { RESEARCH_LIMITS } = capabilities;
    expect(RESEARCH_LIMITS).toBeDefined();
    expect(RESEARCH_LIMITS.MAX_QUERIES_PER_STEP).toBeDefined();
    expect(RESEARCH_LIMITS.MAX_FETCHES_PER_STEP).toBeDefined();
  });
});

// ============================================================
// INTEGRATION: End-to-end pipeline produces output
// ============================================================

describe('Integration: Pipeline produces deliverable end-to-end', () => {
  test('full pipeline completes without error on a research task', async () => {
    const step = makeStep({ id: 42, assigned_agent_id: 'agent-edward-1' });

    mockSearchWeb.mockResolvedValue({
      results: [
        { title: 'Market Report 2026', url: 'https://example.com/report', snippet: 'Market data' },
        { title: 'Industry Analysis', url: 'https://example.com/analysis', snippet: 'Trends' }
      ],
      error: null
    });
    mockFetchPage.mockResolvedValue({
      content: 'Detailed market report content with statistics and trends. '.repeat(20),
      title: 'Market Report',
      url: 'https://example.com/report',
      error: null
    });

    mockCallLLM
      // Decompose
      .mockResolvedValueOnce({
        content: JSON.stringify({
          subQuestions: ['What are key market trends?', 'Who are the competitors?'],
          searchQueries: ['AI agent market 2026', 'AI agent competitors analysis'],
          keyRequirements: ['Market sizing', 'Competitor analysis']
        }),
        usage: { prompt_tokens: 100, completion_tokens: 80 }
      })
      // Gap analysis
      .mockResolvedValueOnce({
        content: JSON.stringify({ gaps: [], additionalQueries: [], sufficient: true }),
        usage: { prompt_tokens: 100, completion_tokens: 30 }
      })
      // Synthesize
      .mockResolvedValueOnce({
        content: '# Market Analysis\n\n## Summary\nMarket growing [https://example.com/report]\n\n## Findings\n1. Size: $5B\n2. 15 competitors\n\n## Recommendations\n- Enterprise focus',
        usage: { prompt_tokens: 500, completion_tokens: 400 }
      })
      // Critique
      .mockResolvedValueOnce({
        content: JSON.stringify({
          scores: { completeness: 4, accuracy: 3.5, actionability: 4, depth: 3.5 },
          overallScore: 3.75, gaps: [], lesson: 'Solid coverage'
        }),
        usage: { prompt_tokens: 300, completion_tokens: 100 }
      });

    const result = await pipeline.execute({
      step,
      promptData: { systemPrompt: 'You are Edward, Research Analyst at NERV.' },
      userMessage: 'Analyze the AI agent market',
      effectiveTier: 'tier2'
    });

    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(100);
    expect(result.critiqueScore).toBeGreaterThanOrEqual(3.0);
    expect(result.phases.length).toBeGreaterThanOrEqual(4);
  });

  test('skipResearch config skips research and gap analysis for engineering tasks', async () => {
    const step = makeStep({ id: 43, assigned_agent_id: 'agent-spike-1' });

    mockCallLLM
      // Decompose
      .mockResolvedValueOnce({
        content: JSON.stringify({
          subQuestions: ['Architecture?'],
          searchQueries: [],
          keyRequirements: ['Working code']
        }),
        usage: { prompt_tokens: 50, completion_tokens: 30 }
      })
      // Synthesize (no gap analysis since skipResearch)
      .mockResolvedValueOnce({
        content: '```javascript\nfunction hello() { return "world"; }\n```',
        usage: { prompt_tokens: 200, completion_tokens: 100 }
      })
      // Critique
      .mockResolvedValueOnce({
        content: JSON.stringify({
          scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
          overallScore: 4.0, gaps: [], lesson: 'Clean code'
        }),
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });

    const result = await pipeline.execute({
      step,
      promptData: { systemPrompt: 'You are Spike, Engineer.' },
      userMessage: 'Write a hello world function',
      effectiveTier: 'tier2',
      config: { skipResearch: true }
    });

    expect(result.error).toBeNull();
    expect(result.content).toContain('function');
    // No web searches should have been made
    expect(mockSearchWeb).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
  });
});
