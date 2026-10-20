import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { getWorkspacePath } from '../config/paths.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COPILOT_HOOKS = '.github/hooks/tkt-governance.json';
const MANIFEST = '.tktcraft/agent-integration.json';
const BEGIN = '<!-- tktcraft:begin -->';
const END = '<!-- tktcraft:end -->';

export interface AgentIntegrationResult {
  status: 'installed';
  verifiedActive: false;
  instructionsPath: string;
  preservedFiles: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Could not read integration configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(value)) throw new Error(`Invalid integration configuration at ${path}: expected a JSON object.`);
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLegacyHooks(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key: string, entry: unknown) => {
    if (key === 'command' && typeof entry === 'string') {
      for (const mode of ['pre-tool', 'post-tool']) {
        if (entry === `node ../bin/tkt.js hook ${mode}` || entry === `node ./bin/tkt.js hook ${mode}` ||
            entry === `node .agents/tkt-hook.cjs ${mode}`) {
          return `node .tktcraft/hooks/tkt-hook.cjs ${mode}`;
        }
      }
    }
    return entry;
  });
}

function launcherContent(path: string, legacy = false): string {
  return [
    `const launcher = ${JSON.stringify(path)};`,
    "if (!require('node:fs').existsSync(launcher)) {",
    "  console.error('tkt hook launcher: installed package is missing. Reinstall tktcraft and rerun tkt setup.');",
    legacy ? '  process.exit(1);' : "  process.exit(process.argv[2]?.startsWith('copilot-') ? 2 : 1);",
    '}',
    'require(launcher);',
    '',
  ].join('\n');
}

function instructionBlock(path: string): string {
  const prefix = path === 'AGENTS.md' ? './' : '../';
  return [
    BEGIN,
    '## Ticket operations (tktcraft)',
    '',
    `For Jira or Azure DevOps requests, read the full [tkt-ops workflow](${prefix}.tktcraft/skills/tkt-ops/SKILL.md).`,
    `Read the connected [board routing index](${prefix}.tktcraft/boards/INDEX.md) or run \`tkt board-schema\` before choosing fields or statuses.`,
    'If not connected, list boards and let the user choose before running `tkt setup --board "<ID>"`.',
    'Never delete tickets. Show a dry-run/structured preview and obtain explicit user approval before every create/update; never treat a staged token as proof of approval.',
    'After a write, display both the direct ticket link and connected board-view link.',
    'Keep credentials in ignored `.tktcraft/.env`, not chat, browser login, instructions, or board configuration.',
    END,
  ].join('\n');
}

