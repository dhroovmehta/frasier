// web.js — Lightweight web access for agents (Decision 6)
// WHY: Agents need live data — prices, news, competitor info — but we can't run
// a headless browser on a 1GB VPS. HTTP fetch + HTML-to-text covers 80% of use cases
// at zero extra cost. No Puppeteer, no Chrome, no RAM explosion.
//
// Two capabilities:
// 1. fetchPage(url) — GET a URL, strip HTML to plain text
// 2. searchWeb(query) — Search via DuckDuckGo HTML (no API key needed)
//
// CRITICAL: Must use a real browser User-Agent. DuckDuckGo returns empty/different
// HTML for bot UAs. Learned this the hard way — a bot UA got zero results.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============================================================
// PAGE FETCHING (HTTP GET + HTML-to-text)
// ============================================================

/**
 * Fetch a web page and extract readable text content.
 * Strips HTML tags, scripts, styles, and returns clean text.
 * Truncates to maxChars to avoid blowing up LLM context.
 *
 * @param {string} url - The URL to fetch
 * @param {number} [maxChars=8000] - Max characters to return
 * @returns {{ content: string, title: string, url: string, error: string|null }}
 */
async function fetchPage(url, maxChars = 8000) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) {
      return { content: null, title: null, url, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();

    // If JSON, return formatted
    if (contentType.includes('application/json')) {
      const truncated = raw.substring(0, maxChars);
      return { content: truncated, title: url, url, error: null };
    }

    // Extract title
    const titleMatch = raw.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // Strip HTML to plain text
    const text = htmlToText(raw);
    const truncated = text.substring(0, maxChars);

    return { content: truncated, title, url, error: null };
  } catch (err) {
    console.error(`[web] Failed to fetch ${url}: ${err.message}`);
    return { content: null, title: null, url, error: err.message };
  }
}

// ============================================================
// WEB SEARCH (Brave API primary, DuckDuckGo fallback)
// ============================================================

/**
 * Search the web. Tries Brave Search API first (structured JSON, reliable),
 * falls back to DuckDuckGo HTML scraping if Brave key isn't set or fails.
 *
 * @param {string} query - Search query
 * @param {number} [maxResults=5] - Max results to return
 * @returns {{ results: Array<{title, url, snippet}>, error: string|null }}
 */
async function searchWeb(query, maxResults = 5) {
  const braveKey = process.env.BRAVE_API_KEY;

  // Try Brave first — structured JSON, won't break on HTML changes
  if (braveKey) {
    const braveResult = await searchBrave(query, braveKey, maxResults);
    if (braveResult.results.length > 0) return braveResult;
    console.log(`[web] Brave returned 0 results, falling back to DuckDuckGo`);
  }

  // Fallback: DuckDuckGo HTML scraping
  return searchDuckDuckGo(query, maxResults);
}

/**
 * Search via Brave Search API. Returns structured JSON — no HTML parsing needed.
 * Free tier: 2,000 queries/month, 1 req/sec.
 */
