import { describe, expect, it } from 'vitest';

import { sanitizeRelayInfo } from './useRelayInfo';

describe('sanitizeRelayInfo', () => {
  it('drops fields whose type does not match NIP-11', () => {
    const info = sanitizeRelayInfo({
      name: 'Relay',
      icon: 42,
      supported_nips: '1,11,42',
      supported_extensions: { a: 1 },
      limitation: { auth_required: 'yes', restricted_writes: true },
      fees: { admission: [{ amount: 1, unit: 'sats' }, { amount: '1' }], subscription: 'x' },
    });
    expect(info).toEqual({
      name: 'Relay',
      limitation: { restricted_writes: true },
      fees: { admission: [{ amount: 1, unit: 'sats' }] },
    });
  });

  it('keeps only numbers in supported_nips', () => {
    expect(sanitizeRelayInfo({ supported_nips: [1, '42', 50, null] }).supported_nips).toEqual([1, 50]);
  });

  it('returns an empty doc for non-objects', () => {
    expect(sanitizeRelayInfo(null)).toEqual({});
    expect(sanitizeRelayInfo([1])).toEqual({});
    expect(sanitizeRelayInfo(undefined)).toEqual({});
  });
});
