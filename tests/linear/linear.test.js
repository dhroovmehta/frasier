// Linear Integration Tests (TDD — written BEFORE implementation)
// Tests the Linear API client, sync logic, and LLM title polishing.
//
// WHY: The Linear integration is a two-way sync layer. These tests define
// expected behavior so we can build linear.js against a clear contract.

const createMockSupabase = require('../mocks/supabase');
const { makeMission, makeStep, resetIdCounter } = require('../helpers');

// Set up mocks BEFORE requiring linear
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock models.js — we control LLM responses for title polishing
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

function makeLinearErrorResponse(status, message) {
  return {
    ok: false,
    status,
    json: async () => ({ errors: [{ message }] }),
    text: async () => message
  };
}

function makeGraphQLErrorResponse(errors) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ errors }),
    text: async () => JSON.stringify({ errors })
  };
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  resetIdCounter();
  mockSupabase.__reset();
  mockCallLLM.mockReset();
  mockFetch.mockReset();
  // Default: LINEAR_API_KEY is set
  process.env.LINEAR_API_KEY = 'lin_test_key_123';
  process.env.LINEAR_TEAM_ID = 'team-uuid-123';
  // Reset linear module's internal cache and mark as initialized
  // WHY: These tests focus on individual API functions, not the lazy init
  // behavior (tested in linear-status-sync.test.js). Setting cache to {}
  // with initialized=true prevents ensureInitialized() from consuming
  // mock fetch responses intended for the actual test.
  linear.__resetCache();
  linear.__setCache({});
});

afterEach(() => {
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_TEAM_ID;
});

// ============================================================
// linearRequest()
// ============================================================

describe('linearRequest()', () => {
  test('sends correct headers (Authorization without Bearer prefix)', async () => {
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({ test: true }));

    await linear.linearRequest('query { viewer { id } }');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'lin_test_key_123'
        }
      })
    );
  });

  test('returns data on success', async () => {
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({ viewer: { id: 'abc' } }));

    const result = await linear.linearRequest('query { viewer { id } }');
    expect(result).toEqual({ viewer: { id: 'abc' } });
  });

  test('returns null on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(makeLinearErrorResponse(500, 'Internal Server Error'));

    const result = await linear.linearRequest('query { viewer { id } }');
    expect(result).toBeNull();
  });

  test('returns null on GraphQL errors', async () => {
    mockFetch.mockResolvedValueOnce(makeGraphQLErrorResponse([{ message: 'Field not found' }]));

    const result = await linear.linearRequest('query { viewer { id } }');
    expect(result).toBeNull();
  });

  test('returns null when LINEAR_API_KEY is not set', async () => {
    delete process.env.LINEAR_API_KEY;

    const result = await linear.linearRequest('query { viewer { id } }');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// polishTitleAndDescription()
// ============================================================

describe('polishTitleAndDescription()', () => {
  test('calls tier-1 LLM and returns parsed title + description', async () => {
    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "AI Newsletter Landscape Analysis", "description": "Research top AI newsletters, tools, and strategies."}',
      error: null
    });

    const result = await linear.polishTitleAndDescription('look into what newsletters are doing well in the ai space');

    expect(mockCallLLM).toHaveBeenCalledWith(expect.objectContaining({
      forceTier: 'tier1'
    }));
    expect(result.title).toBe('AI Newsletter Landscape Analysis');
    expect(result.description).toBe('Research top AI newsletters, tools, and strategies.');
  });

  test('handles LLM failure gracefully (returns truncated raw text)', async () => {
    mockCallLLM.mockResolvedValueOnce({ content: null, error: 'LLM timeout' });

    const rawText = 'look into what newsletters are doing well in the ai space';
    const result = await linear.polishTitleAndDescription(rawText);

    expect(result.title).toBe(rawText.substring(0, 80));
    expect(result.description).toBe(rawText.substring(0, 500));
  });

  test('handles non-JSON LLM response gracefully', async () => {
    mockCallLLM.mockResolvedValueOnce({
      content: 'Here is a nice title for you: AI Newsletter Analysis',
      error: null
    });

    const rawText = 'look into newsletters';
    const result = await linear.polishTitleAndDescription(rawText);

    // Falls back to raw text truncation
    expect(result.title).toBeTruthy();
    expect(result.description).toBeTruthy();
  });
});

// ============================================================
// syncMissionToLinear()
// ============================================================

