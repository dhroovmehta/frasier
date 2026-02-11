// notion.js — Publish deliverables and summaries to Notion
// WHY: Discord is for alerts only. Notion is where deliverables live.
// Each team has a page in the VoxYZ HQ workspace.
// Deliverables are created as child pages under the team's page.

const supabase = require('./supabase');

const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ============================================================
// CORE API
// ============================================================

async function notionRequest(method, path, body = null) {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    console.error('[notion] Missing NOTION_API_KEY');
    return null;
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${NOTION_API_URL}${path}`, options);

  if (!response.ok) {
    const error = await response.text();
    console.error(`[notion] API ${response.status}: ${error}`);
    return null;
  }

  return response.json();
}

// ============================================================
// PAGE DISCOVERY
// ============================================================

/**
 * Find the HQ page and team sub-pages.
 * Uses direct page ID (from env) to avoid search API issues.
 * Falls back to search if no ID configured.
 */
let pageCache = null;

async function getTeamPages() {
  if (pageCache) return pageCache;

  // Use direct page ID if configured (most reliable)
  const hqPageId = process.env.NOTION_HQ_PAGE_ID || '304c642f7e708027958adc5e3c989068';

  // Get child pages of the HQ page
  const children = await notionRequest('GET', `/blocks/${hqPageId}/children?page_size=100`);

  if (!children || !children.results) {
    console.error(`[notion] Could not access HQ page. Check NOTION_HQ_PAGE_ID and integration access.`);
    return null;
  }

  // Find team pages by title among children
  const teamPages = {};
  const teamKeywords = {
    'team-research': 'research',
    'team-execution': 'execution',
    'team-advisory': 'advisory'
  };

  for (const block of children.results) {
    if (block.type === 'child_page') {
      const title = (block.child_page?.title || '').toLowerCase();
      for (const [teamId, keyword] of Object.entries(teamKeywords)) {
        if (title.includes(keyword)) {
          teamPages[teamId] = block.id;
          console.log(`[notion] Found ${block.child_page.title}: ${block.id}`);
        }
      }
    }
  }

  pageCache = {
    hqPageId,
    teamPages
  };

  return pageCache;
}

// ============================================================
// PUBLISH DELIVERABLE
// ============================================================

/**
 * Publish a completed deliverable as a new Notion page under the team's page.
 *
 * @param {Object} params
 * @param {string} params.title - Page title
 * @param {string} params.content - The deliverable content (markdown-ish)
 * @param {string} params.teamId - Which team page to publish under
 * @param {string} params.agentName - Who created it
 * @param {number} params.missionId - For reference
 * @param {number} params.stepId - For reference
 * @returns {Object|null} The created page, or null on failure
 */
async function publishDeliverable({ title, content, teamId, agentName, missionId, stepId }) {
  const pages = await getTeamPages();
  if (!pages) return null;

  const parentPageId = pages.teamPages[teamId] || pages.hqPageId;

  // Convert content to Notion blocks (paragraphs)
  const blocks = contentToBlocks(content);

  const page = await notionRequest('POST', '/pages', {
    parent: { page_id: parentPageId },
    properties: {
      title: {
        title: [{ text: { content: title } }]
      }
    },
    children: [
      // Metadata header
      {
        object: 'block',
        type: 'callout',
        callout: {
          icon: { emoji: '📋' },
          rich_text: [{
            text: {
              content: `Agent: ${agentName} | Mission #${missionId} | Step #${stepId} | ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            }
          }]
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      ...blocks
    ]
  });

  if (page) {
    console.log(`[notion] Published: "${title}" → ${page.url}`);

    // Log to notion_sync table
    await supabase
      .from('notion_sync')
      .insert({
        mission_step_id: stepId,
        team_id: teamId,
        notion_page_id: page.id,
        page_title: title,
        sync_type: 'deliverable',
        status: 'synced'
      });

    return page;
  }

  return null;
}

/**
 * Publish a daily summary to Notion.
 */
async function publishDailySummary({ title, content, teamId }) {
  const pages = await getTeamPages();
  if (!pages) return null;

  const parentPageId = pages.teamPages[teamId] || pages.hqPageId;
  const blocks = contentToBlocks(content);

  const page = await notionRequest('POST', '/pages', {
    parent: { page_id: parentPageId },
    properties: {
      title: {
        title: [{ text: { content: title } }]
      }
    },
    children: [
      {
        object: 'block',
        type: 'callout',
        callout: {
          icon: { emoji: '📊' },
          rich_text: [{
            text: { content: `Daily Summary — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` }
          }]
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      ...blocks
    ]
  });

  if (page) {
    console.log(`[notion] Daily summary published: "${title}" → ${page.url}`);
  }

  return page;
}

// ============================================================
// CONTENT CONVERSION
// ============================================================

/**
 * Convert text content to Notion block objects.
 * Handles headings (##), bullet points (-), and paragraphs.
 * Notion API limit: 100 blocks per request, 2000 chars per block.
 */
function contentToBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Heading 1
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ text: { content: trimmed.substring(2).trim() } }]
        }
      });
    }
    // Heading 2
    else if (trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: trimmed.substring(3).trim() } }]
        }
      });
    }
    // Heading 3
    else if (trimmed.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [{ text: { content: trimmed.substring(4).trim() } }]
        }
      });
    }
    // Bullet point
    else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ text: { content: truncate(trimmed.substring(2).trim(), 1900) } }]
        }
      });
    }
    // Numbered list
    else if (/^\d+\.\s/.test(trimmed)) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: [{ text: { content: truncate(trimmed.replace(/^\d+\.\s/, ''), 1900) } }]
        }
      });
    }
    // Regular paragraph
    else {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ text: { content: truncate(trimmed, 1900) } }]
        }
      });
    }

    // Notion limit: 100 blocks per request
    if (blocks.length >= 95) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ text: { content: '[Content truncated — full version in Google Drive]' } }]
        }
      });
      break;
    }
  }

  return blocks;
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

/**
 * Clear the page cache (call when workspace structure changes).
 */
function clearCache() {
  pageCache = null;
}

module.exports = {
  publishDeliverable,
  publishDailySummary,
  getTeamPages,
  clearCache
};
