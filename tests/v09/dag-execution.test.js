// tests/v09/dag-execution.test.js — DAG Step Eligibility & Parallel Execution (v0.9.0 Phase 6)
// TDD: Tests define the contract for areAllDependenciesMet(), getPredecessorOutputs(),
// and the modified getPendingSteps() with DAG support + backward compatibility.

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, makeStep, makeMission, makeDependency, resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);
jest.mock('../../src/lib/linear', () => ({
  syncMissionToLinear: jest.fn().mockResolvedValue(null),
  syncStepToLinear: jest.fn().mockResolvedValue(null),
  updateIssueStatus: jest.fn().mockResolvedValue(null),
  updateIssueCustomField: jest.fn().mockResolvedValue(null),
  completeProject: jest.fn().mockResolvedValue(null),
  cancelProject: jest.fn().mockResolvedValue(null),
  syncCritiqueScore: jest.fn().mockResolvedValue(null)
}));

const missions = require('../../src/lib/missions');

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();
});

// ============================================================
// DAG Step Eligibility
// ============================================================

describe('DAG Step Eligibility', () => {

  it('step with no dependencies is immediately eligible (returns null)', async () => {
    // No step_dependencies rows exist for this step
    const result = await missions.areAllDependenciesMet(100);
    expect(result).toBeNull();
  });

  it('step with one unsatisfied dependency is blocked', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 200, depends_on_step_id: 100 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'pending' }),
      makeStep({ id: 200, status: 'pending' })
    ]);

    const result = await missions.areAllDependenciesMet(200);
    expect(result).toBe(false);
  });

  it('step with one satisfied dependency is eligible', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 200, depends_on_step_id: 100 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'pending' })
    ]);

    const result = await missions.areAllDependenciesMet(200);
    expect(result).toBe(true);
  });

  it('step with two dependencies, one unsatisfied, is blocked', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 300, depends_on_step_id: 100 }),
      makeDependency({ step_id: 300, depends_on_step_id: 200 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'in_progress' }),
      makeStep({ id: 300, status: 'pending' })
    ]);

    const result = await missions.areAllDependenciesMet(300);
    expect(result).toBe(false);
  });

  it('step with two dependencies, both satisfied, is eligible', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 300, depends_on_step_id: 100 }),
      makeDependency({ step_id: 300, depends_on_step_id: 200 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'completed' }),
      makeStep({ id: 300, status: 'pending' })
    ]);

    const result = await missions.areAllDependenciesMet(300);
    expect(result).toBe(true);
  });

  it('diamond pattern: T3 depends on T1+T2, eligible only when both complete', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 300, depends_on_step_id: 100 }),
      makeDependency({ step_id: 300, depends_on_step_id: 200 })
    ]);

    // T1 done, T2 not done → blocked
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'pending' }),
      makeStep({ id: 300, status: 'pending' })
    ]);
    expect(await missions.areAllDependenciesMet(300)).toBe(false);

    // Now complete T2 → eligible
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'completed' }),
      makeStep({ id: 300, status: 'pending' })
    ]);
    expect(await missions.areAllDependenciesMet(300)).toBe(true);
  });

  it('completing a dependency unblocks downstream steps', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 200, depends_on_step_id: 100 })
    ]);

    // T1 in_progress → T2 blocked
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'in_progress' }),
      makeStep({ id: 200, status: 'pending' })
    ]);
    expect(await missions.areAllDependenciesMet(200)).toBe(false);

    // T1 completed → T2 unblocked
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'pending' })
    ]);
    expect(await missions.areAllDependenciesMet(200)).toBe(true);
  });
});

// ============================================================
// Backward Compatibility
// ============================================================

