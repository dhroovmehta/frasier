// Phase 5A: Context Enrichment Tests
// Tests for the new context.js module that enriches task prompts with
// original request, project context, output templates, and domain instructions.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';

const createMockSupabase = require('../mocks/supabase');
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const context = require('../../src/lib/context');

beforeEach(() => {
  mockSupabase.__reset();
});

// ============================================================
// OUTPUT TEMPLATE SELECTION
// ============================================================

describe('selectOutputTemplate()', () => {
  test('returns research template for research tasks', () => {
    const template = context.selectOutputTemplate('Conduct market research on AI SaaS competitors');
    expect(template).toContain('Executive Summary');
    expect(template).toContain('Key Findings');
    expect(template).toContain('Recommendations');
  });

  test('returns strategy template for strategy tasks', () => {
    const template = context.selectOutputTemplate('Develop a go-to-market strategy for Q3');
    expect(template).toContain('Strategic Overview');
    expect(template).toContain('Implementation Roadmap');
  });

  test('returns content template for content creation tasks', () => {
    const template = context.selectOutputTemplate('Write a blog post about our product launch');
    expect(template).toContain('Hook');
    expect(template).toContain('Call to Action');
  });

  test('returns engineering template for engineering tasks', () => {
    const template = context.selectOutputTemplate('Build an API endpoint for user registration');
    expect(template).toContain('Technical Approach');
    expect(template).toContain('Implementation');
  });

  test('returns requirements template for requirements tasks', () => {
    const template = context.selectOutputTemplate('Define requirements for the dashboard feature');
    expect(template).toContain('Functional Requirements');
    expect(template).toContain('Acceptance Criteria');
  });

  test('returns default template for unmatched tasks', () => {
    const template = context.selectOutputTemplate('Do something vague');
    expect(template).toBeTruthy();
    expect(typeof template).toBe('string');
  });
});

// ============================================================
// DOMAIN INSTRUCTIONS
// ============================================================

describe('getDomainInstructions()', () => {
  test('returns research instructions for Research Analyst role', () => {
    const instructions = context.getDomainInstructions('Research Analyst');
    expect(instructions).toContain('data points');
    expect(instructions).toContain('sources');
  });

  test('returns strategy instructions for Strategy Lead role', () => {
    const instructions = context.getDomainInstructions('Strategy Lead');
    expect(instructions).toContain('roadmap');
    expect(instructions).toContain('metrics');
  });

  test('returns content instructions for Content Creator role', () => {
    const instructions = context.getDomainInstructions('Content Creator');
    expect(instructions).toContain('Audience');
  });

  test('returns generic instructions for unknown roles', () => {
    const instructions = context.getDomainInstructions('Random Role');
    expect(instructions).toBeTruthy();
    expect(typeof instructions).toBe('string');
  });
});

// ============================================================
// ORIGINAL MESSAGE RETRIEVAL
// ============================================================

describe('getOriginalMessage()', () => {
  test('traces mission → proposal → raw_message', async () => {
    mockSupabase.__setData('mission_proposals', [
      { id: 10, raw_message: 'Build me a Real Estate AI Agent', status: 'accepted' }
    ]);
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: 10, title: 'Real Estate AI', status: 'in_progress' }
    ]);

    const msg = await context.getOriginalMessage(100);
    expect(msg).toBe('Build me a Real Estate AI Agent');
  });

  test('returns null when mission has no proposal', async () => {
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: null, title: 'Standalone', status: 'in_progress' }
    ]);

    const msg = await context.getOriginalMessage(100);
    expect(msg).toBeNull();
  });

  test('returns null when proposal has no raw_message', async () => {
    mockSupabase.__setData('mission_proposals', [
      { id: 10, raw_message: null, status: 'accepted' }
    ]);
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: 10, title: 'Test', status: 'in_progress' }
    ]);

    const msg = await context.getOriginalMessage(100);
    expect(msg).toBeNull();
  });
});

// ============================================================
// BUILD TASK CONTEXT (main pipeline)
// ============================================================

describe('buildTaskContext()', () => {
  test('includes original message when available', async () => {
    mockSupabase.__setData('mission_proposals', [
      { id: 10, raw_message: 'Research the AI SaaS market', status: 'accepted' }
    ]);
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: 10, title: 'AI SaaS Research', status: 'in_progress' }
    ]);

    const step = {
      id: 1,
      mission_id: 100,
      description: 'Conduct competitive analysis of AI SaaS market',
      model_tier: 'tier1'
    };

    const result = await context.buildTaskContext(step, 'Research Analyst');
    expect(result).toContain('Research the AI SaaS market');
    expect(result).toContain("ZERO'S ORIGINAL REQUEST");
  });

  test('includes domain-specific quality mandates', async () => {
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: null, title: 'Test', status: 'in_progress' }
    ]);

    const step = {
      id: 1,
      mission_id: 100,
      description: 'Research competitors',
      model_tier: 'tier1'
    };

    const result = await context.buildTaskContext(step, 'Research Analyst');
    expect(result).toContain('data points');
    expect(result).toContain('QUALITY MANDATES');
  });

  test('includes task description', async () => {
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: null, title: 'Test', status: 'in_progress' }
    ]);

    const step = {
      id: 1,
      mission_id: 100,
      description: 'Analyze top 5 competitors in the AI agent space',
      model_tier: 'tier1'
    };

    const result = await context.buildTaskContext(step, 'Research Analyst');
    expect(result).toContain('Analyze top 5 competitors');
  });

  test('includes output template', async () => {
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: null, title: 'Test', status: 'in_progress' }
    ]);

    const step = {
      id: 1,
      mission_id: 100,
      description: 'Research the competitive landscape',
      model_tier: 'tier1'
    };

    const result = await context.buildTaskContext(step, 'Research Analyst');
    expect(result).toContain('OUTPUT FORMAT');
  });

  test('includes quality standards block', async () => {
    mockSupabase.__setData('missions', [
      { id: 100, proposal_id: null, title: 'Test', status: 'in_progress' }
    ]);

    const step = {
      id: 1,
      mission_id: 100,
      description: 'Write a strategy document',
      model_tier: 'tier1'
    };

    const result = await context.buildTaskContext(step, 'Strategy Lead');
    expect(result).toContain('QUALITY STANDARDS');
  });
});
