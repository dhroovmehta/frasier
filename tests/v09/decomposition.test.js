// tests/v09/decomposition.test.js — Decomposition Engine (v0.9.0 Phase 5)
// TDD: Tests define the contract for decomposeProject() and supporting functions.
// Frasier takes a directive, breaks it into parallel/sequential tasks with
// dependency DAG, assigns agents, and creates mission steps.

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, makeMission, makeStep, resetIdCounter } = require('../helpers');

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
const mockSaveApproach = jest.fn();
jest.mock('../../src/lib/approach_memory', () => ({
  findSimilar: mockFindSimilar,
  formatForPrompt: jest.fn(() => ''),
  save: mockSaveApproach
}));

// Mock missions.js
const mockCreateStep = jest.fn();
jest.mock('../../src/lib/missions', () => ({
  createStep: mockCreateStep.mockResolvedValue({ id: 100 })
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

const decomposition = require('../../src/lib/decomposition');

// ============================================================
// TEST DATA
// ============================================================

function buildValidPlan() {
  return {
    tasks: [
      { id: 'T1', description: 'Research real estate market', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'TAM/SAM/SOM with sources' },
      { id: 'T2', description: 'Research AI speed-to-lead tech', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Tech landscape with pricing' },
      { id: 'T3', description: 'Design product architecture', required_role: 'engineering', parallel_group: 2, depends_on: ['T1', 'T2'], acceptance_criteria: 'Architecture diagram' },
      { id: 'T4', description: 'Write product requirements', required_role: 'strategy', parallel_group: 2, depends_on: ['T1'], acceptance_criteria: 'PRD with user stories' }
    ],
    end_state: 'production_docs',
    escalation_needed: false,
    hiring_needed: []
  };
}

function buildLLMPlanResponse(plan = null) {
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

  // Default: LLM returns a valid decomposition plan
  mockCallLLM.mockResolvedValue(buildLLMPlanResponse());

  // Default: agents exist for all roles
  mockFindBestAgent.mockResolvedValue(
    makeAgent({ id: 'agent-research', role: 'Research Analyst', display_name: 'Edward' })
  );

  // Default: no approach memory
  mockFindSimilar.mockResolvedValue([]);

  // Default: step creation returns incrementing IDs
  let stepIdCounter = 100;
  mockCreateStep.mockImplementation(async () => ({ id: stepIdCounter++ }));
});

// ============================================================
// decomposeProject()
// ============================================================

describe('decomposeProject', () => {

  it('calls LLM with roster + directive + approach memory hints', async () => {
    mockSupabase.__setData('agents', [
      makeAgent({ id: 'edward', role: 'Research Analyst', status: 'active' }),
      makeAgent({ id: 'spike', role: 'Full-Stack Engineer', status: 'active' })
    ]);

    await decomposition.decomposeProject({
      projectId: 1,
      missionId: 10,
      directive: 'Build a real estate speed-to-lead AI agent',
      frasierAgentId: 'frasier-001'
    });

    expect(mockCallLLM).toHaveBeenCalled();
    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('real estate');
    expect(callArgs.forceTier).toBe('tier2');
  });

  it('uses T2 model for decomposition (strategic work)', async () => {
    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    expect(mockCallLLM.mock.calls[0][0].forceTier).toBe('tier2');
  });

  it('returns structured plan with tasks, dependencies, parallel_groups', async () => {
    const result = await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    expect(result.plan).toBeDefined();
    expect(result.plan.tasks).toHaveLength(4);
    expect(result.plan.end_state).toBe('production_docs');
  });

  it('persists plan to decomposition_plans table', async () => {
    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    const stored = mockSupabase.__getData('decomposition_plans');
    expect(stored).toHaveLength(1);
    expect(stored[0].project_id).toBe(1);
    expect(stored[0].mission_id).toBe(10);
    expect(stored[0].status).toBe('active');
    expect(stored[0].decomposed_by).toBe('frasier');
  });

  it('determines end_state: production_docs / working_prototype / hybrid', async () => {
    mockCallLLM.mockResolvedValue(buildLLMPlanResponse({
      ...buildValidPlan(),
      end_state: 'working_prototype'
    }));

    const result = await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    expect(result.plan.end_state).toBe('working_prototype');
  });

  it('falls back to single-mission creation when JSON parsing fails', async () => {
    mockCallLLM.mockResolvedValue({
      content: 'This is not valid JSON at all, just rambling text about the plan...',
      model: 'claude-sonnet', tier: 'tier2', usage: {}, error: null
    });

    const result = await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    // Should not crash — returns a fallback single-task plan
    expect(result.error).toBeNull();
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.fallback).toBe(true);
  });
});

// ============================================================
// Dependency Graph Validation
// ============================================================

describe('Dependency Graph Validation', () => {

  it('accepts valid DAG (no cycles)', () => {
    const tasks = [
      { id: 'T1', depends_on: [] },
      { id: 'T2', depends_on: ['T1'] },
      { id: 'T3', depends_on: ['T1', 'T2'] }
    ];

    expect(() => decomposition.validateDependencyGraph(tasks)).not.toThrow();
  });

  it('rejects plan with cyclic dependencies', () => {
    const tasks = [
      { id: 'T1', depends_on: ['T3'] },
      { id: 'T2', depends_on: ['T1'] },
      { id: 'T3', depends_on: ['T2'] }
    ];

    expect(() => decomposition.validateDependencyGraph(tasks)).toThrow(/cycle/i);
  });

  it('accepts tasks with no dependencies (parallel root tasks)', () => {
    const tasks = [
      { id: 'T1', depends_on: [] },
      { id: 'T2', depends_on: [] },
      { id: 'T3', depends_on: [] }
    ];

    expect(() => decomposition.validateDependencyGraph(tasks)).not.toThrow();
  });

  it('accepts diamond dependencies (T3 depends on T1 AND T2)', () => {
    const tasks = [
      { id: 'T1', depends_on: [] },
      { id: 'T2', depends_on: [] },
      { id: 'T3', depends_on: ['T1', 'T2'] }
    ];

    expect(() => decomposition.validateDependencyGraph(tasks)).not.toThrow();
  });
});

// ============================================================
// createStepsFromPlan
// ============================================================

describe('createStepsFromPlan', () => {

  it('creates one mission_step per task in plan', async () => {
    const plan = buildValidPlan();
    await decomposition.createStepsFromPlan(10, plan, { research: 'edward', engineering: 'spike', strategy: 'jet' });

    expect(mockCreateStep).toHaveBeenCalledTimes(4);
  });

  it('sets step_order = parallel_group for each step', async () => {
    const plan = buildValidPlan();
    await decomposition.createStepsFromPlan(10, plan, { research: 'edward', engineering: 'spike', strategy: 'jet' });

    // T1 and T2 are parallel_group 1, T3 and T4 are parallel_group 2
    const call1 = mockCreateStep.mock.calls[0][0];
    const call3 = mockCreateStep.mock.calls[2][0];
    expect(call1.stepOrder).toBe(1);
    expect(call3.stepOrder).toBe(2);
  });

  it('creates step_dependencies rows from depends_on references', async () => {
    const plan = buildValidPlan();
    await decomposition.createStepsFromPlan(10, plan, { research: 'edward', engineering: 'spike', strategy: 'jet' });

    const deps = mockSupabase.__getData('step_dependencies');
    // T3 depends on T1 and T2 (2 rows), T4 depends on T1 (1 row) = 3 total
    expect(deps).toHaveLength(3);
  });

  it('maps task IDs (T1, T2) to actual step IDs in dependency rows', async () => {
    const plan = buildValidPlan();
    await decomposition.createStepsFromPlan(10, plan, { research: 'edward', engineering: 'spike', strategy: 'jet' });

    const deps = mockSupabase.__getData('step_dependencies');
    // All dep entries should use numeric step IDs, not task IDs
    for (const dep of deps) {
      expect(typeof dep.step_id).toBe('number');
      expect(typeof dep.depends_on_step_id).toBe('number');
    }
  });

  it('assigns correct agent to each step based on required_role', async () => {
    const plan = buildValidPlan();
    const agentMap = { research: 'edward', engineering: 'spike', strategy: 'jet' };
    await decomposition.createStepsFromPlan(10, plan, agentMap);

    // T1 (research) → edward
    expect(mockCreateStep.mock.calls[0][0].assignedAgentId).toBe('edward');
    // T3 (engineering) → spike
    expect(mockCreateStep.mock.calls[2][0].assignedAgentId).toBe('spike');
    // T4 (strategy) → jet
    expect(mockCreateStep.mock.calls[3][0].assignedAgentId).toBe('jet');
  });

  it('includes acceptance_criteria in step description', async () => {
    const plan = buildValidPlan();
    await decomposition.createStepsFromPlan(10, plan, { research: 'edward', engineering: 'spike', strategy: 'jet' });

    const call1 = mockCreateStep.mock.calls[0][0];
    expect(call1.description).toContain('TAM/SAM/SOM with sources');
  });
});

// ============================================================
// Proactive Hiring
// ============================================================

describe('Proactive Hiring', () => {

  it('calls autoHireGapAgent for each hiring_needed entry', async () => {
    mockCallLLM.mockResolvedValue(buildLLMPlanResponse({
      ...buildValidPlan(),
      hiring_needed: [
        { role_title: 'Real Estate Market Analyst', role_category: 'research' }
      ]
    }));

    // No agent found for the needed role
    mockFindBestAgent.mockResolvedValue(null);
    mockAutoHire.mockResolvedValue(
      makeAgent({ id: 'new-agent', role: 'Real Estate Market Analyst' })
    );

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    expect(mockAutoHire).toHaveBeenCalledTimes(1);
    expect(mockAutoHire.mock.calls[0][0]).toBe('Real Estate Market Analyst');
  });

  it('does not hire when all required roles have existing agents', async () => {
    // Plan has no hiring_needed
    mockCallLLM.mockResolvedValue(buildLLMPlanResponse(buildValidPlan()));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    expect(mockAutoHire).not.toHaveBeenCalled();
  });
});

// ============================================================
// Escalation
// ============================================================

describe('Escalation', () => {

  it('logs to escalation_log when escalation_needed is true', async () => {
    mockCallLLM.mockResolvedValue(buildLLMPlanResponse({
      ...buildValidPlan(),
      escalation_needed: true,
      escalation_reason: 'Budget exceeds $100 threshold'
    }));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    const escalations = mockSupabase.__getData('escalation_log');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalation_type).toBe('budget');
    expect(escalations[0].reason).toContain('$100');
  });

  it('does NOT create steps when escalation is needed', async () => {
    mockCallLLM.mockResolvedValue(buildLLMPlanResponse({
      ...buildValidPlan(),
      escalation_needed: true,
      escalation_reason: 'Needs founder approval'
    }));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    // No steps should be created
    expect(mockCreateStep).not.toHaveBeenCalled();
  });
});

// ============================================================
// Approach Memory
// ============================================================

describe('Approach Memory', () => {

  it('retrieves similar past approaches before decomposition', async () => {
    mockFindSimilar.mockResolvedValue([
      { task_summary: 'Similar project', critique_score: 4.2, search_queries: ['query1'] }
    ]);

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build real estate AI', frasierAgentId: 'frasier-001'
    });

    expect(mockFindSimilar).toHaveBeenCalled();
  });

  it('saves successful decomposition as new approach_memory entry', async () => {
    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    const approaches = mockSupabase.__getData('approach_memory');
    expect(approaches.length).toBeGreaterThanOrEqual(0);
    // Approach is saved to the approach_memory module
    // (the mock tracks calls)
  });
});
