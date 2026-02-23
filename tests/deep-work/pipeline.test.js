// Deep Work Pipeline Tests (TDD — written BEFORE implementation)
// Tests the multi-phase execution engine: decompose → research → synthesize → critique → revise
//
// WHY: The pipeline replaces worker.js's single LLM call (lines 122-128) with a
// structured multi-phase approach. These tests define expected behavior so we can
// build pipeline.js against a clear contract.

const createMockSupabase = require('../mocks/supabase');
const { makeStep, makeAgent, makePersona, resetIdCounter } = require('../helpers');

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

function makeEngineeringStep(overrides = {}) {
  return makeStep({
    description: 'Build a REST API endpoint for user authentication',
    assigned_agent_id: 'toji-engineering',
    model_tier: 'tier2',
    status: 'in_progress',
    ...overrides
  });
}

function makeSimpleStep(overrides = {}) {
  return makeStep({
    description: 'Respond to a greeting message',
    assigned_agent_id: 'jet-chief',
    model_tier: 'tier1',
    status: 'in_progress',
    ...overrides
  });
}

// Standard mock prompt data that worker.js would normally build
function makePromptData(overrides = {}) {
  return {
    systemPrompt: 'You are a test agent with expertise.',
    memories: { formatted: 'No memories yet.' },
    agent: { id: 'edward-research', role: 'Research Analyst' },
    persona: { full_sep_prompt: 'Test persona' },
    ...overrides
  };
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Default: decompose returns structured JSON with sub-questions and search queries
  mockCallLLM.mockImplementation(async ({ forceTier, userMessage }) => {
    // Decompose phase (tier1) — returns JSON
    if (userMessage && userMessage.includes('DECOMPOSE')) {
      return {
        content: JSON.stringify({
          subQuestions: [
            'What is the current market size for K-12 AI tutoring?',
            'Who are the top competitors in AI tutoring?'
          ],
          searchQueries: [
            'K-12 AI tutoring market size 2026',
            'AI tutoring platform competitors funding'
          ],
          keyRequirements: ['Market data with sources', 'Competitor analysis']
        }),
        model: 'minimax',
        tier: 'tier1',
        usage: { prompt_tokens: 200, completion_tokens: 100 },
        error: null
      };
    }

    // Synthesize phase — returns the actual deliverable
    if (userMessage && userMessage.includes('SYNTHESIZE')) {
      return {
        content: '# AI Tutoring Platform Viability\n\nBased on research, the K-12 AI tutoring market is valued at $2.3B (Grand View Research, 2025)...',
        model: 'claude-sonnet',
        tier: 'tier2',
        usage: { prompt_tokens: 1500, completion_tokens: 800 },
        error: null
      };
    }

    // Critique phase (tier1) — returns JSON with score
    if (userMessage && userMessage.includes('CRITIQUE')) {
      return {
        content: JSON.stringify({
          scores: { completeness: 4, dataBacked: 4, actionability: 3, depth: 4 },
          overallScore: 3.8,
          gaps: ['Could use more specific competitor revenue data'],
          lesson: 'Market sizing is more convincing when built bottom-up from user counts'
        }),
        model: 'minimax',
        tier: 'tier1',
        usage: { prompt_tokens: 300, completion_tokens: 150 },
        error: null
      };
    }

    // Revise phase — improved deliverable
    if (userMessage && userMessage.includes('REVISE')) {
      return {
        content: '# AI Tutoring Platform Viability (Revised)\n\nThe K-12 AI tutoring market...',
        model: 'claude-sonnet',
        tier: 'tier2',
        usage: { prompt_tokens: 2000, completion_tokens: 1000 },
        error: null
      };
    }

    // Default response
    return {
      content: 'Default mock response',
      model: 'minimax',
      tier: 'tier1',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      error: null
    };
  });

  // Default: search returns results
  mockSearchWeb.mockResolvedValue({
    results: [
      { title: 'K-12 AI Tutoring Market Report', url: 'https://example.com/report', snippet: 'The K-12 AI tutoring market reached $2.3B in 2025...' },
      { title: 'Top AI Tutoring Platforms 2026', url: 'https://example.com/competitors', snippet: 'Khan Academy, Squirrel AI, and Carnegie Learning lead...' }
    ],
    error: null
  });

  // Default: page fetch returns content
  mockFetchPage.mockResolvedValue({
    content: 'According to Grand View Research, the global AI in education market was valued at $2.3 billion in 2025 and is expected to grow at a CAGR of 36.0% from 2025 to 2030.',
    title: 'AI in Education Market Report',
    url: 'https://example.com/report',
    error: null
  });
});

