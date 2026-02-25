// tests/v010/capability-aware-decomposition.test.js — Capability-Aware Decomposition (v0.10.0)
// TDD: Tests define the contract for capability manifest injection and feasibility validation.
// WHY: The decomposition engine was planning blind — creating tasks with acceptance criteria
// that agents couldn't fulfill (e.g., "mine 50 Reddit threads" when agents can only search via Brave).
// These tests ensure the planner knows what agents can and cannot do.

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, resetIdCounter } = require('../helpers');

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
jest.mock('../../src/lib/agents', () => ({
  findBestAgentAcrossTeams: mockFindBestAgent,
  autoHireGapAgent: jest.fn(),
  getStandingTeamForRole: jest.fn(() => 'team-research')
}));

// Mock approach_memory.js
jest.mock('../../src/lib/approach_memory', () => ({
  findSimilar: jest.fn().mockResolvedValue([]),
  formatForPrompt: jest.fn(() => ''),
  save: jest.fn()
}));

// Mock missions.js
const mockCreateStep = jest.fn();
jest.mock('../../src/lib/missions', () => ({
  createStep: mockCreateStep.mockResolvedValue({ id: 100 }),
  createMission: jest.fn().mockResolvedValue({ id: 10, title: 'Test' })
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

const capabilities = require('../../src/lib/capabilities');
const decomposition = require('../../src/lib/decomposition');

// ============================================================
// TEST DATA
// ============================================================

function buildValidPlan() {
  return {
    tasks: [
      { id: 'T1', description: 'Research market trends via web search', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Market analysis with cited web sources' },
      { id: 'T2', description: 'Write product requirements', required_role: 'strategy', parallel_group: 2, depends_on: ['T1'], acceptance_criteria: 'PRD with user stories' }
    ],
    end_state: 'production_docs',
    escalation_needed: false,
    hiring_needed: []
  };
}

function buildInfeasiblePlan() {
  return {
    tasks: [
      { id: 'T1', description: 'Mine 50 Reddit threads per niche from r/tax, r/smallbusiness', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Minimum 50 relevant threads per niche catalogued with URLs, upvotes, and top quotes' },
      { id: 'T2', description: 'Pull Google Trends search volume data for each niche × state', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Search volume CSV with monthly trend data per keyword' }
    ],
    end_state: 'production_docs',
    escalation_needed: false,
    hiring_needed: []
  };
}

function buildRevisedPlan() {
  return {
    tasks: [
      { id: 'T1', description: 'Search for Reddit discussions about tax and small business pain points using Brave Search, compile top findings with source links', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Compiled research from web search results covering Reddit/forum discussions, with source URLs and key pain point quotes' },
      { id: 'T2', description: 'Research search demand signals using available web sources and keyword analysis articles', required_role: 'research', parallel_group: 1, depends_on: [], acceptance_criteria: 'Demand analysis report using available web data, industry reports, and keyword research articles' }
    ],
    end_state: 'production_docs',
    escalation_needed: false,
    hiring_needed: []
  };
}

function buildLLMResponse(plan) {
  return {
    content: JSON.stringify(plan),
    model: 'claude-sonnet', tier: 'tier2',
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    error: null
  };
}

function buildFeasibilityResponse(allFeasible) {
  if (allFeasible) {
    return {
      content: JSON.stringify({
        feasible: true,
        issues: []
      }),
      model: 'minimax', tier: 'tier1',
      usage: { prompt_tokens: 500, completion_tokens: 200 },
      error: null
    };
  }
  return {
    content: JSON.stringify({
      feasible: false,
      issues: [
        { taskId: 'T1', issue: 'Requires direct Reddit scraping — agents cannot browse Reddit. Use Brave Search for "reddit tax pain points" instead.', suggestion: 'Search for Reddit content via Brave Search API rather than direct mining' },
        { taskId: 'T2', issue: 'Requires Google Trends API access — not available. Use keyword research articles and industry reports instead.', suggestion: 'Gather demand signals from available web sources and published keyword research' }
      ]
    }),
    model: 'minimax', tier: 'tier1',
    usage: { prompt_tokens: 500, completion_tokens: 300 },
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

  mockFindBestAgent.mockResolvedValue(
    makeAgent({ id: 'agent-research', role: 'Research Analyst', display_name: 'Edward' })
  );

  let stepIdCounter = 100;
  mockCreateStep.mockImplementation(async () => ({ id: stepIdCounter++ }));
});

// ============================================================
// CAPABILITY MANIFEST MODULE
// ============================================================

describe('Capability Manifest (capabilities.js)', () => {

  it('exports buildCapabilityManifest() function', () => {
    expect(typeof capabilities.buildCapabilityManifest).toBe('function');
  });

  it('returns a string containing agent role capabilities', () => {
    const manifest = capabilities.buildCapabilityManifest();
    expect(typeof manifest).toBe('string');
    expect(manifest.length).toBeGreaterThan(100);
  });

  it('includes research agent capabilities', () => {
    const manifest = capabilities.buildCapabilityManifest();
    expect(manifest).toContain('research');
    expect(manifest).toMatch(/web search|brave|search/i);
  });

  it('includes engineering agent capabilities', () => {
    const manifest = capabilities.buildCapabilityManifest();
    expect(manifest).toMatch(/engineering/i);
    expect(manifest).toMatch(/code/i);
  });

  it('includes content agent capabilities', () => {
    const manifest = capabilities.buildCapabilityManifest();
    expect(manifest).toContain('content');
  });

  it('includes explicit CANNOT constraints', () => {
    const manifest = capabilities.buildCapabilityManifest();
    // Must list what agents cannot do
    expect(manifest).toMatch(/cannot|CANNOT|can NOT/i);
  });

  it('includes global execution constraints', () => {
    const manifest = capabilities.buildCapabilityManifest();
    // Must mention search limits, fetch limits, or resource constraints
    expect(manifest).toMatch(/limit|max|per task|per step/i);
  });

  it('exports ROLE_CAPABILITIES constant', () => {
    expect(capabilities.ROLE_CAPABILITIES).toBeDefined();
    expect(typeof capabilities.ROLE_CAPABILITIES).toBe('object');
    expect(capabilities.ROLE_CAPABILITIES.research).toBeDefined();
    expect(capabilities.ROLE_CAPABILITIES.engineering).toBeDefined();
  });

  it('each role has tools, strengths, and cannot arrays', () => {
    for (const [role, cap] of Object.entries(capabilities.ROLE_CAPABILITIES)) {
      expect(cap.tools).toBeDefined();
      expect(Array.isArray(cap.tools)).toBe(true);
      expect(cap.tools.length).toBeGreaterThan(0);
      expect(cap.cannot).toBeDefined();
      expect(Array.isArray(cap.cannot)).toBe(true);
      expect(cap.cannot.length).toBeGreaterThan(0);
      expect(cap.strengths).toBeDefined();
      expect(Array.isArray(cap.strengths)).toBe(true);
    }
  });
});

// ============================================================
// DECOMPOSITION PROMPT — Capability Injection
// ============================================================

describe('Decomposition Prompt — Capability Injection', () => {

  it('includes capability manifest in the LLM prompt', async () => {
    mockCallLLM.mockResolvedValue(buildLLMResponse(buildValidPlan()));

    mockSupabase.__setData('agents', [
      makeAgent({ id: 'edward', role: 'Research Analyst', status: 'active' })
    ]);

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Research the market', frasierAgentId: 'frasier-001'
    });

    const callArgs = mockCallLLM.mock.calls[0][0];
    // The prompt must contain capability information
    expect(callArgs.userMessage).toMatch(/CAPABILITIES|TOOLS|CONSTRAINTS/i);
  });

  it('includes CANNOT constraints in the prompt', async () => {
    mockCallLLM.mockResolvedValue(buildLLMResponse(buildValidPlan()));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Research the market', frasierAgentId: 'frasier-001'
    });

    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.userMessage).toMatch(/cannot|CANNOT/i);
  });

  it('includes the feasibility instruction in the prompt', async () => {
    mockCallLLM.mockResolvedValue(buildLLMResponse(buildValidPlan()));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Build something', frasierAgentId: 'frasier-001'
    });

    const callArgs = mockCallLLM.mock.calls[0][0];
    // Must instruct the planner to only create achievable tasks
    expect(callArgs.userMessage).toMatch(/achievable|feasible|listed (tools|capabilities)/i);
  });

  it('still includes directive, roster, and approach hints', async () => {
    mockCallLLM.mockResolvedValue(buildLLMResponse(buildValidPlan()));

    mockSupabase.__setData('agents', [
      makeAgent({ id: 'edward', role: 'Research Analyst', status: 'active', display_name: 'Edward' })
    ]);

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Research real estate markets', frasierAgentId: 'frasier-001'
    });

    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('Research real estate markets');
    expect(callArgs.userMessage).toContain('Edward');
  });
});

