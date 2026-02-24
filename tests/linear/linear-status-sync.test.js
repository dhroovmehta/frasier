// Linear Status Sync + Revision Cap Tests (TDD — written BEFORE implementation)
// Tests for v0.9.1 fixes:
//   Fix 1: Lazy Linear cache init (worker process never initializes Linear)
//   Fix 2: 3-strike revision cap (prevent infinite review loops)
//   Fix 3: Dependency linking in Linear
//   Fix 4: failStep syncs "Canceled" to Linear

const createMockSupabase = require('../mocks/supabase');
const { makeStep, makeMission, makeDependency, resetIdCounter } = require('../helpers');

// Set up mocks BEFORE requiring modules
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const mockCallLLM = jest.fn();
jest.mock('../../src/lib/models', () => ({
  callLLM: mockCallLLM,
  MODELS: {
    tier1: { name: 'minimax', tier: 'tier1', maxTokens: 4096 },
    tier2: { name: 'claude-sonnet', tier: 'tier2', maxTokens: 8192 },
    tier3: { name: 'claude-opus', tier: 'tier3', maxTokens: 4096 }
  }
}));

// Mock fetch for Linear GraphQL calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

const linear = require('../../src/lib/linear');
const missions = require('../../src/lib/missions');

// ============================================================
// TEST DATA FACTORIES
// ============================================================

function makeLinearGraphQLResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data })
  };
}

/**
 * Set up mock fetch responses for ensureInitialized().
 * Returns all workflow states and labels pre-existing so no creation calls needed.
 */
function setupInitResponses() {
  // 1. ensureWorkflowStatesExist — query team states
  mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
    team: { states: { nodes: [
      { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
      { id: 'state-in-progress', name: 'In Progress', type: 'started' },
      { id: 'state-in-review', name: 'In Review', type: 'started' },
      { id: 'state-done', name: 'Done', type: 'completed' },
      { id: 'state-canceled', name: 'Canceled', type: 'cancelled' }
    ]}}
  }));

  // 2. ensureLabelsExist — query existing labels (all present, no creations)
  const allLabels = [
    'Frasier', 'Gendo', 'Sahaquiel', 'Toji', 'Kaworu', 'Ritsuko',
    'Armisael', 'Shamshel', 'Zechs', 'Zeruel', 'Jet', 'Rei',
    'Research', 'Strategy', 'Content', 'Engineering', 'QA', 'Marketing', 'Knowledge',
    'frasier-managed'
  ].map((name, i) => ({ id: `label-${name.toLowerCase()}`, name }));

  mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
    issueLabels: { nodes: allLabels }
  }));
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  resetIdCounter();
  mockSupabase.__reset();
  mockCallLLM.mockReset();
  mockFetch.mockReset();
  process.env.LINEAR_API_KEY = 'lin_test_key_123';
  process.env.LINEAR_TEAM_ID = 'team-uuid-123';
  linear.__resetCache();
  linear.__resetInitialized();
});

afterEach(() => {
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_TEAM_ID;
});

// ============================================================
// FIX 1: Lazy Linear cache initialization
// WHY: Worker process never calls initialize() — cache stays empty,
// so every updateIssueStatus() fails with "Unknown workflow state."
// ============================================================

