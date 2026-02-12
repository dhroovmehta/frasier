// google_drive.js — Publish deliverables as Google Docs in shared Drive folders
// WHY: Notion is great for pages, but Google Drive is better for docs, spreadsheets,
// and files that Zero might want to share externally or edit collaboratively.
// Each team gets a subfolder. Deliverables become Google Docs with full formatting.

const { google } = require('googleapis');
const supabase = require('./supabase');

// ============================================================
// AUTH
// ============================================================

let driveClient = null;

/**
 * Get an authenticated Google Drive client using the service account key.
 * The key is stored as a JSON string in the GOOGLE_SERVICE_ACCOUNT_KEY env var.
 */
function getDriveClient() {
  if (driveClient) return driveClient;

  try {
    let key;

    // Option 1: Read from a JSON file (most reliable — avoids dotenv escaping issues)
    const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
      || require('path').join(__dirname, '../../credentials/google-service-account.json');

    try {
      const fs = require('fs');
      if (fs.existsSync(keyFilePath)) {
        key = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
        console.log('[gdrive] Loaded service account from file');
      }
    } catch (fileErr) {
      // Fall through to env var
    }

    // Option 2: Fall back to env var
    if (!key) {
      const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      if (!keyJson) {
        console.error('[gdrive] Missing service account key. Place it at credentials/google-service-account.json');
        return null;
      }
      key = JSON.parse(keyJson);
      if (key.private_key) {
        key.private_key = key.private_key.replace(/\\n/g, '\n');
      }
    }

    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive']
    });

    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  } catch (err) {
    console.error('[gdrive] Failed to initialize Drive client:', err.message);
    return null;
  }
}

// ============================================================
// FOLDER MANAGEMENT
// ============================================================

let folderCache = null;

/**
 * Get or create the team folder structure.
 * Root: "VoxYZ Deliverables" (or env override)
 * Children: "Research Team", "Execution Team", "Advisory Team"
 */
async function getTeamFolders() {
  if (folderCache) return folderCache;

  const drive = getDriveClient();
  if (!drive) return null;

  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (rootFolderId) {
    // Use the configured root folder
    const teamFolders = await findOrCreateTeamFolders(drive, rootFolderId);
    folderCache = { rootFolderId, teamFolders };
    return folderCache;
  }

  // No root folder configured — find or create one
  const rootName = process.env.GOOGLE_DRIVE_ROOT_NAME || 'VoxYZ Deliverables';
  const rootId = await findOrCreateFolder(drive, rootName, null);
  if (!rootId) return null;

  const teamFolders = await findOrCreateTeamFolders(drive, rootId);
  folderCache = { rootFolderId: rootId, teamFolders };
  return folderCache;
}

/**
 * Find or create the three team subfolders under the root.
 */
async function findOrCreateTeamFolders(drive, parentId) {
  const teamMap = {
    'team-research': 'Research Team',
    'team-execution': 'Execution Team',
    'team-advisory': 'Advisory Team'
  };

  const result = {};
  for (const [teamId, folderName] of Object.entries(teamMap)) {
    const folderId = await findOrCreateFolder(drive, folderName, parentId);
    if (folderId) {
      result[teamId] = folderId;
      console.log(`[gdrive] ${folderName} folder: ${folderId}`);
    }
  }

  return result;
}

/**
 * Find a folder by name (under a parent), or create it if missing.
 */
async function findOrCreateFolder(drive, name, parentId) {
  try {
    // Search for existing folder
    let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) {
      query += ` and '${parentId}' in parents`;
    }

    const list = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (list.data.files && list.data.files.length > 0) {
      return list.data.files[0].id;
    }

    // Create folder
    const folder = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
      },
      fields: 'id'
    });

    console.log(`[gdrive] Created folder "${name}": ${folder.data.id}`);
    return folder.data.id;
  } catch (err) {
    console.error(`[gdrive] Error with folder "${name}":`, err.message);
    return null;
  }
}

// ============================================================
// PUBLISH DELIVERABLE
// ============================================================

/**
 * Publish a deliverable as a Google Doc under the team's folder.
 *
 * @param {Object} params
 * @param {string} params.title - Document title
 * @param {string} params.content - The deliverable content (plain text / markdown)
 * @param {string} params.teamId - Which team folder
 * @param {string} params.agentName - Who created it
 * @param {number} params.missionId - For reference
 * @param {number} params.stepId - For reference
 * @returns {Object|null} { id, url } or null on failure
 */
async function publishDeliverable({ title, content, teamId, agentName, missionId, stepId }) {
  const drive = getDriveClient();
  if (!drive) return null;

  const folders = await getTeamFolders();
  if (!folders) return null;

  const parentFolderId = folders.teamFolders[teamId] || folders.rootFolderId;

  // Add metadata header to the content
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fullContent = `Agent: ${agentName} | Mission #${missionId} | Step #${stepId} | ${dateStr}\n${'─'.repeat(60)}\n\n${content}`;

  try {
    // Upload as a text file (service accounts have no Drive storage,
    // so we transfer ownership to the founder's account after creation)
    const file = await drive.files.create({
      requestBody: {
        name: `${title}.txt`,
        mimeType: 'text/plain',
        parents: [parentFolderId]
      },
      media: {
        mimeType: 'text/plain',
        body: fullContent
      },
      fields: 'id, webViewLink'
    });

    const docId = file.data.id;
    const docUrl = file.data.webViewLink;

    // Transfer ownership to the founder so storage counts against their 15GB
    const ownerEmail = process.env.GMAIL_USER;
    if (ownerEmail) {
      await drive.permissions.create({
        fileId: docId,
        transferOwnership: true,
        requestBody: {
          role: 'owner',
          type: 'user',
          emailAddress: ownerEmail
        }
      });
    }

    // Also make viewable by anyone with link
    await drive.permissions.create({
      fileId: docId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    console.log(`[gdrive] Published: "${title}" → ${docUrl}`);

    // Log to google_drive_sync table if it exists
    await supabase
      .from('google_drive_sync')
      .insert({
        mission_step_id: stepId,
        team_id: teamId,
        drive_file_id: docId,
        file_title: title,
        file_url: docUrl,
        sync_type: 'deliverable',
        status: 'synced'
      })
      .then(({ error }) => {
        if (error) console.log(`[gdrive] Sync log skipped (table may not exist): ${error.message}`);
      });

    return { id: docId, url: docUrl };
  } catch (err) {
    console.error(`[gdrive] Failed to publish "${title}":`, err.message);
    return null;
  }
}

/**
 * Clear the folder cache (call when folder structure changes).
 */
function clearCache() {
  folderCache = null;
}

module.exports = {
  publishDeliverable,
  getTeamFolders,
  clearCache
};
