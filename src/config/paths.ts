import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WORKSPACE_DIRECTORY = '.tktcraft';

function ignoreWorkspace(workspaceDir: string): void {
  const path = join(workspaceDir, '.gitignore');
  const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = content.split(/\r?\n/).map(line => line.trim());
  const missing = ['.tktcraft/', '.env'].filter(entry => !lines.includes(entry) && !lines.includes(`/${entry}`));
  if (missing.length) {
    writeFileSync(path, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf-8');
  }
}

export function getWorkspacePath(workspaceDir: string, ...parts: string[]): string {
  const home = join(workspaceDir, WORKSPACE_DIRECTORY);
  const legacy = join(workspaceDir, '.tkt');
  for (const path of [home, legacy]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
      throw new Error(`Expected a regular workspace directory at ${path}; resolve it before continuing.`);
    }
  }
  if (existsSync(legacy)) {
    if (existsSync(home)) {
      throw new Error(`Both ${legacy} and ${home} exist. Reconcile them into .tktcraft before continuing; neither was overwritten.`);
    }
    ignoreWorkspace(workspaceDir);
    renameSync(legacy, home);
  }
  return join(home, ...parts);
}

export function ensureWorkspaceHome(workspaceDir: string): string {
  const home = getWorkspacePath(workspaceDir);
  ignoreWorkspace(workspaceDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
