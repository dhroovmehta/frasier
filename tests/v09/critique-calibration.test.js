// tests/v09/critique-calibration.test.js — Calibrated Self-Critique (TDD)
// Tests the enhanced critique rubric, calibration instructions, and revised
// revision trigger logic. Written BEFORE implementation per TDD discipline.
//
// WHY: The original critique used a generic 1-5 scoring guide that led to
// inflated scores (most output scored 3.5-4.5). Calibrated rubric anchors
// each dimension to concrete descriptions so LLMs self-score more honestly.
// Revision triggers are now more aggressive: ANY dimension < 3.0 OR average < 3.5.

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

// ============================================================
// MOCK HELPER: Builds a standard LLM mock with configurable critique response
// ============================================================

function buildMockLLM(critiqueResponse, options = {}) {
  const { reviseContent = 'Revised deliverable content', secondCritiqueResponse = null } = options;
  let critiqueCallCount = 0;

  return async ({ userMessage }) => {
    if (userMessage && userMessage.includes('DECOMPOSE')) {
      return {
        content: JSON.stringify({
          subQuestions: ['What is the market size?', 'Who are the key competitors?'],
          searchQueries: ['AI tutoring market size', 'AI tutoring competitors funding'],
          keyRequirements: ['Market data with sources']
        }),
        model: 'minimax', tier: 'tier1',
        usage: { prompt_tokens: 200, completion_tokens: 100 },
        error: null
      };
    }

    if (userMessage && userMessage.includes('SYNTHESIZE')) {
      return {
        content: '# AI Tutoring Analysis\n\nThe K-12 AI tutoring market is growing rapidly.',
        model: 'claude-sonnet', tier: 'tier2',
        usage: { prompt_tokens: 1500, completion_tokens: 800 },
        error: null
      };
    }

    if (userMessage && userMessage.includes('CRITIQUE')) {
      critiqueCallCount++;
      // If a second critique response is provided, use it on the 2nd+ call
      if (critiqueCallCount > 1 && secondCritiqueResponse) {
        return {
          content: JSON.stringify(secondCritiqueResponse),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 300, completion_tokens: 150 },
          error: null
        };
      }
      return {
        content: JSON.stringify(critiqueResponse),
        model: 'minimax', tier: 'tier1',
        usage: { prompt_tokens: 300, completion_tokens: 150 },
        error: null
      };
    }

    if (userMessage && userMessage.includes('REVISE')) {
      return {
        content: reviseContent,
        model: 'claude-sonnet', tier: 'tier2',
        usage: { prompt_tokens: 2000, completion_tokens: 1000 },
        error: null
      };
    }

    return { content: 'Default', model: 'minimax', tier: 'tier1', usage: {}, error: null };
  };
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Default web mocks (research phase needs these)
  // WHY >500 chars: Research phase now retries with refined queries when sources are
  // "thin" (<500 chars). These critique tests don't test research behavior, so we
  // provide substantive content to prevent the retry LLM call from firing.
  mockSearchWeb.mockResolvedValue({
    results: [
      { title: 'Market Report', url: 'https://example.com/report', snippet: 'Market data...' },
      { title: 'Industry Analysis', url: 'https://example.com/analysis', snippet: 'Analysis...' },
      { title: 'Competitor Review', url: 'https://example.com/review', snippet: 'Review...' }
    ],
    error: null
  });
  mockFetchPage.mockResolvedValue({
    content: 'According to the 2026 Global EdTech Report, the K-12 AI tutoring market has grown to an estimated $3.2 billion, with a compound annual growth rate of 35.7% projected through 2030. Key players include Khan Academy (valued at $800M), Squirrel AI ($600M in revenue), Carnegie Learning ($450M annual), and emerging startups like Photomath and Quizlet AI. The North American market represents 42% of global spending, followed by Asia-Pacific at 38%. Integration of adaptive learning algorithms has increased student engagement by 47% on average.',
    title: 'Market Report',
    url: 'https://example.com/report',
    error: null
  });
});

// ============================================================
// CALIBRATED CRITIQUE — Rubric and scoring anchors
// ============================================================

