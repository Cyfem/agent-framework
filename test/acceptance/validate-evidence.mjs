#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_SCHEMA, loadAndValidateManifest } from './lib/manifest.mjs';
import {
  assert,
  assertArray,
  assertDigest,
  assertEnum,
  assertExactKeys,
  assertInteger,
  assertString,
  assertUnique,
  parseCliArgs,
  printFailure,
  readJson,
  rejectCostFields,
  resolveExistingRepoPath,
} from './lib/validation.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..');
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function validateEvidence(evidence, manifestResult) {
  rejectCostFields(evidence);
  assertExactKeys(
    evidence,
    [
      'schema',
      'evidenceRunId',
      'commit',
      'platform',
      'node',
      'packageVersion',
      'packageManager',
      'lockDigest',
      'manifestDigest',
      'buildDigest',
      'suite',
      'status',
      'cases',
      'provider',
    ],
    '$',
  );
  assert(evidence.schema === EVIDENCE_SCHEMA, `schema must be ${EVIDENCE_SCHEMA}`);
  assertString(evidence.evidenceRunId, 'evidenceRunId', ID_PATTERN);
  assertString(evidence.commit, 'commit', /^[a-f0-9]{40}$/u);
  assertEnum(evidence.platform, ['win32', 'linux'], 'platform');
  assertString(evidence.node, 'node', /^22(?:\.|$)/u);
  assert(
    evidence.packageVersion === manifestResult.manifest.packageVersion,
    'packageVersion does not match the manifest',
  );
  assert(evidence.packageManager === 'pnpm@11.1.3', 'packageManager must be pnpm@11.1.3');
  assertDigest(evidence.lockDigest, 'lockDigest');
  assert(
    evidence.manifestDigest === manifestResult.digest,
    'manifestDigest does not match the manifest file',
  );
  assertDigest(evidence.buildDigest, 'buildDigest');
  assertString(evidence.suite, 'suite', ID_PATTERN);
  assertEnum(evidence.status, ['passed', 'failed', 'incomplete'], 'status');
  assertArray(evidence.cases, 'cases');
  const caseIds = [];
  for (const [index, entry] of evidence.cases.entries()) {
    const field = `cases[${index}]`;
    assertExactKeys(entry, ['caseId', 'status', 'reasonCode'], field);
    assertString(entry.caseId, `${field}.caseId`, ID_PATTERN);
    assert(
      manifestResult.caseIds.has(entry.caseId),
      `${field}.caseId is not declared in the manifest`,
    );
    assertEnum(entry.status, ['passed', 'failed', 'skipped'], `${field}.status`);
    if (entry.status === 'skipped')
      assertString(entry.reasonCode, `${field}.reasonCode`, /^[A-Z][A-Z0-9_]*$/u);
    else
      assert(
        entry.reasonCode === undefined,
        `${field}.reasonCode is only allowed for skipped cases`,
      );
    caseIds.push(entry.caseId);
  }
  assertUnique(caseIds, 'cases.caseId');
  if (evidence.provider !== undefined) {
    assertExactKeys(
      evidence.provider,
      [
        'profileId',
        'expectedSdkAttempts',
        'sdkCreateAttempts',
        'hardLimit',
        'completedCalls',
        'usageReportedCalls',
        'unknownAttempts',
      ],
      'provider',
    );
    assertString(evidence.provider.profileId, 'provider.profileId', /^[a-z0-9][a-z0-9._-]*$/u);
    const profile = manifestResult.manifest.providerProfiles.find(
      (item) => item.profileId === evidence.provider.profileId,
    );
    assert(profile, 'provider.profileId is not declared in the manifest');
    for (const key of [
      'expectedSdkAttempts',
      'sdkCreateAttempts',
      'hardLimit',
      'completedCalls',
      'usageReportedCalls',
      'unknownAttempts',
    ])
      assertInteger(evidence.provider[key], `provider.${key}`);
    assert(
      evidence.provider.expectedSdkAttempts === profile.expectedSdkAttempts,
      'provider.expectedSdkAttempts does not match the manifest',
    );
    assert(
      evidence.provider.hardLimit === profile.hardLimit,
      'provider.hardLimit does not match the manifest',
    );
    assert(
      evidence.provider.sdkCreateAttempts <= evidence.provider.hardLimit,
      'provider.sdkCreateAttempts exceeds hardLimit',
    );
    assert(
      evidence.provider.completedCalls <= evidence.provider.sdkCreateAttempts,
      'provider.completedCalls exceeds sdkCreateAttempts',
    );
    assert(
      evidence.provider.usageReportedCalls <= evidence.provider.completedCalls,
      'provider.usageReportedCalls exceeds completedCalls',
    );
    assert(
      evidence.provider.unknownAttempts <= evidence.provider.sdkCreateAttempts,
      'provider.unknownAttempts exceeds sdkCreateAttempts',
    );
    if (evidence.status === 'passed') {
      assert(
        evidence.provider.sdkCreateAttempts === evidence.provider.expectedSdkAttempts,
        'passed provider evidence must use the exact expected SDK attempts',
      );
      assert(
        evidence.provider.completedCalls === evidence.provider.expectedSdkAttempts,
        'passed provider evidence must complete every expected SDK attempt',
      );
      assert(
        evidence.provider.unknownAttempts === 0,
        'passed provider evidence cannot contain outcome-unknown attempts',
      );
    }
  }
  if (evidence.status === 'passed') {
    assert(
      evidence.cases.every((entry) => entry.status === 'passed'),
      'passed evidence cannot contain failed or skipped cases',
    );
  }
  return { cases: caseIds.length, status: evidence.status };
}

try {
  const options = parseCliArgs(process.argv.slice(2));
  const relativeManifest = options.get('manifest') ?? 'test/acceptance/subagent-v2.manifest.json';
  const relativeEvidence = options.get('evidence');
  if (typeof relativeManifest !== 'string') throw new Error('--manifest requires a value');
  if (typeof relativeEvidence !== 'string')
    throw new Error('usage: validate-evidence.mjs --evidence=<safe/repo-relative.json>');
  const manifestPath = await resolveExistingRepoPath(repoRoot, relativeManifest, '--manifest');
  const evidencePath = await resolveExistingRepoPath(repoRoot, relativeEvidence, '--evidence');
  const manifestResult = await loadAndValidateManifest(manifestPath, repoRoot);
  const evidence = await readJson(evidencePath);
  const summary = validateEvidence(evidence, manifestResult);
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', evidenceStatus: summary.status, cases: summary.cases, manifestDigest: manifestResult.digest })}\n`,
  );
} catch (error) {
  printFailure(error);
  process.exitCode = 1;
}