describe('syncMissionToLinear()', () => {
  test('creates Linear project and saves to linear_sync', async () => {
    const mission = makeMission({ id: 42, title: 'Test Mission', description: 'Test description' });

    // Mock LLM polish
    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "Polished Mission Title", "description": "Polished description."}',
      error: null
    });

    // Mock project creation
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      projectCreate: {
        success: true,
        project: { id: 'proj-uuid-1', url: 'https://linear.app/frasier/project/proj-1', slugId: 'proj-1' }
      }
    }));

    const result = await linear.syncMissionToLinear(mission);

    expect(result).not.toBeNull();
    expect(result.id).toBe('proj-uuid-1');

    // Verify linear_sync record was created
    const syncRows = mockSupabase.__getData('linear_sync');
    expect(syncRows.length).toBe(1);
    expect(syncRows[0].entity_type).toBe('project');
    expect(syncRows[0].entity_id).toBe('proj-uuid-1');
    expect(syncRows[0].mission_id).toBe(42);
    expect(syncRows[0].sync_type).toBe('mission_to_project');
  });

  test('returns null when API key is missing', async () => {
    delete process.env.LINEAR_API_KEY;
    const mission = makeMission({ id: 1 });

    const result = await linear.syncMissionToLinear(mission);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// syncStepToLinear()
// ============================================================

describe('syncStepToLinear()', () => {
  test('creates Linear issue with labels and saves to linear_sync', async () => {
    const step = makeStep({ id: 101, mission_id: 42, description: 'Research competitors', assigned_agent_id: 'sahaquiel' });

    // Seed linear_sync with the parent project
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'project', entity_id: 'proj-uuid-1',
      entity_url: 'https://linear.app/frasier/project/proj-1',
      mission_id: 42, sync_type: 'mission_to_project', status: 'synced'
    }]);

    // Mock LLM polish
    mockCallLLM.mockResolvedValueOnce({
      content: '{"title": "Competitor Analysis", "description": "Analyze top competitors."}',
      error: null
    });

    // Mock issue creation
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueCreate: {
        success: true,
        issue: { id: 'issue-uuid-1', identifier: 'FRA-1', url: 'https://linear.app/frasier/issue/FRA-1' }
      }
    }));

    const result = await linear.syncStepToLinear(step);

    expect(result).not.toBeNull();
    expect(result.id).toBe('issue-uuid-1');

    // Verify linear_sync record
    const syncRows = mockSupabase.__getData('linear_sync');
    const issueSync = syncRows.find(r => r.entity_type === 'issue');
    expect(issueSync).toBeTruthy();
    expect(issueSync.entity_id).toBe('issue-uuid-1');
    expect(issueSync.mission_step_id).toBe(101);
    expect(issueSync.sync_type).toBe('step_to_issue');
  });

  test('returns null when API key is missing', async () => {
    delete process.env.LINEAR_API_KEY;
    const step = makeStep({ id: 1 });

    const result = await linear.syncStepToLinear(step);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// updateIssueStatus()
// ============================================================

describe('updateIssueStatus()', () => {
  test('looks up linear_sync by step ID and sends mutation', async () => {
    // Seed linear_sync with an issue record
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    // Pre-cache workflow states
    linear.__setCache({
      workflowStates: { 'In Progress': 'state-in-progress-uuid' }
    });

    // Mock issue update
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueUpdate: { success: true, issue: { id: 'issue-uuid-1', state: { name: 'In Progress' } } }
    }));

    const result = await linear.updateIssueStatus(101, 'In Progress');
    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalled();
  });

  test('returns null when no sync record exists', async () => {
    mockSupabase.__setData('linear_sync', []);

    const result = await linear.updateIssueStatus(999, 'In Progress');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// updateIssueCustomField()
// ============================================================

describe('updateIssueCustomField()', () => {
  test('sends correct mutation for numeric field (Self-Critique Score)', async () => {
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    linear.__setCache({
      customFields: { 'Self-Critique Score': 'cf-score-uuid' }
    });

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueUpdate: { success: true }
    }));

    const result = await linear.updateIssueCustomField(101, 'Self-Critique Score', 4.2);
    expect(result).not.toBeNull();
  });

  test('sends correct mutation for date field (Started At)', async () => {
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    linear.__setCache({
      customFields: { 'Started At': 'cf-started-uuid' }
    });

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueUpdate: { success: true }
    }));

    const result = await linear.updateIssueCustomField(101, 'Started At', '2026-02-23T14:30:00Z');
    expect(result).not.toBeNull();
  });
});

// ============================================================
// addIssueComment()
// ============================================================

describe('addIssueComment()', () => {
  test('posts comment text on the correct issue', async () => {
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      commentCreate: { success: true, comment: { id: 'comment-uuid-1' } }
    }));

    const result = await linear.addIssueComment(101, 'Deliverable: https://drive.google.com/doc/abc');
    expect(result).not.toBeNull();

    // Verify the fetch body contains the comment text
    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.variables.input.body).toContain('https://drive.google.com/doc/abc');
  });
});

// ============================================================
// completeProject() / cancelProject()
// ============================================================

