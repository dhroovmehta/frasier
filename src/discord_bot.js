// discord_bot.js — Founder interface & notification system (PM2 process #1)
// WHY: Discord is the lifeline. Zero interacts with Frasier here.
// This bot:
//   1. Receives messages from Zero → creates mission proposals
//   2. Posts results, summaries, and alerts to Discord channels
//   3. Handles approval requests (Tier 3 escalation, spending approval)
//   4. Posts daily summary at 9:30am ET
//
// Channel structure:
//   - #frasier-dm (or DM): Zero ↔ Frasier personal assistant
//   - #team-research: Research team updates
//   - #team-execution: Execution team updates (when active)
//   - #team-advisory: Advisory team updates (when active)
//   - #daily-summary: Daily rollup
//   - #alerts: System alerts and errors

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const missions = require('./lib/missions');
const agents = require('./lib/agents');
const events = require('./lib/events');
const models = require('./lib/models');
const memory = require('./lib/memory');
const policy = require('./lib/policy');
const notion = require('./lib/notion');
const gdrive = require('./lib/google_drive');
const alerts = require('./lib/alerts');
const web = require('./lib/web');
const projects = require('./lib/projects');
const content = require('./lib/content');
const linear = require('./lib/linear');

// ============================================================
// DISCORD CLIENT SETUP
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// Channel name → ID mapping (populated on ready)
const channels = {};

// ============================================================
// BOT EVENTS
// ============================================================

client.once(Events.ClientReady, async (c) => {
  console.log(`[discord] Bot ready as ${c.user.tag}`);

  // Cache channel IDs
  for (const guild of c.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.isTextBased()) {
        channels[channel.name] = channel;
      }
    }
  }

  console.log(`[discord] Cached ${Object.keys(channels).length} channels`);

  // Share channel map with alerts module so heartbeat can post to Discord
  alerts.setDiscordChannels(channels);

  await events.logEvent({
    eventType: 'discord_bot_started',
    severity: 'info',
    description: `Discord bot ready as ${c.user.tag}`
  });

  // Start polling for announcements
  pollForAnnouncements();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only respond to Zero (founder)
  const zeroDiscordId = process.env.DISCORD_ZERO_ID;
  if (zeroDiscordId && message.author.id !== zeroDiscordId) return;

  const content = message.content.trim();
  if (!content) return;

  console.log(`[discord] Message from Zero: "${content.substring(0, 80)}..."`);

  try {
    // Handle special commands
    if (content.startsWith('!')) {
      await handleCommand(message, content);
      return;
    }

    // Everything else becomes a mission proposal via Frasier
    await handleFrasierMessage(message, content);
  } catch (err) {
    console.error('[discord] Error handling message:', err.message);
    await message.reply('Something went wrong. Error logged.');
    await events.logEvent({
      eventType: 'discord_error',
      severity: 'error',
      description: `Error handling message: ${err.message}`
    });
  }
});

// ============================================================
// MESSAGE CLASSIFICATION (v0.9.0)
// ============================================================

const supabase = require('./lib/supabase');

const VALID_CLASSIFICATIONS = ['casual', 'simple_task', 'full_project'];

/**
 * Classify a Discord message as casual / simple_task / full_project.
 * WHY: Separate T1 call determines routing BEFORE Frasier's response.
 * This replaces the old action tag parsing with a dedicated classifier
 * that's cheaper, faster, and more reliable.
 *
 * @param {string} messageContent - The raw message text from Zero
 * @param {string} discordMessageId - Discord message ID for audit trail
 * @returns {{ classification, confidence, reasoning }}
 */
async function classifyMessage(messageContent, discordMessageId) {
  try {
    const result = await models.callLLM({
      systemPrompt: 'You are a message classifier for an AI agent organization. Respond only with valid JSON.',
      userMessage: `Classify this message from the founder into exactly one category.

MESSAGE: "${messageContent}"

Categories:
- "casual" — Greetings, small talk, opinions, status questions, jokes, thank-yous. No work expected.
- "simple_task" — A single deliverable request: research, analysis, comparison, content creation, vetting, recommendations. One agent can handle it.
- "full_project" — A major initiative requiring multiple phases, multiple agents, or cross-functional work. Examples: "build me an X", "launch a product line", "create a complete strategy for Y".

Respond with ONLY JSON (no markdown, no explanation):
{"classification": "casual|simple_task|full_project", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`,
      agentId: 'frasier',
      forceTier: 'tier1'
    });

    if (result.error) {
      console.log(`[classification] LLM error: ${result.error}, defaulting to simple_task`);
      return await persistClassification(messageContent, discordMessageId, {
        classification: 'simple_task', confidence: 0, reasoning: 'LLM call failed'
      });
    }

    // Parse JSON — handle markdown fences
    let parsed;
    try {
      const cleaned = result.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.log(`[classification] JSON parse failed, defaulting to simple_task`);
      return await persistClassification(messageContent, discordMessageId, {
        classification: 'simple_task', confidence: 0, reasoning: 'JSON parse failed'
      });
    }

    // Validate classification value
    if (!VALID_CLASSIFICATIONS.includes(parsed.classification)) {
      console.log(`[classification] Invalid classification "${parsed.classification}", defaulting to simple_task`);
      parsed.classification = 'simple_task';
    }

    // Default to simple_task when confidence is low — safer than guessing full_project
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    if (confidence < 0.7 && parsed.classification !== 'simple_task') {
      console.log(`[classification] Low confidence ${confidence} for "${parsed.classification}", defaulting to simple_task`);
      parsed.classification = 'simple_task';
    }

    return await persistClassification(messageContent, discordMessageId, {
      classification: parsed.classification,
      confidence,
      reasoning: parsed.reasoning || ''
    });
  } catch (err) {
    console.error(`[classification] Unexpected error: ${err.message}`);
    return { classification: 'simple_task', confidence: 0, reasoning: 'Classification error' };
  }
}

/**
 * Persist classification to message_classifications table for audit trail.
 * Returns the classification result for use by routing logic.
 */
