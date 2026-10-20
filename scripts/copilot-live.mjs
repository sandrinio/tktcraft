import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phases = ['preview-create', 'create', 'preview-update', 'update', 'read'];
// On Windows `npm` is a .cmd shim that spawnSync cannot start without a shell.
const NPM_CLI = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  .find(path => path && /npm-cli\.c?js$/.test(path) && existsSync(path));

export function parseOptions(args) {
  const options = { phase: 'preview-create' };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    if (!args[index].startsWith('--') ||
        !['provider', 'project', 'board', 'phase', 'report', 'approve-preview'].includes(key) ||
        !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Expected named live-test options; tokens must be provisioned in ignored .tktcraft/.env, never arguments.');
    }
    options[key] = args[index + 1];
  }
  if (!['ado', 'jira'].includes(options.provider) || !options.project || !options.board ||
      !phases.includes(options.phase)) {
    throw new Error('Specify --provider ado|jira, --project, and the user-selected --board. Optional --phase defaults to preview-create.');
  }
  if (['create', 'update'].includes(options.phase) && !/^[a-f0-9]{64}$/.test(options['approve-preview'] ?? '')) {
    throw new Error('A write requires --approve-preview <digest> after showing that exact preview and obtaining explicit human approval.');
  }
  return options;
}

export function previewDigest(provider, project, board, phase, preview) {
  return createHash('sha256').update(JSON.stringify({ provider, project, board, phase, preview })).digest('hex');
}

export function selectIssueType(provider, board) {
  const routed = board.placement.routedIssueTypes ?? [];
  const allowed = board.issueTypes.map(type => type.name)
    .filter(name => !routed.length || routed.some(route => route.toLowerCase() === name.toLowerCase()));
  const preferred = provider === 'ado'
    ? ['User Story', 'Product Backlog Item', 'PBI', 'Requirement', 'Issue', 'Task']
    : ['Task', 'Story', 'Bug'];
  const selected = preferred.find(name => allowed.includes(name));
  assert.ok(selected, 'No preferred test type is supported by this board; stop and select a supported type explicitly.');
  return selected;
}

export function markerQuery(provider, project, board, marker) {
  if (provider === 'ado') return marker;
  const filter = (board.placement.filterQuery || `project = ${JSON.stringify(project)}`)
    .replace(/\s+ORDER\s+BY[\s\S]*$/i, '');
  return `(${filter}) AND summary ~ ${JSON.stringify(`"${marker}"`)}`;
}