describe('completeProject() / cancelProject()', () => {
  test('completeProject looks up project and sends completed state', async () => {
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'project', entity_id: 'proj-uuid-1',
      mission_id: 42, sync_type: 'mission_to_project', status: 'synced'
    }]);

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      projectUpdate: { success: true }
    }));

    const result = await linear.completeProject(42);
    expect(result).not.toBeNull();
  });

  test('cancelProject looks up project and sends canceled state', async () => {
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'project', entity_id: 'proj-uuid-1',
      mission_id: 42, sync_type: 'mission_to_project', status: 'synced'
    }]);

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      projectUpdate: { success: true }
    }));

    const result = await linear.cancelProject(42);
    expect(result).not.toBeNull();
  });

  test('returns null when no project sync record exists', async () => {
    mockSupabase.__setData('linear_sync', []);

    const result = await linear.completeProject(999);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// syncCritiqueScore()
// ============================================================

describe('syncCritiqueScore()', () => {
  test('fetches score from pipeline_phases and updates custom field', async () => {
    // Seed pipeline_phases with critique record
    mockSupabase.__setData('pipeline_phases', [{
      id: 1, mission_step_id: 101, phase_name: 'critique', score: 4.2
    }]);

    // Seed linear_sync
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'issue', entity_id: 'issue-uuid-1',
      mission_step_id: 101, sync_type: 'step_to_issue', status: 'synced'
    }]);

    linear.__setCache({
      customFields: { 'Self-Critique Score': 'cf-score-uuid' }
    });

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueUpdate: { success: true }
    }));

    await linear.syncCritiqueScore(101);

    expect(mockFetch).toHaveBeenCalled();
  });

  test('does nothing when no critique phase exists', async () => {
    mockSupabase.__setData('pipeline_phases', []);

    await linear.syncCritiqueScore(101);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// ensureLabelsExist()
// ============================================================

describe('ensureLabelsExist()', () => {
  test('creates all required labels (20 total: 12 agent + 7 work-type + 1 system)', async () => {
    // Mock: query existing labels (empty — all need creation)
    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueLabels: { nodes: [] }
    }));

    // Mock: each label creation (20 labels)
    for (let i = 0; i < 20; i++) {
      mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
        issueLabelCreate: { success: true, issueLabel: { id: `label-${i}`, name: `label-${i}` } }
      }));
    }

    await linear.ensureLabelsExist();

    // 1 query + 20 creates = 21 calls
    expect(mockFetch).toHaveBeenCalledTimes(21);
  });

  test('is idempotent — does not duplicate existing labels', async () => {
    // Mock: all labels already exist
    const existingLabels = [
      'Frasier', 'Gendo', 'Sahaquiel', 'Toji', 'Kaworu', 'Ritsuko',
      'Armisael', 'Shamshel', 'Zechs', 'Zeruel', 'Jet', 'Rei',
      'Research', 'Strategy', 'Content', 'Engineering', 'QA', 'Marketing', 'Knowledge',
      'frasier-managed'
    ].map((name, i) => ({ id: `label-${i}`, name }));

    mockFetch.mockResolvedValueOnce(makeLinearGraphQLResponse({
      issueLabels: { nodes: existingLabels }
    }));

    await linear.ensureLabelsExist();

    // Only 1 query, no creates
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Graceful degradation
// ============================================================

describe('graceful degradation', () => {
  test('all functions return null when LINEAR_API_KEY is not set', async () => {
    delete process.env.LINEAR_API_KEY;

    const mission = makeMission({ id: 1 });
    const step = makeStep({ id: 1 });

    expect(await linear.linearRequest('query { test }')).toBeNull();
    expect(await linear.syncMissionToLinear(mission)).toBeNull();
    expect(await linear.syncStepToLinear(step)).toBeNull();
    expect(await linear.updateIssueStatus(1, 'In Progress')).toBeNull();
    expect(await linear.updateIssueCustomField(1, 'Started At', 'now')).toBeNull();
    expect(await linear.addIssueComment(1, 'test')).toBeNull();
    expect(await linear.completeProject(1)).toBeNull();
    expect(await linear.cancelProject(1)).toBeNull();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('sync functions catch errors and never throw', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    const mission = makeMission({ id: 1 });

    // These should not throw
    const result = await linear.syncMissionToLinear(mission);
    expect(result).toBeNull();
  });
});

// ============================================================
// getProjectUrl()
// ============================================================

describe('getProjectUrl()', () => {
  test('returns project URL from linear_sync by mission ID', async () => {
    mockSupabase.__setData('linear_sync', [{
      id: 1, entity_type: 'project', entity_id: 'proj-uuid-1',
      entity_url: 'https://linear.app/frasier/project/proj-1',
      mission_id: 42, sync_type: 'mission_to_project', status: 'synced'
    }]);

    const url = await linear.getProjectUrl(42);
    expect(url).toBe('https://linear.app/frasier/project/proj-1');
  });

  test('returns null when no sync record exists', async () => {
    mockSupabase.__setData('linear_sync', []);

    const url = await linear.getProjectUrl(999);
    expect(url).toBeNull();
  });
});