describe('Calibrated Critique', () => {

  it('critique prompt uses rubric with concrete 1-5 anchors per dimension', async () => {
    // Set up a mock that captures the critique prompt
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 3, accuracy: 3, actionability: 3, depth: 3 },
      overallScore: 3.0, gaps: [], lesson: 'OK'
    }));

    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Find the critique LLM call — it's the one with 'CRITIQUE' in the prompt
    const critiqueCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('CRITIQUE')
    );
    expect(critiqueCall).toBeDefined();

    const critiquePrompt = critiqueCall[0].userMessage;

    // Should have concrete anchors for DEPTH
    expect(critiquePrompt).toContain('generic, could be from any AI');
    expect(critiquePrompt).toContain('expert-level analysis with novel connections');
    expect(critiquePrompt).toContain('groundbreaking insight, publishable quality');

    // Should have concrete anchors for ACCURACY
    expect(critiquePrompt).toContain('fabricated facts or hallucinated data');
    expect(critiquePrompt).toContain('all claims cross-referenced, sources cited');

    // Should have concrete anchors for ACTIONABILITY
    expect(critiquePrompt).toContain('vague advice, no specifics');
    expect(critiquePrompt).toContain('detailed playbook with timelines and metrics');

    // Should have concrete anchors for COMPLETENESS
    expect(critiquePrompt).toContain('addresses less than 50% of requirements');
    expect(critiquePrompt).toContain('exhaustive, anticipates follow-up questions');
  });

  it('scores 4 dimensions: depth, accuracy, actionability, completeness', async () => {
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 4, accuracy: 3, actionability: 3, depth: 4 },
      overallScore: 3.5, gaps: ['Minor gaps'], lesson: 'Decent work'
    }));

    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Find the critique LLM call prompt
    const critiqueCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('CRITIQUE')
    );
    const critiquePrompt = critiqueCall[0].userMessage;

    // The prompt should ask for all 4 dimensions by name
    expect(critiquePrompt).toMatch(/depth/i);
    expect(critiquePrompt).toMatch(/accuracy/i);
    expect(critiquePrompt).toMatch(/actionability/i);
    expect(critiquePrompt).toMatch(/completeness/i);
  });

  it('revision triggers when ANY dimension < 3.0', async () => {
    // All dimensions good EXCEPT depth = 2 (below 3.0)
    // Average = (4 + 4 + 4 + 2) / 4 = 3.5 which is >= 3.5 threshold
    // But ANY dimension < 3.0 should still trigger revision
    mockCallLLM.mockImplementation(buildMockLLM(
      {
        scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 2 },
        overallScore: 3.5,
        gaps: ['Depth is lacking'],
        lesson: 'Needs deeper analysis'
      },
      {
        // Post-revision critique passes
        secondCritiqueResponse: {
          scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
          overallScore: 4.0, gaps: [], lesson: 'Much improved'
        }
      }
    ));

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Should have triggered a revision despite average >= 3.5
    expect(result.revised).toBe(true);
  });

  it('revision triggers when average < 3.5', async () => {
    // No single dimension is below 3.0, but average is 3.25 (below 3.5)
    mockCallLLM.mockImplementation(buildMockLLM(
      {
        scores: { completeness: 3, accuracy: 3, actionability: 4, depth: 3 },
        overallScore: 3.25,
        gaps: ['Overall mediocre'],
        lesson: 'Needs polish'
      },
      {
        secondCritiqueResponse: {
          scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
          overallScore: 4.0, gaps: [], lesson: 'Better'
        }
      }
    ));

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Should trigger revision because average 3.25 < 3.5
    expect(result.revised).toBe(true);
  });

  it('allows max 2 revision attempts (up from 1)', async () => {
    let critiqueCallCount = 0;
    let reviseCallCount = 0;

    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Bad first attempt',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 1500, completion_tokens: 800 }, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        critiqueCallCount++;
        // All critiques return terrible scores — forces revision every time
        return {
          content: JSON.stringify({
            scores: { completeness: 1, accuracy: 1, actionability: 1, depth: 1 },
            overallScore: 1.0,
            gaps: ['Everything is terrible'],
            lesson: 'Start over'
          }),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 300, completion_tokens: 150 }, error: null
        };
      }
      if (userMessage && userMessage.includes('REVISE')) {
        reviseCallCount++;
        return {
          content: `Revised attempt ${reviseCallCount}`,
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 2000, completion_tokens: 1000 }, error: null
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

    // Should have revised exactly 2 times (max), NOT more
    expect(reviseCallCount).toBe(2);

    // Critique should be called 3 times: initial + after each revision
    expect(critiqueCallCount).toBe(3);

    // Final content should be from the last revision
    expect(result.content).toContain('Revised attempt 2');
    expect(result.revised).toBe(true);
  });

  it('injects citation_score from Phase 2 into accuracy dimension context', async () => {
    // Set up mock that captures the critique prompt to check for citation_score injection
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
      overallScore: 4.0, gaps: [], lesson: 'Great'
    }));

    const step = makeResearchStep();

    // Pass citationScore via config (from Phase 2 research quality)
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2',
      config: { citationScore: 0.72 }
    });

    // Find the critique call
    const critiqueCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('CRITIQUE')
    );
    expect(critiqueCall).toBeDefined();

    const critiquePrompt = critiqueCall[0].userMessage;
    // Should mention the citation score for accuracy context
    expect(critiquePrompt).toContain('0.72');
    expect(critiquePrompt).toMatch(/citation/i);
  });

  it('stores all 4 dimension scores in pipeline_phases metadata', async () => {
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 4, accuracy: 3, actionability: 3, depth: 4 },
      overallScore: 3.5, gaps: ['Minor'], lesson: 'Good'
    }));

    const step = makeResearchStep({ id: 42 });
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Check pipeline_phases table for the critique record
    const phases = mockSupabase.__getData('pipeline_phases');
    const critiquePhase = phases.find(p => p.phase_name === 'critique');
    expect(critiquePhase).toBeDefined();

    // Metadata should contain all 4 dimension scores
    expect(critiquePhase.metadata.scores).toBeDefined();
    expect(critiquePhase.metadata.scores).toHaveProperty('completeness');
    expect(critiquePhase.metadata.scores).toHaveProperty('accuracy');
    expect(critiquePhase.metadata.scores).toHaveProperty('actionability');
    expect(critiquePhase.metadata.scores).toHaveProperty('depth');
  });
});

