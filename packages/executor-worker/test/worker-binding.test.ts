import { describe, expect, it } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  WORKER_SUBAGENT_BINDING_KIND,
  decodeWorkerBinding,
  workerSubAgentBindingCodec,
} from '../src';

function validBinding(jobId = 'worker-job-1') {
  return { kind: WORKER_SUBAGENT_BINDING_KIND, jobId };
}

function expectInvalid(value: unknown, label = 'invalid Worker binding'): void {
  expect(() => decodeWorkerBinding(value), label).toThrow(
    expect.objectContaining({ code: 'BINDING_INVALID' }),
  );
}

describe('Worker binding codec closed boundary', () => {
  acceptanceIt('C7-WORKER-10.l1.binding-closed-shape', 'hostile-object-boundary', () => {
    expect(decodeWorkerBinding(validBinding('a'))).toEqual(validBinding('a'));
    expect(decodeWorkerBinding(validBinding(`a${'z'.repeat(127)}`))).toEqual(
      validBinding(`a${'z'.repeat(127)}`),
    );
    expect(workerSubAgentBindingCodec.encode(validBinding())).toEqual(validBinding());

    for (const jobId of [
      '',
      `a${'z'.repeat(128)}`,
      '-leading-dash',
      '.leading-dot',
      '_leading-underscore',
      'contains/slash',
      'contains\\slash',
      'contains space',
      'contains\0control',
      'contains-\u007f-del',
    ]) {
      expectInvalid(validBinding(jobId));
    }

    expectInvalid(null);
    expectInvalid([]);
    expectInvalid({});
    expectInvalid({ jobId: 'worker-job-1' });
    expectInvalid({ kind: WORKER_SUBAGENT_BINDING_KIND });
    expectInvalid({ ...validBinding(), extra: true });
    expectInvalid({ ...validBinding(), kind: 'maneeagent-process/v1' });
    expectInvalid({ ...validBinding(), jobId: 1 });
  });

  it('rejects Proxy, symbols, non-enumerable fields, accessors and custom prototypes', () => {
    expectInvalid(new Proxy(validBinding(), {}), 'Proxy');

    const symbolField = validBinding() as Record<PropertyKey, unknown>;
    symbolField[Symbol('hidden')] = 'not-closed';
    expectInvalid(symbolField, 'symbol field');

    const nonEnumerable = validBinding() as Record<PropertyKey, unknown>;
    Object.defineProperty(nonEnumerable, 'hidden', {
      configurable: true,
      enumerable: false,
      value: 'not-closed',
    });
    expectInvalid(nonEnumerable, 'non-enumerable field');

    let getterCalls = 0;
    const accessor = Object.defineProperties(
      {},
      {
        kind: {
          configurable: true,
          enumerable: true,
          value: WORKER_SUBAGENT_BINDING_KIND,
        },
        jobId: {
          configurable: true,
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error('A binding decoder must not execute an attacker-controlled getter.');
          },
        },
      },
    );
    expectInvalid(accessor, 'accessor field');
    expect(getterCalls).toBe(0);

    class HostileBinding {
      readonly kind = WORKER_SUBAGENT_BINDING_KIND;
      readonly jobId = 'worker-job-1';
    }
    expectInvalid(new HostileBinding(), 'custom prototype');
    expect(
      decodeWorkerBinding(Object.assign(Object.create(null) as object, validBinding())),
    ).toEqual(validBinding());
  });
});
