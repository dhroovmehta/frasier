// Phase 2: Roster Injection Tests
// Tests that Frasier's prompt includes a formatted roster of all active agents
// grouped by team, using "Name (Role)" format.

const createMockSupabase = require('../mocks/supabase');
const { makeAgent, makeTeam, makePersona, resetIdCounter } = require('../helpers');

// Set up env vars before any module loads
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';

let mockSupabase;

// Mock supabase before requiring modules that use it
jest.mock('../../src/lib/supabase', () => {
  const createMock = require('../mocks/supabase');
  const mock = createMock();
  // Store reference so tests can access __setData/__reset
  global.__mockSupabase = mock;
  return mock;
});

// Mock models to prevent real API calls
jest.mock('../../src/lib/models', () => require('../mocks/models'));

// Mock skills to avoid DB dependency
jest.mock('../../src/lib/skills', () => ({
  getAgentSkills: jest.fn().mockResolvedValue([]),
  formatSkillsForPrompt: jest.fn().mockReturnValue('')
}));

const agents = require('../../src/lib/agents');
const memory = require('../../src/lib/memory');

beforeEach(() => {
  mockSupabase = global.__mockSupabase;
  mockSupabase.__reset();
  resetIdCounter();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildRosterSection()', () => {
  test('returns formatted roster with "Name (Role)" per team', async () => {
    const team = makeTeam({ id: 'team-research', name: 'Research Team', status: 'active' });
    const gendo = makeAgent({ id: 'agent-gendo', display_name: 'Gendo', role: 'Research Strategist', team_id: 'team-research', agent_type: 'team_lead' });
    const sahaquiel = makeAgent({ id: 'agent-sahaquiel', display_name: 'Sahaquiel', role: 'Research Analyst', team_id: 'team-research', agent_type: 'sub_agent' });

    mockSupabase.__setData('teams', [team]);
    mockSupabase.__setData('agents', [gendo, sahaquiel]);

    const roster = await agents.buildRosterSection();

    expect(roster).toContain('## Current Roster');
    expect(roster).toContain('### Research Team [active]');
    expect(roster).toContain('Gendo (Research Strategist) (Lead)');
    expect(roster).toContain('Sahaquiel (Research Analyst)');
  });

  test('excludes retired agents', async () => {
    const team = makeTeam({ id: 'team-research', name: 'Research Team', status: 'active' });
    const active = makeAgent({ id: 'agent-active', display_name: 'Gendo', role: 'Analyst', team_id: 'team-research', status: 'active' });
    const retired = makeAgent({ id: 'agent-retired', display_name: 'Rei', role: 'QA', team_id: 'team-research', status: 'retired' });

    mockSupabase.__setData('teams', [team]);
    mockSupabase.__setData('agents', [active, retired]);

    const roster = await agents.buildRosterSection();

    expect(roster).toContain('Gendo');
    expect(roster).not.toContain('Rei');
  });

  test('shows team status (active/dormant)', async () => {
    const activeTeam = makeTeam({ id: 'team-research', name: 'Research Team', status: 'active' });
    const dormantTeam = makeTeam({ id: 'team-execution', name: 'Execution Team', status: 'dormant' });

    mockSupabase.__setData('teams', [activeTeam, dormantTeam]);
    mockSupabase.__setData('agents', []);

    const roster = await agents.buildRosterSection();

    expect(roster).toContain('### Research Team [active]');
    expect(roster).toContain('### Execution Team [dormant]');
  });

  test('includes type labels: (Lead), (QA)', async () => {
    const team = makeTeam({ id: 'team-research', name: 'Research', status: 'active' });
    const lead = makeAgent({ display_name: 'Gendo', role: 'Strategist', team_id: 'team-research', agent_type: 'team_lead' });
    const qa = makeAgent({ display_name: 'Ein', role: 'QA Engineer', team_id: 'team-research', agent_type: 'qa' });
    const sub = makeAgent({ display_name: 'Sahaquiel', role: 'Analyst', team_id: 'team-research', agent_type: 'sub_agent' });

    mockSupabase.__setData('teams', [team]);
    mockSupabase.__setData('agents', [lead, qa, sub]);

    const roster = await agents.buildRosterSection();

    expect(roster).toContain('Gendo (Strategist) (Lead)');
    expect(roster).toContain('Ein (QA Engineer) (QA)');
    expect(roster).toMatch(/Sahaquiel \(Analyst\)(?!\s*\()/); // No type tag for sub_agent
  });

  test('shows "No agents assigned" for empty teams', async () => {
    const team = makeTeam({ id: 'team-advisory', name: 'Advisory Team', status: 'dormant' });

    mockSupabase.__setData('teams', [team]);
    mockSupabase.__setData('agents', []);

    const roster = await agents.buildRosterSection();

    expect(roster).toContain('Advisory Team [dormant]');
    expect(roster).toContain('No agents assigned');
  });
});

describe('buildAgentPrompt() roster injection', () => {
  test('includes roster section for chief_of_staff agent', async () => {
    const team = makeTeam({ id: 'team-research', name: 'Research', status: 'active' });
    const frasier = makeAgent({
      id: 'frasier-cos',
      display_name: 'Frasier',
      role: 'Chief of Staff',
      agent_type: 'chief_of_staff',
      team_id: null,
      persona_id: 1
    });
    const gendo = makeAgent({
      id: 'agent-gendo',
      display_name: 'Gendo',
      role: 'Research Strategist',
      team_id: 'team-research',
      agent_type: 'team_lead'
    });
    const persona = makePersona('frasier-cos', {
      id: 1,
      full_sep_prompt: '# Frasier — Chief of Staff\n\nYou are Frasier.'
    });

    mockSupabase.__setData('teams', [team]);
    mockSupabase.__setData('agents', [frasier, gendo]);
    mockSupabase.__setData('agent_personas', [persona]);
    mockSupabase.__setData('agent_memories', []);
    mockSupabase.__setData('lessons_learned', []);
    mockSupabase.__setData('agent_skills', []);

    const result = await memory.buildAgentPrompt('frasier-cos', []);

    expect(result.systemPrompt).toContain('## Current Roster');
    expect(result.systemPrompt).toContain('Gendo (Research Strategist) (Lead)');
  });

  test('does NOT include roster for non-chief_of_staff agents', async () => {
    const team = makeTeam({ id: 'team-research', name: 'Research', status: 'active' });
    const gendo = makeAgent({
      id: 'agent-gendo',
      display_name: 'Gendo',
      role: 'Research Strategist',
      team_id: 'team-research',
      agent_type: 'team_lead',
      persona_id: 2
    });
    const persona = makePersona('agent-gendo', {
      id: 2,
      full_sep_prompt: '# Gendo — Research Strategist\n\nYou are Gendo.'
    });

    mockSupabase.__setData('teams', [team]);
    mockSupabase.__setData('agents', [gendo]);
    mockSupabase.__setData('agent_personas', [persona]);
    mockSupabase.__setData('agent_memories', []);
    mockSupabase.__setData('lessons_learned', []);
    mockSupabase.__setData('agent_skills', []);

    const result = await memory.buildAgentPrompt('agent-gendo', []);

    expect(result.systemPrompt).not.toContain('## Current Roster');
  });
});