// ============================================================
// CRITIQUE PROMPT CALIBRATION — Specific instructional language
// ============================================================

describe('Critique Prompt Calibration', () => {

  // Helper: run pipeline and extract the critique prompt text
  async function getCritiquePrompt(config = {}) {
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 3, accuracy: 3, actionability: 3, depth: 3 },
      overallScore: 3.0, gaps: [], lesson: 'OK'
    }));

    const step = makeResearchStep();
    await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2',
      config
    });

    const critiqueCall = mockCallLLM.mock.calls.find(
      call => call[0].userMessage && call[0].userMessage.includes('CRITIQUE')
    );
    return critiqueCall[0].userMessage;
  }

  it('includes instruction: "3.0 is GOOD. 4.0 is EXCELLENT. 5.0 is rare."', async () => {
    const prompt = await getCritiquePrompt();
    // Allow minor formatting variations but the core calibration message must be there
    expect(prompt).toContain('3.0 is GOOD');
    expect(prompt).toContain('4.0 is EXCELLENT');
    expect(prompt).toContain('5.0 is rare');
  });

  it('includes instruction: "Average output should score 2.5-3.0"', async () => {
    const prompt = await getCritiquePrompt();
    expect(prompt).toContain('Average output should score 2.5-3.0');
  });

  it('includes instruction: "Be BRUTALLY HONEST"', async () => {
    const prompt = await getCritiquePrompt();
    expect(prompt).toContain('BRUTALLY HONEST');
  });
});

// ============================================================
// REVISION LOOP — After-revision re-critique
// ============================================================