async function persistClassification(messageContent, discordMessageId, classification) {
  await supabase.from('message_classifications').insert({
    discord_message_id: discordMessageId,
    sender_id: 'zero',
    raw_message: messageContent,
    classification: classification.classification,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    action_taken: classification.classification === 'casual' ? 'response'
      : classification.classification === 'full_project' ? 'decomposition'
      : 'proposal'
  });

  return classification;
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Handle messages as Frasier conversations.
 * Zero talks to Frasier → Frasier processes → creates proposal or responds.
 */
async function handleFrasierMessage(message, content) {
  await message.channel.sendTyping();

  // Build Frasier's prompt with memory
  const frasierAgent = await findFrasier();
  if (!frasierAgent) {
    await message.reply('Frasier is not set up yet. Run the agent setup first.');
    return;
  }

  // Extract REAL topic tags from what Zero said — not generic labels.
  // WHY: If Zero says "what about that Super Bowl game?", we need to pull memories
  // tagged with 'super-bowl', 'football', 'nfl' — not just 'founder-interaction'.
  // This is what lets Frasier recall a casual Sunday conversation on Saturday.
  const contentTopics = extractConversationTopics(content);
  const retrievalTags = ['founder-interaction', ...contentTopics];

  const promptData = await memory.buildAgentPrompt(frasierAgent.id, retrievalTags);
  if (promptData.error) {
    await message.reply(`Error loading Frasier: ${promptData.error}`);
    return;
  }

  // PRE-FETCH: If Zero's message contains URLs (tweets, articles), fetch them now
  // so Frasier has the actual content. Twitter/X URLs auto-rewrite to fxtwitter.
  const { enrichedText: enrichedContent } = await web.prefetchUrls(content);

  // Add context about what Frasier should do
  const frasierInstructions = `Zero (the founder) just sent you this message via Discord:

"${enrichedContent}"

As Chief of Staff, determine the appropriate action:
1. If this is a task or request → acknowledge it, state which team/agent you'll route it to, and what the expected deliverable is
2. If this is a question → answer it directly from your knowledge and memory
3. If this is casual conversation → engage naturally, share your genuine thoughts, be a real person. Reference past conversations if relevant.
4. If this requires approval → explain what needs approval and why

CRITICAL — LIVE DATA: If Zero asks about current prices, news, scores, weather, recent events, or ANYTHING that requires up-to-date information, you MUST use your web access. Do NOT guess or use stale training data. Instead, include [WEB_SEARCH:your query] in your response and the system will fetch live results for you. Examples:
- "What is the price of ETH?" → include [WEB_SEARCH:current ethereum ETH price USD]
- "What happened in the news today?" → include [WEB_SEARCH:today's top news]
- "How did the market do?" → include [WEB_SEARCH:stock market today S&P 500]
If you are not 100% certain the information is current, USE WEB SEARCH. Never hallucinate prices, dates, scores, or stats.

SYSTEM SPEED: Your team is AI-powered. Tasks complete in MINUTES, not days. Never quote timelines like "3 business days" or "by end of week." When routing a task, say something like "The team will have this ready shortly" or "You'll have the deliverable within minutes." Do NOT use human-team timelines.

Always be concise, professional, and action-oriented. Reference relevant context from your memory. If Zero is referencing a past conversation, recall what you both said and build on it.

AGENT NAMING: When referencing agents, ALWAYS use their name and role — e.g., "Gendo (Research Strategist)" or "Rei (Content Creator)". Never use generic labels like "the research agent" or "our content person". Check your roster for exact names and roles.

CRITICAL ACTION TAGS — You MUST end EVERY response with exactly ONE of these tags:

[ACTION:PROPOSAL] — USE THIS when Zero is asking for ANY work to be done. This includes: research, analysis, building, writing, creating, investigating, vetting, finding information, comparing options, making recommendations, or any request where a deliverable is expected. When in doubt, USE THIS. Your response should acknowledge the task and state who you'll route it to — the actual work happens in the pipeline AFTER the proposal is created.

[ACTION:RESPONSE] — ONLY use this for pure conversation with NO work request. Examples: greetings, casual chat, status questions, opinions, thank-yous, jokes. If Zero is asking you to DO anything or FIND OUT anything, this is the WRONG tag.

[ACTION:MULTI_STEP_PROPOSAL] — USE THIS when Zero's request involves MULTIPLE sequential phases requiring different expertise. Examples: "Research X, then create content based on findings," "Analyze competitors, then build a strategy, then write the pitch." Include a phase breakdown:

[PHASES]
PHASE 1: <description> | ROLE: <research|content|strategy|engineering|marketing|qa|knowledge> | TIER: <tier1|tier2>
PHASE 2: <description> | ROLE: <role> | TIER: <tier>
[/PHASES]

Each phase will execute sequentially — phase 2 only starts after phase 1 is fully approved. Each phase automatically receives the previous phase's output as context.

[ACTION:NEW_PROJECT] — USE THIS when Zero describes a major initiative that will require multiple phases and potentially multiple agents. Examples: "Build me a Real Estate AI Agent", "Launch a new product line", "Create a complete marketing strategy". Include project details:

[PROJECT_DETAILS]
NAME: <short project name>
DESCRIPTION: <1-2 sentence description>
[/PROJECT_DETAILS]

The system will create a project with lifecycle tracking (discovery → requirements → design → build → test → deploy) and ensure the right agents are available.

[ACTION:APPROVAL_NEEDED] — Use when something requires Zero's explicit approval before proceeding (e.g., spending over budget, major strategic decisions).

DEFAULT TO [ACTION:PROPOSAL] for single-step tasks, [ACTION:MULTI_STEP_PROPOSAL] for multi-phase requests, [ACTION:NEW_PROJECT] for major initiatives. It is far worse to miss a task (Zero waits forever for nothing) than to create an unnecessary proposal (which is harmless).`;

  // Call LLM as Frasier — always Tier 1, Frasier is just routing/responding
  const result = await models.callLLM({
    systemPrompt: promptData.systemPrompt,
    userMessage: frasierInstructions,
    agentId: frasierAgent.id,
    forceTier: 'tier1'
  });

  if (result.error) {
    await message.reply(`Frasier is having trouble: ${result.error}`);
    return;
  }

  let response = result.content;

  // WEB ACCESS: If Frasier embedded [WEB_SEARCH:] or [WEB_FETCH:] tags, resolve them
  // and re-call the LLM with the live data. Same pattern as worker.js.
  const webResolution = await web.resolveWebTags(response);
  if (webResolution.hasWebTags) {
    console.log(`[discord] Frasier requested ${webResolution.results.length} web resource(s). Fetching...`);
    const webContext = web.formatWebResults(webResolution.results);

    const followUp = await models.callLLM({
      systemPrompt: promptData.systemPrompt,
      userMessage: `${frasierInstructions}\n\nHere is live web data you requested:\n${webContext}\n\nUsing the live data above, respond to Zero's message. Do NOT include [WEB_SEARCH] or [WEB_FETCH] tags in this response.`,
      agentId: frasierAgent.id,
      forceTier: 'tier1'
    });

    if (followUp.content) {
      response = followUp.content;
      console.log('[discord] Frasier web-enriched response generated.');
    }
  }

  // Parse the action tag
  if (response.includes('[ACTION:NEW_PROJECT]')) {
    // NEW PROJECT: Create a project with lifecycle tracking, determine needed roles,
    // find/hire agents, and create the first mission.
    const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').replace(/\[PROJECT_DETAILS\][\s\S]*?\[\/PROJECT_DETAILS\]/g, '').trim();

    // Parse project details
    const detailsMatch = response.match(/\[PROJECT_DETAILS\]([\s\S]*?)\[\/PROJECT_DETAILS\]/);
    const nameMatch = detailsMatch && detailsMatch[1].match(/NAME:\s*(.+)/i);
    const descMatch = detailsMatch && detailsMatch[1].match(/DESCRIPTION:\s*(.+)/i);

    const projectName = nameMatch ? nameMatch[1].trim() : content.substring(0, 100);
    const projectDesc = descMatch ? descMatch[1].trim() : content;

    try {
      // Create the project
      const project = await projects.createProject({
        name: projectName,
        description: projectDesc,
        originalMessage: content
      });

      if (project) {
        // Determine needed roles dynamically via LLM and ensure agents exist
        const neededRoles = await agents.determineDynamicProjectRoles(projectDesc);
        const roleStatus = [];

        for (const role of neededRoles) {
          const existing = await agents.findBestAgentAcrossTeams(role.category);
          if (existing) {
            roleStatus.push(`${existing.display_name} (${existing.role}) — ready`);
          } else {
            const hired = await agents.autoHireGapAgent(role.title, role.category, {
              projectDescription: projectDesc,
              projectName: projectName
            });
            if (hired) {
              roleStatus.push(`${hired.display_name} (${role.title}) — newly hired`);
            }
          }
        }

        // Create first proposal for discovery phase
        await missions.createProposal({
          proposingAgentId: 'zero',
          title: `[PROJECT:${project.id}] Discovery: ${projectName}`,
          description: `[PROJECT:${project.id}] ${content}`,
          priority: 'normal',
          rawMessage: content
        });

        const statusLines = roleStatus.length > 0
          ? '\n' + roleStatus.map(s => `  - ${s}`).join('\n')
          : '';

        await sendSplit(message.channel,
          cleanResponse +
          `\n\n*Project "${projectName}" created (ID: #${project.id}). Lifecycle tracking active.*` +
          (statusLines ? `\n*Team:${statusLines}*` : '') +
          '\n*Discovery phase mission created. Team will start shortly.*'
        );
      } else {
        await sendSplit(message.channel, cleanResponse + '\n\n*Failed to create project. Mission proposal created as fallback.*');
        await missions.createProposal({
          proposingAgentId: 'zero',
          title: cleanProposalTitle(content),
          description: content,
          rawMessage: content
        });
      }
    } catch (err) {
      console.error(`[discord] Project creation failed:`, err.message);
      await sendSplit(message.channel, cleanResponse + '\n\n*Mission proposal created.*');
      await missions.createProposal({
        proposingAgentId: 'zero',
        title: cleanProposalTitle(content),
        description: content,
        rawMessage: content
      });
    }

  } else if (response.includes('[ACTION:MULTI_STEP_PROPOSAL]')) {
    // Multi-phase mission — include the [PHASES] block in the proposal description
    // so heartbeat can parse it downstream and create chained steps
    const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();

    // Extract the phases block from Frasier's response and append to description
    const phasesMatch = response.match(/\[PHASES\][\s\S]*?\[\/PHASES\]/);
    const description = phasesMatch
      ? `${content}\n\n${phasesMatch[0]}`
      : content; // Fallback: if phases block malformed, treat as single-step

    const phases = missions.parsePhases(description);
    const phaseCount = phases.length;

    await missions.createProposal({
      proposingAgentId: 'zero',
      title: cleanProposalTitle(content),
      description,
      priority: content.toLowerCase().includes('urgent') ? 'urgent' : 'normal',
      rawMessage: content
    });

    const suffix = phaseCount > 1
      ? `\n\n*Multi-step mission proposal created (${phaseCount} phases). Team will execute sequentially.*`
      : '\n\n*Mission proposal created. Team will pick this up shortly.*';
    await sendSplit(message.channel, cleanResponse.replace(/\[PHASES\][\s\S]*?\[\/PHASES\]/g, '').trim() + suffix);

  } else if (response.includes('[ACTION:PROPOSAL]')) {
    // Single-step mission proposal
    const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();
    await missions.createProposal({
      proposingAgentId: 'zero',
      title: cleanProposalTitle(content),
      description: content,
      priority: content.toLowerCase().includes('urgent') ? 'urgent' : 'normal',
      rawMessage: content
    });

    await sendSplit(message.channel, cleanResponse + '\n\n*Mission proposal created. Team will pick this up shortly.*');
  } else {
    // Just a response
    const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();
    await sendSplit(message.channel, cleanResponse);
  }

  // Save FULL exchange to Frasier's memory with content-based topic tags.
  // Both Zero's message AND Frasier's response are saved so the complete
  // back-and-forth is available on future retrieval.
  const saveTags = ['founder-interaction', 'founder-request', ...contentTopics];

  // Save Zero's message as its own memory (so individual turns are retrievable)
  await memory.saveMemory({
    agentId: frasierAgent.id,
    memoryType: 'conversation',
    content: `Zero said: "${content}"`,
    summary: `Zero: ${content.substring(0, 150)}`,
    topicTags: saveTags,
    importance: 8,
    sourceType: 'conversation',
    relatedAgentIds: ['zero']
  });

  // Save Frasier's response as its own memory
  const cleanResponse = response.replace(/\[ACTION:\w+\]/g, '').trim();
  await memory.saveMemory({
    agentId: frasierAgent.id,
    memoryType: 'conversation',
    content: `I said to Zero: "${cleanResponse}"`,
    summary: `My response to Zero: ${cleanResponse.substring(0, 150)}`,
    topicTags: saveTags,
    importance: 7,
    sourceType: 'conversation',
    relatedAgentIds: ['zero']
  });

  // LESSON EXTRACTION: If Zero gives a directive, preference, or strategic instruction,
  // save it as a permanent lesson so Frasier NEVER forgets it.
  const isDirective = detectFounderDirective(content);
  if (isDirective) {
    await memory.saveLesson({
      agentId: frasierAgent.id,
      lesson: `Zero's instruction: "${content.substring(0, 400)}"`,
      context: `Founder directive via Discord`,
      category: 'founder-directive',
      importance: 9
    });
    console.log(`[discord] Saved founder directive as permanent lesson: "${content.substring(0, 80)}..."`);
  }

  // Save conversation to history
  await memory.saveConversation({
    conversationId: `discord-${Date.now()}`,
    conversationType: 'founder_chat',
    senderAgentId: 'zero',
    recipientAgentId: frasierAgent.id,
    content,
    context: 'Discord DM'
  });
}

/**
 * Handle special commands (!status, !teams, !costs, etc.)
 */
async function handleCommand(message, content) {
  const [cmd, ...args] = content.substring(1).split(' ');

  switch (cmd.toLowerCase()) {
    case 'status': {
      const activeAgents = await agents.getAllActiveAgents();
      const activeMissions = await missions.getActiveMissions();
      const teams = await agents.getAllTeams();

      let reply = '**System Status**\n';
      reply += `Teams: ${teams.map(t => `${t.name} [${t.status}]`).join(', ')}\n`;
      reply += `Active Agents: ${activeAgents.length}\n`;
      reply += `Active Missions: ${activeMissions.length}\n`;
      await sendSplit(message.channel, reply);
      break;
    }

    case 'teams': {
      const teams = await agents.getAllTeams();
      let reply = '**Teams**\n';
      for (const team of teams) {
        const teamAgents = await agents.getTeamAgents(team.id);
        reply += `\n**${team.name}** [${team.status}]\n`;
        if (teamAgents.length > 0) {
          for (const a of teamAgents) {
            reply += `  - ${a.display_name} (${a.role}) [${a.status}]\n`;
          }
        } else {
          reply += '  No agents assigned\n';
        }
      }
      await sendSplit(message.channel, reply);
      break;
    }

    case 'costs': {
      const since = new Date();
      since.setHours(0, 0, 0, 0); // Today
      const costs = await models.getModelCosts(since.toISOString());
      if (!costs) {
        await message.reply('Unable to fetch cost data.');
        return;
      }
      let reply = '**Today\'s LLM Costs**\n';
      reply += `Tier 1 (MiniMax): ${costs.tier1.calls} calls, $${costs.tier1.cost.toFixed(4)}\n`;
      reply += `Tier 2 (Sonnet): ${costs.tier2.calls} calls, $${costs.tier2.cost.toFixed(4)}\n`;
      reply += `Tier 3 (Opus): ${costs.tier3.calls} calls, $${costs.tier3.cost.toFixed(4)}\n`;
      reply += `**Total: ${costs.total.calls} calls, $${costs.total.cost.toFixed(4)}, ${costs.total.tokens.toLocaleString()} tokens**`;
      await message.reply(reply);
      break;
    }

    case 'approve': {
      const stepId = parseInt(args[0]);
      if (!stepId) {
        await message.reply('Usage: !approve <step_id>');
        return;
      }
      await missions.approveStep(stepId);
      await message.reply(`Step #${stepId} approved.`);
      break;
    }

    case 'activate': {
      const teamId = args[0];
      if (!teamId) {
        await message.reply('Usage: !activate <team-id>');
        return;
      }
      const success = await agents.setTeamStatus(teamId, 'active');
      await message.reply(success ? `Team ${teamId} activated.` : `Failed to activate ${teamId}.`);
      break;
    }

    case 'deactivate': {
      const teamId = args[0];
      if (!teamId) {
        await message.reply('Usage: !deactivate <team-id>');
        return;
      }
      const success = await agents.setTeamStatus(teamId, 'dormant');
      await message.reply(success ? `Team ${teamId} deactivated.` : `Failed to deactivate ${teamId}.`);
      break;
    }

    case 'hire': {
      const hireId = parseInt(args[0]);
      if (!hireId) {
        await message.reply('Usage: `!hire <proposal_id>`');
        return;
      }

      const hire = await agents.getHiringProposal(hireId);
      if (!hire) {
        await message.reply(`Hiring proposal #${hireId} not found.`);
        return;
      }
      if (hire.status !== 'pending') {
        await message.reply(`Hiring proposal #${hireId} is already ${hire.status}.`);
        return;
      }

      const approved = await agents.approveHiringProposal(hireId);
      if (approved) {
        await message.reply(`Hiring proposal #${hireId} approved. A new **${hire.role}** will be created on **${hire.team_id}** shortly.`);
      } else {
        await message.reply(`Failed to approve hiring proposal #${hireId}.`);
      }
      break;
    }

    case 'reject': {
      const rejectId = parseInt(args[0]);
      if (!rejectId) {
        await message.reply('Usage: `!reject <proposal_id>`');
        return;
      }

      const rejected = await agents.rejectHiringProposal(rejectId);
      if (rejected) {
        await message.reply(`Hiring proposal #${rejectId} rejected.`);
      } else {
        await message.reply(`Failed to reject hiring proposal #${rejectId}. It may not be pending.`);
      }
      break;
    }

    case 'fire': {
      const agentName = args.join(' ').trim();
      if (!agentName) {
        await message.reply('Usage: `!fire <agent_name>`');
        return;
      }

      // Find Frasier — can't fire the chief of staff
      const frasier = await findFrasier();

      // Find the agent by display_name (case-insensitive)
      const allAgents = await agents.getAllActiveAgents();
      const target = allAgents.find(a => a.display_name.toLowerCase() === agentName.toLowerCase());

      if (!target) {
        await message.reply(`No active agent named "${agentName}" found. Use \`!roster\` to see all agents.`);
        return;
      }

      if (frasier && target.id === frasier.id) {
        await message.reply(`Can't fire Frasier (Chief of Staff). The organization needs a leader.`);
        return;
      }

      await agents.setAgentStatus(target.id, 'retired');
      await message.reply(`**${target.display_name}** (${target.role}) has been retired from ${target.team_id}. Name released back to the pool.`);

      await events.logEvent({
        eventType: 'agent_fired',
        agentId: target.id,
        teamId: target.team_id,
        severity: 'info',
        description: `${target.display_name} (${target.role}) retired by Zero`
      });
      break;
    }

    case 'roster': {
      const teams = await agents.getAllTeams();
      let reply = '**Agent Roster**\n';

      for (const team of teams) {
        const teamAgents = await agents.getTeamAgents(team.id);
        reply += `\n**${team.name}** [${team.status}]\n`;

        if (teamAgents.length > 0) {
          for (const a of teamAgents) {
            const typeTag = a.agent_type === 'chief_of_staff' ? ' (CoS)' :
              a.agent_type === 'team_lead' ? ' (Lead)' :
              a.agent_type === 'qa' ? ' (QA)' : '';
            reply += `  - ${a.display_name} — ${a.role}${typeTag} [${a.status}]\n`;
          }
        } else {
          reply += '  No agents assigned\n';
        }
      }

      // Show pending hiring proposals
      const pendingHires = await agents.getAllHiringProposals();
      const pending = pendingHires.filter(h => h.status === 'pending');
      const approved = pendingHires.filter(h => h.status === 'approved');

      if (pending.length > 0 || approved.length > 0) {
        reply += '\n**Hiring Proposals**\n';
        for (const h of pending) {
          reply += `  - #${h.id}: ${h.role} for ${h.team_id} [pending — \`!hire ${h.id}\`]\n`;
        }
        for (const h of approved) {
          reply += `  - #${h.id}: ${h.role} for ${h.team_id} [approved — creating agent...]\n`;
        }
      }

      await sendSplit(message.channel, reply);
      break;
    }

    case 'newbiz': {
      const bizName = args.join(' ').trim();
      if (!bizName) {
        await message.reply('Usage: `!newbiz <business_name>`');
        return;
      }

      // Generate a slug-style ID from the name
      const bizId = bizName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const biz = await agents.createBusiness({
        id: bizId,
        name: bizName,
        description: `Business unit: ${bizName}`
      });

      if (biz) {
        await message.reply(`Business **${bizName}** (${bizId}) created.`);
      } else {
        await message.reply(`Failed to create business "${bizName}". It may already exist.`);
      }
      break;
    }

    case 'content': {
      await handleContentCommand(message, args);
      break;
    }

    case 'watchlist': {
      await handleWatchlistCommand(message, args);
      break;
    }

    case 'help': {
      await message.reply(
        '**Commands:**\n' +
        '`!status` — System overview\n' +
        '`!teams` — List all teams and agents\n' +
        '`!roster` — Full agent roster + pending hires\n' +
        '`!costs` — Today\'s LLM costs\n' +
        '`!approve <step_id>` — Approve a pending step\n' +
        '`!hire <id>` — Approve a hiring proposal\n' +
        '`!reject <id>` — Reject a hiring proposal\n' +
        '`!fire <name>` — Retire an agent\n' +
        '`!newbiz <name>` — Create a business unit\n' +
        '`!activate <team-id>` — Activate a team\n' +
        '`!deactivate <team-id>` — Deactivate a team\n' +
        '\n**Content Pipeline:**\n' +
        '`!content list` — Show drafts waiting for review\n' +
        '`!content view <id>` — View full draft details\n' +
        '`!content approve <id>` — Approve a draft for publishing\n' +
        '`!content reject <id>` — Reject a draft permanently\n' +
        '`!content revise <id> [feedback]` — Send back for revision\n' +
        '`!content stats` — Pipeline statistics\n' +
        '\n**Watchlist:**\n' +
        '`!watchlist list` — Show current watchlist\n' +
        '`!watchlist add topic "AI agents"` — Add a topic\n' +
        '`!watchlist add account @handle` — Add a Twitter account\n' +
        '`!watchlist remove <id or value>` — Remove an item\n' +
        '\nOr just type normally to talk to Frasier.'
      );
      break;
    }

    default:
      await message.reply(`Unknown command: !${cmd}. Type !help for available commands.`);
  }
}

// ============================================================
// CONTENT PIPELINE COMMAND HANDLER
// ============================================================

/**
 * Handle !content subcommands: list, view, approve, reject, revise, stats.
 * WHY: Contentron has no Discord bot. These commands let Zero manage the
 * content pipeline directly from Discord via shared Supabase tables.
 */
async function handleContentCommand(message, args) {
  var sub = (args[0] || '').toLowerCase();

  switch (sub) {
    case 'list':
    case 'queue': {
      var result = await content.listQueuedDrafts();
      if (result.drafts.length === 0) {
        await message.reply('No drafts in the queue right now.');
        return;
      }

      var reply = '**Content Queue** (' + result.drafts.length + ' of ' + result.total + ' drafts)\n\n';
      result.drafts.forEach(function(d, i) {
        var shortId = (d.id || '').substring(0, 8);
        var pillar = content.pillarName(d.pillar);
        var score = d.score_overall ? d.score_overall.toFixed(1) : '—';
        var date = d.created_at ? new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        reply += (i + 1) + '. **' + (d.title || 'Untitled') + '** [' + shortId + ']\n';
        reply += '   ' + (d.format || '—') + ' | Pillar ' + (d.pillar || '?') + ': ' + pillar + ' | Score: ' + score + ' | ' + date + '\n\n';
      });

      if (result.total > 10) {
        reply += '...and ' + (result.total - 10) + ' more. Showing top 10 by score.\n';
      }
      reply += 'Use `!content view <id>` for full details.';
      await sendSplit(message.channel, reply);
      break;
    }

    case 'view': {
      var draftId = args[1];
      if (!draftId) {
        await message.reply('Usage: `!content view <id>`');
        return;
      }

      var draft = await content.viewDraft(draftId);
      if (!draft) {
        await message.reply('Draft not found. Check the ID and try again.');
        return;
      }

      var shortId = (draft.id || '').substring(0, 8);
      var reply = '**' + (draft.title || 'Untitled') + '** [' + shortId + ']\n';
      reply += 'Status: ' + draft.status + ' | Format: ' + (draft.format || '—') + ' | Pillar ' + (draft.pillar || '?') + ': ' + content.pillarName(draft.pillar) + '\n';
      reply += 'Score: ' + (draft.score_overall ? draft.score_overall.toFixed(1) : '—') + '/5.0';

      // Score breakdown
      if (draft.score_breakdown) {
        var sb = draft.score_breakdown;
        reply += ' (';
        var parts = [];
        if (sb.voice_match != null) parts.push('Voice: ' + sb.voice_match);
        if (sb.clarity != null) parts.push('Clarity: ' + sb.clarity);
        if (sb.value != null) parts.push('Value: ' + sb.value);
        if (sb.engagement_potential != null) parts.push('Engagement: ' + sb.engagement_potential);
        if (sb.originality != null) parts.push('Originality: ' + sb.originality);
        reply += parts.join(', ') + ')';
      }
      reply += '\n';

      if (draft.source_topic) {
        reply += 'Source: ' + draft.source_topic + '\n';
      }
      if (draft.revision_count) {
        reply += 'Revisions: ' + draft.revision_count + '\n';
      }

      // Editor issues
      if (draft.editor_issues && draft.editor_issues.length > 0) {
        reply += '\n**Issues:**\n';
        draft.editor_issues.forEach(function(issue) {
          reply += '  - ' + issue + '\n';
        });
      }

      // Editor suggestions
      if (draft.editor_suggestions && draft.editor_suggestions.length > 0) {
        reply += '\n**Suggestions:**\n';
        draft.editor_suggestions.forEach(function(sug) {
          reply += '  - ' + sug + '\n';
        });
      }

      // Full content
      if (draft.content_text) {
        reply += '\n**Content:**\n```\n' + draft.content_text + '\n```';
      }

      await sendSplit(message.channel, reply);
      break;
    }

    case 'approve': {
      var draftId = args[1];
      if (!draftId) {
        await message.reply('Usage: `!content approve <id>`');
        return;
      }

      var result = await content.approveDraft(draftId);
      if (result.ok) {
        await message.reply('Draft **' + (result.draft.title || 'Untitled') + '** approved for publishing. Contentron will pick it up on the next tick.');
        await events.logEvent({
          eventType: 'content_approved',
          severity: 'info',
          description: 'Draft "' + (result.draft.title || draftId) + '" approved by Zero',
          data: { draftId: result.draft.id }
        });
      } else if (result.reason === 'already_published') {
        await message.reply('That draft is already published. No action needed.');
      } else if (result.reason === 'not_found') {
        await message.reply('Draft not found. Check the ID and try again.');
      } else {
        await message.reply('Failed to approve draft: ' + (result.message || result.reason));
      }
      break;
    }

    case 'reject': {
      var draftId = args[1];
      if (!draftId) {
        await message.reply('Usage: `!content reject <id>`');
        return;
      }

      var result = await content.rejectDraft(draftId);
      if (result.ok) {
        await message.reply('Draft **' + (result.draft.title || 'Untitled') + '** rejected and discarded.');
        await events.logEvent({
          eventType: 'content_rejected',
          severity: 'info',
          description: 'Draft "' + (result.draft.title || draftId) + '" rejected by Zero',
          data: { draftId: result.draft.id }
        });
      } else if (result.reason === 'already_discarded') {
        await message.reply('That draft is already discarded. No action needed.');
      } else if (result.reason === 'not_found') {
        await message.reply('Draft not found. Check the ID and try again.');
      } else {
        await message.reply('Failed to reject draft: ' + (result.message || result.reason));
      }
      break;
    }

    case 'revise': {
      var draftId = args[1];
      if (!draftId) {
        await message.reply('Usage: `!content revise <id> [feedback]`');
        return;
      }

      // Everything after the id is feedback text
      var feedback = args.slice(2).join(' ').trim() || null;

      var result = await content.reviseDraft(draftId, feedback);
      if (result.ok) {
        var msg = 'Draft **' + (result.draft.title || 'Untitled') + '** sent back for revision.';
        if (feedback) msg += ' Feedback: "' + feedback + '"';
        msg += ' Contentron\'s Writer will pick this up on the next tick.';
        await message.reply(msg);
        await events.logEvent({
          eventType: 'content_revision_requested',
          severity: 'info',
          description: 'Draft "' + (result.draft.title || draftId) + '" sent for revision by Zero',
          data: { draftId: result.draft.id, feedback: feedback }
        });
      } else if (result.reason === 'not_queued') {
        await message.reply('That draft isn\'t in the queue (status: not "queued"). Only queued drafts can be sent back for revision.');
      } else if (result.reason === 'not_found') {
        await message.reply('Draft not found. Check the ID and try again.');
      } else {
        await message.reply('Failed to revise draft: ' + (result.message || result.reason));
      }
      break;
    }

    case 'stats': {
      var stats = await content.getDraftStats();
      var reply = '**Content Pipeline Stats**\n\n';
      reply += '**Drafts by Status:**\n';

      var statuses = ['draft', 'editing', 'queued', 'revision', 'published', 'discarded'];
      statuses.forEach(function(s) {
        var count = stats.byStatus[s] || 0;
        reply += '  ' + s + ': ' + count + '\n';
      });

      reply += '\n**Published (last 7 days):** ' + stats.publishedLast7Days;
      reply += '\n**New research items:** ' + stats.newResearch;
      await message.reply(reply);
      break;
    }

    default:
      await message.reply(
        '**Content commands:**\n' +
        '`!content list` — Show drafts in queue\n' +
        '`!content view <id>` — View draft details\n' +
        '`!content approve <id>` — Approve for publishing\n' +
        '`!content reject <id>` — Reject permanently\n' +
        '`!content revise <id> [feedback]` — Send back for revision\n' +
        '`!content stats` — Pipeline statistics'
      );
  }
}

// ============================================================
// WATCHLIST COMMAND HANDLER
// ============================================================

/**
 * Handle !watchlist subcommands: list, add, remove.
 * WHY: Scout monitors these items. Adding/removing from Discord
 * gives Zero control over what Scout watches on the next cycle.
 */
async function handleWatchlistCommand(message, args) {
  var sub = (args[0] || '').toLowerCase();

  switch (sub) {
    case 'list': {
      var items = await content.listWatchlist();
      if (items.length === 0) {
        await message.reply('Watchlist is empty. Use `!watchlist add topic "AI agents"` to add items.');
        return;
      }

      // Group by category
      var grouped = {};
      items.forEach(function(item) {
        var cat = item.category || 'other';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(item);
      });

      var reply = '**Watchlist** (' + items.length + ' items)\n';
      var categoryLabels = {
        'core': 'Core Topics',
        'supporting': 'Supporting Topics',
        'trending': 'Trending'
      };

      Object.keys(grouped).forEach(function(cat) {
        reply += '\n**' + (categoryLabels[cat] || cat) + ':**\n';
        grouped[cat].forEach(function(item) {
          var shortId = (item.id || '').substring(0, 8);
          var activeTag = item.active === false ? ' [inactive]' : '';
          reply += '  - ' + item.value + ' (' + item.type + ') [' + shortId + ']' + activeTag + '\n';
        });
      });

      await sendSplit(message.channel, reply);
      break;
    }

    case 'add': {
      var type = (args[1] || '').toLowerCase();
      if (!type) {
        await message.reply('Usage: `!watchlist add topic "AI agents"` or `!watchlist add account @handle`');
        return;
      }

      // Parse value — may be quoted: !watchlist add topic "multimodal AI"
      var valueArgs = args.slice(2);
      var value = valueArgs.join(' ').replace(/^["']|["']$/g, '').trim();

      if (!value) {
        await message.reply('Usage: `!watchlist add ' + type + ' <value>`');
        return;
      }

      var result = await content.addWatchlistItem(type, value);
      if (result.ok) {
        await message.reply('Added **' + value + '** (' + result.item.type + ') to the watchlist. Scout will pick this up on the next cycle.');
        await events.logEvent({
          eventType: 'watchlist_item_added',
          severity: 'info',
          description: 'Watchlist item "' + value + '" added by Zero',
          data: { type: type, value: value }
        });
      } else if (result.reason === 'invalid_type') {
        await message.reply('Invalid type "' + type + '". Use `topic`, `account`, or `rss`.');
      } else {
        await message.reply('Failed to add watchlist item: ' + (result.message || result.reason));
      }
      break;
    }

    case 'remove': {
      var idOrValue = args.slice(1).join(' ').replace(/^["']|["']$/g, '').trim();
      if (!idOrValue) {
        await message.reply('Usage: `!watchlist remove <id or value>`');
        return;
      }

      var result = await content.removeWatchlistItem(idOrValue);
      if (result.ok) {
        await message.reply('Removed **' + result.item.value + '** from the watchlist.');
        await events.logEvent({
          eventType: 'watchlist_item_removed',
          severity: 'info',
          description: 'Watchlist item "' + result.item.value + '" removed by Zero',
          data: { value: result.item.value }
        });
      } else if (result.reason === 'not_found') {
        await message.reply('Item not found. Use `!watchlist list` to see current items.');
      } else {
        await message.reply('Failed to remove item: ' + (result.message || result.reason));
      }
      break;
    }

    default:
      await message.reply(
        '**Watchlist commands:**\n' +
        '`!watchlist list` — Show current watchlist\n' +
        '`!watchlist add topic "AI agents"` — Add a topic\n' +
        '`!watchlist add account @handle` — Add a Twitter account\n' +
        '`!watchlist remove <id or value>` — Remove an item'
      );
  }
}

// ============================================================
// ANNOUNCEMENT POLLING
// ============================================================

/**
 * Poll for unannounced events and post them to Discord.
 * Runs every 30 seconds alongside the main bot.
 */
async function pollForAnnouncements() {
  setInterval(async () => {
    try {
      await announceCompletedSteps();
      await announceHiringProposals();
      await announceAlerts();
    } catch (err) {
      console.error('[discord] Announcement polling error:', err.message);
    }
  }, 30 * 1000);
}

/**
 * Announce completed and approved mission steps.
 * Multi-step support: intermediate steps get progress messages,
 * only the final step publishes to Notion/Drive.
 */
async function announceCompletedSteps() {
  const supabase = require('./lib/supabase');

  const { data: steps, error } = await supabase
    .from('mission_steps')
    .select('*, missions!inner(title, team_id)')
    .eq('status', 'completed')
    .eq('announced', false)
    .limit(5);

  if (error) {
    console.error('[discord] announceCompletedSteps query error:', error.message || error);
    return;
  }
  if (!steps || steps.length === 0) return;

  for (const step of steps) {
    try {
      // Mark as announced FIRST to prevent duplicate Notion/Drive publishes
      // WHY: If Supabase 500s after publishing, the step stays announced=false
      // and gets re-published every poll cycle (duplicate pages/docs).
      const { error: updateErr } = await supabase
        .from('mission_steps')
        .update({ announced: true })
        .eq('id', step.id);

      if (updateErr) {
        console.error(`[discord] Failed to mark step #${step.id} as announced: ${updateErr.message}`);
        continue; // Skip — don't publish if we can't prevent duplicates
      }

      // Determine which channel to post in
      const channelName = getTeamChannel(step.missions.team_id);
      const channel = channels[channelName] || channels['general'];
      if (!channel) {
        console.warn(`[discord] No channel found for team ${step.missions.team_id} (tried: ${channelName}, general). Skipping step #${step.id}`);
        continue;
      }

      // Build announcement
      const agent = await agents.getAgent(step.assigned_agent_id);
      const agentName = agent?.display_name || step.assigned_agent_id;

      // Check if this is part of a multi-step mission
      const { data: allSteps } = await supabase
        .from('mission_steps')
        .select('id, step_order, status')
        .eq('mission_id', step.mission_id)
        .order('step_order', { ascending: true });

      const totalSteps = allSteps?.length || 1;
      const isMultiStep = totalSteps > 1;
      const currentOrder = step.step_order || 1;
      const isFinalStep = !isMultiStep || currentOrder === totalSteps;

      // Fetch Linear project link for announcements
      let linearUrl = null;
      try {
        linearUrl = await linear.getProjectUrl(step.mission_id);
      } catch (err) {
        // Non-blocking — Linear link is nice-to-have
      }

      if (isMultiStep && !isFinalStep) {
        // INTERMEDIATE STEP: progress message only, no Notion/Drive publish
        const linearLink = linearUrl ? `\n[Linear](${linearUrl})` : '';
        const announcement = `**Phase ${currentOrder}/${totalSteps} Complete** — ${step.missions.title}\nAgent: ${agentName} | Next phase starting automatically...${linearLink}`;
        await sendSplit(channel, announcement);
      } else {
        // FINAL STEP (or single-step mission): publish to Notion and Google Drive
        let notionPage = null, driveDoc = null;
        try {
          [notionPage, driveDoc] = await Promise.all([
            notion.publishDeliverable({
              title: step.missions.title,
              content: step.result || '',
              teamId: step.missions.team_id,
              agentName,
              missionId: step.mission_id,
              stepId: step.id
            }),
            gdrive.publishDeliverable({
              title: step.missions.title,
              content: step.result || '',
              teamId: step.missions.team_id,
              agentName,
              missionId: step.mission_id,
              stepId: step.id
            })
          ]);
        } catch (publishErr) {
          console.error(`[discord] Notion/Drive publish failed for step #${step.id}: ${publishErr.message}`);
        }

        // Post deliverable link as comment on Linear issue (fire-and-forget)
        if (driveDoc?.url) {
          linear.addIssueComment(step.id, `Deliverable ready: ${driveDoc.url}`).catch(err =>
            console.error(`[discord] Linear comment failed (non-blocking): ${err.message}`)
          );
        }

        const links = [];
        if (notionPage?.url) links.push(`[Notion](${notionPage.url})`);
        if (driveDoc?.url) links.push(`[Google Doc](${driveDoc.url})`);
        if (linearUrl) links.push(`[Linear](${linearUrl})`);
        const linkText = links.length > 0 ? `\n${links.join(' | ')}` : '';

        const announcement = isMultiStep
          ? `**Mission Complete (${totalSteps}/${totalSteps} phases)** — ${step.missions.title}\nAgent: ${agentName} | All phases approved${linkText}`
          : `**Deliverable Ready** — ${step.missions.title}\nAgent: ${agentName} | Approved by Team Lead${linkText}`;

        await sendSplit(channel, announcement);
      }

      console.log(`[discord] Announced step #${step.id}: ${step.missions.title}`);

    } catch (err) {
      console.error(`[discord] Failed to announce step #${step.id}: ${err.message}`);
    }
  }
}

/**
 * Announce pending hiring proposals to Discord.
 * Posts to #frasier-dm so Zero can approve with !hire <id>.
 */
async function announceHiringProposals() {
  const pendingHires = await agents.getPendingHiringProposals();
  if (pendingHires.length === 0) return;

  const channel = channels['frasier-dm'] || channels['general'];
  if (!channel) return;

  for (const hire of pendingHires) {
    const msg = `**Hiring Proposal #${hire.id}**\n` +
      `Role: ${hire.role}\n` +
      `Team: ${hire.team_id}\n` +
      `Reason: ${hire.justification || 'Team needs this role'}\n\n` +
      `Reply \`!hire ${hire.id}\` to approve or \`!reject ${hire.id}\` to reject.`;

    await sendSplit(channel, msg);
    await agents.markHiringProposalAnnounced(hire.id);
  }
}

/**
 * Announce critical alerts.
 */
async function announceAlerts() {
  const unprocessedErrors = await events.getUnprocessedEvents('worker_error');
  const tier3Requests = await events.getUnprocessedEvents('tier3_escalation_needed');

  const alertChannel = channels['alerts'] || channels['frasier-dm'] || channels['general'];
  if (!alertChannel) return;

  // Post error alerts
  for (const evt of unprocessedErrors.slice(0, 3)) {
    await sendSplit(alertChannel, `⚠ **Error:** ${evt.description}`);
    await events.markProcessed([evt.id]);
  }

  // Post Tier 3 escalation requests
  for (const evt of tier3Requests) {
    await sendSplit(alertChannel,
      `🔴 **Tier 3 Escalation Request**\n${evt.description}\n\nReply \`!approve ${evt.data?.stepId}\` to authorize Claude Opus 4.5.`
    );
    await events.markProcessed([evt.id]);
  }

  // Post revision cap alerts — 3 rejections, step failed, needs founder attention
  const revisionCapEvents = await events.getUnprocessedEvents('revision_cap_reached');
  for (const evt of revisionCapEvents) {
    // Get Linear ticket URL for the step so Dhroov can click through
    let linearUrl = '';
    try {
      const { data: sync } = await supabase
        .from('linear_sync')
        .select('entity_url')
        .eq('mission_step_id', evt.data?.stepId)
        .eq('entity_type', 'issue')
        .maybeSingle();
      if (sync?.entity_url) linearUrl = `\n[View in Linear](${sync.entity_url})`;
    } catch (err) {
      // Non-blocking — URL is nice-to-have
    }

    await sendSplit(alertChannel,
      `**Revision Cap Reached** — ${evt.description}` +
      `\nThe step was rejected ${evt.data?.rejectionCount || 3} times and has been failed.` +
      `\nReview the rejection comments in Linear and decide next steps.` +
      linearUrl
    );
    await events.markProcessed([evt.id]);
  }

  // Post agent upskill notifications
  const upskillEvents = await events.getUnprocessedEvents('agent_upskilled');
  const updatesChannel = channels['updates'] || channels['general'];
  for (const evt of upskillEvents) {
    const ch = updatesChannel || alertChannel;
    if (!ch) continue;
    await sendSplit(ch,
      `📈 **Agent Upskilled** — ${evt.description}\nSkill gap: ${evt.data?.skillGap || 'unknown'}\nThe agent's persona has been permanently upgraded. Retrying the task.`
    );
    await events.markProcessed([evt.id]);
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Find Frasier agent in the database.
 */
async function findFrasier() {
  const supabase = require('./lib/supabase');
  const { data } = await supabase
    .from('agents')
    .select('*')
    .eq('agent_type', 'chief_of_staff')
    .eq('status', 'active')
    .limit(1)
    .single();

  return data || null;
}

/**
 * Generate a clean, human-readable title from a raw founder message.
 * WHY: Raw messages contain Discord mentions (<@id>), URLs, and verbosity
 * that make terrible titles in announcements and Notion/Drive.
 */
function cleanProposalTitle(rawContent) {
  let title = rawContent
    // Remove Discord mentions
    .replace(/<@!?\d+>/g, '')
    // Remove URLs
    .replace(/https?:\/\/\S+/g, '')
    // Remove [PROJECT:N] tags
    .replace(/\[PROJECT:\d+\]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) return 'Mission from Zero';

  // Take first sentence (period, question mark, exclamation, or newline)
  const firstSentence = title.split(/[.?!\n]/)[0].trim();
  if (firstSentence.length > 10) {
    title = firstSentence;
  }

  // Cap at 120 chars, break at word boundary
  if (title.length > 120) {
    title = title.substring(0, 120).replace(/\s+\S*$/, '').trim();
  }

  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return title;
}

/**
 * Map team IDs to Discord channel names.
 */
function getTeamChannel(teamId) {
  const map = {
    'team-research': 'team-research',
    'team-execution': 'team-execution',
    'team-advisory': 'team-advisory'
  };
  return map[teamId] || 'general';
}

/**
 * Send a message to a channel, splitting if over 2000 chars.
 * WHY: Discord has a 2000-char limit. Never silently truncate.
 */
async function sendSplit(channel, text) {
  if (!channel || !text) return;

  const MAX_LEN = 1900; // Leave buffer
  if (text.length <= MAX_LEN) {
    await channel.send(text);
    return;
  }

  // Split on newlines or at max length
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitIdx === -1 || splitIdx < MAX_LEN / 2) {
      splitIdx = MAX_LEN; // Hard split
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

/**
 * Extract real conversation topics from message content.
 * WHY: Generic tags like 'founder-interaction' don't help retrieval when Zero says
 * "remember our Super Bowl conversation?" — we need 'super-bowl', 'football', 'nfl'
 * as tags so topic-based retrieval pulls the right memories 6 days later.
 *
 * Two strategies:
 * 1. Keyword matching against known topic categories
 * 2. N-gram extraction: pull 2-3 word phrases as topic slugs
 *
 * This lets casual conversation topics ("Super Bowl", "that restaurant", "crypto prices")
 * become durable retrieval keys.
 */
function extractConversationTopics(content) {
  const lower = content.toLowerCase();
  const topics = [];

  // Strategy 1: Known topic categories (expandable)
  const topicKeywords = {
    'football': ['football', 'nfl', 'super bowl', 'superbowl', 'touchdown', 'quarterback', 'halftime'],
    'basketball': ['basketball', 'nba', 'lakers', 'celtics', 'playoffs', 'march madness'],
    'sports': ['game', 'score', 'team', 'player', 'season', 'championship', 'finals'],
    'crypto': ['crypto', 'bitcoin', 'ethereum', 'eth', 'btc', 'token', 'blockchain', 'defi'],
    'markets': ['market', 'stocks', 'trading', 'portfolio', 'investment', 'sp500', 'nasdaq'],
    'ai': ['ai', 'artificial intelligence', 'llm', 'gpt', 'claude', 'machine learning'],
    'business': ['revenue', 'profit', 'startup', 'company', 'client', 'customer', 'sales'],
    'tech': ['software', 'app', 'code', 'api', 'deploy', 'server', 'database'],
    'food': ['restaurant', 'food', 'dinner', 'lunch', 'cooking', 'recipe'],
    'travel': ['travel', 'trip', 'flight', 'hotel', 'vacation', 'city'],
    'movies': ['movie', 'film', 'netflix', 'show', 'series', 'watch', 'actor'],
    'music': ['music', 'song', 'album', 'concert', 'artist', 'playlist'],
    'politics': ['election', 'president', 'congress', 'vote', 'policy', 'government'],
    'health': ['health', 'workout', 'gym', 'diet', 'sleep', 'running']
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      topics.push(topic);
    }
  }

  // Strategy 2: Extract notable noun phrases as slug tags.
  // Pull capitalized multi-word phrases (proper nouns) and common bigrams.
  // "Super Bowl" → 'super-bowl', "Patrick Mahomes" → 'patrick-mahomes'
  const properNouns = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];
  for (const phrase of properNouns.slice(0, 5)) {
    const slug = phrase.toLowerCase().replace(/\s+/g, '-');
    if (slug.length >= 3 && slug.length <= 30 && !topics.includes(slug)) {
      topics.push(slug);
    }
  }

  // Always include a general founder tag for baseline retrieval
  if (topics.length === 0) {
    topics.push('casual-chat');
  }

  return topics;
}

/**
 * Detect if a founder message contains a directive, preference, or strategic instruction
 * that should be saved as a permanent lesson.
 * Simple keyword heuristic — errs on the side of saving (better to remember too much
 * than to forget a critical instruction).
 */
function detectFounderDirective(content) {
  const lower = content.toLowerCase();

  // Direct instructions
  const directiveSignals = [
    'always ', 'never ', 'from now on', 'going forward', 'remember that',
    'make sure', 'don\'t forget', 'priority is', 'focus on', 'target is',
    'our goal', 'our target', 'we need to', 'i want', 'i need',
    'stop doing', 'start doing', 'change the', 'update the',
    'the budget is', 'the deadline is', 'the client', 'the customer',
    'important:', 'note:', 'fyi:', 'heads up'
  ];

  for (const signal of directiveSignals) {
    if (lower.includes(signal)) return true;
  }

  // Long messages (>100 chars) that aren't questions are likely strategic context
  if (content.length > 100 && !content.trim().endsWith('?')) return true;

  return false;
}

// ============================================================
// EXPORTS (for testing)
// ============================================================

module.exports = { classifyMessage };

// ============================================================
// STARTUP
// ============================================================

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[discord] Missing DISCORD_BOT_TOKEN in .env');
  console.log('[discord] The bot will not start. Set the token and restart.');
  process.exit(1);
}

client.login(token).catch(err => {
  console.error('[discord] Failed to login:', err.message);
  process.exit(1);
});
