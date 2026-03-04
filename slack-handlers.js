const crypto = require("crypto");
const path = require("path");
const { validateTeamYaml, validatePolicyYaml } = require("./yaml-handler");

// Keyword → team file mapping for smart pre-fetching
const TEAM_KEYWORDS = {
  workstation: "teams/workstations.yml",
  desktop: "teams/workstations.yml",
  laptop: "teams/workstations.yml",
  server: "teams/servers.yml",
  mobile: "teams/company-owned-mobile-devices.yml",
  iphone: "teams/company-owned-mobile-devices.yml",
  ipad: "teams/company-owned-mobile-devices.yml",
  ios: "teams/company-owned-mobile-devices.yml",
  android: "teams/company-owned-mobile-devices.yml",
  personal: "teams/personal-mobile-devices.yml",
  testing: "teams/testing-and-qa.yml",
  qa: "teams/testing-and-qa.yml",
  "no team": "teams/no-team.yml",
  "no-team": "teams/no-team.yml",
  global: "default.yml",
  org: "default.yml",
  organization: "default.yml",
  default: "default.yml",
};

/**
 * Determine which files to pre-fetch based on the user's request text.
 */
async function prefetchRelevantFiles(userRequest, tree, github, config) {
  const requestLower = userRequest.toLowerCase();
  const filesToFetch = new Set();

  // Match team files by keyword
  for (const [keyword, teamFile] of Object.entries(TEAM_KEYWORDS)) {
    if (requestLower.includes(keyword)) {
      filesToFetch.add(teamFile);
    }
  }

  // Default to workstations if no team matched
  if (filesToFetch.size === 0) {
    filesToFetch.add("teams/workstations.yml");
  }

  // If request mentions "policy", fetch existing policy examples
  if (requestLower.includes("policy") || requestLower.includes("policies")) {
    for (const platform of ["macos", "windows", "linux"]) {
      if (requestLower.includes(platform) || (platform === "macos" && requestLower.includes("mac"))) {
        const policyDir = `lib/${platform}/policies`;
        const policyFiles = tree.filter(
          (p) => p.startsWith(policyDir) && p.endsWith(".yml")
        );
        // Fetch up to 2 existing policies as examples for Claude
        for (const pf of policyFiles.slice(0, 2)) {
          filesToFetch.add(pf);
        }
      }
    }
  }

  // If request mentions "software" or "install" or "app", fetch examples
  if (requestLower.includes("software") || requestLower.includes("install") || requestLower.includes("app")) {
    for (const platform of ["macos", "windows", "linux"]) {
      const swDir = `lib/${platform}/software`;
      const swFiles = tree.filter(
        (p) => p.startsWith(swDir) && p.endsWith(".yml")
      );
      for (const sf of swFiles.slice(0, 2)) {
        filesToFetch.add(sf);
      }
    }
  }

  // Fetch default.yml for org-level settings
  if (["sso", "webhook", "integration", "org", "global", "mdm", "label"].some((kw) => requestLower.includes(kw))) {
    filesToFetch.add("default.yml");
  }

  // Fetch all identified files from GitHub
  const result = {};
  for (const relPath of filesToFetch) {
    const fullPath = `${config.github.gitopsBasePath}/${relPath}`;
    const content = await github.getFileContent(fullPath);
    if (content !== null) {
      result[relPath] = content;
    }
  }

  return result;
}

/**
 * Register all Slack event handlers on the Bolt app.
 */
