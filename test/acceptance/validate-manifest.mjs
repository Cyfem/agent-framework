#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadAndValidateManifest, parseAcceptanceRegistrationsSource } from './lib/manifest.mjs';
import { assert, parseCliArgs, printFailure, resolveExistingRepoPath } from './lib/validation.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..');

try {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.has('self-test')) {
    assert(options.size === 1, '--self-test cannot be combined with other options');
    const literal = parseAcceptanceRegistrationsSource(
      "acceptanceIt('SELF-01', 'literal-case', async () => undefined);",
      'self-test/literal.test.ts',
    );
    assert(
      literal.length === 1 &&
        literal[0]?.caseId === 'SELF-01' &&
        literal[0]?.variant === 'literal-case',
      'literal acceptance registration self-test failed',
    );
    let rejectedDynamic = false;
    try {
      parseAcceptanceRegistrationsSource(
        "const caseId = 'SELF-02'; acceptanceIt(caseId, 'dynamic-case', async () => undefined);",
        'self-test/dynamic.test.ts',
      );
    } catch (error) {
      rejectedDynamic =
        error instanceof Error && error.message.includes('must use literal caseId and variant');
    }
    assert(rejectedDynamic, 'dynamic acceptance registration self-test was not rejected');
    process.stdout.write(
      `${JSON.stringify({ status: 'passed', mode: 'self-test', literalRegistrations: literal.length, dynamicRejected: true })}\n`,
    );
    process.exit(0);
  }
  const relativeManifest = options.get('manifest') ?? 'test/acceptance/subagent-v2.manifest.json';
  if (typeof relativeManifest !== 'string') throw new Error('--manifest requires a value');
  const manifestPath = await resolveExistingRepoPath(repoRoot, relativeManifest, '--manifest');
  const result = await loadAndValidateManifest(manifestPath, repoRoot);
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', schema: result.manifest.schema, manifestDigest: result.digest, requirements: result.manifest.requirements.length, cases: result.caseIds.size, providerTotals: result.manifest.providerTotals })}\n`,
  );
} catch (error) {
  printFailure(error);
  process.exitCode = 1;
}
