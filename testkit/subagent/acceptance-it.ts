import { it, type TestContext } from 'vitest';

import { getAcceptanceReporter } from './acceptance-reporter';

const registeredCaseIds = new Set<string>();

export function formatAcceptanceTestName(caseId: string, variant: string): string {
  return `[acceptance:${caseId}][variant:${variant}]`;
}

/** Registers a Vitest case with explicit, machine-readable evidence identity. */
export function acceptanceIt(
  caseId: string,
  variant: string,
  test: (context: TestContext) => void | Promise<void>,
): void {
  if (registeredCaseIds.has(caseId)) {
    throw new Error(`Acceptance caseId "${caseId}" is registered more than once in this worker.`);
  }
  registeredCaseIds.add(caseId);

  it(formatAcceptanceTestName(caseId, variant), async (context) => {
    const reporter = getAcceptanceReporter();
    const handle = reporter.startCase(caseId, variant);
    try {
      await test(context);
      reporter.passCase(handle);
    } catch (error) {
      reporter.failCase(handle, error);
      throw error;
    }
  });
}
