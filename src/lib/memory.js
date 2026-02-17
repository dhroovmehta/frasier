// memory.js — Persistent cumulative memory system
// THE #1 REQUIREMENT: Memory never resets, never expires, never degrades.
//
// Architecture:
//   Identity (static .md in agent_personas table) + Memory (cumulative rows in agent_memories)
//   are SEPARATE systems. Identity defines who the agent is. Memory defines what they've experienced.
//
// Retrieval strategy (hybrid, zero extra cost):
//   1. RECENCY  — last 10 actions/conversations by this agent
//   2. TOPIC    — top 10 memories matching current task's topic tags
//   3. LESSONS  — top 5 highest-importance lessons for this agent
//   Total: ~25 memories per prompt

const supabase = require('./supabase');

// ============================================================
// WRITE OPERATIONS (every action creates a memory)
// ============================================================

/**
 * Save a new memory for an agent. Called after every LLM response,
 * every conversation turn, every decision, every observation.
 *
 * @param {Object} params
 * @param {string} params.agentId - The agent's ID
 * @param {string} params.memoryType - conversation | decision | task | lesson | relationship | observation
 * @param {string} params.content - Full content of the memory
 * @param {string} [params.summary] - Brief summary for quick scan
 * @param {string[]} [params.topicTags] - Tags for retrieval matching
 * @param {number} [params.importance] - 1-10, higher = more important (default 5)
 * @param {string} [params.sourceType] - mission | conversation | review | standup | autonomous
 * @param {string} [params.sourceId] - Reference ID to source
 * @param {string[]} [params.relatedAgentIds] - Other agents involved
 * @param {Object} [params.metadata] - Flexible extra data
 * @returns {Object} The created memory row
 */
async function saveMemory({
  agentId,
  memoryType,
  content,
  summary = null,
  topicTags = [],
  importance = 5,
  sourceType = null,
  sourceId = null,
  relatedAgentIds = [],
  metadata = {}
}) {
  if (!agentId || !memoryType || !content) {
    console.error('[memory] saveMemory missing required fields:', { agentId, memoryType, hasContent: !!content });
    return null;
  }

  const { data, error } = await supabase
    .from('agent_memories')
    .insert({
      agent_id: agentId,
      memory_type: memoryType,
      content,
      summary: summary || content.substring(0, 200),
      topic_tags: topicTags,
      importance,
      source_type: sourceType,
      source_id: sourceId,
      related_agent_ids: relatedAgentIds,
      metadata
    })
    .select()
    .single();

  if (error) {
    console.error(`[memory] Failed to save memory for ${agentId}:`, error.message);
    return null;
  }

  console.log(`[memory] Saved memory #${data.id} for ${agentId} (type: ${memoryType}, tags: ${topicTags.join(',')})`);
  return data;
}

/**
 * Save a lesson learned. Lessons are always included in memory retrieval
 * regardless of topic, so they're the agent's accumulated wisdom.
 */
async function saveLesson({
  agentId,
  lesson,
  context = null,
  category = null,
  importance = 7,
  sourceMissionId = null,
  metadata = {}
}) {
  const { data, error } = await supabase
    .from('lessons_learned')
    .insert({
      agent_id: agentId,
      lesson,
      context,
      category,
      importance,
      source_mission_id: sourceMissionId,
      metadata
    })
    .select()
    .single();

  if (error) {
    console.error(`[memory] Failed to save lesson for ${agentId}:`, error.message);
    return null;
  }

  console.log(`[memory] Saved lesson #${data.id} for ${agentId}: "${lesson.substring(0, 80)}..."`);
  return data;
}

/**
 * Log a decision to the decisions log.
 */
async function logDecision({
  agentId,
  decision,
  reasoning = null,
  alternativesConsidered = null,
  missionId = null,
  teamId = null,
  metadata = {}
}) {
  const { data, error } = await supabase
    .from('decisions_log')
    .insert({
      agent_id: agentId,
      decision,
      reasoning,
      alternatives_considered: alternativesConsidered,
      mission_id: missionId,
      team_id: teamId,
      metadata
    })
    .select()
    .single();

  if (error) {
    console.error(`[memory] Failed to log decision for ${agentId}:`, error.message);
    return null;
  }

  return data;
}

/**
 * Save a conversation message to history.
 */
async function saveConversation({
  conversationId,
  conversationType,
  senderAgentId,
  recipientAgentId = null,
  teamId = null,
  content,
  context = null,
  missionStepId = null,
  metadata = {}
}) {
  const { data, error } = await supabase
    .from('conversation_history')
    .insert({
      conversation_id: conversationId,
      conversation_type: conversationType,
      sender_agent_id: senderAgentId,
      recipient_agent_id: recipientAgentId,
      team_id: teamId,
      content,
      context,
      mission_step_id: missionStepId,
      metadata
    })
    .select()
    .single();

  if (error) {
    console.error(`[memory] Failed to save conversation:`, error.message);
    return null;
  }

  return data;
}

