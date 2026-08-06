import { expect } from 'vitest';
import { acceptanceIt } from '../../../testkit';

interface LegacyValidatorModule {
  main(argv?: string[]): Promise<Record<string, unknown>>;
}

async function loadLegacyValidator(): Promise<LegacyValidatorModule> {
  // The acceptance validator deliberately lives outside the published Core package.
  // @ts-expect-error -- the repository-owned .mjs validator has no declaration artifact.
  return import('../../../test/acceptance/validate-legacy-source.mjs');
}

acceptanceIt('API-01.l0.legacy-cutover', 'legacy-forbid-all', async () => {
  const { main } = await loadLegacyValidator();

  await expect(main(['--self-test'])).resolves.toMatchObject({
    status: 'passed',
    mode: 'self-test',
    initialHits: 4,
    detectedAdditions: 2,
  });
  await expect(main(['--forbid-all'])).resolves.toMatchObject({
    status: 'passed',
    mode: 'forbid-all',
    currentLegacyHits: 0,
  });
});
