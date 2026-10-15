import type { LoomDb, LoomGraph } from '@loom/core';
import { gitTry, graphName, readConfig, tenant as homeTenant } from '@loom/memory';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** I1: the only place a repo graph name is built — from the session's cwd and the tenant, never from request input. */
export async function resolveRepo(db: LoomDb, cwd: string, home?: string): Promise<{ root: string; top: string; graph: LoomGraph; tenant: string } | null> {
  if (!cwd) return null;
  const common = gitTry(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const top = gitTry(cwd, 'rev-parse', '--show-toplevel');
  if (!common || !top) return null;
  const root = dirname(common);
  const cfg = readConfig(root); if (!cfg?.repoId) return null;
  // `home` is the test-only x-loom-home header (one process acting as two tenants); otherwise LOOM_HOME, then ~/.loom
  const hp = home ? join(home, 'config.json') : null;
  const tenant = hp ? String((existsSync(hp) ? JSON.parse(readFileSync(hp, 'utf8')).tenant : undefined) ?? process.env.USER ?? 'local') : homeTenant();
  return { root, top, graph: db.graph(graphName(tenant, cfg.repoId)), tenant };
}
