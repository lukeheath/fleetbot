const { App } = require("@slack/bolt");
const config = require("./config");
const GitHubClient = require("./github-client");
const ClaudeClient = require("./claude-client");
const { registerHandlers } = require("./slack-handlers");
const { createWebhookHandler } = require("./webhook-handler");

const github = new GitHubClient({
  token: config.github.token,
  repo: config.github.repo,
  baseBranch: config.github.baseBranch,
  gitopsBasePath: config.github.gitopsBasePath,
});

const claude = new ClaudeClient({
  apiKey: config.anthropic.apiKey,
  model: config.anthropic.model,
});

const app = new App({
  token: config.slack.botToken,
  socketMode: true,
  appToken: config.slack.appToken,
  processBeforeResponse: false,
  customRoutes: [
    {
      path: "/github/webhook",
      method: "POST",
      handler: createWebhookHandler(config, github, claude),
    },
  ],
  installerOptions: {
    port: config.webhook.port,
  },
});

registerHandlers(app, config, github, claude);

(async () => {
  await app.start();
  console.log("Fleet is running!");
  console.log(`  Repo: ${config.github.repo}`);
  console.log(`  Branch: ${config.github.baseBranch}`);
  console.log(`  Path: ${config.github.gitopsBasePath}`);
  console.log(`  Model: ${config.anthropic.model}`);
  console.log(`  Webhook: http://localhost:${config.webhook.port}/github/webhook`);
  console.log(`  CI auto-fix: ${config.ci.autoFix ? `enabled (check: ${config.ci.checkName})` : "disabled"}`);
  console.log("\nListening for /fleet commands and GitHub webhooks...");
})();
