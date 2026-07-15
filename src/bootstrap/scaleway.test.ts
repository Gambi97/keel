import { describe, expect, it, vi } from 'vitest';

import { retryWhileBucketPropagates } from './scaleway.js';

function noSuchBucket(): Error {
  return Object.assign(new Error('The specified bucket does not exist'), {
    name: 'NoSuchBucket',
  });
}

describe('retryWhileBucketPropagates', () => {
  it('retries NoSuchBucket until the bucket propagates', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(noSuchBucket())
      .mockRejectedValueOnce(noSuchBucket())
      .mockResolvedValue('ok');
    await expect(retryWhileBucketPropagates(fn, 5, 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget and surfaces the last error', async () => {
    const fn = vi.fn().mockRejectedValue(noSuchBucket());
    await expect(retryWhileBucketPropagates(fn, 3, 0)).rejects.toThrow(
      'The specified bucket does not exist',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws any other error immediately — only the propagation race is retried', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(retryWhileBucketPropagates(fn, 5, 0)).rejects.toThrow('denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
