import type {
  ProviderOperationLedger,
  ProviderOperationRecordV1,
} from './provider-operation-ledger';

/** Test-only crash boundaries. This module is deliberately absent from the package root API. */
export type ProviderOperationFailpointPhase =
  | 'after_prepare_before_in_flight'
  | 'after_in_flight_before_provider'
  | 'after_provider_before_complete'
  | 'after_complete';

export type ProviderOperationFailpoint = (
  phase: ProviderOperationFailpointPhase,
  record: Readonly<ProviderOperationRecordV1>,
) => void | Promise<void>;

const FAILPOINTS = new WeakMap<ProviderOperationLedger, ProviderOperationFailpoint>();

export function setProviderOperationFailpointForTest(
  ledger: ProviderOperationLedger,
  failpoint: ProviderOperationFailpoint | undefined,
): void {
  if (failpoint === undefined) FAILPOINTS.delete(ledger);
  else FAILPOINTS.set(ledger, failpoint);
}

export function providerOperationFailpointForTest(
  ledger: ProviderOperationLedger,
): ProviderOperationFailpoint | undefined {
  return FAILPOINTS.get(ledger);
}
