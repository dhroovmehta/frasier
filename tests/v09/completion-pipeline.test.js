// tests/v09/completion-pipeline.test.js — Completion Notification Pipeline (v0.9.3)
// TDD: Tests define the contract for enriched completeMission() and failMission() —
// these functions must log events, check project links, and trigger phase advancement.
// WHY: Without this, the worker completes missions but nobody is notified (ISS-016).

const createMockSupabase = require('../mocks/supabase');
const { makeMission, resetIdCounter } = require('../helpers');

const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

// Mock linear (missions.js imports this)
jest.mock('../../src/lib/linear', () => ({
  completeProject: jest.fn().mockResolvedValue(null),
  cancelProject: jest.fn().mockResolvedValue(null),
  syncMissionToLinear: jest.fn().mockResolvedValue(null),
  syncStepToLinear: jest.fn().mockResolvedValue(null),
  updateIssueStatus: jest.fn().mockResolvedValue(null)
}));

// Mock events — verify logEvent calls
const mockLogEvent = jest.fn().mockResolvedValue(null);
jest.mock('../../src/lib/events', () => ({
  logEvent: mockLogEvent
}));

// Mock projects — verify checkPhaseCompletion calls
const mockCheckPhaseCompletion = jest.fn().mockResolvedValue(false);
jest.mock('../../src/lib/projects', () => ({
  checkPhaseCompletion: mockCheckPhaseCompletion
}));

const missions = require('../../src/lib/missions');

// ============================================================
// SETUP
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase.__reset();
  resetIdCounter();
});

// ============================================================
// completeMission — event logging & project phase check
// ============================================================

describe('completeMission — notification pipeline', () => {

  it('logs a mission_completed event with mission data', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 42, title: 'Research Market', team_id: 'team-research', status: 'in_progress' })
    ]);

    await missions.completeMission(42);

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'mission_completed',
      severity: 'info'
    }));
    // Verify event data includes mission info for Discord announcement
    const eventArg = mockLogEvent.mock.calls[0][0];
    expect(eventArg.data.missionId).toBe(42);
  });

  it('checks project link and calls checkPhaseCompletion when linked', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 42, title: 'Discovery Phase', status: 'in_progress' })
    ]);
    mockSupabase.__setData('project_missions', [
      { id: 1, project_id: 7, mission_id: 42, phase: 'discovery' }
    ]);

    await missions.completeMission(42);

    expect(mockCheckPhaseCompletion).toHaveBeenCalledTimes(1);
    expect(mockCheckPhaseCompletion).toHaveBeenCalledWith(7);
  });

  it('does NOT call checkPhaseCompletion when no project link exists', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 42, title: 'Standalone Mission', status: 'in_progress' })
    ]);
    // No project_missions rows — mission is not linked to a project

    await missions.completeMission(42);

    expect(mockCheckPhaseCompletion).not.toHaveBeenCalled();
  });

  it('is idempotent — skips event logging if mission already completed', async () => {
    // WHY: Worker and heartbeat can both call checkMissionCompletion().
    // If the worker completes first, heartbeat's call should be a no-op.
    mockSupabase.__setData('missions', [
      makeMission({ id: 42, title: 'Already Done', status: 'completed' })
    ]);

    await missions.completeMission(42);

    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(mockCheckPhaseCompletion).not.toHaveBeenCalled();
  });

  it('still returns mission data on success', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 42, title: 'Test Mission', status: 'in_progress' })
    ]);

    const result = await missions.completeMission(42);

    expect(result).not.toBeNull();
    expect(result.id).toBe(42);
    expect(result.status).toBe('completed');
  });
});

// ============================================================
// failMission — event logging
// ============================================================

describe('failMission — notification pipeline', () => {

  it('logs a mission_failed event with reason', async () => {
    mockSupabase.__setData('missions', [
      makeMission({ id: 42, title: 'Failed Mission', status: 'in_progress' })
    ]);

    await missions.failMission(42, 'Steps failed quality check');

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'mission_failed',
      severity: 'warning'
    }));
    const eventArg = mockLogEvent.mock.calls[0][0];
    expect(eventArg.data.missionId).toBe(42);
    expect(eventArg.data.reason).toBe('Steps failed quality check');
  });
});
