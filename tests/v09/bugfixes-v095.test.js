// tests/v09/bugfixes-v095.test.js — Bug fixes for v0.9.5
// TDD: Tests define the contract BEFORE implementation.
//
// Bug 1 (CRITICAL): createStepsFromPlan passes snake_case params to createStep (expects camelCase)
//   → Steps created with mission_id=undefined, assigned_agent_id=null(default)
// Bug 2 (HIGH): ensureInitialized sets initialized=true even when API call silently fails
//   → Workflow states cache empty forever, all status updates fail
// Bug 3 (MEDIUM): classifyMessage passes agentId:'frasier' to callLLM → FK violation in model_usage
//   → 'frasier' is not a valid agent ID in the agents table
// Bug 4 (MEDIUM): decomposeProject saves approach_memory with missionStepId:0 → FK violation
//   → Step #0 doesn't exist in mission_steps table

const createMockSupabase = require('../mocks/supabase');
const { resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

beforeEach(() => {
  mockSupabase.__reset();
  jest.clearAllMocks();
  resetIdCounter();
});

// ============================================================
// BUG 1: createStepsFromPlan — snake_case vs camelCase params
// ============================================================
// WHY: decomposition.js line 247 calls missions.createStep() with snake_case
// params (mission_id, assigned_agent_id, model_tier, step_order), but
// createStep() at missions.js line 339 destructures camelCase (missionId,
// assignedAgentId, modelTier, stepOrder). JavaScript destructuring silently
// sets unmatched params to undefined → defaults apply.

describe('Bug 1: createStepsFromPlan passes correct param names to createStep', () => {
  let decomposition;

  beforeEach(() => {
    jest.resetModules();

    // WHY doMock: jest.mock is hoisted by babel-jest, which breaks jest.resetModules().
    // doMock runs in order, so the mock is registered AFTER module reset.
    jest.doMock('../../src/lib/supabase', () => global.__mockSupabase);
    jest.doMock('../../src/lib/models', () => require('../mocks/models'));
    jest.doMock('../../src/lib/events', () => ({
      logEvent: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/projects', () => ({
      linkMissionToProject: jest.fn().mockResolvedValue(null),
      checkPhaseCompletion: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/linear', () => ({
      syncMissionToLinear: jest.fn().mockResolvedValue(null),
      syncStepToLinear: jest.fn().mockResolvedValue(null),
      updateIssueStatus: jest.fn().mockResolvedValue(null),
      updateIssueCustomField: jest.fn().mockResolvedValue(null),
      addIssueComment: jest.fn().mockResolvedValue(null),
      syncCritiqueScore: jest.fn().mockResolvedValue(null),
      syncDecomposedProjectToLinear: jest.fn().mockResolvedValue(null),
      createDependencyRelations: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/approach_memory', () => ({
      findSimilar: jest.fn().mockResolvedValue([]),
      formatForPrompt: jest.fn().mockReturnValue(''),
      save: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/agents', () => ({
      findBestAgentAcrossTeams: jest.fn().mockResolvedValue({ id: 'agent-test-123' }),
      autoHireGapAgent: jest.fn().mockResolvedValue(null)
    }));

    // Load real decomposition.js + missions.js (missions.js uses mocked linear/events/supabase)
    decomposition = require('../../src/lib/decomposition');
  });

  test('createStepsFromPlan should insert mission_id correctly (not undefined)', async () => {
    const MISSION_ID = 77;
    const plan = {
      tasks: [{
        id: 'T1',
        description: 'Research competitors',
        required_role: 'research',
        parallel_group: 1,
        depends_on: [],
        acceptance_criteria: 'Deliver a competitive analysis'
      }]
    };
    const agentMap = { research: 'agent-sahaquiel-123' };

    await decomposition.createStepsFromPlan(MISSION_ID, plan, agentMap);

    const rows = mockSupabase.__getData('mission_steps');
    expect(rows.length).toBe(1);
    // Before fix: mission_id is undefined (snake_case key doesn't match camelCase param)
    // After fix: mission_id is 77
    expect(rows[0].mission_id).toBe(MISSION_ID);
  });

  test('createStepsFromPlan should insert assigned_agent_id correctly (not null default)', async () => {
    const MISSION_ID = 77;
    const AGENT_ID = 'agent-sahaquiel-123';
    const plan = {
      tasks: [{
        id: 'T1',
        description: 'Research competitors',
        required_role: 'research',
        parallel_group: 1,
        depends_on: [],
        acceptance_criteria: 'Deliver analysis'
      }]
    };
    const agentMap = { research: AGENT_ID };

    await decomposition.createStepsFromPlan(MISSION_ID, plan, agentMap);

    const rows = mockSupabase.__getData('mission_steps');
    expect(rows.length).toBe(1);
    // Before fix: assigned_agent_id is null (default) because assignedAgentId param unmatched
    // After fix: assigned_agent_id is the correct agent ID
    expect(rows[0].assigned_agent_id).toBe(AGENT_ID);
  });

  test('createStepsFromPlan should insert model_tier=tier2 and step_order=parallel_group', async () => {
    const MISSION_ID = 77;
    const plan = {
      tasks: [{
        id: 'T1',
        description: 'Task 1',
        required_role: 'research',
        parallel_group: 2,
        depends_on: [],
        acceptance_criteria: 'Done'
      }]
    };
    const agentMap = { research: 'agent-test-123' };

    await decomposition.createStepsFromPlan(MISSION_ID, plan, agentMap);

    const rows = mockSupabase.__getData('mission_steps');
    // Before fix: model_tier is 'tier1' (default), step_order is 0 (default)
    // After fix: model_tier is 'tier2', step_order is 2
    expect(rows[0].model_tier).toBe('tier2');
    expect(rows[0].step_order).toBe(2);
  });
});

// ============================================================
// BUG 2: ensureInitialized — must validate cache before declaring success
// ============================================================
// WHY: ensureInitialized() calls ensureWorkflowStatesExist() which calls
// linearRequest(). If the API call fails, the function silently returns
// without populating cache. But initialized is set to true unconditionally,
// preventing retry. All subsequent updateIssueStatus() calls fail with
// "Unknown workflow state" because the cache is empty forever.

describe('Bug 2: ensureInitialized validates cache before setting initialized=true', () => {
  let linear;

  beforeEach(() => {
    jest.resetModules();

    jest.doMock('../../src/lib/supabase', () => global.__mockSupabase);
    jest.doMock('../../src/lib/models', () => require('../mocks/models'));
    // WHY: Bug 1's doMock for linear persists in the mock registry. Override it
    // with requireActual so we get the REAL linear.js (its internal require('./supabase')
    // and require('./models') still route through our doMock'd versions above).
    jest.doMock('../../src/lib/linear', () => jest.requireActual('../../src/lib/linear'));

    // Mock fetch globally for Linear API calls
    global.fetch = jest.fn();

    // Load REAL linear.js — fresh module with clean state (initialized=false, cache=null)
    linear = require('../../src/lib/linear');

    process.env.LINEAR_API_KEY = 'test-key';
    process.env.LINEAR_TEAM_ID = 'test-team-id';
  });

  afterEach(() => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_TEAM_ID;
    delete global.fetch;
  });

  // WHY helper: ensureWorkflowStatesExist creates "In Review" if missing (extra fetch),
  // and ensureLabelsExist creates each missing label (extra fetch per label). To keep
  // fetch count predictable, mock responses include all expected states and labels.
  function makeWorkflowStatesResponse() {
    return {
      ok: true,
      json: () => Promise.resolve({
        data: {
          team: {
            states: { nodes: [
              { id: 'state-1', name: 'In Progress', type: 'started' },
              { id: 'state-2', name: 'Done', type: 'completed' },
              { id: 'state-3', name: 'In Review', type: 'started' }  // Prevents creation mutation
            ] }
          }
        }
      })
    };
  }

  function makeLabelsResponse() {
    // All 20 labels pre-existing so no creation mutations fire
    const allLabels = [
      'Frasier', 'Gendo', 'Sahaquiel', 'Toji', 'Kaworu', 'Ritsuko',
      'Armisael', 'Shamshel', 'Zechs', 'Zeruel', 'Jet', 'Rei',
      'Research', 'Strategy', 'Content', 'Engineering', 'QA', 'Marketing', 'Knowledge',
      'frasier-managed'
    ];
    return {
      ok: true,
      json: () => Promise.resolve({
        data: { issueLabels: { nodes: allLabels.map((name, i) => ({ id: `label-${i}`, name })) } }
      })
    };
  }

  test('ensureInitialized should retry on next call if workflow states fetch failed', async () => {
    // First call: API fails (both workflow states + labels)
    global.fetch.mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve('API Error')
    });
    global.fetch.mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve('API Error')
    });

    await linear.ensureInitialized();

    // Second call: API succeeds (all states + labels present → exactly 2 fetches)
    global.fetch.mockResolvedValueOnce(makeWorkflowStatesResponse());
    global.fetch.mockResolvedValueOnce(makeLabelsResponse());

    await linear.ensureInitialized();

    // If bug exists: initialized=true after first call, second call skipped → fetch called 2 times
    // If fixed: initialized stays false after failure, second call retries → fetch called 4 times
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  test('ensureInitialized should set initialized=true only when cache is populated', async () => {
    // API returns valid workflow states and all labels
    global.fetch.mockResolvedValueOnce(makeWorkflowStatesResponse());
    global.fetch.mockResolvedValueOnce(makeLabelsResponse());

    await linear.ensureInitialized();

    // Third call should NOT trigger API (already initialized successfully)
    await linear.ensureInitialized();
    expect(global.fetch).toHaveBeenCalledTimes(2); // Only from first successful init
  });
});