// ============================================================
// FEASIBILITY VALIDATION GATE
// ============================================================

describe('Feasibility Validation Gate', () => {

  it('exports validatePlanFeasibility() function', () => {
    expect(typeof capabilities.validatePlanFeasibility).toBe('function');
  });

  it('returns { feasible: true } for plans with achievable tasks', async () => {
    mockCallLLM.mockResolvedValue(buildFeasibilityResponse(true));

    const result = await capabilities.validatePlanFeasibility(
      buildValidPlan(),
      'frasier-001'
    );

    expect(result.feasible).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('returns { feasible: false, issues } for plans with infeasible tasks', async () => {
    mockCallLLM.mockResolvedValue(buildFeasibilityResponse(false));

    const result = await capabilities.validatePlanFeasibility(
      buildInfeasiblePlan(),
      'frasier-001'
    );

    expect(result.feasible).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].taskId).toBeDefined();
    expect(result.issues[0].issue).toBeDefined();
  });

  it('uses tier1 LLM for feasibility check (cheap validation)', async () => {
    mockCallLLM.mockResolvedValue(buildFeasibilityResponse(true));

    await capabilities.validatePlanFeasibility(
      buildValidPlan(),
      'frasier-001'
    );

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM.mock.calls[0][0].forceTier).toBe('tier1');
  });

  it('includes the capability manifest in the validation prompt', async () => {
    mockCallLLM.mockResolvedValue(buildFeasibilityResponse(true));

    await capabilities.validatePlanFeasibility(
      buildValidPlan(),
      'frasier-001'
    );

    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.userMessage).toMatch(/CAPABILITIES|TOOLS|CONSTRAINTS/i);
  });

  it('includes the plan tasks in the validation prompt', async () => {
    mockCallLLM.mockResolvedValue(buildFeasibilityResponse(true));

    const plan = buildValidPlan();
    await capabilities.validatePlanFeasibility(plan, 'frasier-001');

    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.userMessage).toContain(plan.tasks[0].description);
    expect(callArgs.userMessage).toContain(plan.tasks[0].acceptance_criteria);
  });

  it('gracefully handles LLM errors — returns feasible: true (fail-open)', async () => {
    mockCallLLM.mockResolvedValue({
      content: 'not valid json at all',
      error: null
    });

    const result = await capabilities.validatePlanFeasibility(
      buildValidPlan(),
      'frasier-001'
    );

    // Fail-open: don't block execution if validation itself breaks
    expect(result.feasible).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

// ============================================================
// DECOMPOSITION FLOW — Feasibility Integration
// ============================================================

describe('Decomposition Flow — Feasibility Integration', () => {

  it('runs feasibility validation after initial decomposition', async () => {
    // First call: decomposition LLM returns a valid plan
    // Second call: feasibility check returns feasible
    mockCallLLM
      .mockResolvedValueOnce(buildLLMResponse(buildValidPlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(true));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Research the market', frasierAgentId: 'frasier-001'
    });

    // Should have called LLM twice: decomposition + feasibility
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(mockCallLLM.mock.calls[0][0].forceTier).toBe('tier2');  // decomposition
    expect(mockCallLLM.mock.calls[1][0].forceTier).toBe('tier1');  // feasibility
  });

  it('re-decomposes when feasibility check finds issues (max 1 retry)', async () => {
    // Call 1: decomposition returns infeasible plan
    // Call 2: feasibility check returns issues
    // Call 3: re-decomposition with feedback returns revised plan
    // Call 4: feasibility check on revised plan passes
    mockCallLLM
      .mockResolvedValueOnce(buildLLMResponse(buildInfeasiblePlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(false))
      .mockResolvedValueOnce(buildLLMResponse(buildRevisedPlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(true));

    const result = await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Mine Reddit threads for market research', frasierAgentId: 'frasier-001'
    });

    // Should have called LLM 4 times: decompose + validate + re-decompose + re-validate
    expect(mockCallLLM).toHaveBeenCalledTimes(4);
    expect(result.plan).toBeDefined();
    expect(result.error).toBeNull();
  });

  it('includes feasibility feedback in re-decomposition prompt', async () => {
    mockCallLLM
      .mockResolvedValueOnce(buildLLMResponse(buildInfeasiblePlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(false))
      .mockResolvedValueOnce(buildLLMResponse(buildRevisedPlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(true));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Mine Reddit threads', frasierAgentId: 'frasier-001'
    });

    // The re-decomposition call (3rd call) should include the issues
    const reDecomposeArgs = mockCallLLM.mock.calls[2][0];
    expect(reDecomposeArgs.userMessage).toMatch(/Reddit|scraping|Brave/i);
  });

  it('proceeds with best plan after max retries exhausted', async () => {
    // Call 1: decomposition returns infeasible plan
    // Call 2: feasibility fails
    // Call 3: re-decomposition still returns infeasible
    // Call 4: feasibility still fails — proceed anyway
    mockCallLLM
      .mockResolvedValueOnce(buildLLMResponse(buildInfeasiblePlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(false))
      .mockResolvedValueOnce(buildLLMResponse(buildInfeasiblePlan()))
      .mockResolvedValueOnce(buildFeasibilityResponse(false));

    const result = await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Do something impossible', frasierAgentId: 'frasier-001'
    });

    // Should still return a plan (the best we got), not error out
    expect(result.plan).toBeDefined();
    expect(result.error).toBeNull();
    // Should NOT attempt a 3rd decomposition
    expect(mockCallLLM).toHaveBeenCalledTimes(4);
  });

  it('skips feasibility check for fallback single-task plans', async () => {
    // LLM returns garbage → falls back to single task
    mockCallLLM.mockResolvedValue({
      content: 'This is not valid JSON',
      model: 'claude-sonnet', tier: 'tier2', usage: {}, error: null
    });

    const result = await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Do something', frasierAgentId: 'frasier-001'
    });

    // Only 1 LLM call (the decomposition). No feasibility check on fallback plans.
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result.fallback).toBe(true);
  });

  it('skips feasibility check for escalated plans', async () => {
    mockCallLLM.mockResolvedValue(buildLLMResponse({
      ...buildValidPlan(),
      escalation_needed: true,
      escalation_reason: 'Needs founder approval'
    }));

    await decomposition.decomposeProject({
      projectId: 1, missionId: 10,
      directive: 'Something big', frasierAgentId: 'frasier-001'
    });

    // Only 1 LLM call (decomposition). Escalated plans skip feasibility + step creation.
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });
});
