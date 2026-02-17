// Phase 3: Projects & Lifecycle Tests
// Tests for the new projects.js module that provides end-to-end project tracking.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';

const createMockSupabase = require('../mocks/supabase');
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const projects = require('../../src/lib/projects');

beforeEach(() => {
  mockSupabase.__reset();
});

// ============================================================
// PROJECT CREATION
// ============================================================

describe('createProject()', () => {
  test('creates project with default phase "discovery"', async () => {
    const project = await projects.createProject({
      name: 'Real Estate AI Agent',
      description: 'Build an AI agent for lead generation',
      originalMessage: 'Build me a Real Estate AI Agent for Lead Generation'
    });

    expect(project).toBeTruthy();
    expect(project.name).toBe('Real Estate AI Agent');
    expect(project.phase).toBe('discovery');
    expect(project.status).toBe('active');
  });

  test('stores original message', async () => {
    const project = await projects.createProject({
      name: 'Test Project',
      originalMessage: 'Zero said this'
    });

    expect(project.original_message).toBe('Zero said this');
  });
});

// ============================================================
// PHASE ADVANCEMENT
// ============================================================

describe('advanceProjectPhase()', () => {
  test('follows correct phase sequence', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Test', phase: 'discovery', status: 'active'
    }]);

    let result;

    result = await projects.advanceProjectPhase(1);
    expect(result.phase).toBe('requirements');

    // Manually update store for next test
    const data = mockSupabase.__getData('projects');
    data[0].phase = 'requirements';
    mockSupabase.__setData('projects', data);

    result = await projects.advanceProjectPhase(1);
    expect(result.phase).toBe('design');
  });

  test('cannot advance past "deploy" (final phase)', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Test', phase: 'deploy', status: 'active'
    }]);

    const result = await projects.advanceProjectPhase(1);
    expect(result.phase).toBe('completed');
    expect(result.status).toBe('completed');
  });

  test('cannot reverse phases', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Test', phase: 'design', status: 'active'
    }]);

    const result = await projects.setProjectPhase(1, 'discovery');
    expect(result).toBeNull(); // Should reject going backwards
  });
});

// ============================================================
// MISSION LINKING
// ============================================================

describe('linkMissionToProject()', () => {
  test('creates linking row', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Test', phase: 'discovery', status: 'active'
    }]);

    const link = await projects.linkMissionToProject(1, 100, 'discovery');
    expect(link).toBeTruthy();
    expect(link.project_id).toBe(1);
    expect(link.mission_id).toBe(100);
    expect(link.phase).toBe('discovery');
  });
});

describe('getProjectMissions()', () => {
  test('returns missions grouped by phase', async () => {
    mockSupabase.__setData('project_missions', [
      { id: 1, project_id: 1, mission_id: 100, phase: 'discovery' },
      { id: 2, project_id: 1, mission_id: 101, phase: 'discovery' },
      { id: 3, project_id: 1, mission_id: 102, phase: 'requirements' }
    ]);

    const missions = await projects.getProjectMissions(1);
    expect(missions.length).toBe(3);
  });
});

// ============================================================
// PROJECT CONTEXT
// ============================================================

describe('saveProjectContext() / getProjectContext()', () => {
  test('saves and retrieves project context', async () => {
    const saved = await projects.saveProjectContext({
      projectId: 1,
      phase: 'discovery',
      contextType: 'deliverable',
      content: 'Market research findings...',
      sourceMissionId: 100
    });

    expect(saved).toBeTruthy();
    expect(saved.context_type).toBe('deliverable');

    const contexts = await projects.getProjectContext(1);
    expect(contexts.length).toBe(1);
    expect(contexts[0].content).toBe('Market research findings...');
  });
});

// ============================================================
// PROJECT DETECTION
// ============================================================

describe('detectExistingProject()', () => {
  test('matches message to active project by keyword overlap', async () => {
    mockSupabase.__setData('projects', [
      { id: 1, name: 'Real Estate AI Agent', description: 'AI agent for lead generation in real estate', status: 'active', phase: 'requirements' },
      { id: 2, name: 'Content Marketing Strategy', description: 'SEO and content plan', status: 'active', phase: 'discovery' }
    ]);

    const match = await projects.detectExistingProject('Continue the real estate AI requirements');
    expect(match).toBeTruthy();
    expect(match.id).toBe(1);
  });

  test('returns null when no projects match', async () => {
    mockSupabase.__setData('projects', [
      { id: 1, name: 'Real Estate AI', description: 'Real estate stuff', status: 'active', phase: 'discovery' }
    ]);

    const match = await projects.detectExistingProject('Build a cryptocurrency trading bot');
    expect(match).toBeNull();
  });

  test('ignores completed projects', async () => {
    mockSupabase.__setData('projects', [
      { id: 1, name: 'Real Estate AI', description: 'Real estate stuff', status: 'completed', phase: 'completed' }
    ]);

    const match = await projects.detectExistingProject('More real estate work');
    expect(match).toBeNull();
  });
});

// ============================================================
// CONTEXT FOR PROMPT INJECTION
// ============================================================

describe('buildProjectContextForPrompt()', () => {
  test('formats project context for prompt injection', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Real Estate AI', description: 'AI for lead gen', status: 'active', phase: 'requirements',
      original_message: 'Build a real estate AI'
    }]);
    mockSupabase.__setData('project_context', [
      { id: 1, project_id: 1, phase: 'discovery', context_type: 'deliverable', content: 'Market is $50B', source_mission_id: 100 }
    ]);

    const contextStr = await projects.buildProjectContextForPrompt(1);
    expect(contextStr).toContain('Real Estate AI');
    expect(contextStr).toContain('requirements'); // current phase
    expect(contextStr).toContain('Market is $50B'); // prior context
  });

  test('returns empty string for unknown project', async () => {
    const contextStr = await projects.buildProjectContextForPrompt(999);
    expect(contextStr).toBe('');
  });
});

// ============================================================
// PHASE COMPLETION CHECK
// ============================================================

describe('checkPhaseCompletion()', () => {
  test('advances phase when all missions in current phase complete', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Test', phase: 'discovery', status: 'active'
    }]);
    mockSupabase.__setData('project_missions', [
      { id: 1, project_id: 1, mission_id: 100, phase: 'discovery' },
      { id: 2, project_id: 1, mission_id: 101, phase: 'discovery' }
    ]);
    mockSupabase.__setData('missions', [
      { id: 100, status: 'completed' },
      { id: 101, status: 'completed' }
    ]);

    const advanced = await projects.checkPhaseCompletion(1);
    expect(advanced).toBe(true);
  });

  test('does not advance when missions still in progress', async () => {
    mockSupabase.__setData('projects', [{
      id: 1, name: 'Test', phase: 'discovery', status: 'active'
    }]);
    mockSupabase.__setData('project_missions', [
      { id: 1, project_id: 1, mission_id: 100, phase: 'discovery' },
      { id: 2, project_id: 1, mission_id: 101, phase: 'discovery' }
    ]);
    mockSupabase.__setData('missions', [
      { id: 100, status: 'completed' },
      { id: 101, status: 'in_progress' }
    ]);

    const advanced = await projects.checkPhaseCompletion(1);
    expect(advanced).toBe(false);
  });
});