describe('Backward Compatibility', () => {

  it('legacy step with no step_dependencies rows uses null (legacy path)', async () => {
    const result = await missions.areAllDependenciesMet(100);
    // null means "no DAG deps found — caller should use legacy step_order check"
    expect(result).toBeNull();
  });

  it('legacy step_order chain still works: step 2 blocked until step 1 complete', async () => {
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'in_progress' }),
      makeStep({ id: 200, mission_id: 1, step_order: 2, status: 'pending' })
    ]);

    const ready = await missions.isPreviousStepComplete(1, 2);
    expect(ready).toBe(false);
  });

  it('legacy step_order: step 2 eligible when step 1 complete', async () => {
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, step_order: 2, status: 'pending' })
    ]);

    const ready = await missions.isPreviousStepComplete(1, 2);
    expect(ready).toBe(true);
  });

  it('step with step_dependencies rows uses DAG path (ignores parent_step_id)', async () => {
    // Step has BOTH parent_step_id AND step_dependencies
    // DAG path should take precedence → areAllDependenciesMet returns non-null
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 200, depends_on_step_id: 100 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed' }),
      makeStep({ id: 200, status: 'pending', parent_step_id: 999 })
    ]);

    // areAllDependenciesMet returns true (not null) → DAG path used, parent_step_id ignored
    const result = await missions.areAllDependenciesMet(200);
    expect(result).toBe(true); // Non-null means DAG path
  });
});

// ============================================================
// Context Flow Between Dependent Tasks
// ============================================================

describe('Context Flow Between Dependent Tasks', () => {

  it('step with dependency receives predecessor output as context', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 200, depends_on_step_id: 100 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed', result: 'Research findings about AI tutoring market', assigned_agent_id: 'edward' }),
      makeStep({ id: 200, status: 'pending' })
    ]);
    mockSupabase.__setData('agents', [
      makeAgent({ id: 'edward', display_name: 'Edward' })
    ]);

    const outputs = await missions.getPredecessorOutputs(200);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].agentName).toBe('Edward');
    expect(outputs[0].result).toContain('Research findings');
  });

  it('step with multiple dependencies receives all predecessor outputs', async () => {
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 300, depends_on_step_id: 100 }),
      makeDependency({ step_id: 300, depends_on_step_id: 200 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed', result: 'Market research data', assigned_agent_id: 'edward' }),
      makeStep({ id: 200, status: 'completed', result: 'Tech landscape analysis', assigned_agent_id: 'spike' }),
      makeStep({ id: 300, status: 'pending' })
    ]);
    mockSupabase.__setData('agents', [
      makeAgent({ id: 'edward', display_name: 'Edward' }),
      makeAgent({ id: 'spike', display_name: 'Spike' })
    ]);

    const outputs = await missions.getPredecessorOutputs(300);
    expect(outputs).toHaveLength(2);
    expect(outputs.map(o => o.agentName)).toContain('Edward');
    expect(outputs.map(o => o.agentName)).toContain('Spike');
  });

  it('context is truncated to 6000 chars per predecessor (RAM safety)', async () => {
    const longResult = 'x'.repeat(10000);
    mockSupabase.__setData('step_dependencies', [
      makeDependency({ step_id: 200, depends_on_step_id: 100 })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, status: 'completed', result: longResult, assigned_agent_id: 'edward' }),
      makeStep({ id: 200, status: 'pending' })
    ]);
    mockSupabase.__setData('agents', [
      makeAgent({ id: 'edward', display_name: 'Edward' })
    ]);

    const outputs = await missions.getPredecessorOutputs(200);
    expect(outputs[0].result.length).toBeLessThanOrEqual(6000);
  });

  it('returns empty array when step has no dependencies', async () => {
    const outputs = await missions.getPredecessorOutputs(100);
    expect(outputs).toEqual([]);
  });
});

// ============================================================
// End-to-End Chaining
// ============================================================

describe('End-to-End Chaining', () => {

  it('mission completes when ALL steps are done', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 1, status: 'in_progress' })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, status: 'completed' }),
      makeStep({ id: 300, mission_id: 1, status: 'completed' })
    ]);

    const completed = await missions.checkMissionCompletion(1);
    expect(completed).toBe(true);

    const mission = mockSupabase.__getData('missions')[0];
    expect(mission.status).toBe('completed');
  });

  it('mission does NOT complete when some steps are pending', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 1, status: 'in_progress' })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, status: 'pending' })
    ]);

    const completed = await missions.checkMissionCompletion(1);
    expect(completed).toBe(false);
  });
});