// ============================================================
// CORE PIPELINE: execute()
// ============================================================

describe('pipeline.execute() — full pipeline flow', () => {

  test('research step runs all 5 phases: decompose → research → synthesize → critique → (no revise if score >= 3)', async () => {
    const step = makeResearchStep();
    const promptData = makePromptData();

    const result = await pipeline.execute({
      step,
      promptData,
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Should succeed
    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();

    // Should have called LLM 3 times: decompose, synthesize, critique
    // (no revise because default critique score is 3.8 >= 3)
    expect(mockCallLLM).toHaveBeenCalledTimes(3);

    // Decompose should use tier1 (cheap)
    expect(mockCallLLM.mock.calls[0][0].forceTier).toBe('tier1');

    // Synthesize should use the step's effective tier
    expect(mockCallLLM.mock.calls[1][0].forceTier).toBe('tier2');

    // Critique should use tier1 (cheap)
    expect(mockCallLLM.mock.calls[2][0].forceTier).toBe('tier1');

    // Should have searched the web
    expect(mockSearchWeb).toHaveBeenCalled();
    expect(mockFetchPage).toHaveBeenCalled();
  });

  test('revise phase fires when critique score < 3', async () => {
    // Override critique to return low score
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['What is the market size?'],
            searchQueries: ['AI tutoring market size'],
            keyRequirements: ['Market data']
          }),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 200, completion_tokens: 100 },
          error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Generic surface-level analysis...',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 1500, completion_tokens: 800 },
          error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        return {
          content: JSON.stringify({
            scores: { completeness: 2, dataBacked: 1, actionability: 2, depth: 2 },
            overallScore: 1.8,
            gaps: ['No real data cited', 'No competitor names', 'Completely generic'],
            lesson: 'Must include specific data from web research'
          }),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 300, completion_tokens: 150 },
          error: null
        };
      }
      if (userMessage && userMessage.includes('REVISE')) {
        return {
          content: '# Revised Analysis\n\nAfter further review, the K-12 AI market...',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 2000, completion_tokens: 1000 },
          error: null
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

    // Should have called LLM 4 times: decompose + synthesize + critique + revise
    expect(mockCallLLM).toHaveBeenCalledTimes(4);

    // Final content should be the revised version
    expect(result.content).toContain('Revised Analysis');
    expect(result.critiqueScore).toBeLessThan(3);
    expect(result.revised).toBe(true);
  });

  test('revise capped at 1 attempt (no infinite loops)', async () => {
    // Both critique and post-revise return low scores
    let critiqueCallCount = 0;
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
          }),
          model: 'minimax', tier: 'tier1', usage: {}, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return { content: 'Bad output', model: 'claude-sonnet', tier: 'tier2', usage: {}, error: null };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        critiqueCallCount++;
        return {
          content: JSON.stringify({
            scores: { completeness: 1, dataBacked: 1, actionability: 1, depth: 1 },
            overallScore: 1.0,
            gaps: ['Everything is wrong'],
            lesson: 'Needs complete redo'
          }),
          model: 'minimax', tier: 'tier1', usage: {}, error: null
        };
      }
      if (userMessage && userMessage.includes('REVISE')) {
        return { content: 'Still bad revised output', model: 'claude-sonnet', tier: 'tier2', usage: {}, error: null };
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

    // Critique should only be called once (NOT re-critiqued after revision)
    expect(critiqueCallCount).toBe(1);

    // Total LLM calls: decompose + synthesize + critique + revise = 4
    expect(mockCallLLM).toHaveBeenCalledTimes(4);

    // Should still return a result (the revised version, even if still bad)
    expect(result.content).toBeTruthy();
    expect(result.revised).toBe(true);
  });
});

// ============================================================
// SKIP RESEARCH (engineering / creative tasks)
// ============================================================

describe('pipeline configuration — skipResearch', () => {

  test('engineering steps skip research phase', async () => {
    const step = makeEngineeringStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData({ agent: { id: 'toji-engineering', role: 'Engineer' } }),
      userMessage: step.description,
      effectiveTier: 'tier2',
      config: { skipResearch: true }
    });

    expect(result.error).toBeNull();
    // No web search calls
    expect(mockSearchWeb).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
    // Still has decompose + synthesize + critique = 3 LLM calls
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
  });
});

// ============================================================
// SKIP PIPELINE (simple/trivial tasks)
// ============================================================

