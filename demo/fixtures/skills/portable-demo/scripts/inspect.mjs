// PORTABLE_SCRIPT_SOURCE_MARKER: this source must only appear after an explicit run.
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = globalThis.process.argv.slice(2);
const guide = readFileSync(join(globalThis.process.cwd(), 'references', 'guide.md'), 'utf8').trim();
const payload = readFileSync(
  join(globalThis.process.cwd(), 'assets', 'payload.txt'),
  'utf8',
).trim();

if (globalThis.process.env.MANEE_FILE_SKILL_EXECUTION_PROBE) {
  appendFileSync(
    globalThis.process.env.MANEE_FILE_SKILL_EXECUTION_PROBE,
    `${JSON.stringify({ scriptUrl: import.meta.url, cwd: globalThis.process.cwd() })}\n`,
  );
}

globalThis.process.stdout.write(
  JSON.stringify({
    argv,
    guide,
    payload,
    cwdBase: basename(globalThis.process.cwd()),
  }),
);

if (argv[0] === '--fail') {
  globalThis.process.stderr.write('EXPECTED_NONZERO_EXIT');
  globalThis.process.exitCode = 7;
}