async function searchBrave(query, apiKey, maxResults = 5) {
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[web] Brave search failed: HTTP ${response.status} — ${body.substring(0, 200)}`);
      return { results: [], error: `Brave HTTP ${response.status}` };
    }

    const data = await response.json();
    const results = (data.web?.results || []).slice(0, maxResults).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || ''
    }));

    console.log(`[web] Brave search "${query}": ${results.length} results`);
    return { results, error: null };
  } catch (err) {
    console.error(`[web] Brave search failed for "${query}": ${err.message}`);
    return { results: [], error: err.message };
  }
}

/**
 * Search via DuckDuckGo HTML endpoint. Free, no API key needed.
 * Fallback when Brave isn't configured or fails.
 */
async function searchDuckDuckGo(query, maxResults = 5) {
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return { results: [], error: `Search failed: HTTP ${response.status}` };
    }

    const html = await response.text();
    const results = parseSearchResults(html, maxResults);

    console.log(`[web] DuckDuckGo search "${query}": ${results.length} results`);
    return { results, error: null };
  } catch (err) {
    console.error(`[web] DuckDuckGo search failed for "${query}": ${err.message}`);
    return { results: [], error: err.message };
  }
}

// ============================================================
// URL PRE-FETCHING (auto-fetch URLs in task descriptions)
// ============================================================

/**
 * Scan text for URLs and pre-fetch their content.
 * WHY: When Zero pastes a tweet or article URL in a task, the agent needs the
 * actual content — not the URL string. This runs BEFORE the LLM call so the
 * agent has real context from day one, instead of hallucinating.
 *
 * Special handling:
 * - Twitter/X URLs → rewritten to api.fxtwitter.com (X blocks scrapers)
 * - Other URLs → fetched directly via fetchPage()
 *
 * @param {string} text - Task description that may contain URLs
 * @returns {{ enrichedText: string, fetchedUrls: number }}
 */
async function prefetchUrls(text) {
  // Find all URLs in the text
  const urlRegex = /https?:\/\/[^\s\])<>,]+/g;
  const urls = [...new Set(text.match(urlRegex) || [])]; // dedupe

  if (urls.length === 0) return { enrichedText: text, fetchedUrls: 0 };

  const fetched = [];

  for (const rawUrl of urls.slice(0, 3)) { // cap at 3 URLs to limit latency
    try {
      // YouTube — dedicated extractor for metadata + transcript
      const ytId = extractYouTubeId(rawUrl);
      if (ytId) {
        const ytResult = await fetchYouTube(ytId, 4000);
        if (ytResult.content) {
          fetched.push({ originalUrl: rawUrl, title: ytResult.title, content: ytResult.content });
          continue;
        }
        if (ytResult.error) console.log(`[web] YouTube pre-fetch failed: ${ytResult.error}`);
        continue; // Don't fall through to generic fetch for YouTube URLs
      }

      // Twitter/X — rewrite to fxtwitter API
      const url = rewriteUrl(rawUrl);
      const isTwitter = url.includes('fxtwitter.com');

      const result = await fetchPage(url, 4000);
      if (result.error) {
        console.log(`[web] Pre-fetch failed for ${rawUrl}: ${result.error}`);
        continue;
      }

      // fxtwitter returns JSON — extract the readable tweet data
      if (isTwitter && result.content) {
        const parsed = parseTweetJson(result.content);
        if (parsed) {
          fetched.push({ originalUrl: rawUrl, title: `Tweet by @${parsed.author}`, content: parsed.text });
          continue;
        }
      }

      if (result.content && result.content.length > 50) {
        fetched.push({ originalUrl: rawUrl, title: result.title, content: result.content });
      }
    } catch (err) {
      console.error(`[web] Pre-fetch error for ${rawUrl}: ${err.message}`);
    }
  }

  if (fetched.length === 0) return { enrichedText: text, fetchedUrls: 0 };

  // Build context block to append to the task description
  const lines = ['\n\n# PRE-FETCHED URL CONTENT (auto-retrieved from URLs in the task)', ''];
  for (const f of fetched) {
    lines.push(`## ${f.originalUrl}`);
    if (f.title && f.title !== f.originalUrl) lines.push(`Title: ${f.title}`);
    lines.push(f.content);
    lines.push('');
  }

  console.log(`[web] Pre-fetched ${fetched.length} URL(s) from task description`);
  return { enrichedText: text + lines.join('\n'), fetchedUrls: fetched.length };
}

// ============================================================
// DISCORD ATTACHMENT FETCHING (text file downloads)
// ============================================================

// WHY: When Dhroov drops a .md roadmap (or .txt spec, .json config) into Discord,
// the bot needs to read the file content into the pipeline alongside any typed message.
// Discord's CDN serves raw files — no HTML stripping needed, just a simple HTTP GET.
// Binary files (images, PDFs) are skipped.

const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.toml', '.ini'];
const TEXT_CONTENT_TYPES = ['text/', 'application/json', 'application/xml', 'application/yaml'];
const MAX_ATTACHMENT_SIZE = 100 * 1024;   // 100KB pre-download check
const MAX_ATTACHMENT_CHARS = 50000;        // 50K chars post-download truncation
const MAX_ATTACHMENTS = 3;

/**
 * Download text-based file attachments from a Discord message.
 *
 * @param {Collection} attachments - Discord.js message.attachments Collection
 * @returns {{ content: string, attachmentCount: number }}
 */
