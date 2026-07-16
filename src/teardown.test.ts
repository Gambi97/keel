import { afterEach, describe, expect, it, vi } from 'vitest';

import { finalizeTeardownAnswers } from './config.js';
import { deleteContainerNamespace } from './bootstrap/scaleway.js';
import { executeTeardown, teardownPlan } from './teardown.js';

const config = finalizeTeardownAnswers({
  projectName: 'demo-app',
  region: 'fr-par',
  scaleway: { accessKey: 'ak', secretKey: 'sk', projectId: 'pid', organizationId: 'oid' },
  infisical: { clientId: 'cid', clientSecret: 'cs' },
  github: {},
  scaling: {},
});

describe('teardownPlan', () => {
  it('sweeps every known environment plus the shared resources', () => {
    const labels = teardownPlan(config).map((s) => s.label);
    // Every env keel could ever have created is swept, not just the selection:
    // an earlier experiment on the same name may have provisioned more.
    for (const env of ['dev', 'staging', 'prod']) {
      expect(labels).toContain(`Scaleway container namespace "demo-app-${env}"`);
      expect(labels).toContain(`Scaleway registry namespace "demo-app-${env}"`);
      expect(labels).toContain(`Scaleway database "demo-app-${env}"`);
      expect(labels).toContain(`Scaleway IAM application "demo-app-${env}-db"`);
      expect(labels).toContain(`Scaleway IAM application "demo-app-${env}-storage"`);
      expect(labels).toContain(`Scaleway IAM policy "demo-app-${env}-db-access"`);
      expect(labels).toContain(`Scaleway IAM policy "demo-app-${env}-storage-access"`);
      expect(labels).toContain(`Scaleway bucket "demo-app-${env}-files"`);
    }
    expect(labels).toContain('Scaleway state bucket "demo-app-tfstate"');
    expect(labels).toContain('Infisical project "demo-app"');
  });

  it('never touches GitHub — the repository is the source of truth', () => {
    const labels = teardownPlan(config).map((s) => s.label);
    expect(labels.some((l) => l.toLowerCase().includes('github'))).toBe(false);
  });

  it('excludes a reused Infisical project — keel only deletes what it created', () => {
    const labels = teardownPlan(config, { infisicalCreatedByKeel: false }).map((s) => s.label);
    expect(labels.some((l) => l.startsWith('Infisical project'))).toBe(false);
  });
});

describe('deleteIamApplication', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to deleting API keys (by bearer_id) when the direct delete is refused', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { method?: string }) => {
        const u = String(url);
        calls.push(`${init?.method ?? 'GET'} ${u}`);
        if (init?.method === 'DELETE' && u.includes('/applications/app-1')) {
          // First refusal (the application still owns keys), then success.
          const refused = calls.filter((c) => c.includes('DELETE') && c.includes('app-1'));
          return new Response('{}', { status: refused.length === 1 ? 409 : 200 });
        }
        if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
        if (u.includes('/api-keys')) {
          // The non-deprecated filter must be used: application_id answers 400.
          if (!u.includes('bearer_id=app-1')) return new Response('{}', { status: 400 });
          return new Response(JSON.stringify({ api_keys: [{ access_key: 'AKIA1' }] }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ applications: [{ id: 'app-1', name: 'demo-app-staging-db' }] }),
          { status: 200 },
        );
      }),
    );
    const { deleteIamApplication } = await import('./bootstrap/scaleway.js');
    await expect(
      deleteIamApplication(
        { secretKey: 'sk', projectId: 'pid', organizationId: 'oid' },
        'demo-app-staging-db',
      ),
    ).resolves.toBe('deleted');
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('/api-keys/AKIA1'))).toBe(true);
  });
});

describe('deleteProject ownership guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a project reached by ID whose name is not the expected one', async () => {
    // No bootstrap record survives: a differently-named project reached via
    // an explicit ID is a reused one, not keel's default creation.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { method?: string }) => {
        if (String(url).includes('/auth/universal-auth/login')) {
          return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
        }
        if (init?.method === 'DELETE') {
          throw new Error('DELETE must never be reached for a reused project');
        }
        return new Response(
          JSON.stringify({ workspaces: [{ id: 'wid', name: 'shared-secrets' }] }),
          { status: 200 },
        );
      }),
    );
    const { deleteProject } = await import('./bootstrap/infisical.js');
    await expect(
      deleteProject({
        host: 'https://app.infisical.com',
        clientId: 'cid',
        clientSecret: 'cs',
        projectName: 'demo-app',
        projectId: 'wid',
      }),
    ).resolves.toBe('kept');
  });
});

describe('executeTeardown', () => {
  it('keeps going after a failure and reports it', async () => {
    const results = await executeTeardown(
      [
        { label: 'a', run: () => Promise.resolve('deleted' as const) },
        { label: 'b', run: () => Promise.reject(new Error('boom')) },
        { label: 'c', run: () => Promise.resolve('absent' as const) },
      ],
      (step) => step.run(),
    );
    expect(results.map((r) => r.outcome)).toEqual(['deleted', 'failed', 'absent']);
    expect(results[1]?.detail).toBe('boom');
  });
});

describe('deleteContainerNamespace', () => {
  afterEach(() => vi.unstubAllGlobals());

  const creds = { secretKey: 'sk', projectId: 'pid', organizationId: 'oid' };

  it('deletes only the exact name match (list endpoints filter by substring)', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { method?: string }) => {
        calls.push({ url: String(url), ...(init?.method ? { method: init.method } : {}) });
        if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: 'ns-longer', name: 'demo-app-staging-2' },
              { id: 'ns-exact', name: 'demo-app-staging' },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    await expect(deleteContainerNamespace(creds, 'fr-par', 'demo-app-staging')).resolves.toBe(
      'deleted',
    );
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain('/namespaces/ns-exact');
  });

  it('reports absent when nothing matches exactly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ namespaces: [{ id: 'x', name: 'other' }] }), {
            status: 200,
          }),
      ),
    );
    await expect(deleteContainerNamespace(creds, 'fr-par', 'demo-app-staging')).resolves.toBe(
      'absent',
    );
  });
});