describe('pipeline configuration — skipPipeline', () => {

  test('simple steps use legacy single-shot (no pipeline phases)', async () => {
    mockCallLLM.mockResolvedValueOnce({
      content: 'Hello! How can I help you today?',
      model: 'minimax', tier: 'tier1',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      error: null
    });

    const step = makeSimpleStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData({ agent: { id: 'jet-chief', role: 'Chief of Staff' } }),
      userMessage: step.description,
      effectiveTier: 'tier1',
      config: { skipPipeline: true }
    });

    expect(result.error).toBeNull();
    expect(result.content).toBe('Hello! How can I help you today?');
    // Only 1 LLM call — no decompose, no critique
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockSearchWeb).not.toHaveBeenCalled();
    // No critique score for simple tasks
    expect(result.critiqueScore).toBeNull();
  });
});

// ============================================================
// RESEARCH PHASE
// ============================================================

describe('research phase — web search', () => {

  test('executes search queries from decompose output', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Should have searched for the queries generated by decompose
    expect(mockSearchWeb).toHaveBeenCalledWith(
      expect.stringContaining('K-12 AI tutoring'),
      expect.any(Number)
    );
  });

  test('caps web fetches at 8 per step', async () => {
    // Return many search results
    mockSearchWeb.mockResolvedValue({
      results: Array(10).fill(null).map((_, i) => ({
        title: `Result ${i}`, url: `https://example.com/${i}`, snippet: `Snippet ${i}`
      })),
      error: null
    });

    // Override decompose to request many queries
    mockCallLLM.mockImplementationOnce(async () => ({
      content: JSON.stringify({
        subQuestions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
        searchQueries: ['query1', 'query2', 'query3', 'query4', 'query5'],
        keyRequirements: ['R1']
      }),
      model: 'minimax', tier: 'tier1', usage: {}, error: null
    }));

    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // fetchPage should be called at most 8 times total
    expect(mockFetchPage.mock.calls.length).toBeLessThanOrEqual(8);
  });

  test('research phase gracefully handles search failures', async () => {
    mockSearchWeb.mockResolvedValue({ results: [], error: 'Brave API timeout' });

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Pipeline should still succeed — synthesize without research data
    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();
  });

  test('research phase gracefully handles page fetch failures', async () => {
    mockFetchPage.mockResolvedValue({ content: null, title: null, url: 'https://example.com', error: 'HTTP 403' });

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Pipeline should still succeed
    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();
  });
});

// ============================================================
// PHASE LOGGING (pipeline_phases table)
// ============================================================

describe('phase logging — pipeline_phases table', () => {

  test('saves phase records to pipeline_phases table', async () => {
    const step = makeResearchStep({ id: 42 });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Check pipeline_phases table
    const phases = mockSupabase.__getData('pipeline_phases');
    expect(phases.length).toBeGreaterThanOrEqual(3); // decompose, research, synthesize, critique

    // Verify decompose phase logged
    const decompose = phases.find(p => p.phase_name === 'decompose');
    expect(decompose).toBeDefined();
    expect(decompose.mission_step_id).toBe(42);
    expect(decompose.phase_order).toBe(1);
    expect(decompose.model_tier).toBe('tier1');

    // Verify research phase logged
    const research = phases.find(p => p.phase_name === 'research');
    expect(research).toBeDefined();
    expect(research.model_tier).toBeNull(); // no LLM used

    // Verify synthesize phase logged
    const synthesize = phases.find(p => p.phase_name === 'synthesize');
    expect(synthesize).toBeDefined();
    expect(synthesize.model_tier).toBe('tier2');

    // Verify critique phase logged
    const critique = phases.find(p => p.phase_name === 'critique');
    expect(critique).toBeDefined();
    expect(critique.score).toBeDefined();
  });

  test('critique phase records the overall score', async () => {
    const step = makeResearchStep({ id: 99 });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    const phases = mockSupabase.__getData('pipeline_phases');
    const critique = phases.find(p => p.phase_name === 'critique');
    expect(critique.score).toBe(3.8); // matches our mock
  });
});

// ============================================================
// RESULT SHAPE
// ============================================================

