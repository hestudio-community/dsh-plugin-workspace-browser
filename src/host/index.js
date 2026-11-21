import Schema from '@deepseek-ai/schemastery';
import { PROJECT_ID } from '../shared/identity.js';
import { createAgent } from './agent.js';
import { createPool, DEFAULT_IDLE_TIMEOUT_MINUTES } from './pool.js';
import { createRunnerLauncher } from './runner.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRootAccount, rootAccountName } from './root-account.js';
import { createWorkspaceAccess } from './workspace-access.js';
import { registerWeb } from './web.js';

export const inject = ['workspaceRegistry', 'connection', 'webServer'];

export const Config = Schema.object({
  agentEnabled: Schema.boolean().default(true).volatile().description(`Register the ${PROJECT_ID} tool. Each Session must explicitly enable access to its workspace browser.`),
  idleTimeoutMinutes: Schema.natural().max(1440).default(DEFAULT_IDLE_TIMEOUT_MINUTES).volatile().description('Minutes to keep a browser after its last workspace view disconnects (0–1440). Set to 0 to disable idle expiry. Changes apply without restarting the browser.'),
  allowedWebOrigins: Schema.array(Schema.string()).default([]).volatile().description('Exact public HTTP(S) origins of trusted reverse-proxied DSH Web deployments. Leave empty for local access only.'),
  ...(process.platform === 'linux' && process.geteuid() === 0 ? {
    rootBrowserAccount: Schema.string().default('').volatile().description('Dedicated local non-login system account used to run Chromium when the Host runs as root.'),
  } : {}),
  dockerExecutable: Schema.string().default('').description('Absolute path to the local Docker CLI. Leave empty for the platform default.'),
  seccompProfile: Schema.string().default('').description('Absolute path to a reviewed Docker seccomp profile. Leave empty to use the bundled Chromium profile.'),
  profileNamespace: Schema.string().pattern(/^[A-Za-z0-9_-]{1,64}$/).default('default').description('Use a stable, distinct value for each DSH profile that shares this Docker engine.'),
});

export function apply(ctx, config) {
  ctx.effect(() => {
    const runner = createRunnerLauncher(config);
    const workspaceAccess = process.platform === 'linux' && process.geteuid() === 0 ? createWorkspaceAccess({
      resolveWorkspace: sessionId => pool.findSession(sessionId),
      resolveAccount: () => resolveRootAccount(rootAccountName(config.rootBrowserAccount)),
      protectedPaths: [fileURLToPath(new URL('../../', import.meta.url)), process.env.DSH_HOME, process.env.DSH_PROFILE_DIR,
        config.seccompProfile && dirname(config.seccompProfile), config.dockerExecutable && dirname(config.dockerExecutable)].filter(Boolean),
    }) : undefined;
    const pool = createPool(ctx.workspaceRegistry, runner.start, () => config.idleTimeoutMinutes.get(),
      (sessionId, peerId, workspace) => workspaceAccess?.noteFailure(sessionId, peerId, workspace));
    const agent = createAgent(ctx, pool, config.agentEnabled.get());
    let dropWeb;
    let dropConfig;
    async function dispose() {
      workspaceAccess?.dispose();
      dropConfig?.();
      try { dropWeb?.(); } finally {
        try { agent.stopAdmission(); } finally {
          try { await runner.close(); } finally {
            try { await pool.dispose(); } finally { await agent.dispose(); }
          }
        }
      }
    }
    try {
      dropWeb = registerWeb(ctx, pool, agent, runner.environment, () => config.allowedWebOrigins.get(), workspaceAccess);
      dropConfig = ctx.on('loader/volatile-update', () => {
        void agent.setEnabled(config.agentEnabled.get())?.catch((error) => {
          ctx.logger.error(`Could not update the ${PROJECT_ID} tool: %s`, error);
        });
      });
    } catch (error) {
      void dispose().catch(() => {});
      throw error;
    }
    return dispose;
  }, `${PROJECT_ID}: Host`);
}
