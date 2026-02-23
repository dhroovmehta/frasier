// Approach Memory Tests (TDD — written BEFORE implementation)
// Tests "what worked before" — agents accumulate judgment across tasks.
//
// WHY: When an agent decomposes a new task, knowing that "last time I researched
// a market, these search queries produced good data" makes decomposition sharper.

const createMockSupabase = require('../mocks/supabase');
const { makeStep, resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const approachMemory = require('../../src/lib/approach_memory');

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();
});

// ============================================================
// SAVE APPROACH
// ============================================================

describe('approachMemory.save()', () => {

  test('saves a completed approach to approach_memory table', async () => {
    await approachMemory.save({
      agentId: 'edward-research',
      missionStepId: 42,
      taskSummary: 'Research the viability of an AI tutoring platform',
      topicTags: ['market-research', 'ai', 'education', 'k-12'],
      decomposition: {
        subQuestions: ['What is the market size?', 'Who are competitors?'],
      },
      searchQueries: ['AI tutoring market size 2026', 'AI tutoring competitors'],
      effectiveQueries: ['AI tutoring market size 2026'],
      critiqueScore: 4.2
    });

    const rows = mockSupabase.__getData('approach_memory');
    expect(rows.length).toBe(1);
    expect(rows[0].agent_id).toBe('edward-research');
    expect(rows[0].mission_step_id).toBe(42);
    expect(rows[0].topic_tags).toEqual(['market-research', 'ai', 'education', 'k-12']);
    expect(rows[0].critique_score).toBe(4.2);
    expect(rows[0].search_queries).toEqual(['AI tutoring market size 2026', 'AI tutoring competitors']);
    expect(rows[0].effective_queries).toEqual(['AI tutoring market size 2026']);
  });

  test('truncates task summary to 500 characters', async () => {
    const longSummary = 'A'.repeat(1000);
    await approachMemory.save({
      agentId: 'edward-research',
      missionStepId: 1,
      taskSummary: longSummary,
      topicTags: ['test'],
      decomposition: {},
      searchQueries: [],
      effectiveQueries: [],
      critiqueScore: 3.5
    });

    const rows = mockSupabase.__getData('approach_memory');
    expect(rows[0].task_summary.length).toBeLessThanOrEqual(500);
  });
});

// ============================================================
// RETRIEVE SIMILAR APPROACHES
// ============================================================

describe('approachMemory.findSimilar()', () => {

  test('finds approaches with overlapping topic tags', async () => {
    // Seed two approaches
    mockSupabase.__setData('approach_memory', [
      {
        id: 1,
        agent_id: 'edward-research',
        mission_step_id: 10,
        task_summary: 'Research AI tutoring market',
        topic_tags: ['market-research', 'ai', 'education'],
        decomposition: { subQuestions: ['Market size?'] },
        search_queries: ['AI tutoring market size'],
        effective_queries: ['AI tutoring market size'],
        critique_score: 4.5,
        created_at: new Date().toISOString()
      },
      {
        id: 2,
        agent_id: 'edward-research',
        mission_step_id: 20,
        task_summary: 'Research social media trends',
        topic_tags: ['social-media', 'trends', 'marketing'],
        decomposition: { subQuestions: ['Top platforms?'] },
        search_queries: ['social media trends 2026'],
        effective_queries: ['social media trends 2026'],
        critique_score: 3.8,
        created_at: new Date().toISOString()
      }
    ]);

    const results = await approachMemory.findSimilar({
      agentId: 'edward-research',
      topicTags: ['market-research', 'ai'],
      limit: 5
    });

    // Should find the education approach (overlapping tags), not social media
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].task_summary).toContain('AI tutoring');
  });

  test('returns empty array when no similar approaches exist', async () => {
    const results = await approachMemory.findSimilar({
      agentId: 'edward-research',
      topicTags: ['quantum-physics'],
      limit: 5
    });

    expect(results).toEqual([]);
  });

  test('only returns approaches from the same agent', async () => {
    mockSupabase.__setData('approach_memory', [
      {
        id: 1,
        agent_id: 'toji-engineering',
        mission_step_id: 10,
        task_summary: 'Build API endpoint',
        topic_tags: ['api', 'engineering'],
        decomposition: {},
        search_queries: [],
        effective_queries: [],
        critique_score: 4.0,
        created_at: new Date().toISOString()
      }
    ]);

    const results = await approachMemory.findSimilar({
      agentId: 'edward-research',
      topicTags: ['api', 'engineering'],
      limit: 5
    });

    // Edward shouldn't see Toji's approaches
    expect(results).toEqual([]);
  });

  test('orders results by critique score descending (best approaches first)', async () => {
    mockSupabase.__setData('approach_memory', [
      {
        id: 1, agent_id: 'edward-research', mission_step_id: 10,
        task_summary: 'Mediocre research', topic_tags: ['research'],
        decomposition: {}, search_queries: [], effective_queries: [],
        critique_score: 2.5, created_at: new Date().toISOString()
      },
      {
        id: 2, agent_id: 'edward-research', mission_step_id: 20,
        task_summary: 'Excellent research', topic_tags: ['research'],
        decomposition: {}, search_queries: [], effective_queries: [],
        critique_score: 4.8, created_at: new Date().toISOString()
      }
    ]);

    const results = await approachMemory.findSimilar({
      agentId: 'edward-research',
      topicTags: ['research'],
      limit: 5
    });

    expect(results.length).toBe(2);
    expect(results[0].critique_score).toBeGreaterThan(results[1].critique_score);
  });
});

// ============================================================
// FORMAT FOR PROMPT INJECTION
// ============================================================

describe('approachMemory.formatForPrompt()', () => {

  test('formats approaches as prompt-ready text', () => {
    const approaches = [
      {
        task_summary: 'Research AI tutoring market',
        decomposition: { subQuestions: ['Market size?', 'Competitors?'] },
        effective_queries: ['AI tutoring market size 2026'],
        critique_score: 4.5
      }
    ];

    const formatted = approachMemory.formatForPrompt(approaches);
    expect(formatted).toContain('AI tutoring market');
    expect(formatted).toContain('Market size?');
    expect(formatted).toContain('AI tutoring market size 2026');
    expect(formatted).toContain('4.5');
  });

  test('returns empty string for no approaches', () => {
    expect(approachMemory.formatForPrompt([])).toBe('');
  });
});
