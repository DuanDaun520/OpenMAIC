/**
 * claimAnonymousPartition — the data side of login.
 *
 * Everything touching Postgres is faked: the agent-session store's mergeOwner
 * (its projection renumbering has its own tests in the storage package) and
 * the pool/client pair, which only records the SQL text and bind params so the
 * assertions pin the exact statements the claim issues.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  mergeOwner: vi.fn(),
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  failNextStatement: false,
}));

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ mergeOwner: mocks.mergeOwner }),
}));

import { claimAnonymousPartition } from '@/lib/server/owner-claim';

const ANON = 'anon:a652e716-0e2e-47f5-8432-4ee60f6f0977';
const USER = 'user:7c9e6679-7425-40de-944b-e07fc5f903ae';

function fakePool() {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (mocks.failNextStatement && !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) {
        mocks.failNextStatement = false;
        throw new Error('statement failed');
      }
      mocks.queries.push({ sql, params: params ?? [] });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    client,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries = [];
  mocks.failNextStatement = false;
});

describe('claimAnonymousPartition', () => {
  it('merges agent sessions first, then moves the course domain in one transaction', async () => {
    const { pool, client } = fakePool();

    await claimAnonymousPartition({ pool, anonOwnerId: ANON, userOwnerId: USER });

    expect(mocks.mergeOwner).toHaveBeenCalledTimes(1);
    expect(mocks.mergeOwner).toHaveBeenCalledWith(ANON, USER);

    const statements = mocks.queries.map((q) => q.sql.trim().toUpperCase());
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('COMMIT');
    // Exactly one batched statement between BEGIN and COMMIT.
    expect(statements.filter((s) => s.startsWith('UPDATE DOCUMENT_STAGES'))).toHaveLength(1);

    const batch = mocks.queries.find((q) => q.sql.includes('document_stages'));
    expect(batch?.params).toEqual([ANON, USER]);
    expect(client.release).toHaveBeenCalled();
  });

  it('resolves owner-keyed collisions in the account’s favor', async () => {
    const { pool } = fakePool();

    await claimAnonymousPartition({ pool, anonOwnerId: ANON, userOwnerId: USER });

    const batch = mocks.queries.find((q) => q.sql.includes('document_stages'))!.sql;
    // Colliding anonymous folders drop their stages to the root and disappear.
    expect(batch).toContain('UPDATE document_stages SET folder_id = NULL');
    // Favorites/learning: the account's own row wins, the rest move.
    expect(batch).toContain('ON CONFLICT (owner_id, stage_id) DO NOTHING');
    // Live skills with colliding names are dropped before the move.
    expect(batch).toContain('a.deleted_at IS NULL');
    // Every predicate is the exact anonymous id — idempotent, never greedy.
    expect(batch.match(/owner_id = \$1/g)?.length).toBeGreaterThanOrEqual(8);
    expect(batch).not.toContain('owner_id = $3');
  });

  it('refuses malformed owner ids before touching either domain', async () => {
    const { pool, client } = fakePool();

    await expect(
      claimAnonymousPartition({ pool, anonOwnerId: 'user:someone-else', userOwnerId: USER }),
    ).rejects.toThrow(/malformed owner ids/);
    await expect(
      claimAnonymousPartition({ pool, anonOwnerId: 'anon:not-a-uuid', userOwnerId: USER }),
    ).rejects.toThrow(/malformed owner ids/);
    await expect(
      claimAnonymousPartition({
        pool,
        anonOwnerId: ANON,
        userOwnerId: "user:'); DROP TABLE user_accounts; --",
      }),
    ).rejects.toThrow(/malformed owner ids/);

    expect(mocks.mergeOwner).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when a statement fails, releasing the client', async () => {
    const { pool, client } = fakePool();
    mocks.failNextStatement = true;

    await expect(
      claimAnonymousPartition({ pool, anonOwnerId: ANON, userOwnerId: USER }),
    ).rejects.toThrow('statement failed');

    const statements = mocks.queries.map((q) => q.sql.trim().toUpperCase());
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
