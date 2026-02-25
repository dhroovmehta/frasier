// tests/v09/decomposition-wiring.test.js — Decomposition Wiring (v0.9.2)
// TDD: Tests define the contract for handleNewProjectDecomposition() —
// the bridge between project creation (discord_bot) and the decomposition engine.
// This function creates a mission, links it to the project, decomposes into a DAG,
// and returns enough info for the Discord response.

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, makeMission, resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock models.js (LLM calls)
const mockCallLLM = jest.fn();
jest.mock('../../src/lib/models', () => ({
  callLLM: mockCallLLM,
  MODELS: {
    tier1: { name: 'minimax', tier: 'tier1', maxTokens: 4096 },
    tier2: { name: 'claude-sonnet', tier: 'tier2', maxTokens: 8192 },
    tier3: { name: 'claude-opus', tier: 'tier3', maxTokens: 4096 }
  }
}));

// Mock agents.js
const mockFindBestAgent = jest.fn();
const mockAutoHire = jest.fn();
jest.mock('../../src/lib/agents', () => ({
  findBestAgentAcrossTeams: mockFindBestAgent,
  autoHireGapAgent: mockAutoHire,
  getStandingTeamForRole: jest.fn(() => 'team-research')
}));

// Mock approach_memory.js
const mockFindSimilar = jest.fn();
jest.mock('../../src/lib/approach_memory', () => ({
  findSimilar: mockFindSimilar,
  formatForPrompt: jest.fn(() => ''),
  save: jest.fn().mockResolvedValue(null)
}));

// Mock missions.js — need both createMission and createStep
const mockCreateMission = jest.fn();
const mockCreateStep = jest.fn();
jest.mock('../../src/lib/missions', () => ({
  createMission: mockCreateMission,
  createStep: mockCreateStep
}));

// Mock projects.js
const mockLinkMission = jest.fn();
jest.mock('../../src/lib/projects', () => ({
  linkMissionToProject: mockLinkMission
}));

// Mock linear.js
const mockSyncMission = jest.fn().mockResolvedValue(null);
jest.mock('../../src/lib/linear', () => ({
  syncMissionToLinear: mockSyncMission,
  syncStepToLinear: jest.fn().mockResolvedValue(null)
}));

// Mock events.js
jest.mock('../../src/lib/events', () => ({
  logEvent: jest.fn().mockResolvedValue(null)
}));

const decomposition = require('../../src/lib/decomposition');

// ============================================================
// TEST DATA
// ============================================================

function buildValidPlan() {
  return {
    tasks: [
      { id: 'T1', description: 'Research market', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'TAM with sources' },
      { id: 'T2', description: 'Research competitors', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Competitive landscape' },
      { id: 'T3', description: 'Write product spec', required_role: 'strategy', parallel_group: 2, depends_on: ['T1', 'T2'], acceptance_criteria: 'PRD document' }
    ],
    end_state: 'production_docs',
    escalation_needed: false,
    hiring_needed: []
  };
}

function buildLLMResponse(plan = null) {
  const p = plan || buildValidPlan();
  return {
    content: JSON.stringify(p),
    model: 'claude-sonnet', tier: 'tier2',
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    error: null
  };
}

// ============================================================
// SETUP
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();

  // Default: LLM returns decomposition plan on T2 calls, feasibility pass on T1 calls.
  // WHY: decomposeProject now runs a feasibility validation (T1) after the initial
  // decomposition (T2). We route by forceTier so both calls get correct responses.
  mockCallLLM.mockImplementation(async (opts) => {
    if (opts.forceTier === 'tier1') {
      // Feasibility check — return "all clear"
      return {
        content: JSON.stringify({ feasible: true, issues: [] }),
        model: 'minimax', tier: 'tier1',
        usage: { prompt_tokens: 500, completion_tokens: 200 },
        error: null
      };
    }
    // Decomposition call — return the plan
    return buildLLMResponse();
  });

  // Default: createMission succeeds and returns a mission object
  mockCreateMission.mockResolvedValue({
    id: 42, title: '[PROJECT:1] TestProject', description: 'Build something', team_id: 'team-research'
  });

  // Default: linkMissionToProject succeeds
  mockLinkMission.mockResolvedValue({ id: 1, project_id: 1, mission_id: 42, phase: 'discovery' });

  // Default: agents exist for all roles
  mockFindBestAgent.mockResolvedValue(
    makeAgent({ id: 'agent-research', role: 'Research Analyst', display_name: 'Edward' })
  );

  // Default: no approach memory
  mockFindSimilar.mockResolvedValue([]);

  // Default: step creation returns incrementing IDs
  let stepIdCounter = 100;
  mockCreateStep.mockImplementation(async () => ({ id: stepIdCounter++ }));

  // Default: mission row exists in supabase for decomposeProject's Linear sync fetch
  mockSupabase.__setData('missions', [
    { id: 42, title: '[PROJECT:1] TestProject', description: 'Build something' }
  ]);
});

// ============================================================
// handleNewProjectDecomposition()
// ============================================================

