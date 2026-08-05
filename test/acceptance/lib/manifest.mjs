import path from 'node:path';
import {
  assert,
  assertArray,
  assertEnum,
  assertExactKeys,
  assertInteger,
  assertSafeRelativePath,
  assertString,
  assertUnique,
  readJson,
  rejectCostFields,
  resolveExistingRepoPath,
  sha256File,
} from './validation.mjs';

export const MANIFEST_SCHEMA = 'subagent-v2-acceptance-manifest/v1';
export const EVIDENCE_SCHEMA = 'subagent-v2-evidence/v1';

export const EXPECTED_PROVIDER_PROFILES = Object.freeze({
  smoke: [24, 24],
  worker: [19, 21],
  process: [19, 21],
  http: [11, 13],
  bullmq: [15, 16],
  docker: [15, 16],
  'core-full': [110, 112],
});

const PHASES = ['phase-1', 'phase-2', 'phase-3'];
const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]*$/u;
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VARIANT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

function validateProviderProfiles(manifest) {
  assertArray(manifest.providerProfiles, 'providerProfiles');
  assert(
    manifest.providerProfiles.length === Object.keys(EXPECTED_PROVIDER_PROFILES).length,
    'providerProfiles must contain exactly the seven frozen profiles',
  );
  const ids = [];
  let expectedTotal = 0;
  let hardTotal = 0;
  for (const [index, profile] of manifest.providerProfiles.entries()) {
    const field = `providerProfiles[${index}]`;
    assertExactKeys(profile, ['profileId', 'status', 'expectedSdkAttempts', 'hardLimit'], field);
    assertString(profile.profileId, `${field}.profileId`, VARIANT_PATTERN);
    assertEnum(profile.status, ['planned', 'active'], `${field}.status`);
    assertInteger(profile.expectedSdkAttempts, `${field}.expectedSdkAttempts`);
    assertInteger(profile.hardLimit, `${field}.hardLimit`);
    const frozen = EXPECTED_PROVIDER_PROFILES[profile.profileId];
    assert(frozen, `${field}.profileId is not a frozen provider profile`);
    assert(
      profile.expectedSdkAttempts === frozen[0] && profile.hardLimit === frozen[1],
      `${profile.profileId} budget must be ${frozen[0]}/${frozen[1]}`,
    );
    assert(
      profile.hardLimit >= profile.expectedSdkAttempts,
      `${field}.hardLimit must cover expectedSdkAttempts`,
    );
    ids.push(profile.profileId);
    expectedTotal += profile.expectedSdkAttempts;
    hardTotal += profile.hardLimit;
  }
  assertUnique(ids, 'providerProfiles.profileId');
  assertExactKeys(manifest.providerTotals, ['expectedSdkAttempts', 'hardLimit'], 'providerTotals');
  assertInteger(manifest.providerTotals.expectedSdkAttempts, 'providerTotals.expectedSdkAttempts');
  assertInteger(manifest.providerTotals.hardLimit, 'providerTotals.hardLimit');
  assert(expectedTotal === 213 && hardTotal === 223, 'provider profile sums must remain 213/223');
  assert(
    manifest.providerTotals.expectedSdkAttempts === expectedTotal &&
      manifest.providerTotals.hardLimit === hardTotal,
    'providerTotals must equal the profile sums',
  );
}

async function validateCase(entry, requirement, index, repoRoot) {
  const field = `${requirement}.cases[${index}]`;
  assertExactKeys(entry, ['caseId', 'variant', 'phase', 'layer', 'evidenceSource'], field);
  assertString(entry.caseId, `${field}.caseId`, CASE_ID_PATTERN);
  assertString(entry.variant, `${field}.variant`, VARIANT_PATTERN);
  assertEnum(entry.phase, PHASES, `${field}.phase`);
  assertEnum(entry.layer, LAYERS, `${field}.layer`);
  assertExactKeys(
    entry.evidenceSource,
    ['type', 'file', 'testName', 'scenarioId', 'suite'],
    `${field}.evidenceSource`,
  );
  assertEnum(
    entry.evidenceSource.type,
    ['vitest', 'process', 'pack', 'regression', 'ark-scenario'],
    `${field}.evidenceSource.type`,
  );
  if (entry.evidenceSource.file !== undefined) {
    assertSafeRelativePath(entry.evidenceSource.file, `${field}.evidenceSource.file`);
    await resolveExistingRepoPath(
      repoRoot,
      entry.evidenceSource.file,
      `${field}.evidenceSource.file`,
    );
  }
  for (const key of ['testName', 'scenarioId', 'suite']) {
    if (entry.evidenceSource[key] !== undefined)
      assertString(entry.evidenceSource[key], `${field}.evidenceSource.${key}`);
  }
}

