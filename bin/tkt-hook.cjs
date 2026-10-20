const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2];
const copilot = mode === 'copilot-pre-tool' || mode === 'copilot-post-tool';
const failureCode = copilot ? 2 : 1;
if (!['pre-tool', 'post-tool', 'copilot-pre-tool', 'copilot-post-tool'].includes(mode)) {
  console.error('tkt hook launcher: expected pre-tool or post-tool, optionally prefixed with copilot-.');
  process.exit(failureCode);
}

const cli = join(__dirname, 'tkt.js');
if (!existsSync(cli)) {
  console.error('tkt hook launcher: missing bin/tkt.js. Reinstall tktcraft and rerun tkt setup.');
  process.exit(failureCode);
}

const result = spawnSync(process.execPath, [cli, 'hook', mode], { stdio: 'inherit' });
if (result.error) {
  console.error(`tkt hook launcher: ${result.error.message}. Check Node.js and rerun tkt setup.`);
  process.exit(failureCode);
}
if (result.signal) {
  console.error(`tkt hook launcher: process terminated by ${result.signal}.`);
}
process.exit(result.status === 0 ? 0 : (copilot ? 2 : result.status ?? 1));