describe('pipeline.execute() result shape', () => {

  test('returns expected result structure', async () => {
    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    expect(result).toEqual(expect.objectContaining({
      content: expect.any(String),
      critiqueScore: expect.any(Number),
      revised: expect.any(Boolean),
      phases: expect.any(Array),
      error: null
    }));

    // Phases array should describe what happened
    expect(result.phases.length).toBeGreaterThanOrEqual(3);
    expect(result.phases[0]).toEqual(expect.objectContaining({
      name: 'decompose',
      durationMs: expect.any(Number)
    }));
  });

  test('returns critique lesson for downstream use', async () => {
    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Critique lesson should be available for Phase 5 (lesson extraction)
    expect(result.critiqueLesson).toBeDefined();
    expect(typeof result.critiqueLesson).toBe('string');
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('error handling', () => {

  test('returns error when decompose LLM call fails', async () => {
    mockCallLLM.mockResolvedValueOnce({
      content: null, model: 'minimax', tier: 'tier1',
      usage: {}, error: 'Model overloaded'
    });

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    expect(result.error).toBeTruthy();
    expect(result.content).toBeNull();
  });

  test('returns error when synthesize LLM call fails', async () => {
    // Decompose succeeds
    mockCallLLM
      .mockResolvedValueOnce({
        content: JSON.stringify({
          subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
        }),
        model: 'minimax', tier: 'tier1', usage: {}, error: null
      })
      // Synthesize fails
      .mockResolvedValueOnce({
        content: null, model: 'claude-sonnet', tier: 'tier2',
        usage: {}, error: 'Rate limited'
      });

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    expect(result.error).toBeTruthy();
  });

  test('handles malformed decompose JSON gracefully', async () => {
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: 'This is not valid JSON at all, just plain text rambling',
          model: 'minimax', tier: 'tier1', usage: {}, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Synthesized output without structured decomposition',
          model: 'claude-sonnet', tier: 'tier2', usage: {}, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        return {
          content: JSON.stringify({
            scores: { completeness: 3, dataBacked: 3, actionability: 3, depth: 3 },
            overallScore: 3.0, gaps: [], lesson: 'OK output'
          }),
          model: 'minimax', tier: 'tier1', usage: {}, error: null
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

    // Should still produce output — falls back to synthesize without structured decomposition
    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();
  });

  test('handles malformed critique JSON gracefully', async () => {
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
          }),
          model: 'minimax', tier: 'tier1', usage: {}, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return { content: 'Good output', model: 'claude-sonnet', tier: 'tier2', usage: {}, error: null };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        // Returns plain text instead of JSON
        return {
          content: 'This deliverable looks solid. Score: 4 out of 5. Good job.',
          model: 'minimax', tier: 'tier1', usage: {}, error: null
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

    // Should succeed — default to moderate score when critique JSON is malformed
    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();
    // Default score when parsing fails should be moderate (not trigger revise)
    expect(result.critiqueScore).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// DECOMPOSE PROMPT CONTENT
// ============================================================

describe('decompose phase — prompt construction', () => {

  test('decompose prompt includes the task description', async () => {
    const step = makeResearchStep({ description: 'Analyze the competitive landscape of AI coding assistants' });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    const decomposeCall = mockCallLLM.mock.calls[0][0];
    expect(decomposeCall.userMessage).toContain('AI coding assistants');
    expect(decomposeCall.userMessage).toContain('DECOMPOSE');
  });
});

// ============================================================
// SYNTHESIZE PROMPT CONTENT
// ============================================================

describe('synthesize phase — prompt construction', () => {

  test('synthesize prompt includes research data', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // The synthesize call should contain research data
    const synthesizeCall = mockCallLLM.mock.calls[1][0];
    expect(synthesizeCall.userMessage).toContain('SYNTHESIZE');
    // Should include fetched page content or search snippets
    expect(synthesizeCall.userMessage).toMatch(/research|data|source/i);
  });

  test('synthesize uses agent system prompt from promptData', async () => {
    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData({ systemPrompt: 'You are Edward, a brilliant Research Analyst.' }),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    const synthesizeCall = mockCallLLM.mock.calls[1][0];
    expect(synthesizeCall.systemPrompt).toContain('Edward');
  });
});

// ============================================================
// getCritiquePhase() — for Phase 5 (lesson extraction)
// ============================================================

describe('pipeline.getCritiquePhase()', () => {

  test('returns critique phase data for a given step', async () => {
    const step = makeResearchStep({ id: 55 });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    const critique = await pipeline.getCritiquePhase(55);
    expect(critique).toBeDefined();
    expect(critique.phase_name).toBe('critique');
    expect(critique.output_content).toBeTruthy();
    expect(critique.score).toBeDefined();
  });

  test('returns null when step has no critique (skipPipeline)', async () => {
    const step = makeSimpleStep({ id: 77 });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier1',
      config: { skipPipeline: true }
    });

    const critique = await pipeline.getCritiquePhase(77);
    expect(critique).toBeNull();
  });
});