async function fetchAttachments(attachments) {
  if (!attachments || attachments.size === 0) {
    return { content: '', attachmentCount: 0 };
  }

  const fetched = [];

  for (const [, attachment] of [...attachments.entries()].slice(0, MAX_ATTACHMENTS)) {
    const { name, size, url, contentType } = attachment;

    // Extension-first filtering (primary) — Discord often sends application/octet-stream for text files
    const ext = (name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
    const isTextByExt = TEXT_EXTENSIONS.includes(ext);
    const isTextByType = contentType && TEXT_CONTENT_TYPES.some(prefix => contentType.startsWith(prefix));

    if (!isTextByExt && !isTextByType) {
      console.log(`[web] Skipping non-text attachment: ${name} (${contentType || 'unknown type'})`);
      continue;
    }

    // Pre-download size check — reject before wasting bandwidth
    if (size > MAX_ATTACHMENT_SIZE) {
      console.log(`[web] Skipping oversized attachment: ${name} (${(size / 1024).toFixed(1)}KB > 100KB limit)`);
      continue;
    }

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(15000)  // 15s timeout for larger files
      });

      if (!response.ok) {
        console.log(`[web] Failed to download attachment ${name}: HTTP ${response.status}`);
        continue;
      }

      let text = await response.text();

      // Post-download truncation
      if (text.length > MAX_ATTACHMENT_CHARS) {
        console.log(`[web] Truncating attachment ${name}: ${text.length} chars → ${MAX_ATTACHMENT_CHARS}`);
        text = text.substring(0, MAX_ATTACHMENT_CHARS) + '\n\n[...truncated at 50,000 characters]';
      }

      fetched.push({ name, text });
    } catch (err) {
      console.error(`[web] Error downloading attachment ${name}: ${err.message}`);
    }
  }

  if (fetched.length === 0) {
    return { content: '', attachmentCount: 0 };
  }

  // Build formatted content block (mirrors prefetchUrls format)
  const lines = ['# ATTACHED FILES (downloaded from Discord message)', ''];
  for (const f of fetched) {
    lines.push(`## File: ${f.name}`);
    lines.push(f.text);
    lines.push('');
  }

  console.log(`[web] Downloaded ${fetched.length} attachment(s): ${fetched.map(f => f.name).join(', ')}`);
  return { content: lines.join('\n'), attachmentCount: fetched.length };
}

/**
 * Rewrite URLs that need special handling (Twitter/X → fxtwitter API, etc.)
 * WHY: x.com and twitter.com block non-authenticated scraping entirely.
 * api.fxtwitter.com returns clean JSON with tweet text, no auth needed.
 */
function rewriteUrl(url) {
  // Twitter/X → fxtwitter API (returns JSON with tweet text)
  const twitterMatch = url.match(/^https?:\/\/(?:www\.)?(twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
  if (twitterMatch) {
    const rewritten = `https://api.fxtwitter.com/${twitterMatch[2]}/status/${twitterMatch[3]}`;
    console.log(`[web] Rewrote Twitter URL → ${rewritten}`);
    return rewritten;
  }

  return url;
}

// ============================================================
// YOUTUBE EXTRACTION (metadata + transcript, no API key)
// ============================================================

/**
 * Extract video ID from any YouTube URL format.
 * Handles: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/
 */
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/i
  ];
  for (const p of patterns) {
    const match = url.match(p);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch YouTube video metadata + transcript.
 * WHY: YouTube.com returns a massive HTML page with embedded JSON containing all
 * video metadata. We extract ytInitialPlayerResponse for title, description,
 * channel, views, duration. Transcript via innertube get_transcript endpoint.
 *
 * @param {string} videoId - YouTube video ID (11 chars)
 * @param {number} [maxChars=6000] - Max chars for combined output
 * @returns {{ content: string, title: string, error: string|null }}
 */
async function fetchYouTube(videoId, maxChars = 6000) {
  try {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return { content: null, title: null, error: `YouTube HTTP ${response.status}` };
    }

    const html = await response.text();

    // Extract ytInitialPlayerResponse — contains all video metadata
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script)/s);
    if (!playerMatch) {
      return { content: null, title: null, error: 'Could not parse YouTube page' };
    }

    const player = JSON.parse(playerMatch[1]);
    const details = player.videoDetails || {};

    const title = details.title || 'Unknown Video';
    const author = details.author || 'Unknown Channel';
    const views = Number(details.viewCount || 0).toLocaleString();
    const durationSec = Number(details.lengthSeconds || 0);
    const durationMin = Math.floor(durationSec / 60);
    const durationStr = durationSec > 0 ? `${durationMin}m ${durationSec % 60}s` : 'unknown';
    const description = (details.shortDescription || '').substring(0, 2000);

    // Build metadata section
    const lines = [
      `YouTube Video: ${title}`,
      `Channel: ${author}`,
      `Views: ${views} | Duration: ${durationStr}`,
      `URL: https://youtube.com/watch?v=${videoId}`,
      '',
      '--- Description ---',
      description
    ];

    // Attempt transcript extraction (best-effort — YouTube blocks this since mid-2025)
    const transcript = await extractYouTubeTranscript(html, videoId);
    if (transcript) {
      const maxTranscript = maxChars - lines.join('\n').length - 100;
      lines.push('');
      lines.push('--- Transcript ---');
      lines.push(transcript.substring(0, Math.max(maxTranscript, 1000)));
    }

    const content = lines.join('\n').substring(0, maxChars);
    console.log(`[web] YouTube: "${title}" by ${author} (${views} views${transcript ? ', transcript extracted' : ', no transcript'})`);

    return { content, title: `YouTube: ${title}`, error: null };
  } catch (err) {
    console.error(`[web] YouTube fetch failed for ${videoId}: ${err.message}`);
    return { content: null, title: null, error: err.message };
  }
}