describe('Revision loop with re-critique', () => {

  it('re-critiques after revision to get updated scores', async () => {
    let critiqueCount = 0;
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Initial output',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 1500, completion_tokens: 800 }, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        critiqueCount++;
        if (critiqueCount === 1) {
          // First critique: low score triggers revision
          return {
            content: JSON.stringify({
              scores: { completeness: 2, accuracy: 2, actionability: 2, depth: 2 },
              overallScore: 2.0, gaps: ['All weak'], lesson: 'Improve everything'
            }),
            model: 'minimax', tier: 'tier1',
            usage: { prompt_tokens: 300, completion_tokens: 150 }, error: null
          };
        }
        // Second critique: passes — no more revisions needed
        return {
          content: JSON.stringify({
            scores: { completeness: 4, accuracy: 4, actionability: 4, depth: 4 },
            overallScore: 4.0, gaps: [], lesson: 'Great improvement'
          }),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 300, completion_tokens: 150 }, error: null
        };
      }
      if (userMessage && userMessage.includes('REVISE')) {
        return {
          content: 'Much improved revised content',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 2000, completion_tokens: 1000 }, error: null
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

    // Critique was called twice: initial + after revision
    expect(critiqueCount).toBe(2);

    // Only 1 revision happened (second critique passed)
    expect(result.revised).toBe(true);
    expect(result.content).toContain('Much improved');

    // The final critique score should be the post-revision score
    expect(result.critiqueScore).toBe(4.0);
  });

  it('stops revising after 2 attempts even if scores stay low', async () => {
    let reviseCount = 0;

    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Poor output',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 1500, completion_tokens: 800 }, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        // Always returns terrible scores
        return {
          content: JSON.stringify({
            scores: { completeness: 1, accuracy: 1, actionability: 1, depth: 1 },
            overallScore: 1.0, gaps: ['Hopeless'], lesson: 'Give up'
          }),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 300, completion_tokens: 150 }, error: null
        };
      }
      if (userMessage && userMessage.includes('REVISE')) {
        reviseCount++;
        return {
          content: `Still bad attempt ${reviseCount}`,
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 2000, completion_tokens: 1000 }, error: null
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

    // Max 2 revision attempts
    expect(reviseCount).toBe(2);
    // Still returns content (the best we got)
    expect(result.content).toBeTruthy();
    expect(result.revised).toBe(true);
  });

  it('does not revise when all dimensions >= 3.0 AND average >= 3.5', async () => {
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 4, accuracy: 3, actionability: 4, depth: 3 },
      overallScore: 3.5,
      gaps: ['Minor formatting issues'],
      lesson: 'Good work overall'
    }));

    const step = makeResearchStep();
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // No revision needed
    expect(result.revised).toBe(false);

    // LLM calls: decompose + gap_analysis + synthesize + critique = 4 (no revise)
    // v0.11.0: gap analysis LLM call added between research and synthesize phases
    expect(mockCallLLM).toHaveBeenCalledTimes(4);
  });

  it('handles revise failure gracefully and falls back to previous content', async () => {
    let critiqueCount = 0;
    mockCallLLM.mockImplementation(async ({ userMessage }) => {
      if (userMessage && userMessage.includes('DECOMPOSE')) {
        return {
          content: JSON.stringify({
            subQuestions: ['Q1'], searchQueries: ['query1'], keyRequirements: ['R1']
          }),
          model: 'minimax', tier: 'tier1', usage: { prompt_tokens: 200, completion_tokens: 100 }, error: null
        };
      }
      if (userMessage && userMessage.includes('SYNTHESIZE')) {
        return {
          content: 'Original output',
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 1500, completion_tokens: 800 }, error: null
        };
      }
      if (userMessage && userMessage.includes('CRITIQUE')) {
        critiqueCount++;
        return {
          content: JSON.stringify({
            scores: { completeness: 2, accuracy: 2, actionability: 2, depth: 2 },
            overallScore: 2.0, gaps: ['Weak'], lesson: 'Needs work'
          }),
          model: 'minimax', tier: 'tier1',
          usage: { prompt_tokens: 300, completion_tokens: 150 }, error: null
        };
      }
      if (userMessage && userMessage.includes('REVISE')) {
        // Revision fails
        return {
          content: null,
          model: 'claude-sonnet', tier: 'tier2',
          usage: { prompt_tokens: 0, completion_tokens: 0 },
          error: 'Rate limited'
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

    // Should still return content (the original, since revision failed)
    expect(result.content).toBe('Original output');
    // Revised should be false since the revision didn't succeed
    expect(result.revised).toBe(false);
  });
});

// ============================================================
// BACKWARD COMPATIBILITY — existing behavior preserved
// ============================================================

describe('Backward compatibility', () => {

  it('still supports old dataBacked score name in LLM response (maps to accuracy)', async () => {
    // Some LLM responses might still use the old "dataBacked" field name
    mockCallLLM.mockImplementation(buildMockLLM({
      scores: { completeness: 4, dataBacked: 3, actionability: 4, depth: 4 },
      overallScore: 3.75, gaps: [], lesson: 'OK'
    }));

    const step = makeResearchStep({ id: 50 });
    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier2'
    });

    // Should still work — no crash
    expect(result.error).toBeNull();
    expect(result.content).toBeTruthy();

    // Check that scores are stored in metadata
    const phases = mockSupabase.__getData('pipeline_phases');
    const critiquePhase = phases.find(p => p.phase_name === 'critique');
    expect(critiquePhase).toBeDefined();
    expect(critiquePhase.metadata.scores).toBeDefined();
  });

  it('skipPipeline still bypasses all phases including new revision loop', async () => {
    mockCallLLM.mockResolvedValueOnce({
      content: 'Quick response',
      model: 'minimax', tier: 'tier1',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      error: null
    });

    const step = makeStep({
      description: 'Say hello',
      assigned_agent_id: 'jet-chief',
      model_tier: 'tier1',
      status: 'in_progress'
    });

    const result = await pipeline.execute({
      step,
      promptData: makePromptData(),
      userMessage: step.description,
      effectiveTier: 'tier1',
      config: { skipPipeline: true }
    });

    // Only 1 LLM call, no critique, no revision loop
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result.critiqueScore).toBeNull();
    expect(result.revised).toBe(false);
  });
});
