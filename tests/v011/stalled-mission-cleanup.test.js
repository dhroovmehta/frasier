// tests/v011/stalled-mission-cleanup.test.js — ISS-028: Zombie Step Queue Clog
// TDD: Tests define the contract for failBlockedSteps() and the removal of
// the .limit(limit * 2) cap in getPendingSteps().

const fs = require('fs');
const path = require('path');
const createMockSupabase = require('../mocks/supabase');
const { makeStep, makeMission, resetIdCounter } = require('../helpers');

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
// failBlockedSteps — Auto-fail zombie steps
// ============================================================

describe('failBlockedSteps', () => {

  it('fails pending steps with step_order > failed step order', async () => {
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, step_order: 2, status: 'failed' }),
      makeStep({ id: 300, mission_id: 1, step_order: 3, status: 'pending' }),
      makeStep({ id: 400, mission_id: 1, step_order: 4, status: 'pending' })
    ]);

    const count = await missions.failBlockedSteps(1);
    expect(count).toBe(2);

    const steps = mockSupabase.__getData('mission_steps');
    expect(steps.find(s => s.id === 300).status).toBe('failed');
    expect(steps.find(s => s.id === 400).status).toBe('failed');
    // Step 100 (completed) and 200 (already failed) untouched
    expect(steps.find(s => s.id === 100).status).toBe('completed');
    expect(steps.find(s => s.id === 200).status).toBe('failed');
  });

  it('does not fail parallel steps at same order as failed step', async () => {
    // WHY: In DAG-decomposed missions, multiple steps can share the same step_order
    // (parallel group). Only steps AFTER the failed group should be auto-failed.
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'failed' }),
      makeStep({ id: 200, mission_id: 1, step_order: 1, status: 'pending' }),
      makeStep({ id: 300, mission_id: 1, step_order: 2, status: 'pending' })
    ]);

    const count = await missions.failBlockedSteps(1);
    expect(count).toBe(1); // Only step 300

    const steps = mockSupabase.__getData('mission_steps');
    expect(steps.find(s => s.id === 200).status).toBe('pending');
    expect(steps.find(s => s.id === 300).status).toBe('failed');
  });

  it('returns 0 when no failed steps exist', async () => {
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, step_order: 2, status: 'pending' })
    ]);

    const count = await missions.failBlockedSteps(1);
    expect(count).toBe(0);
  });

  it('returns 0 when no pending steps after failed step', async () => {
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, step_order: 2, status: 'failed' })
    ]);

    const count = await missions.failBlockedSteps(1);
    expect(count).toBe(0);
  });

  it('cascade: failBlockedSteps + checkMissionCompletion marks mission as failed', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 1, status: 'in_progress' })
    ]);
    mockSupabase.__setData('mission_steps', [
      makeStep({ id: 100, mission_id: 1, step_order: 1, status: 'completed' }),
      makeStep({ id: 200, mission_id: 1, step_order: 2, status: 'failed' }),
      makeStep({ id: 300, mission_id: 1, step_order: 3, status: 'pending' })
    ]);

    // First: auto-fail blocked steps
    await missions.failBlockedSteps(1);

    // Then: check mission completion — all steps now done (completed or failed)
    const completed = await missions.checkMissionCompletion(1);
    expect(completed).toBe(true);

    const mission = mockSupabase.__getData('missions')[0];
    expect(mission.status).toBe('failed');
  });
});

// ============================================================
// getPendingSteps — No more artificial limit
// ============================================================

describe('getPendingSteps resilience', () => {

  it('source code does not contain .limit(limit * 2) pattern', () => {
    // WHY: The .limit(limit * 2) cap caused ISS-028 — zombie steps from dead missions
    // filled the fetch window, preventing live mission steps from ever being reached.
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/lib/missions.js'), 'utf8'
    );
    expect(source).not.toContain('.limit(limit * 2)');
  });
});