// ============================================================
// READ OPERATIONS (retrieve relevant memories for LLM prompts)
// ============================================================

/**
 * Retrieve memories for an agent using the hybrid strategy:
 *   1. RECENCY  — last 10 memories (most recent actions)
 *   2. TOPIC    — top 10 memories matching task's topic tags
 *   3. LESSONS  — top 5 highest-importance lessons
 *
 * Returns ~25 deduplicated memories formatted for prompt injection.
 *
 * @param {string} agentId - The agent to retrieve memories for
 * @param {string[]} [topicTags] - Tags relevant to the current task
 * @returns {Object} { recent, topicMatched, lessons, formatted }
 */
async function retrieveMemories(agentId, topicTags = []) {
  // Pull 15 topic-matched memories (up from 10) to ensure full multi-turn
  // conversations are retrieved even days later. A 5-turn casual chat = 10 memory
  // rows (5 from Zero, 5 responses). 15 gives us room for the full exchange.
  const [recent, topicMatched, lessons] = await Promise.all([
    getRecentMemories(agentId, 10),
    topicTags.length > 0 ? getTopicMemories(agentId, topicTags, 15) : [],
    getLessons(agentId, 5)
  ]);

  // Deduplicate: topic matches might overlap with recent
  const seenIds = new Set(recent.map(m => m.id));
  const uniqueTopicMatched = topicMatched.filter(m => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });

  // Format for prompt injection
  const formatted = formatMemoriesForPrompt(recent, uniqueTopicMatched, lessons);

  return {
    recent,
    topicMatched: uniqueTopicMatched,
    lessons,
    totalCount: recent.length + uniqueTopicMatched.length + lessons.length,
    formatted
  };
}

/**
 * Get the most recent memories for an agent (recency retrieval).
 */
async function getRecentMemories(agentId, limit = 10) {
  const { data, error } = await supabase
    .from('agent_memories')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[memory] Failed to get recent memories for ${agentId}:`, error.message);
    return [];
  }

  return data || [];
}

/**
 * Get memories matching specific topic tags (topic retrieval).
 * Uses PostgreSQL array containment for tag matching.
 */
async function getTopicMemories(agentId, topicTags, limit = 10) {
  const { data, error } = await supabase
    .from('agent_memories')
    .select('*')
    .eq('agent_id', agentId)
    .overlaps('topic_tags', topicTags)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[memory] Failed to get topic memories for ${agentId}:`, error.message);
    return [];
  }

  return data || [];
}

/**
 * Get top lessons learned for an agent (wisdom retrieval).
 * Always included regardless of task topic.
 */
async function getLessons(agentId, limit = 5) {
  const { data, error } = await supabase
    .from('lessons_learned')
    .select('*')
    .eq('agent_id', agentId)
    .order('importance', { ascending: false })
    .order('applied_count', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[memory] Failed to get lessons for ${agentId}:`, error.message);
    return [];
  }

  return data || [];
}

/**
 * Get recent conversations involving an agent.
 * Useful for context about ongoing work discussions.
 */
async function getRecentConversations(agentId, limit = 5) {
  const { data, error } = await supabase
    .from('conversation_history')
    .select('*')
    .or(`sender_agent_id.eq.${agentId},recipient_agent_id.eq.${agentId}`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[memory] Failed to get conversations for ${agentId}:`, error.message);
    return [];
  }

  return data || [];
}

// ============================================================
// PROMPT FORMATTING
// ============================================================

/**
 * Format retrieved memories into a string block for LLM prompt injection.
 * Structured so the LLM can clearly distinguish memory types.
 */
