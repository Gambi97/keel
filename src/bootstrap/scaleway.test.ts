import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryWhileBucketPropagates, validateScalewayCredentials } from './scaleway.js';

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** fetch stub: first call is the project read, second the security settings. */
function stubScalewayApi(settingsResponse: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).includes('/security-settings')) return settingsResponse;
      return jsonResponse(200, { organization_id: 'org-1' });
    }),
  );
}

const creds = { secretKey: 'sk', projectId: 'pid', organizationId: 'org-1' };

describe('validateScalewayCredentials — API-key expiration policy pre-flight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('warns when the org forces API keys to expire (the first CI apply would fail)', async () => {
    stubScalewayApi(jsonResponse(200, { max_api_key_expiration_duration: '31536000s' }));
    const { warning } = await validateScalewayCredentials(creds);
    expect(warning).toMatch(/requires API keys to expire/);
    expect(warning).toMatch(/365 days/);
    expect(warning).toMatch(/first CI apply/);
  });

  it('stays quiet when expiration is unlimited ("0s")', async () => {
    stubScalewayApi(jsonResponse(200, { max_api_key_expiration_duration: '0s' }));
    const { warning } = await validateScalewayCredentials(creds);
    expect(warning).toBeUndefined();
  });

  it('degrades silently when the key cannot read the security settings', async () => {
    stubScalewayApi(jsonResponse(403, { message: 'insufficient permissions' }));
    const { warning } = await validateScalewayCredentials(creds);
    expect(warning).toBeUndefined();
  });
});