export async function loadAndValidateManifest(manifestPath, repoRoot) {
  const manifest = await readJson(manifestPath);
  rejectCostFields(manifest);
  assertExactKeys(
    manifest,
    ['schema', 'design', 'packageVersion', 'providerProfiles', 'providerTotals', 'requirements'],
    '$',
  );
  assert(manifest.schema === MANIFEST_SCHEMA, `schema must be ${MANIFEST_SCHEMA}`);
  assert(manifest.design === 'subagent-v2', 'design must be subagent-v2');
  assert(manifest.packageVersion === '2.0.0', 'packageVersion must be 2.0.0');
  validateProviderProfiles(manifest);
  assertArray(manifest.requirements, 'requirements');
  assert(manifest.requirements.length > 0, 'requirements must not be empty');
  const requirementIds = [];
  const caseIds = [];
  for (const [index, requirement] of manifest.requirements.entries()) {
    const field = `requirements[${index}]`;
    assertExactKeys(
      requirement,
      ['requirementId', 'status', 'phase', 'requiredLayers', 'requiredVariants', 'cases'],
      field,
    );
    assertString(requirement.requirementId, `${field}.requirementId`, ID_PATTERN);
    assertEnum(requirement.status, ['planned', 'implemented'], `${field}.status`);
    assertEnum(requirement.phase, PHASES, `${field}.phase`);
    assertArray(requirement.requiredLayers, `${field}.requiredLayers`);
    requirement.requiredLayers.forEach((layer, layerIndex) =>
      assertEnum(layer, LAYERS, `${field}.requiredLayers[${layerIndex}]`),
    );
    assertUnique(requirement.requiredLayers, `${field}.requiredLayers`);
    assertArray(requirement.requiredVariants, `${field}.requiredVariants`);
    requirement.requiredVariants.forEach((variant, variantIndex) =>
      assertString(variant, `${field}.requiredVariants[${variantIndex}]`, VARIANT_PATTERN),
    );
    assertUnique(requirement.requiredVariants, `${field}.requiredVariants`);
    assertArray(requirement.cases, `${field}.cases`);
    assert(
      requirement.status === 'planned' || requirement.cases.length > 0,
      `${field} is implemented but has no cases`,
    );
    for (const [caseIndex, entry] of requirement.cases.entries()) {
      await validateCase(entry, requirement.requirementId, caseIndex, repoRoot);
      assert(
        entry.phase === requirement.phase,
        `${field}.cases[${caseIndex}].phase must match the requirement phase`,
      );
      caseIds.push(entry.caseId);
    }
    if (requirement.status === 'implemented') {
      const coveredLayers = new Set(requirement.cases.map((entry) => entry.layer));
      const coveredVariants = new Set(requirement.cases.map((entry) => entry.variant));
      for (const layer of requirement.requiredLayers) {
        assert(coveredLayers.has(layer), `${field} has no case for required layer ${layer}`);
      }
      for (const variant of requirement.requiredVariants) {
        assert(
          coveredVariants.has(variant),
          `${field} has no case for required variant ${variant}`,
        );
      }
    }
    requirementIds.push(requirement.requirementId);
  }
  assertUnique(requirementIds, 'requirements.requirementId');
  assertUnique(caseIds, 'requirements.cases.caseId');
  return {
    manifest,
    digest: await sha256File(manifestPath),
    requirementIds: new Set(requirementIds),
    caseIds: new Set(caseIds),
    repoRoot: path.resolve(repoRoot),
  };
}
