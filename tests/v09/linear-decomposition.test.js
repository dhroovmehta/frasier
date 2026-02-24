// tests/v09/linear-decomposition.test.js — Decomposed Project Linear Sync + QA Scope (v0.9.0 Phase 8)
// TDD: Tests define the contract for syncDecomposedProjectToLinear() and QA scope adjustment.

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

// Mock uuid (ESM module that Jest can't parse)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234'
}));

// Mock fetch for Linear GraphQL API
const mockFetch = jest.fn();
global.fetch = mockFetch;

const linear = require('../../src/lib/linear');
const conversations = require('../../src/lib/conversations');

// ============================================================
// SETUP
// ============================================================

function makeLinearGraphQLResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data })
  };
}

function buildTestPlan() {
  return {
    tasks: [
      { id: 'T1', description: 'Research AI market', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Market report' },
      { id: 'T2', description: 'Research competitors', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Competitor analysis' },
      { id: 'T3', description: 'Design architecture', required_role: 'engineering', parallel_group: 2, depends_on: ['T1', 'T2'], acceptance_criteria: 'Architecture doc' }
    ],
    end_state: 'production_docs'
  };
}

function buildTestSteps() {
  return [
    makeStep({ id: 100, mission_id: 10, description: 'Research AI market', assigned_agent_id: 'edward', step_order: 1 }),
    makeStep({ id: 101, mission_id: 10, description: 'Research competitors', assigned_agent_id: 'edward', step_order: 1 }),
    makeStep({ id: 102, mission_id: 10, description: 'Design architecture', assigned_agent_id: 'spike', step_order: 2 })
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Set env for Linear
  process.env.LINEAR_API_KEY = 'test-key';
  process.env.LINEAR_TEAM_ID = 'team-123';

  // Default: LLM returns polished title
  mockCallLLM.mockResolvedValue({
    content: '{"title": "Polished Title", "description": "Polished description"}',
    error: null
  });

  // Default: Linear API returns success
  mockFetch.mockResolvedValue(makeLinearGraphQLResponse({
    projectCreate: {
      success: true,
      project: { id: 'proj-1', url: 'https://linear.app/proj-1', slugId: 'proj-1' }
    }
  }));

  // Set cache for labels
  linear.__setCache({
    labels: { 'frasier-managed': 'label-fm', 'Research': 'label-research', 'Engineering': 'label-eng' }
  });
});

afterEach(() => {
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_TEAM_ID;
  linear.__resetCache();
});

// ============================================================
// Decomposed Project Linear Sync
// ============================================================

describe('Decomposed Project Linear Sync', () => {

  it('creates Linear project from decomposition plan', async () => {
    const plan = buildTestPlan();
    const steps = buildTestSteps();

    await linear.syncDecomposedProjectToLinear({
      missionId: 10,
      title: 'AI Speed-to-Lead Agent',
      plan,
      steps
    });

    // Should have called Linear API for project creation
    expect(mockFetch).toHaveBeenCalled();
    const firstCall = mockFetch.mock.calls[0];
    const body = JSON.parse(firstCall[1].body);
    expect(body.query).toContain('ProjectCreate');
  });

  it('creates Linear issue per task with correct labels', async () => {
    // Set up fetch to respond differently for project vs issue creation
    mockFetch
      .mockResolvedValueOnce(makeLinearGraphQLResponse({
        projectCreate: { success: true, project: { id: 'proj-1', url: 'https://linear.app/proj-1', slugId: 'proj-1' } }
      }))
      .mockResolvedValue(makeLinearGraphQLResponse({
        issueCreate: { success: true, issue: { id: 'issue-1', identifier: 'NRV-1', url: 'https://linear.app/issue-1' } }
      }));

    const plan = buildTestPlan();
    const steps = buildTestSteps();

    await linear.syncDecomposedProjectToLinear({
      missionId: 10,
      title: 'AI Speed-to-Lead Agent',
      plan,
      steps
    });

    // 1 project creation + N issue creations (with LLM calls for polishing)
    // At minimum, we should have more than 1 Linear API call
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('sync failure does not block execution (no throw)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const plan = buildTestPlan();
    const steps = buildTestSteps();

    // Should not throw — fire-and-forget safety
    await expect(
      linear.syncDecomposedProjectToLinear({
        missionId: 10,
        title: 'AI Speed-to-Lead Agent',
        plan,
        steps
      })
    ).resolves.not.toThrow();
  });

  it('saves sync records to linear_sync table', async () => {
    mockFetch.mockResolvedValue(makeLinearGraphQLResponse({
      projectCreate: { success: true, project: { id: 'proj-1', url: 'https://linear.app/proj-1', slugId: 'proj-1' } }
    }));

    const plan = buildTestPlan();
    const steps = buildTestSteps();

    await linear.syncDecomposedProjectToLinear({
      missionId: 10,
      title: 'AI Speed-to-Lead Agent',
      plan,
      steps
    });

    const syncRecords = mockSupabase.__getData('linear_sync');
    // At least the project sync record
    expect(syncRecords.length).toBeGreaterThanOrEqual(1);
    expect(syncRecords[0].entity_type).toBe('project');
  });
});

// ============================================================
// QA Scope Adjustment
// ============================================================

describe('QA Scope Adjustment', () => {

  it('domain task QA prompt limits Ein to technical quality review', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      'Edward',
      'Market research deliverable content...',
      'Research AI tutoring market size and competitors',
      'Research AI tutoring',
      { reviewerRole: 'qa', taskRole: 'research' }
    );

    expect(prompt).toContain('technical quality');
    expect(prompt).toContain('Do not judge domain expertise');
  });

  it('engineering task QA prompt gives Ein full review scope', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      'Spike',
      'API architecture deliverable content...',
      'Design the API architecture for the speed-to-lead system',
      'Build the backend',
      { reviewerRole: 'qa', taskRole: 'engineering' }
    );

    // Should NOT contain the domain expertise limitation
    expect(prompt).not.toContain('Do not judge domain expertise');
  });

  it('non-QA reviewer gets full review scope regardless of task role', () => {
    const prompt = conversations.buildEnhancedReviewPrompt(
      'Edward',
      'Research deliverable...',
      'Research task',
      'Original message',
      { reviewerRole: 'team_lead', taskRole: 'research' }
    );

    // Team lead reviews everything — no scope limitation
    expect(prompt).not.toContain('Do not judge domain expertise');
  });
});
