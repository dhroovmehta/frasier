// Research Quality & Citation Enforcement Tests (TDD — written BEFORE implementation)
// WHY: Agents were producing deliverables with hallucinated data and zero source attribution.
// These tests enforce research depth (minimum 3 substantive sources), citation validation
// (every factual claim traced back to a source), and anti-hallucination guardrails
// (synthesis prompt explicitly forbids fabrication).
//
// Part of v0.9.0 Phase 2 — Research Depth & Citation Enforcement

const createMockSupabase = require('../mocks/supabase');
const { makeStep, resetIdCounter } = require('../helpers');

// Set up mocks BEFORE requiring pipeline
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock models.js — we control every LLM response
const mockCallLLM = jest.fn();
jest.mock('../../src/lib/models', () => ({
  callLLM: mockCallLLM,
  MODELS: {
    tier1: { name: 'minimax', tier: 'tier1', maxTokens: 4096 },
    tier2: { name: 'claude-sonnet', tier: 'tier2', maxTokens: 8192 },
    tier3: { name: 'claude-opus', tier: 'tier3', maxTokens: 4096 }
  }
}));

// Mock web.js — no real HTTP calls
const mockSearchWeb = jest.fn();
const mockFetchPage = jest.fn();
jest.mock('../../src/lib/web', () => ({
  searchWeb: mockSearchWeb,
  fetchPage: mockFetchPage,
  prefetchUrls: jest.fn(text => ({ enrichedText: text, fetchedUrls: 0 })),
  resolveWebTags: jest.fn(() => ({ hasWebTags: false, results: [] })),
  formatWebResults: jest.fn(() => '')
}));

// Mock context.js
jest.mock('../../src/lib/context', () => ({
  buildTaskContext: jest.fn(async (step, role) => `## YOUR TASK\n${step.description}`),
  getDomainInstructions: jest.fn(() => 'Test domain instructions'),
  getOriginalMessage: jest.fn(async () => 'Test original request')
}));

// Mock memory.js
jest.mock('../../src/lib/memory', () => ({
  buildAgentPrompt: jest.fn(async () => ({
    systemPrompt: 'You are a test agent with expertise.',
    memories: { formatted: 'No memories yet.' },
    agent: { id: 'agent-test', role: 'Research Analyst' },
    persona: { full_sep_prompt: 'Test persona' }
  })),
  saveLesson: jest.fn(async () => ({ data: { id: 1 }, error: null }))
}));

const pipeline = require('../../src/lib/pipeline');

// ============================================================
// TEST DATA FACTORIES
// ============================================================

function makeResearchStep(overrides = {}) {
  return makeStep({
    description: 'Research the viability of an AI tutoring platform for K-12 students',
    assigned_agent_id: 'edward-research',
    model_tier: 'tier2',
    status: 'in_progress',
    ...overrides
  });
}

function makePromptData(overrides = {}) {
  return {
    systemPrompt: 'You are a test agent with expertise.',
    memories: { formatted: 'No memories yet.' },
    agent: { id: 'edward-research', role: 'Research Analyst' },
    persona: { full_sep_prompt: 'Test persona' },
    ...overrides
  };
}

/**
 * Build a standard mock search result with the given number of substantive pages.
 * "Substantive" = page content > 500 chars.
 */
function buildSubstantiveSearchResults(count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push({
      title: `Source ${i + 1}: AI Tutoring Report`,
      url: `https://example.com/source-${i + 1}`,
      snippet: `Snippet ${i + 1} about AI tutoring market data.`
    });
  }
  return results;
}

function buildSubstantivePageContent(index) {
  // >500 chars to count as substantive
  return `According to the 2026 Global EdTech Report (source ${index}), the K-12 AI tutoring market ` +
    `has grown to an estimated $3.2 billion, with a compound annual growth rate of 35.7% projected ` +
    `through 2030. Key players include Khan Academy (valued at $800M), Squirrel AI ($600M in revenue), ` +
    `Carnegie Learning ($450M annual), and emerging startups like Photomath and Quizlet AI. ` +
    `The North American market represents 42% of global spending, followed by Asia-Pacific at 38%. ` +
    `Integration of adaptive learning algorithms has increased student engagement by 47% on average, ` +
    `while reducing teacher workload by approximately 15 hours per month per classroom. ` +
    `Regulatory frameworks in the EU (AI Act Article 9) and US (COPPA updates) are shaping data ` +
    `practices for AI tools targeting minors under 13.`;
}

