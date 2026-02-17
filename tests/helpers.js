// Test data factory functions

let idCounter = 1;

function makeAgent(overrides = {}) {
  const id = idCounter++;
  return {
    id: overrides.id || `agent-test-${id}`,
    name: overrides.name || `Test (${overrides.role || 'Research Analyst'})`,
    display_name: overrides.display_name || `TestAgent${id}`,
    role: overrides.role || 'Research Analyst',
    title: overrides.title || overrides.role || 'Research Analyst',
    team_id: overrides.team_id || 'team-research',
    agent_type: overrides.agent_type || 'sub_agent',
    status: overrides.status || 'active',
    persona_id: overrides.persona_id || null,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    retired_at: overrides.retired_at || null,
    ...overrides
  };
}

function makeTeam(overrides = {}) {
  return {
    id: overrides.id || `team-test-${idCounter++}`,
    name: overrides.name || 'Test Team',
    description: overrides.description || 'A test team',
    status: overrides.status || 'active',
    lead_agent_id: overrides.lead_agent_id || null,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides
  };
}

function makeProposal(overrides = {}) {
  return {
    id: overrides.id || idCounter++,
    proposing_agent_id: overrides.proposing_agent_id || 'zero',
    title: overrides.title || 'Test Proposal',
    description: overrides.description || 'Test proposal description',
    raw_message: overrides.raw_message || 'Test raw message',
    discord_message_id: overrides.discord_message_id || null,
    assigned_team_id: overrides.assigned_team_id || null,
    status: overrides.status || 'pending',
    priority: overrides.priority || 'normal',
    announced: overrides.announced || false,
    processed: overrides.processed || false,
    created_at: overrides.created_at || new Date().toISOString(),
    ...overrides
  };
}

function makeMission(overrides = {}) {
  return {
    id: overrides.id || idCounter++,
    proposal_id: overrides.proposal_id || null,
    team_id: overrides.team_id || 'team-research',
    title: overrides.title || 'Test Mission',
    description: overrides.description || 'Test mission description',
    status: overrides.status || 'in_progress',
    completed_at: overrides.completed_at || null,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides
  };
}

function makeStep(overrides = {}) {
  return {
    id: overrides.id || idCounter++,
    mission_id: overrides.mission_id || 1,
    description: overrides.description || 'Test step description',
    assigned_agent_id: overrides.assigned_agent_id || 'agent-test-1',
    model_tier: overrides.model_tier || 'tier1',
    status: overrides.status || 'pending',
    result: overrides.result || null,
    result_format: overrides.result_format || 'text',
    step_order: overrides.step_order || 1,
    parent_step_id: overrides.parent_step_id || null,
    announced: overrides.announced || false,
    processed: overrides.processed || false,
    started_at: overrides.started_at || null,
    completed_at: overrides.completed_at || null,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides
  };
}

function makePersona(agentId, overrides = {}) {
  return {
    id: overrides.id || idCounter++,
    agent_id: agentId,
    agent_md: overrides.agent_md || 'Test agent identity',
    soul_md: overrides.soul_md || 'Test soul',
    skills_md: overrides.skills_md || 'Test skills',
    identity_md: overrides.identity_md || 'Test identity',
    full_sep_prompt: overrides.full_sep_prompt || `# TestAgent — Research Analyst\n\nYou are a test agent.`,
    version: overrides.version || 1,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides
  };
}

function resetIdCounter() {
  idCounter = 1;
}

module.exports = {
  makeAgent,
  makeTeam,
  makeProposal,
  makeMission,
  makeStep,
  makePersona,
  resetIdCounter
};