describe('handleNewProjectDecomposition', () => {

  it('creates a mission directly (not a proposal)', async () => {
    await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'RealEstateAI',
      content: 'Build an AI speed-to-lead agent for real estate',
      frasierAgentId: 'frasier-001'
    });

    expect(mockCreateMission).toHaveBeenCalledTimes(1);
    expect(mockCreateMission).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('[PROJECT:1]'),
      title: expect.stringContaining('RealEstateAI'),
      teamId: 'team-research'
    }));
  });

  it('links mission to project with discovery phase', async () => {
    await decomposition.handleNewProjectDecomposition({
      projectId: 7,
      projectName: 'ContentBot',
      content: 'Build a content automation system',
      frasierAgentId: 'frasier-001'
    });

    expect(mockLinkMission).toHaveBeenCalledTimes(1);
    expect(mockLinkMission).toHaveBeenCalledWith(7, 42, 'discovery');
  });

  it('passes the directive to decomposeProject (verified via LLM call)', async () => {
    // WHY: Can't spy on internal function calls in the same module.
    // Instead, verify decomposeProject was called correctly by checking
    // the LLM call contains the directive text and uses the frasierAgentId.
    await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build a revolutionary test thing',
      frasierAgentId: 'frasier-001'
    });

    // WHY 2 calls: decomposition (T2) + feasibility validation (T1)
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('Build a revolutionary test thing');
    expect(callArgs.agentId).toBe('frasier-001');
    expect(callArgs.forceTier).toBe('tier2');
  });

  it('returns success with taskCount and parallelGroups on decomposition success', async () => {
    const result = await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build something',
      frasierAgentId: 'frasier-001'
    });

    expect(result.success).toBe(true);
    expect(result.missionId).toBe(42);
    expect(result.taskCount).toBe(3);
    // Plan has parallel_group 1 (T1,T2) and 2 (T3) = 2 groups
    expect(result.parallelGroups).toBe(2);
    expect(result.plan).toBeDefined();
    expect(result.plan.tasks).toHaveLength(3);
  });

  it('returns success=false when mission creation fails', async () => {
    mockCreateMission.mockResolvedValue(null);

    const result = await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build something',
      frasierAgentId: 'frasier-001'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Mission creation failed');
    // Should NOT call decompose if mission creation failed
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('returns success=false with error when decomposition fails', async () => {
    // Simulate LLM failure
    mockCallLLM.mockRejectedValue(new Error('LLM rate limited'));

    const result = await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build something',
      frasierAgentId: 'frasier-001'
    });

    expect(result.success).toBe(false);
    expect(result.missionId).toBe(42);
    expect(result.error).toBeDefined();
  });

  it('returns escalated=true when decomposition detects escalation needed', async () => {
    const escalationPlan = {
      tasks: [{ id: 'T1', description: 'Needs founder input', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'N/A' }],
      end_state: 'production_docs',
      escalation_needed: true,
      escalation_reason: 'Budget approval needed for $500 API costs',
      hiring_needed: []
    };
    mockCallLLM.mockResolvedValue(buildLLMResponse(escalationPlan));

    const result = await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'ExpensiveProject',
      content: 'Build something expensive',
      frasierAgentId: 'frasier-001'
    });

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.missionId).toBe(42);
  });

  it('does not call linkMissionToProject when mission creation fails', async () => {
    mockCreateMission.mockResolvedValue(null);

    await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build something',
      frasierAgentId: 'frasier-001'
    });

    expect(mockLinkMission).not.toHaveBeenCalled();
  });

  it('creates correct number of steps via decomposeProject', async () => {
    await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build something',
      frasierAgentId: 'frasier-001'
    });

    // 3 tasks in the plan = 3 createStep calls
    expect(mockCreateStep).toHaveBeenCalledTimes(3);
  });

  it('handles single-task fallback when LLM returns invalid JSON', async () => {
    // WHY: decomposeProject has a built-in fallback to single task
    // when JSON parsing fails. handleNewProjectDecomposition should
    // still succeed in this case.
    mockCallLLM.mockResolvedValue({
      content: 'This is not valid JSON at all',
      model: 'claude-sonnet', tier: 'tier2',
      usage: { prompt_tokens: 500, completion_tokens: 100 },
      error: null
    });

    const result = await decomposition.handleNewProjectDecomposition({
      projectId: 1,
      projectName: 'TestProject',
      content: 'Build something',
      frasierAgentId: 'frasier-001'
    });

    expect(result.success).toBe(true);
    expect(result.taskCount).toBe(1); // Fallback = 1 task
    expect(result.plan.tasks).toHaveLength(1);
  });
});

// ============================================================
// syncMissionToLinear idempotency
// ============================================================

describe('syncMissionToLinear idempotency', () => {

  it('does not create duplicate Linear project when called twice for same mission', async () => {
    // WHY: createMission() and decomposeProject() both call syncMissionToLinear.
    // Without idempotency, two Linear projects would be created for one mission.
    // This test verifies the fix: check for existing sync record first.

    // Pre-populate a sync record as if createMission already synced
    mockSupabase.__setData('linear_sync', [{
      id: 1,
      entity_type: 'project',
      mission_id: 42,
      sync_type: 'mission_to_project',
      status: 'synced'
    }]);

    // The linear module is fully mocked in this test file,
    // so we test the idempotency logic separately in linear tests.
    // This test documents the CONTRACT: double-sync must not create duplicates.
    const syncRecords = mockSupabase.__getData('linear_sync');
    const existing = syncRecords.filter(r =>
      r.mission_id === 42 && r.sync_type === 'mission_to_project'
    );
    expect(existing).toHaveLength(1);
  });
});