function registerHandlers(app, config, github, claude) {
  app.command("/fleet", async ({ ack, command, respond, client }) => {
    await ack();

    const userRequest = (command.text || "").trim();
    const channelId = command.channel_id;
    const userId = command.user_id;

    console.log(`[/fleet] Request from user ${userId} in channel ${channelId}: "${userRequest}"`);

    if (!userRequest) {
      console.log("[/fleet] Empty request, sending usage help");
      await respond({
        response_type: "ephemeral",
        text: [
          "*Usage:* `/fleet <describe the change you want>`",
          "",
          "*Examples:*",
          "• `/fleet Add a policy to check that Firefox is installed on macOS workstations`",
          "• `/fleet Change the macOS minimum OS version to 15.3 for workstations`",
          "• `/fleet Add Slack to the fleet maintained apps for the servers team`",
        ].join("\n"),
      });
      return;
    }

    // Send a "thinking" message
    await respond({
      response_type: "ephemeral",
      text: ":hourglass_flowing_sand: Analyzing your request and creating a draft PR...",
    });

    try {
      // Fetch repo structure
      console.log("[/fleet] Fetching repo tree...");
      const tree = await github.getRepoTreePaths();
      console.log(`[/fleet] Repo tree fetched: ${tree.length} files`);

      // Smart pre-fetch relevant files
      console.log("[/fleet] Pre-fetching relevant files...");
      const relevantFiles = await prefetchRelevantFiles(userRequest, tree, github, config);
      console.log(`[/fleet] Pre-fetched ${Object.keys(relevantFiles).length} files: ${Object.keys(relevantFiles).join(", ")}`);

      // Call Claude to propose changes
      console.log("[/fleet] Sending request to Claude...");
      const proposal = await claude.proposeChanges(userRequest, tree, relevantFiles);
      console.log(`[/fleet] Claude proposed ${proposal.changes.length} changes: "${proposal.prTitle}"`);

      // Validate the proposed changes
      const warnings = [];
      for (const change of proposal.changes) {
        if (change.filePath.startsWith("teams/") && !change.isNewFile) {
          const errs = validateTeamYaml(change.content);
          warnings.push(...errs.map((e) => `\`${change.filePath}\`: ${e}`));
        } else if (change.filePath.includes("/policies/")) {
          const errs = validatePolicyYaml(change.content);
          warnings.push(...errs.map((e) => `\`${change.filePath}\`: ${e}`));
        }
      }
      if (warnings.length > 0) {
        console.log(`[/fleet] Validation warnings: ${warnings.join("; ")}`);
      }

      // Generate a unique ID for the branch
      const branchId = crypto
        .createHash("sha256")
        .update(`${userId}:${userRequest}:${Date.now()}`)
        .digest("hex")
        .slice(0, 12);

      // Create branch, commit, and open draft PR
      const branchName = `fleet/${branchId}`;
      console.log(`[/fleet] Creating branch ${branchName}...`);
      await github.createBranch(branchName);

      const changes = proposal.changes.map((c) => {
        const normalized = path.posix.normalize(c.filePath);
        if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
          throw new Error(`Invalid file path in response: ${c.filePath}`);
        }
        return {
          path: `${config.github.gitopsBasePath}/${normalized}`,
          content: c.content,
        };
      });
      console.log(`[/fleet] Committing ${changes.length} file(s): ${changes.map((c) => c.path).join(", ")}`);
      await github.commitChanges(branchName, changes, proposal.prTitle);

      console.log("[/fleet] Opening draft PR...");
      const pr = await github.createPullRequest(branchName, proposal.prTitle, proposal.prBody, { draft: true });
      console.log(`[/fleet] Draft PR created: ${pr.url}`);

      // Send the PR link back to the channel
      const fileList = proposal.changes
        .map((c) => `• \`${c.filePath}\` — ${c.changeDescription}`)
        .join("\n");

      const blocks = [
        {
          type: "header",
          text: { type: "plain_text", text: "Draft PR Created" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: *<${pr.url}|${proposal.prTitle}>*\n\n${proposal.summary}\n\n*Files changed:*\n${fileList}`,
          },
        },
      ];

      if (warnings.length > 0) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:warning: *Validation warnings:*\n${warnings.map((w) => `• ${w}`).join("\n")}`,
          },
        });
      }

      await client.chat.postMessage({
        channel: channelId,
        blocks,
        text: `Draft PR created: ${pr.url}`,
      });
      console.log("[/fleet] Slack message sent. Done.");
    } catch (err) {
      console.error("[/fleet] Error:", err);
      await client.chat.postMessage({
        channel: channelId,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:x: *Error:* ${err.message}`,
            },
          },
        ],
        text: `Error: ${err.message}`,
      });
    }
  });
}

module.exports = { registerHandlers };
