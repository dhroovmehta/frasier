// Phase 4: Smart Routing + Gap-Fill Hiring Tests
// Tests for cross-team agent matching and auto-hiring for missing roles.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';

const createMockSupabase = require('../mocks/supabase');
const mockSupabase = createMockSupabase();
global.__mockSupabase = mockSupabase;

jest.mock('../../src/lib/supabase', () => global.__mockSupabase);

const agents = require('../../src/lib/agents');

beforeEach(() => {
  mockSupabase.__reset();
});

// ============================================================
// CROSS-TEAM AGENT MATCHING
// ============================================================

describe('findBestAgentAcrossTeams()', () => {
  test('finds research agent on team-research even when targeting team-execution', async () => {
    mockSupabase.__setData('agents', [
      { id: 'agent-gendo-1', display_name: 'Gendo', role: 'Research Analyst', status: 'active', team_id: 'team-research', agent_type: 'sub_agent' },
      { id: 'agent-spike-1', display_name: 'Spike', role: 'Full-Stack Engineer', status: 'active', team_id: 'team-execution', agent_type: 'sub_agent' }
    ]);

    const match = await agents.findBestAgentAcrossTeams('research');
    expect(match).toBeTruthy();
    expect(match.id).toBe('agent-gendo-1');
  });

  test('returns null when no agent matches the role category', async () => {
    mockSupabase.__setData('agents', [
      { id: 'agent-gendo-1', display_name: 'Gendo', role: 'Research Analyst', status: 'active', team_id: 'team-research', agent_type: 'sub_agent' }
    ]);

    const match = await agents.findBestAgentAcrossTeams('content');
    expect(match).toBeNull();
  });

  test('only returns active agents', async () => {
    mockSupabase.__setData('agents', [
      { id: 'agent-faye-1', display_name: 'Faye', role: 'Content Creator', status: 'retired', team_id: 'team-research', agent_type: 'sub_agent' }
    ]);

    const match = await agents.findBestAgentAcrossTeams('content');
    expect(match).toBeNull();
  });

  test('finds strategy agent by role keywords', async () => {
    mockSupabase.__setData('agents', [
      { id: 'agent-misato-1', display_name: 'Misato', role: 'Strategy Lead', status: 'active', team_id: 'team-research', agent_type: 'team_lead' }
    ]);

    const match = await agents.findBestAgentAcrossTeams('strategy');
    expect(match).toBeTruthy();
    expect(match.display_name).toBe('Misato');
  });
});

// ============================================================
// STANDING TEAM MAPPING
// ============================================================

describe('getStandingTeamForRole()', () => {
  test('maps research roles to team-research', () => {
    expect(agents.getStandingTeamForRole('research')).toBe('team-research');
    expect(agents.getStandingTeamForRole('strategy')).toBe('team-research');
    expect(agents.getStandingTeamForRole('knowledge')).toBe('team-research');
  });

  test('maps engineering/content roles to team-execution', () => {
    expect(agents.getStandingTeamForRole('engineering')).toBe('team-execution');
    expect(agents.getStandingTeamForRole('content')).toBe('team-execution');
    expect(agents.getStandingTeamForRole('qa')).toBe('team-execution');
    expect(agents.getStandingTeamForRole('marketing')).toBe('team-execution');
  });

  test('defaults to team-research for unknown roles', () => {
    expect(agents.getStandingTeamForRole('unknown')).toBe('team-research');
  });
});

// ============================================================
// AUTO-HIRE GAP AGENT
// ============================================================

describe('autoHireGapAgent()', () => {
  test('creates agent on the correct standing team', async () => {
    // Set up name pool
    mockSupabase.__setData('name_pool', [
      { id: 1, name: 'Kaworu', source: 'evangelion', assigned: false }
    ]);
    mockSupabase.__setData('teams', [
      { id: 'team-execution', name: 'Team Execution', status: 'active' }
    ]);

    const agent = await agents.autoHireGapAgent('Content Creator', 'content');
    expect(agent).toBeTruthy();
    expect(agent.role).toBe('Content Creator');
    expect(agent.team_id).toBe('team-execution');
  });

  test('returns null when name pool is empty', async () => {
    mockSupabase.__setData('name_pool', []);

    const agent = await agents.autoHireGapAgent('Content Creator', 'content');
    expect(agent).toBeNull();
  });
});

// ============================================================
// DETERMINE PROJECT ROLES
// ============================================================

describe('determineProjectRoles()', () => {
  test('identifies research role from description', () => {
    const roles = agents.determineProjectRoles('Research the AI SaaS market and analyze competitors');
    expect(roles).toContain('research');
  });

  test('identifies multiple roles', () => {
    const roles = agents.determineProjectRoles(
      'Research the market, then build an API and write content for the launch'
    );
    expect(roles).toContain('research');
    expect(roles).toContain('engineering');
    expect(roles).toContain('content');
  });

  test('returns at least research for vague descriptions', () => {
    const roles = agents.determineProjectRoles('Do something');
    expect(roles.length).toBeGreaterThanOrEqual(1);
  });
});