describe('Fix 1: Lazy Linear cache init', () => {
  test('ensureInitialized() populates workflowStates and labels on first call', async () => {
    setupInitResponses();

    await linear.ensureInitialized();

    // Verify: 2 fetch calls (workflow states query + labels query)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify cache is populated by using updateIssueStatus
    // (which reads from cache.workflowStates)
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueUpdate: { success: true, issue: { id: 'issue-uuid-1', state: { name: 'In Progress' } } }
    }));

    const result = await linear.updateIssueStatus(101, 'In Progress');
    // Should succeed because cache.workflowStates['In Progress'] exists
    expect(result).not.toBeNull();
  });

  test('ensureInitialized() is idempotent — second call is a no-op', async () => {
    setupInitResponses();

    await linear.ensureInitialized();
    const callCountAfterFirst = mockFetch.mock.calls.length;

    // Second call should NOT make any additional fetch calls
    await linear.ensureInitialized();
    expect(mockFetch.mock.calls.length).toBe(callCountAfterFirst);
  });

  test('updateIssueStatus() auto-initializes when cache is empty', async () => {
    // Don't call ensureInitialized — let updateIssueStatus trigger it
    setupInitResponses();

    // Seed linear_sync so getLinearIssueId returns a result
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    // Mock the actual issueUpdate mutation (after init responses)
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueUpdate: { success: true, issue: { id: 'issue-uuid-1', state: { name: 'In Progress' } } }
    }));

    const result = await linear.updateIssueStatus(101, 'In Progress');

    // Should succeed — ensureInitialized populated the cache automatically
    expect(result).not.toBeNull();
    // 2 init calls + 1 update = 3 total
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('syncStepToLinear() auto-initializes and applies labels', async () => {
    // Don't call ensureInitialized — let syncStepToLinear trigger it
    setupInitResponses();

    const step = makeStep({
      id: 101, mission_id: 42,
      description: 'Research competitors',
      assigned_agent_id: 'agent-sahaquiel-123'
    });

    // Seed parent project in linear_sync
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'project', entity_id: 'proj-uuid-1',
      mission_id: 42, sync_type: 'mission_to_project', status: 'synced'
    }]);

    // Mock LLM polish
    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "Competitor Analysis", "description": "Analyze top competitors."}',
      error: null
    });

    // Mock issue creation (after init responses)
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueCreate: {
        success: true,
        issue: { id: 'issue-uuid-1', identifier: 'FRA-1', url: 'https://linear.app/frasier/issue/FRA-1' }
      }
    }));

    const result = await linear.syncStepToLinear(step);

    // Should succeed — auto-initialized cache populated labels
    expect(result).not.toBeNull();
    expect(result.id).toBe('issue-uuid-1');

    // Verify labels were applied (check the issueCreate mutation input)
    const issueCreateCall = mockFetch.mock.calls[2]; // init(2) + issueCreate(1)
    const body = JSON.parse(issueCreateCall[1].body);
    const labelIds = body.variables.input.labelIds || [];
    // Should have at least the Research label and frasier-managed label
    expect(labelIds.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// FIX 2: 3-strike revision cap
// WHY: No revision cap exists — QA can reject indefinitely, creating
// an infinite review loop. After 3 rejections, fail the step and
// alert the founder with Linear ticket links.
// ============================================================

describe('Fix 2: 3-strike revision cap', () => {
  test('countStepRejections() returns correct count of past rejections', async () => {
    mockSupabase.__setData('approval_chain', [
      { id: 1, mission_step_id: 101, status: 'rejected', feedback: 'Bad research' },
      { id: 2, mission_step_id: 101, status: 'rejected', feedback: 'Still incomplete' },
      { id: 3, mission_step_id: 101, status: 'approved', feedback: 'Looks good' }, // not counted
      { id: 4, mission_step_id: 999, status: 'rejected', feedback: 'Different step' } // different step
    ]);

    const count = await missions.countStepRejections(101);
    expect(count).toBe(2);
  });

  test('countStepRejections() returns 0 when no rejections exist', async () => {
    mockSupabase.__setData('approval_chain', []);

    const count = await missions.countStepRejections(101);
    expect(count).toBe(0);
  });

  test('addIssueComment() posts formatted rejection feedback to Linear', async () => {
    // Pre-initialize cache so ensureInitialized is a no-op
    setupInitResponses();
    await linear.ensureInitialized();
    mockFetch.mockReset(); // Clear init fetch calls, start fresh for this test

    // Seed linear_sync with issue record
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    // Mock comment creation
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      commentCreate: { success: true, comment: { id: 'comment-uuid-1' } }
    }));

    const rejectionFeedback = '**Rejection #2**\nThe research lacks competitor pricing data and market size estimates.';
    const result = await linear.addIssueComment(101, rejectionFeedback);

    expect(result).not.toBeNull();

    // Verify the comment body contains the rejection feedback
    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.variables.input.body).toContain('Rejection #2');
    expect(body.variables.input.body).toContain('competitor pricing');
  });
});