function formatMemoriesForPrompt(recent, topicMatched, lessons) {
  const sections = [];

  if (recent.length > 0) {
    sections.push('## Your Recent Activity');
    for (const m of recent) {
      const date = new Date(m.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      sections.push(`- [${date}] (${m.memory_type}) ${m.summary || m.content.substring(0, 200)}`);
    }
  }

  if (topicMatched.length > 0) {
    sections.push('\n## Relevant Past Experience');
    for (const m of topicMatched) {
      const date = new Date(m.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      sections.push(`- [${date}] ${m.summary || m.content.substring(0, 200)}`);
    }
  }

  if (lessons.length > 0) {
    sections.push('\n## Key Lessons You\'ve Learned');
    for (const l of lessons) {
      sections.push(`- ${l.lesson}`);
    }
  }

  if (sections.length === 0) {
    return '## Memory\nNo prior memories yet. This is your first task.';
  }

  return sections.join('\n');
}

// ============================================================
// AGENT IDENTITY (static persona retrieval)
// ============================================================

/**
 * Fetch an agent's full persona (static identity + SEP prompt).
 * This is the "who you are" part — separate from memory.
 */
async function getAgentPersona(agentId) {
  // Fetch agent and persona separately to avoid ambiguous FK relationship
  // WHY: agents.persona_id → agent_personas AND agent_personas.agent_id → agents
  // creates two relationships that Supabase can't auto-resolve in a join
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single();

  if (agentErr || !agent) {
    console.error(`[memory] Failed to get agent ${agentId}:`, agentErr?.message);
    return null;
  }

  // Fetch persona if agent has one linked
  let persona = null;
  if (agent.persona_id) {
    const { data: p, error: pErr } = await supabase
      .from('agent_personas')
      .select('*')
      .eq('id', agent.persona_id)
      .single();

    if (!pErr && p) persona = p;
  }

  // If no persona via persona_id, try by agent_id
  if (!persona) {
    const { data: p, error: pErr } = await supabase
      .from('agent_personas')
      .select('*')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!pErr && p) persona = p;
  }

  if (persona) {
    return {
      agent,
      systemPrompt: persona.full_sep_prompt,
      persona
    };
  }

  // Fallback: construct a basic prompt from agent fields
  return {
    agent,
    systemPrompt: `You are ${agent.display_name}, ${agent.title || agent.role} at NERV.\n\nRole: ${agent.role}`,
    persona: null
  };
}

/**
 * Build the complete system prompt for an LLM call:
 * [Static Identity] + [Retrieved Memories] + [Task Context]
 *
 * This is the core function that makes agents feel alive.
 * Called before every single LLM call.
 */
async function buildAgentPrompt(agentId, topicTags = []) {
  const skills = require('./skills');

  const [personaData, memories, agentSkills] = await Promise.all([
    getAgentPersona(agentId),
    retrieveMemories(agentId, topicTags),
    skills.getAgentSkills(agentId)
  ]);

  if (!personaData) {
    return { systemPrompt: null, memories: null, error: `Agent ${agentId} not found` };
  }

  // Combine identity + memory + skills into one system prompt
  const skillsSection = skills.formatSkillsForPrompt(agentSkills);

  const promptParts = [
    personaData.systemPrompt
  ];

  // For Frasier (chief_of_staff): inject the full roster so they know who to route tasks to.
  // WHY: Without this, Frasier has no idea which agents exist or what their names are.
  // The roster is injected between persona and memory so it's always visible.
  if (personaData.agent && personaData.agent.agent_type === 'chief_of_staff') {
    const agentsModule = require('./agents');
    const rosterSection = await agentsModule.buildRosterSection();
    promptParts.push('\n---\n');
    promptParts.push(rosterSection);
    promptParts.push('\nWhen referencing agents, ALWAYS use their name and role: e.g., "Gendo (Research Strategist)". Never use generic labels like "the research agent".');
  }

  promptParts.push('\n---\n');
  promptParts.push('# YOUR MEMORY (What you remember from past experience)');
  promptParts.push(memories.formatted);

  // Only add skills section if agent has developed skills (backwards-compatible)
  if (skillsSection) {
    promptParts.push('\n---\n');
    promptParts.push(skillsSection);
  }

  promptParts.push('\n---\n');
  promptParts.push(`# WEB ACCESS
You can access live web data when you need current information (prices, news, recent events, competitor info).
- To search the web: include [WEB_SEARCH:your query here] in your response
- To fetch a specific page: include [WEB_FETCH:https://example.com/page] in your response
The system will fetch the data and provide it to you in a follow-up. Only use these when you genuinely need live/current data.

# SOCIAL MEDIA
To schedule a social media post (Twitter, LinkedIn, etc.), include [SOCIAL_POST:your post content here] in your response.
The system will queue it to Buffer for publishing. Only use this when the task specifically involves creating social content.`);

  promptParts.push('\n---\n');
  promptParts.push('IMPORTANT: You have persistent memory. Reference your past experiences, lessons, and recent activity when relevant. You remember everything above — it is YOUR lived experience, not external data.');

  const systemPrompt = promptParts.join('\n');

  return {
    systemPrompt,
    memories,
    agent: personaData.agent,
    persona: personaData.persona
  };
}

// ============================================================
// MEMORY STATISTICS
// ============================================================

/**
 * Get memory stats for an agent (used in daily summaries).
 */
async function getMemoryStats(agentId) {
  const { count: totalMemories } = await supabase
    .from('agent_memories')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  const { count: totalLessons } = await supabase
    .from('lessons_learned')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  const { count: totalDecisions } = await supabase
    .from('decisions_log')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  return {
    memories: totalMemories || 0,
    lessons: totalLessons || 0,
    decisions: totalDecisions || 0
  };
}

module.exports = {
  // Write
  saveMemory,
  saveLesson,
  logDecision,
  saveConversation,
  // Read
  retrieveMemories,
  getRecentMemories,
  getTopicMemories,
  getLessons,
  getRecentConversations,
  // Identity + Memory combined
  getAgentPersona,
  buildAgentPrompt,
  // Stats
  getMemoryStats
};
