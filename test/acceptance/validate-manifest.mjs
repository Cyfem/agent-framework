#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadAndValidateManifest } from './lib/manifest.mjs';
import { parseCliArgs, printFailure, resolveExistingRepoPath } from './lib/validation.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..');

try {
  const options = parseCliArgs(process.argv.slice(2));
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