// ============================================================
// FIX 3: Dependency linking in Linear
// WHY: Decomposed projects create issues but don't link them.
// Linear should show blocking/blocked relationships between tasks.
// ============================================================

describe('Fix 3: Dependency linking', () => {
  test('createDependencyRelations() creates blocking relations between issues', async () => {
    // Mission 42 has 3 steps: step 201 → step 202 → step 203
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 201, mission_id: 42 }),
      makeStep({ id: 202, mission_id: 42 }),
      makeStep({ id: 203, mission_id: 42 })
    ]);

    // Step 202 depends on 201; Step 203 depends on 202
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 202, depends_on_step_id: 201 }),
      makeDependency({ step_id: 203, depends_on_step_id: 202 })
    ]);

    // Linear sync records for each step
    mockSupabase.__setData('linear_sync', [
      { id: 1, entity_type: 'issue', entity_id: 'issue-201', mission_step_id: 201, sync_type: 'step_to_issue', status: 'synced' },
      { id: 2, entity_type: 'issue', entity_id: 'issue-202', mission_step_id: 202, sync_type: 'step_to_issue', status: 'synced' },
      { id: 3, entity_type: 'issue', entity_id: 'issue-203', mission_step_id: 203, sync_type: 'step_to_issue', status: 'synced' }
    ]);

    // Mock 2 issueRelationCreate mutations (one per dependency)
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueRelationCreate: { success: true }
    }));
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueRelationCreate: { success: true }
    }));

    const result = await linear.createDependencyRelations(42);

    expect(result).not.toBeNull();
    expect(result.created).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify first relation: issue-202 blocked by issue-201
    const call1 = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(call1.variables.input.issueId).toBe('issue-202');
    expect(call1.variables.input.relatedIssueId).toBe('issue-201');
    expect(call1.variables.input.type).toBe('blocks');
  });

  test('createDependencyRelations() handles missing sync records gracefully', async () => {
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 301, mission_id: 50 }),
      makeStep({ id: 302, mission_id: 50 })
    ]);

    // Dependency exists but one step has no Linear sync record
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 302, depends_on_step_id: 301 })
    ]);

    // Only step 302 has a sync record — step 301 is missing
    mockSupabase.__setData('linear_sync', [
      { id: 1, entity_type: 'issue', entity_id: 'issue-302', mission_step_id: 302, sync_type: 'step_to_issue', status: 'synced' }
    ]);

    const result = await linear.createDependencyRelations(50);

    // Should return 0 created, no errors thrown
    expect(result).not.toBeNull();
    expect(result.created).toBe(0);
    // No fetch calls since we can't create a relation with a missing issue
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// FIX 4: failStep → Linear "Canceled"
// WHY: When a step fails (including revision cap), the Linear issue
// should move to "Canceled" state so Dhroov sees it in the board.
// ============================================================

describe('Fix 4: failStep → Linear Canceled', () => {
  test('failStep() syncs Canceled status to Linear', async () => {
    // Seed mission_steps with the step to fail
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 101, mission_id: 42, status: 'in_review' })
    ]);

    // Spy on linear.updateIssueStatus to verify it's called
    const spy = jest.spyOn(linear, 'updateIssueStatus').mockResolvedValue(null);

    await missions.failStep(101, 'Revision cap reached (3 rejections)');

    // Verify step was marked as failed in DB
    const steps = mockSupabase.__getData('mission_steps');
    const failedStep = steps.find(s => s.id === 101);
    expect(failedStep.status).toBe('failed');
    expect(failedStep.result).toContain('Revision cap reached');

    // Verify Linear sync was called with Canceled
    expect(spy).toHaveBeenCalledWith(101, 'Canceled');

    spy.mockRestore();
  });
});