/**
 * Try to extract transcript from YouTube page via innertube get_transcript.
 * Best-effort: YouTube blocked server-side caption access mid-2025. This may
 * return null. When it does, agents still get metadata (title, description, etc.)
 * which covers most research use cases.
 */
async function extractYouTubeTranscript(html, videoId) {
  try {
    // Extract innertube params from the page
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const visitorMatch = html.match(/"VISITOR_DATA":"([^"]+)"/);
    const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
    const paramsMatch = html.match(/"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/);

    if (!apiKeyMatch || !paramsMatch) return null;

    const cookies = [];
    // Attempt to get cookies from initial page for session continuity
    const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKeyMatch[1]}`, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': versionMatch ? versionMatch[1] : '2.20260211.01.00',
        'Origin': 'https://www.youtube.com',
        'Referer': `https://www.youtube.com/watch?v=${videoId}`
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: versionMatch ? versionMatch[1] : '2.20260211.01.00',
            visitorData: visitorMatch ? visitorMatch[1] : undefined
          }
        },
        params: paramsMatch[1]
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) return null;

    const data = await response.json();
    const actions = data.actions || [];
    if (actions.length === 0) return null;

    // Navigate the deeply nested transcript structure
    const panel = actions[0]?.updateEngagementPanelAction?.content
      ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer;
    if (!panel) return null;

    const segments = panel.body?.transcriptSegmentListRenderer?.initialSegments || [];
    if (segments.length === 0) return null;

    const lines = [];
    for (const seg of segments) {
      const renderer = seg.transcriptSegmentRenderer;
      if (renderer) {
        const text = renderer.snippet?.runs?.map(r => r.text).join('') || '';
        if (text.trim()) lines.push(text.trim());
      }
    }

    return lines.length > 0 ? lines.join(' ') : null;
  } catch {
    return null; // Transcript extraction is best-effort
  }
}

// ============================================================
// AGENT TOOL INTERFACE
// ============================================================

/**
 * Process a web access request from an agent's task output.
 * Agents can embed [WEB_SEARCH:query] or [WEB_FETCH:url] tags in their output
 * to trigger web access. The worker calls this to resolve them.
 *
 * @param {string} text - Agent output that may contain web tags
 * @returns {{ results: Array<{type, query, data}>, enrichedText: string }}
 */
async function resolveWebTags(text) {
  const results = [];

  // Find [WEB_SEARCH:query] tags
  const searchMatches = text.matchAll(/\[WEB_SEARCH:([^\]]+)\]/g);
  for (const match of searchMatches) {
    const query = match[1].trim();
    const searchResult = await searchWeb(query);
    results.push({ type: 'search', query, data: searchResult });
  }

  // Find [WEB_FETCH:url] tags
  const fetchMatches = text.matchAll(/\[WEB_FETCH:(https?:\/\/[^\]]+)\]/g);
  for (const match of fetchMatches) {
    const url = match[1].trim();
    const fetchResult = await fetchPage(url);
    results.push({ type: 'fetch', query: url, data: fetchResult });
  }

  return { results, hasWebTags: results.length > 0 };
}