// ============================================================
// BUG 3: logModelUsage should sanitize non-agent caller IDs
// ============================================================
// WHY: classifyMessage() at discord_bot.js:153 passes agentId: 'frasier'
// (a string literal). This reaches logModelUsage() which inserts into
// model_usage table. The agent_id column has a FK to agents(id).
// 'frasier' is not a valid agent ID — real IDs start with 'agent-'.
// The sanitization only catches 'system', not other invalid strings.
//
// Testing through callLLM with mocked fetch (OpenRouter) to exercise the
// full code path: callLLM → logModelUsage → Supabase insert.

describe('Bug 3: logModelUsage handles non-agent caller IDs', () => {
  let models;

  beforeEach(() => {
    jest.resetModules();

    jest.doMock('../../src/lib/supabase', () => global.__mockSupabase);
    // WHY: Override any prior doMock for models — we need the REAL models.js
    // to test the actual logModelUsage sanitization logic.
    jest.doMock('../../src/lib/models', () => jest.requireActual('../../src/lib/models'));

    // Mock fetch for OpenRouter API calls
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'test response' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      })
    });

    process.env.OPENROUTER_API_KEY = 'test-key';

    // Load REAL models.js to test logModelUsage behavior
    models = require('../../src/lib/models');
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete global.fetch;
  });

  test('callLLM with agentId=frasier should sanitize to null in model_usage', async () => {
    await models.callLLM({
      systemPrompt: 'You are a classifier.',
      userMessage: 'Classify this message.',
      agentId: 'frasier',  // Not a valid agent ID
      missionStepId: null,
      forceTier: 'tier1'
    });

    const rows = mockSupabase.__getData('model_usage');
    expect(rows.length).toBe(1);
    // Before fix: agent_id is 'frasier' (only 'system' was sanitized)
    // After fix: agent_id is null (non-UUID agent IDs sanitized)
    expect(rows[0].agent_id).toBeNull();
  });

  test('callLLM with valid agent ID should keep it in model_usage', async () => {
    await models.callLLM({
      systemPrompt: 'You are a research analyst.',
      userMessage: 'Research the market.',
      agentId: 'agent-sahaquiel-1770840215198',
      missionStepId: 82,
      forceTier: 'tier1'
    });

    const rows = mockSupabase.__getData('model_usage');
    expect(rows[0].agent_id).toBe('agent-sahaquiel-1770840215198');
  });

  test('callLLM with agentId=system should sanitize to null in model_usage', async () => {
    await models.callLLM({
      systemPrompt: 'Polish this title.',
      userMessage: 'Make it better.',
      agentId: 'system',
      missionStepId: null,
      forceTier: 'tier1'
    });

    const rows = mockSupabase.__getData('model_usage');
    expect(rows[0].agent_id).toBeNull();
  });
});