function buildThinPageContent() {
  // <500 chars — should NOT count as substantive
  return 'AI tutoring is growing. Market is big. More info coming soon.';
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Default: decompose returns 3+ search queries
  mockCallLLM.mockImplementation(async ({ forceTier, userMessage }) => {
    if (userMessage && userMessage.includes('DECOMPOSE')) {
      return {
        content: JSON.stringify({
          subQuestions: [
            'What is the current market size for K-12 AI tutoring?',
            'Who are the top competitors in AI tutoring?',
            'What regulations affect AI tutoring for minors?'
          ],
          searchQueries: [
            'K-12 AI tutoring market size 2026',
            'AI tutoring platform competitors funding',
            'AI education regulation COPPA 2026'
          ],
          keyRequirements: ['Market data with sources', 'Competitor analysis', 'Regulatory landscape']
        }),
        model: 'minimax', tier: 'tier1',
        usage: { prompt_tokens: 200, completion_tokens: 100 },
        error: null
      };
    }

    // Refined query generation (for retry logic)
    if (userMessage && userMessage.includes('REFINE_QUERIES')) {
      return {
        content: JSON.stringify({
          refinedQueries: [
            'K-12 edtech market report 2025 2026',
            'AI tutoring startup funding rounds series A'
          ]
        }),
        model: 'minimax', tier: 'tier1',
        usage: { prompt_tokens: 150, completion_tokens: 80 },
        error: null
      };
    }

    if (userMessage && userMessage.includes('SYNTHESIZE')) {
      return {
        content: '# AI Tutoring Platform Viability\n\nBased on research, the K-12 AI tutoring market is valued at $3.2B [Source: https://example.com/source-1].\n\nCompetitors include Khan Academy ($800M valuation) [Source: https://example.com/source-2] and Squirrel AI [Source: https://example.com/source-3].',
        model: 'claude-sonnet', tier: 'tier2',
        usage: { prompt_tokens: 1500, completion_tokens: 800 },
        error: null
      };
    }

    if (userMessage && userMessage.includes('CRITIQUE')) {
      return {
        content: JSON.stringify({
          scores: { completeness: 4, dataBacked: 4, actionability: 3, depth: 4 },
          overallScore: 3.8,
          gaps: ['Could use more specific competitor revenue data'],
          lesson: 'Market sizing is more convincing when built bottom-up'
        }),
        model: 'minimax', tier: 'tier1',
        usage: { prompt_tokens: 300, completion_tokens: 150 },
        error: null
      };
    }

    if (userMessage && userMessage.includes('REVISE')) {
      return {
        content: '# AI Tutoring Platform Viability (Revised)\n\nRevised content with better data...',
        model: 'claude-sonnet', tier: 'tier2',
        usage: { prompt_tokens: 2000, completion_tokens: 1000 },
        error: null
      };
    }

    return {
      content: 'Default mock response',
      model: 'minimax', tier: 'tier1',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      error: null
    };
  });

  // Default: 3 search results per query, all substantive
  mockSearchWeb.mockResolvedValue({
    results: buildSubstantiveSearchResults(3),
    error: null
  });

  // Default: substantive page content (>500 chars)
  mockFetchPage.mockImplementation(async (url) => {
    const index = url.match(/source-(\d+)/) ? url.match(/source-(\d+)/)[1] : '1';
    return {
      content: buildSubstantivePageContent(index),
      title: `AI Tutoring Report ${index}`,
      url,
      error: null
    };
  });
});

// ============================================================
// RESEARCH DEPTH ENFORCEMENT
// ============================================================