/**
 * Format web results into a context string that can be injected into an agent's
 * follow-up prompt. Called by the worker when an agent needs live data.
 *
 * @param {Array} results - From resolveWebTags()
 * @returns {string} Formatted web context for LLM prompt
 */
function formatWebResults(results) {
  if (!results || results.length === 0) return '';

  const lines = ['# LIVE WEB DATA (fetched just now)', ''];

  for (const r of results) {
    if (r.type === 'search') {
      lines.push(`## Search: "${r.query}"`);
      if (r.data.error) {
        lines.push(`Error: ${r.data.error}`);
      } else {
        for (const sr of r.data.results) {
          lines.push(`- **${sr.title}** (${sr.url})`);
          if (sr.snippet) lines.push(`  ${sr.snippet}`);
        }
      }
      lines.push('');
    } else if (r.type === 'fetch') {
      lines.push(`## Page: ${r.query}`);
      if (r.data.error) {
        lines.push(`Error: ${r.data.error}`);
      } else {
        lines.push(`Title: ${r.data.title}`);
        lines.push(`Content (truncated):\n${r.data.content?.substring(0, 3000) || 'No content'}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ============================================================
// TWEET PARSING (fxtwitter JSON → readable text)
// ============================================================

/**
 * Parse fxtwitter API JSON into a clean, readable format for LLM context.
 * WHY: Raw JSON wastes tokens. Extract just what the agent needs: who said what,
 * engagement stats (to gauge credibility), and media descriptions.
 */
function parseTweetJson(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    const tweet = data.tweet;
    if (!tweet) return null;

    const author = tweet.author?.screen_name || 'unknown';
    const name = tweet.author?.name || author;
    const followers = tweet.author?.followers || 0;
    const lines = [
      `@${author} (${name}, ${followers.toLocaleString()} followers):`,
      '',
      tweet.text || tweet.raw_text?.text || '',
      '',
      `Engagement: ${(tweet.likes || 0).toLocaleString()} likes, ${(tweet.retweets || 0).toLocaleString()} retweets, ${(tweet.replies || 0).toLocaleString()} replies, ${(tweet.views || 0).toLocaleString()} views`,
      `Posted: ${tweet.created_at || 'unknown'}`
    ];

    if (tweet.media?.photos?.length > 0) {
      lines.push(`Attached: ${tweet.media.photos.length} image(s)`);
    }

    return { author, text: lines.join('\n') };
  } catch {
    return null;
  }
}

// ============================================================
// HTML PARSING HELPERS (no dependencies)
// ============================================================

/**
 * Convert HTML to plain text. No external dependencies.
 * Strips tags, decodes entities, collapses whitespace.
 */
function htmlToText(html) {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Replace common block elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<br[^>]*\/?>/gi, '\n');
  text = text.replace(/<hr[^>]*\/?>/gi, '\n---\n');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#x27;/g, "'");
  text = text.replace(/&#x2F;/g, '/');
  text = text.replace(/&mdash;/g, '—');
  text = text.replace(/&ndash;/g, '–');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

/**
 * Parse DuckDuckGo HTML search results into structured data.
 * WHY split on just "result__body": DDG uses multi-class attributes like
 * class="links_main links_deep result__body", so splitting on the exact
 * class="result__body" fails. Learned this the hard way — it's why web
 * search returned 0 results despite getting valid HTML.
 */
function parseSearchResults(html, maxResults) {
  const results = [];

  // Split on result__body — DDG wraps each result in a div with this class
  // among others (links_main, links_deep, etc.)
  const resultBlocks = html.split(/result__body/gi);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i];

    // Extract URL and title from result__a link
    // Handles both attribute orders: class then href, or href then class
    let linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      linkMatch = block.match(/href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    }
    if (!linkMatch) continue;

    let url = linkMatch[1];
    const title = htmlToText(linkMatch[2]).trim();

    // DuckDuckGo wraps URLs in a redirect — extract the real URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Clean up protocol-relative URLs
    if (url.startsWith('//')) url = 'https:' + url;

    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]).trim() : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

module.exports = {
  fetchPage,
  searchWeb,
  prefetchUrls,
  fetchAttachments,
  resolveWebTags,
  formatWebResults,
  htmlToText
};