function normalizedBody(value) {
  assert.equal(typeof value, 'string', 'Expected a text description or acceptance field.');
  return value.replace(/^\s*(?:#{1,6}|[-*])\s+/gm, '').replaceAll('**', '').replace(/\s+/g, ' ').trim();
}

export function assertBodyMatches(provider, ticket, description) {
  if (provider === 'ado') {
    const [purpose, acceptance] = description.split('## Acceptance Criteria\n');
    assert.ok(acceptance, 'Live draft must include its acceptance section.');
    assert.equal(normalizedBody(ticket.description), normalizedBody(purpose));
    assert.equal(normalizedBody(ticket.acceptanceCriteria), normalizedBody(acceptance));
  } else {
    assert.equal(normalizedBody(ticket.description), normalizedBody(description));
  }
}

function draft(marker) {
  return [
    '## Purpose',
    'Disposable-workspace integration verification for the unreleased tktcraft 0.2.3 candidate.',
    `Run marker: ${marker}`,
    '## Acceptance Criteria',
    '- Create, read back, update, and read back this marked test ticket on the selected board.',
    '- Verify exact title/body fields, board placement, and both post-hook links.',
    '- Retain the remote ticket after testing; only local test folders are disposable.',
    '**Filed by:** Copilot, using the user-selected board and a generated verification draft; execution requires separate approval.',
    '',
  ].join('\n');
}

export async function runLive(options) {
  const { loadDotEnv, upsertDotEnvValues } = await import('../dist/config/manager.js');
  const credentials = loadDotEnv(ROOT);
  const keys = options.provider === 'ado'
    ? ['ADO_ORG_URL', 'ADO_TOKEN']
    : ['JIRA_URL', 'JIRA_USER', 'JIRA_TOKEN'];
  for (const key of keys) assert.ok(credentials[key]?.trim(), `Missing ${key} in ignored .tktcraft/.env (legacy root .env is also read).`);
  const redact = value => ['JIRA_TOKEN', 'ADO_TOKEN'].reduce(
    (text, key) => credentials[key] ? text.replaceAll(credentials[key], '[REDACTED]') : text, value
  );
  const reportPath = resolve(options.report ?? join(ROOT, '.tktcraft/copilot-live-evidence.json'));
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf-8')) : {};
  report.marker ??= `tktcraft-cp07-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
  report.previews ??= {};
  report.items ??= {};
  report.attempts ??= [];
  report.localCleanupRuns ??= [];
  const saved = report.previews[options.provider];
  const writing = options.phase === 'create' || options.phase === 'update';
  if (writing) {
    assert.equal(saved?.digest, options['approve-preview'], 'The supplied digest does not match the saved preview.');
    assert.equal(saved.project, options.project);
    assert.equal(saved.boardId, options.board);
    assert.equal(saved.phase, `preview-${options.phase}`);
  }
  if (options.phase !== 'preview-create' && options.phase !== 'create') {
    assert.ok(report.items[options.provider]?.key, 'No recorded remote ticket; do not guess an ID.');
  }
  const save = () => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, redact(`${JSON.stringify(report, null, 2)}\n`), { mode: 0o600 });
  };
  const temporary = mkdtempSync(join(tmpdir(), 'tkt live verification '));
  const cleanup = { directories: [temporary], verifiedRemoved: false };
  report.localCleanupRuns.push(cleanup);
  const attempt = { provider: options.provider, phase: options.phase, startedAt: new Date().toISOString(), status: 'running' };
  report.attempts.push(attempt);
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf-8', timeout: 180000,
      env: { ...process.env, ...Object.fromEntries(keys.map(key => [key, credentials[key]])), TKT_FORCE_YES: '0' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(redact(result.error?.message || `${command} failed (${result.status}): ${result.stdout}${result.stderr}`));
    }
    return result.stdout;
  };
  const npm = (args, cwd) => NPM_CLI ? run(process.execPath, [NPM_CLI, ...args], cwd) : run('npm', args, cwd);
  try {
    save();
    const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], ROOT));
    assert.ok(!packed.files.some(file => /(^|\/)\.env$|(^|\/)\.tkt(?:craft)?\//.test(file.path)), 'Credential/config path included in archive.');
    const archive = join(temporary, packed.filename);
    const unpacked = spawnSync('tar', ['-xOf', archive], { maxBuffer: 20 * 1024 * 1024 });
    assert.equal(unpacked.status, 0, 'Could not inspect package archive.');
    for (const key of ['JIRA_TOKEN', 'ADO_TOKEN']) {
      if (credentials[key]) assert.ok(!unpacked.stdout.includes(Buffer.from(credentials[key])), 'Credential found in archive; stopped.');
    }
    attempt.packageVersion = packed.version;
    attempt.packageSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const workspace = join(temporary, `${options.provider} consumer workspace`);
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      name: 'tkt-live-verification', private: true, type: 'module',
      dependencies: { 'undici-types': pathToFileURL(join(ROOT, 'node_modules/undici-types')).href },
    }));
    npm(['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--package-lock=false', archive], workspace);
    writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n');
    upsertDotEnvValues(Object.fromEntries(keys.map(key => [key, credentials[key]])), workspace);
    const cli = (...args) => JSON.parse(run(process.execPath,
      ['node_modules/tktcraft/bin/tkt.js', ...args, '--format', 'json'], workspace));
    const setup = cli('setup', '--provider', options.provider, '--project', options.project, '--board', options.board, '--non-interactive');
    assert.equal(setup.ok, true);
    assert.equal(setup.agentIntegration.verifiedActive, false);
    assert.equal(cli('me').ok, true);
    const board = cli('board-schema').data;
    assert.equal(String(board.id), options.board, 'Connected board does not match the user-selected board.');
    const query = markerQuery(options.provider, options.project, board, report.marker);
    const search = () => cli('search', query, '--board-only').data.tickets;
    const createPhase = options.phase === 'preview-create' || options.phase === 'create';
    const item = report.items[options.provider];
    const issueType = createPhase ? (writing ? saved.issueType : selectIssueType(options.provider, board)) : item.issueType;
    const summary = createPhase
      ? `[tktcraft E2E] ${options.provider.toUpperCase()} ${report.marker}`
      : `${item.createdSummary} [verified update]`;
    const description = draft(report.marker);
    writeFileSync(join(workspace, 'ticket-draft.md'), description);
    const command = createPhase
      ? ['create', '--type', issueType, '--summary', summary, '--description-file', 'ticket-draft.md',
        '--column', board.columns[0].columnName]
      : ['update', item.key, '--summary', summary];
    if (createPhase) {
      const existing = search();
      assert.equal(existing.length, 0, `Marked ticket already exists: ${existing.map(ticket => ticket.key).join(', ')}. Read back; do not repeat creation.`);
    }
    if (options.phase !== 'read') {
      const preview = cli(...command, '--dry-run');
      assert.equal(preview.action, `${createPhase ? 'create' : 'update'}.preview`);
      assert.equal(preview.permissionRequired, true);
      const previewPhase = createPhase ? 'preview-create' : 'preview-update';
      const digest = previewDigest(options.provider, options.project, options.board, previewPhase, preview);
      if (writing) {
        assert.equal(digest, options['approve-preview'], 'Live preview changed. Show and approve a new preview before writing.');
        attempt.writeStartedAt = new Date().toISOString();
        save();
        // This flag is not proof of consent: the caller must obtain explicit approval first.
        const output = cli(...command, '--yes');
        const ticket = output.data;
        assert.ok(ticket?.key, 'Write returned no ticket key; search before any retry.');
        report.items[options.provider] = {
          ...item, key: ticket.key, issueType,
          createdSummary: createPhase ? summary : item.createdSummary,
          expectedSummary: summary, description,
          expectedLabels: createPhase ? preview.effectiveLabels : item.expectedLabels,
          expectedAreaPath: createPhase ? preview.effectiveAreaPath : item.expectedAreaPath,
          expectedIterationPath: createPhase ? preview.effectiveIterationPath : item.expectedIterationPath,
          targetStatuses: createPhase ? preview.targetStatuses : item.targetStatuses,
          links: output.links,
        };
        save();
        assert.ok(output.links?.directUrl && output.links?.boardViewUrl, 'Write returned incomplete post-hook links.');
        console.log(JSON.stringify({ provider: options.provider, action: options.phase, key: ticket.key, links: output.links }, null, 2));
      } else {
        report.previews[options.provider] = {
          phase: options.phase, status: 'preview-passed', project: options.project, boardId: options.board,
          boardName: board.name, boardUrl: board.boardUrl, profile: setup.profileName,
          issueType, description, preview, digest, identityVerified: true,
        };
        attempt.status = 'passed';
        console.log(JSON.stringify({ provider: options.provider, ...report.previews[options.provider] }, null, 2));
        return;
      }
    }
    const expected = report.items[options.provider];
    const readBack = cli('get', expected.key).data;
    assert.equal(readBack.summary, expected.expectedSummary);
    assert.equal(readBack.issueType, expected.issueType);
    assert.ok(readBack.description.includes(report.marker), 'Description lost the run marker.');
    assertBodyMatches(options.provider, readBack, expected.description);
    assert.deepEqual([...readBack.labels].sort(), [...(expected.expectedLabels ?? [])].sort());
    assert.equal(readBack.parentKey ?? null, null);
    if (options.provider === 'ado') {
      assert.equal(readBack.areaPath, expected.expectedAreaPath);
      assert.equal(readBack.iterationPath, expected.expectedIterationPath);
    }
    assert.ok(expected.targetStatuses.includes(readBack.status), 'Ticket status is outside the previewed initial board column.');
    let visible = false;
    for (const delay of [0, 1000, 3000, 6000]) {
      if (delay) await setTimeout(delay);
      if (search().some(ticket => ticket.key === expected.key && ticket.summary === expected.expectedSummary)) {
        visible = true;
        break;
      }
    }
    assert.ok(visible, 'Marked ticket was not visible in the board-scoped search.');
    expected.readBack = { status: 'passed', summary: readBack.summary, boardColumn: readBack.boardColumn, providerStatus: readBack.status,
      bodyVerified: true, bodyComparison: 'exact normalized description/acceptance text',
      placementVerified: true, boardSearchVerified: true, checkedAt: new Date().toISOString() };
    attempt.status = 'passed';
    console.log(JSON.stringify({ provider: options.provider, key: expected.key, assertions: expected.readBack, links: expected.links }, null, 2));
  } catch (error) {
    attempt.status = 'failed';
    attempt.error = redact(error instanceof Error ? error.message : String(error));
    if (attempt.writeStartedAt) attempt.retryPolicy = 'Do not repeat the write. Read back/search the recorded marker first.';
    throw new Error(attempt.error);
  } finally {
    try {
      rmSync(temporary, { recursive: true, force: true });
      cleanup.verifiedRemoved = !existsSync(temporary);
      assert.ok(cleanup.verifiedRemoved, 'Run-owned local workspace cleanup was not verified.');
    } finally {
      save();
      console.log(`Run-owned workspace/archive removed: ${cleanup.verifiedRemoved}. Sanitized evidence: ${reportPath}`);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runLive(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