describe('Research Depth Enforcement', () => {

  it('rejects research with fewer than 3 substantive sources', async () => {
    // Only 1 search result, and that page has thin content
    mockSearchWeb.mockResolvedValue({
      results: [{ title: 'Thin Source', url: 'https://example.com/thin', snippet: 'Very brief.' }],
      error: null
    });
    mockFetchPage.mockResolvedValue({
      content: buildThinPageContent(),
      title: 'Thin Source',
      url: 'https://example.com/thin',
      error: null
    });

    // Also make the refined queries return nothing useful
    // (override REFINE_QUERIES response to also search, but still get thin content)
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['What is K-12 AI market?'],
            searchQueries: ['K-12 AI tutoring market'],
            keyRequirements: ['Market data']
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      if (userMessage && userMessage.includes('REFINE')) {
        return {
          content: JSON.stringify({ refinedQueries: ['edtech AI market size report'] }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 100, completion_tokens: 50 }, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Limited research available. The AI tutoring market shows promise.',
          model: 'claude-sonnet', tier: 'tier2', usage: { prompt_tokens: 500, completion_tokens: 200 }, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        return {
          content: JSON.stringify({
            scores: { completeness: 2, dataBacked: 1, actionability: 2, depth: 2 },
            overallScore: 1.8, gaps: ['No substantive sources'], lesson: 'Need better queries'
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      return { content: 'Default', model: 'minimax', tier: 'tier1', usage: {}, error: null };
    });

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Pipeline should still complete (graceful degradation), but research metadata
    // should indicate insufficient sources were found
    const phases = mockSupabase.__getData('pipeline_phases');
    const researchPhase = phases.find(p => p.phase_name === 'research');
    expect(researchPhase).toBeDefined();
    expect(researchPhase.metadata.substantiveSources).toBeLessThan(3);
    expect(researchPhase.metadata.retriesAttempted).toBeGreaterThan(0);
  });

  it('retries with refined queries when sources insufficient (max 2 retries)', async () => {
    let searchCallCount = 0;

    // First set of searches returns thin content, retries get better content
    mockSearchWeb.mockImplementation(async (query) => {
      searchCallCount++;
      if (searchCallCount <= 2) {
        // First round: only thin results
        return {
          results: [{ title: 'Thin', url: `https://example.com/thin-${searchCallCount}`, snippet: 'Brief' }],
          error: null
        };
      }
      // After retry: substantive results
      return {
        results: buildSubstantiveSearchResults(3),
        error: null
      };
    });

    let fetchCallCount = 0;
    mockFetchPage.mockImplementation(async (url) => {
      fetchCallCount++;
      if (url.includes('thin')) {
        return { content: buildThinPageContent(), title: 'Thin', url, error: null };
      }
      return {
        content: buildSubstantivePageContent(fetchCallCount),
        title: `Report ${fetchCallCount}`,
        url,
        error: null
      };
    });

    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Should have made an LLM call for refined queries (the REFINE_QUERIES call)
    const refineCalls = mockCallLLM.mock.calls.filter(
      call => call[0].userMessage && call[0].userMessage.includes('REFINE')
    );
    // At least 1 retry attempt, at most 2
    expect(refineCalls.length).toBeGreaterThanOrEqual(1);
    expect(refineCalls.length).toBeLessThanOrEqual(2);
  });

  it('requires at least 3 distinct search queries from decompose phase', async () => {
    // Decompose returns only 1 query — runResearch should still work but log the concern
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['What is the market size?'],
            searchQueries: ['AI tutoring market'],  // only 1 query
            keyRequirements: ['Market data']
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Research findings based on available data.',
          model: 'claude-sonnet', tier: 'tier2', usage: { prompt_tokens: 500, completion_tokens: 200 }, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        return {
          content: JSON.stringify({
            scores: { completeness: 3, dataBacked: 3, actionability: 3, depth: 3 },
            overallScore: 3.0, gaps: [], lesson: 'Adequate'
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      return { content: 'Default', model: 'minimax', tier: 'tier1', usage: {}, error: null };
    });

    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // The decompose phase metadata should track query count
    const phases = mockSupabase.__getData('pipeline_phases');
    const decomposePhase = phases.find(p => p.phase_name === 'decompose');
    expect(decomposePhase.metadata.searchQueries).toHaveLength(1);

    // Research phase should still proceed (graceful degradation)
    const researchPhase = phases.find(p => p.phase_name === 'research');
    expect(researchPhase).toBeDefined();
  });

  it('validates research contains task-relevant content before synthesis', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Research phase metadata should include structured source list with char counts
    const phases = mockSupabase.__getData('pipeline_phases');
    const researchPhase = phases.find(p => p.phase_name === 'research');
    expect(researchPhase.metadata.structuredSources).toBeDefined();
    expect(researchPhase.metadata.structuredSources.length).toBeGreaterThan(0);

    // Each source should have charCount field
    for (const source of researchPhase.metadata.structuredSources) {
      expect(source).toHaveProperty('url');
      expect(source).toHaveProperty('charCount');
      expect(typeof source.charCount).toBe('number');
    }
  });

  it('passes research sources to synthesis as structured reference list', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // The synthesize call should contain structured AVAILABLE SOURCES section
    const synthesizeCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('SYNTHESIZE')
    );
    expect(synthesizeCall).toBeDefined();
    expect(synthesizeCall[0].userMessage).toContain('AVAILABLE SOURCES');
    // Should include actual source URLs
    expect(synthesizeCall[0].userMessage).toContain('https://example.com/source-');
  });
});

// ============================================================
// CITATION VALIDATION
// ============================================================

describe('Citation Validation', () => {

  it('flags output containing URLs not found in research sources', () => {
    const researchSources = [
      { url: 'https://example.com/source-1', title: 'Report 1', charCount: 600 },
      { url: 'https://example.com/source-2', title: 'Report 2', charCount: 700 }
    ];

    const output = `The market is worth $3.2B [Source: https://example.com/source-1].
Some claim it's $5B [Source: https://fabricated.com/fake-report].
Competition is fierce [Source: https://example.com/source-2].`;

    const result = pipeline.validateSourceCitations(output, researchSources);

    expect(result.uncitedUrls).toContain('https://fabricated.com/fake-report');
    expect(result.citedUrls).toContain('https://example.com/source-1');
    expect(result.citedUrls).toContain('https://example.com/source-2');
  });

  it('computes citation_score as (cited claims / total factual claims)', () => {
    const researchSources = [
      { url: 'https://example.com/source-1', title: 'Report 1', charCount: 600 },
      { url: 'https://example.com/source-2', title: 'Report 2', charCount: 700 }
    ];

    // 3 factual paragraphs: 2 with citations, 1 without
    const output = `The K-12 AI tutoring market is valued at $3.2 billion [Source: https://example.com/source-1].

Khan Academy leads with 800M users and $800M valuation [Source: https://example.com/source-2].

The regulatory landscape is complex with COPPA and EU AI Act affecting all vendors.`;

    const result = pipeline.validateSourceCitations(output, researchSources);

    // 2 out of 3 factual paragraphs have citations
    expect(result.citationScore).toBeGreaterThan(0);
    expect(result.citationScore).toBeLessThanOrEqual(1);
    expect(result.citedClaims).toBe(2);
    expect(result.totalFactualClaims).toBe(3);
  });

  it('stores citation_score in critique phase metadata', async () => {
    const step = makeResearchStep({ id: 200 });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // The critique phase should include citation_score in metadata
    const phases = mockSupabase.__getData('pipeline_phases');
    const critiquePhase = phases.find(p => p.phase_name === 'critique');
    expect(critiquePhase.metadata).toHaveProperty('citationScore');
    expect(typeof critiquePhase.metadata.citationScore).toBe('number');
  });

  it('output with zero citations gets citation_score 0', () => {
    const researchSources = [
      { url: 'https://example.com/source-1', title: 'Report 1', charCount: 600 }
    ];

    // No citations at all — just unsourced claims
    const output = `The market is growing rapidly. Competition is fierce. The future looks bright for AI tutoring.`;

    const result = pipeline.validateSourceCitations(output, researchSources);

    expect(result.citationScore).toBe(0);
    expect(result.citedClaims).toBe(0);
  });
});

// ============================================================
// ANTI-HALLUCINATION
// ============================================================

describe('Anti-Hallucination', () => {

  it('synthesis prompt includes "Use ONLY these sources" instruction', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Find the synthesize LLM call
    const synthesizeCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('SYNTHESIZE')
    );
    expect(synthesizeCall).toBeDefined();

    const prompt = synthesizeCall[0].userMessage;
    // Must contain anti-hallucination instruction
    expect(prompt).toMatch(/use\s+only\s+these\s+sources/i);
    expect(prompt).toMatch(/never\s+fabricate|data\s+not\s+available/i);
  });

  it('synthesis prompt includes actual source URLs from research phase', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    const synthesizeCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('SYNTHESIZE')
    );
    expect(synthesizeCall).toBeDefined();

    const prompt = synthesizeCall[0].userMessage;
    // Must contain the actual URLs from research
    expect(prompt).toContain('https://example.com/source-1');
    expect(prompt).toContain('https://example.com/source-2');
  });

  it('output template includes citation requirement for every role', () => {
    // We need to check that context.js DOMAIN_INSTRUCTIONS includes citation requirements
    // Re-require context.js (unmocked) to test the actual module
    jest.isolateModules(() => {
      // Temporarily unmock context and supabase for this test
      jest.unmock('../../src/lib/context');
      jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

      const context = require('../../src/lib/context');

      const CITATION_PATTERN = /citation\s+requirement/i;

      // Check every named domain
      for (const [domain, instructions] of Object.entries(context.DOMAIN_INSTRUCTIONS)) {
        expect(instructions).toMatch(CITATION_PATTERN);
      }

      // Also check the generic fallback by calling getDomainInstructions with unknown role
      const fallback = context.getDomainInstructions('some-unknown-role');
      expect(fallback).toMatch(CITATION_PATTERN);
    });
  });
});
