import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
export function loadPlaywright() {
  const root = process.env.MW_PLAYWRIGHT_ROOT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
  return createRequire(path.join(root, 'package.json'))('playwright-core');
}