// ============================================================
// BUG 4: decomposeProject saves approach_memory with missionStepId: 0
// ============================================================
// WHY: decomposition.js line 168 passes missionStepId: 0 to approachMemory.save().
// The approach_memory table has a FK constraint on mission_step_id → mission_steps(id).
// Step #0 doesn't exist. This should be null — decomposition-level approach memory
// is not tied to a specific step.

describe('Bug 4: decomposeProject saves approach_memory with null missionStepId', () => {
  let decomposition, approachMemory;

  beforeEach(() => {
    jest.resetModules();

    jest.doMock('../../src/lib/supabase', () => global.__mockSupabase);

    // Mock callLLM to return a valid decomposition plan
    const planJson = JSON.stringify({
      tasks: [{
        id: 'T1',
        description: 'Research task',
        required_role: 'research',
        parallel_group: 1,
        depends_on: [],
        acceptance_criteria: 'Done'
      }],
      end_state: 'production_docs',
      escalation_needed: false,
      hiring_needed: []
    });
    jest.doMock('../../src/lib/models', () => ({
      callLLM: jest.fn().mockResolvedValue({
        content: planJson,
        model: 'mock',
        tier: 'tier2',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        error: null
      }),
      selectTier: jest.fn().mockReturnValue('tier2'),
      getModelCosts: jest.fn(),
      MODELS: {},
      COMPLEX_KEYWORDS: [],
      TIER3_KEYWORDS: []
    }));

    jest.doMock('../../src/lib/events', () => ({
      logEvent: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/projects', () => ({
      linkMissionToProject: jest.fn().mockResolvedValue(null),
      checkPhaseCompletion: jest.fn().mockResolvedValue(null)
    }));
    jest.doMock('../../src/lib/linear', () => ({
      syncMissionToLinear: jest.fn().mockResolvedValue(null),
      syncStepToLinear: jest.fn().mockResolvedValue(null),
      updateIssueStatus: jest.fn().mockResolvedValue(null),
      updateIssueCustomField: jest.fn().mockResolvedValue(null),
      addIssueComment: jest.fn().mockResolvedValue(null),
      syncCritiqueScore: jest.fn().mockResolvedValue(null),
      syncDecomposedProjectToLinear: jest.fn().mockResolvedValue(null),
      createDependencyRelations: jest.fn().mockResolvedValue(null)
    }));

    approachMemory = {
      findSimilar: jest.fn().mockResolvedValue([]),
      formatForPrompt: jest.fn().mockReturnValue(''),
      save: jest.fn().mockResolvedValue(null)
    };
    jest.doMock('../../src/lib/approach_memory', () => approachMemory);

    jest.doMock('../../src/lib/agents', () => ({
      findBestAgentAcrossTeams: jest.fn().mockResolvedValue({ id: 'agent-test-123' }),
      autoHireGapAgent: jest.fn().mockResolvedValue(null)
    }));

    decomposition = require('../../src/lib/decomposition');
  });

  test('decomposeProject should pass null missionStepId to approachMemory.save, not 0', async () => {
    // Set up Supabase data needed by decomposeProject
    mockSupabase.__setData('agents', [
      { id: 'agent-test-123', display_name: 'TestAgent', role: 'Research Analyst', status: 'active' }
    ]);
    // Mission row for the Linear sync fetch inside decomposeProject
    mockSupabase.__setData('missions', [{ id: 77, title: 'Test Mission', description: 'Test desc' }]);

    const result = await decomposition.decomposeProject({
      projectId: 3,
      missionId: 77,
      directive: 'Build a landing page for MemoBot',
      frasierAgentId: 'agent-frasier-123'
    });

    expect(result.error).toBeNull();
    expect(approachMemory.save).toHaveBeenCalledTimes(1);
    const saveCall = approachMemory.save.mock.calls[0][0];
    // Before fix: missionStepId is 0 (hardcoded — FK violation)
    // After fix: missionStepId is null (no specific step for decomposition-level memory)
    expect(saveCall.missionStepId).toBeNull();
    expect(saveCall.missionStepId).not.toBe(0);
  });
});
