import Schema from '@deepseek-ai/schemastery';
import { createAgent } from './agent.js';
import { createPool } from './pool.js';
import { createRunnerLauncher } from './runner.js';
import { registerWeb } from './web.js';

export const inject = ['workspaceRegistry', 'connection', 'webServer'];

export const Config = Schema.object({
  agentEnabled: Schema.boolean().default(true).volatile().description('Register the workspace browser tool. Each Session must explicitly enable access to its workspace browser.'),
  dockerExecutable: Schema.string().default('').description('Absolute path to the local Docker CLI. Leave empty for the platform default.'),
  seccompProfile: Schema.string().default('').description('Absolute path to a reviewed Docker seccomp profile. Leave empty to use the bundled Chromium profile.'),
  profileNamespace: Schema.string().pattern(/^[A-Za-z0-9_-]{1,64}$/).default('default').description('Use a stable, distinct value for each DSH profile that shares this Docker engine.'),
});

export function apply(ctx, config) {
  ctx.effect(() => {
    const runner = createRunnerLauncher(config);
    const pool = createPool(ctx.workspaceRegistry, runner.start);
    const agent = createAgent(ctx, pool, config.agentEnabled.get());
    let dropWeb;
    let dropConfig;
    async function dispose() {
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
      dropWeb = registerWeb(ctx, pool, agent);
      dropConfig = ctx.on('loader/volatile-update', () => {
        void agent.setEnabled(config.agentEnabled.get())?.catch((error) => {
          ctx.logger.error('Could not update the workspace browser tool: %s', error);
        });
      });
    } catch (error) {
      void dispose().catch(() => {});
      throw error;
    }
    return dispose;
  }, 'Workspace Browser: Host');
}