export function scaffoldWorkspaceAgentHarness(workspaceDir: string = process.cwd()): AgentIntegrationResult {
  const workspace = resolve(workspaceDir);
  if (workspace === PACKAGE_ROOT) {
    return { status: 'installed', verifiedActive: false, instructionsPath: 'AGENTS.md', preservedFiles: [] };
  }

  const installedLauncher = join(PACKAGE_ROOT, 'bin', 'tkt-hook.cjs');
  for (const asset of ['.agents/skills/tkt-ops/SKILL.md', '.agents/hooks.json', COPILOT_HOOKS, 'bin/tkt-hook.cjs']) {
    if (!existsSync(join(PACKAGE_ROOT, asset))) {
      throw new Error(`Missing tktcraft integration asset: ${join(PACKAGE_ROOT, asset)}. Reinstall tktcraft and rerun tkt setup.`);
    }
  }
  const manifestPath = getWorkspacePath(workspace, 'agent-integration.json');
  const previous: Record<string, string> = {};
  let instructionsPath = existsSync(join(workspace, 'AGENTS.md')) || !existsSync(join(workspace, '.github/copilot-instructions.md'))
    ? 'AGENTS.md' : '.github/copilot-instructions.md';
  if (existsSync(manifestPath)) {
    const manifest = readObject(manifestPath);
    if (manifest.version !== 1 || !isObject(manifest.files) ||
        !['AGENTS.md', '.github/copilot-instructions.md'].includes(String(manifest.instructionsPath))) {
      throw new Error(`Invalid tktcraft integration manifest at ${manifestPath}. Review it before rerunning setup.`);
    }
    instructionsPath = String(manifest.instructionsPath);
    for (const [path, digest] of Object.entries(manifest.files)) {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`Invalid asset hash in ${manifestPath}. Review it before rerunning setup.`);
      }
      previous[path] = digest;
    }
  }

  const writes = new Map<string, string>();
  const files: Record<string, string> = {};
  const preservedFiles: string[] = [];
  const manageFile = (path: string, desired: string, legacy?: string): void => {
    const target = join(workspace, path);
    const existing = existsSync(target) ? readFileSync(target, 'utf-8') : undefined;
    if (existing !== undefined && existing !== desired && existing !== legacy && hash(existing) !== previous[path]) {
      throw new Error(`Conflicting customized integration at ${target}; it was not overwritten. Review the file before rerunning tkt setup.`);
    }
    if (existing !== desired) writes.set(path, desired);
    files[path] = hash(desired);
  };

  manageFile('.tktcraft/hooks/tkt-hook.cjs', launcherContent(installedLauncher));
  const oldLauncherPath = '.agents/tkt-hook.cjs';
  if (existsSync(join(workspace, oldLauncherPath))) {
    const oldLauncher = readFileSync(join(workspace, oldLauncherPath), 'utf-8');
    const compatibilityLauncher = "require('../.tktcraft/hooks/tkt-hook.cjs');\n";
    if (![launcherContent(installedLauncher), launcherContent(installedLauncher, true), compatibilityLauncher].includes(oldLauncher) &&
        hash(oldLauncher) !== previous[oldLauncherPath]) {
      throw new Error(`Conflicting customized integration at ${join(workspace, oldLauncherPath)}; it was not overwritten.`);
    }
    manageFile(oldLauncherPath, compatibilityLauncher, oldLauncher);
  }
  const copilotSource = readFileSync(join(PACKAGE_ROOT, COPILOT_HOOKS), 'utf-8');
  manageFile(COPILOT_HOOKS,
    copilotSource.replaceAll('node .agents/tkt-hook.cjs', 'node .tktcraft/hooks/tkt-hook.cjs'),
    copilotSource);

  const hookPath = '.agents/hooks.json';
  const sourceHooks = normalizeLegacyHooks(readObject(join(PACKAGE_ROOT, hookPath)));
  if (!isObject(sourceHooks)) throw new Error('Invalid packaged legacy hook registration.');
  const existingHooks = existsSync(join(workspace, hookPath)) ? readObject(join(workspace, hookPath)) : {};
  const registration = 'tkt-board-governance';
  const registrationKey = `${hookPath}#${registration}`;
  if (Object.hasOwn(existingHooks, registration) &&
      !isDeepStrictEqual(normalizeLegacyHooks(existingHooks[registration]), sourceHooks[registration]) &&
      hash(JSON.stringify(existingHooks[registration])) !== previous[registrationKey]) {
    throw new Error(`Customized tkt hooks at ${join(workspace, hookPath)}. Reconcile the ${registration} section before rerunning tkt setup; it was not overwritten.`);
  }
  const desiredHooks = { ...existingHooks, [registration]: sourceHooks[registration] };
  if (!isDeepStrictEqual(existingHooks, desiredHooks)) {
    writes.set(hookPath, `${JSON.stringify(desiredHooks, null, 2)}\n`);
  }
  files[registrationKey] = hash(JSON.stringify(sourceHooks[registration]));

  const targetInstructions = join(workspace, instructionsPath);
  const existingInstructions = existsSync(targetInstructions) ? readFileSync(targetInstructions, 'utf-8') : '';
  const start = existingInstructions.indexOf(BEGIN);
  const end = existingInstructions.indexOf(END);
  const block = instructionBlock(instructionsPath);
  const blockKey = `${instructionsPath}#tktcraft`;
  if (start !== -1 || end !== -1) {
    if (start === -1 || end < start || existingInstructions.indexOf(BEGIN, start + BEGIN.length) !== -1 ||
        existingInstructions.indexOf(END, end + END.length) !== -1) {
      throw new Error(`Malformed or duplicate tktcraft instruction markers at ${targetInstructions}; it was not overwritten.`);
    }
    const existingBlock = existingInstructions.slice(start, end + END.length);
    if (existingBlock !== block && hash(existingBlock) !== previous[blockKey]) {
      throw new Error(`Customized tktcraft instructions at ${targetInstructions}; it was not overwritten.`);
    }
    if (existingBlock !== block) {
      writes.set(instructionsPath, existingInstructions.slice(0, start) + block + existingInstructions.slice(end + END.length));
    }
  } else {
    const separator = existingInstructions ? (existingInstructions.endsWith('\n') ? '\n' : '\n\n') : '';
    writes.set(instructionsPath, `${existingInstructions}${separator}${block}\n`);
  }
  files[blockKey] = hash(block);

  const skillRoot = '.agents/skills/tkt-ops';
  const canonicalSkillRoot = '.tktcraft/skills/tkt-ops';
  const entryMarker = '<!-- tktcraft:skill-entry -->';
  const directories: string[] = [];
  const collectSkill = (base: string, relative = '', legacy = false): Map<string, string> => {
    const found = new Map<string, string>();
    const directory = join(base, skillRoot, relative);
    if (!existsSync(directory)) return found;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        for (const [name, content] of collectSkill(base, path, legacy)) found.set(name, content);
        if (legacy) directories.push(join(base, skillRoot, path));
      } else if (entry.isFile()) {
        found.set(path, readFileSync(join(base, skillRoot, path), 'utf-8'));
      } else {
        throw new Error(`Unsupported skill asset at ${join(directory, entry.name)}; reconcile it before setup.`);
      }
    }
    return found;
  };
  const packaged = collectSkill(PACKAGE_ROOT);
  const oldSkill = collectSkill(workspace, '', true);
  const deletions: string[] = [];
  let skillBody = '';
  for (const name of new Set([...packaged.keys(), ...oldSkill.keys()])) {
    const path = `${canonicalSkillRoot}/${name}`;
    const oldPath = `${skillRoot}/${name}`;
    const source = packaged.get(name);
    const desired = name === 'SKILL.md' ? source?.replaceAll('(../../hooks.json)', '(../../../.agents/hooks.json)') : source;
    const legacy = name === 'SKILL.md' && oldSkill.get(name)?.includes(entryMarker) ? undefined : oldSkill.get(name);
    const customizedLegacy = legacy !== undefined && legacy !== source &&
      legacy !== source?.replaceAll('.tktcraft/', '.tkt/') && hash(legacy) !== previous[oldPath];
    const existing = existsSync(join(workspace, path)) ? readFileSync(join(workspace, path), 'utf-8') : undefined;
    const customized = existing !== undefined && existing !== desired && hash(existing) !== previous[path];
    if (existing !== undefined && legacy !== undefined && existing !== legacy && (customized || customizedLegacy)) {
      throw new Error(`Conflicting skill assets at ${join(workspace, oldPath)} and ${join(workspace, path)}; neither was overwritten.`);
    }
    const content = customized ? existing : customizedLegacy ? legacy : desired ?? legacy;
    if (content === undefined) continue;
    if (existing !== content) writes.set(path, content);
    if (content === desired && !customizedLegacy) files[path] = hash(content);
    else preservedFiles.push(path);
    if (name === 'SKILL.md') skillBody = content;
    else if (legacy !== undefined) deletions.push(join(workspace, oldPath));
  }
  const header = skillBody.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ??
    packaged.get('SKILL.md')?.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
  if (!header) throw new Error('Packaged tkt-ops skill is missing YAML metadata.');
  const skillEntry = `${header.trimEnd()}\n\n${entryMarker}\nRead the [full tkt-ops workflow](../../../.tktcraft/skills/tkt-ops/SKILL.md) before any ticket operation. Templates and board context live under .tktcraft/.\n`;
  const oldBody = oldSkill.get('SKILL.md');
  manageFile(`${skillRoot}/SKILL.md`, skillEntry, oldBody?.includes(entryMarker) ? undefined : oldBody);

  const gitignorePath = join(workspace, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : 'node_modules/\n';
  const ignores = ['.env', '.tktcraft/'].filter((entry) => !gitignore.split(/\r?\n/).some((line) => line.trim() === entry));
  if (ignores.length) {
    writes.set('.gitignore', `${gitignore}${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}${ignores.join('\n')}\n`);
  }
  const manifest = `${JSON.stringify({ version: 1, instructionsPath, files }, null, 2)}\n`;
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf-8') !== manifest) writes.set(MANIFEST, manifest);
  for (const [path, content] of writes) {
    const target = join(workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  for (const path of deletions) rmSync(path);
  for (const directory of directories) {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
  return { status: 'installed', verifiedActive: false, instructionsPath, preservedFiles };
}
