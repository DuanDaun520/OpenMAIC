/**
 * Anonymous→account partition claim — the data side of login.
 *
 * Before accounts owned anything, every course/favorite/session row was keyed
 * by the anonymous owner cookie. When a user logs in on that browser, the
 * partition they were just working in moves to their account
 * (`user:<user_accounts.id>`) so "我的课程" survives the login; the caller then
 * rotates the anonymous cookie so no stale partition survives the identity
 * change (see app/api/auth/login/route.ts).
 *
 * Two domains move, each in its own transaction:
 *
 *  1. Agent sessions go through the storage package's `mergeOwner`, which
 *     owns the owner-event projection renumbering — hand-written SQL here
 *     would corrupt the per-owner event sequence.
 *  2. Documents and the course side tables move in one transaction below.
 *
 * Every predicate is `owner_id = $1` (the exact anonymous id), which makes the
 * whole claim idempotent — a second login finds no rows — and incapable of
 * touching anything another account already claimed. Owner-keyed unique
 * constraints (folder names, skill names, favorite/learning rows) resolve in
 * the account's favor: the pre-existing account row wins, the anonymous
 * duplicate is dropped or falls back to a neutral state.
 */
import type { Pool } from 'pg';

import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAnonOwnerId(id: string): boolean {
  return id.startsWith('anon:') && UUID_V4.test(id.slice('anon:'.length));
}

function isUserOwnerId(id: string): boolean {
  return id.startsWith('user:') && UUID_V4.test(id.slice('user:'.length));
}

/**
 * Move one anonymous partition to an account owner. Throws (leaving the
 * caller to keep the anonymous cookie for a retry) when either domain fails;
 * because each domain is idempotent, a partial move is safely re-run by the
 * next login.
 */
export async function claimAnonymousPartition(params: {
  pool: Pool;
  anonOwnerId: string;
  userOwnerId: string;
}): Promise<void> {
  const { pool, anonOwnerId, userOwnerId } = params;
  if (!isAnonOwnerId(anonOwnerId) || !isUserOwnerId(userOwnerId)) {
    throw new Error(
      `[owner-claim] refusing to claim: malformed owner ids (${anonOwnerId} -> ${userOwnerId})`,
    );
  }

  // Domain 1: agent sessions (and their owner-event projection).
  await (await getAgentSessionStore()).mergeOwner(anonOwnerId, userOwnerId);

  // Domain 2: documents, folders, course-side rows, materials, skills.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE document_stages SET owner_id = $2 WHERE owner_id = $1;
       UPDATE stage_meta SET owner_id = $2 WHERE owner_id = $1;

       -- Folder names are unique per owner. A colliding anonymous folder drops
       -- its stages to the root and disappears; non-colliding ones move whole.
       UPDATE document_stages SET folder_id = NULL
       WHERE folder_id IN (
         SELECT f.id FROM document_folders f
         WHERE f.owner_id = $1
           AND EXISTS (SELECT 1 FROM document_folders u
                       WHERE u.owner_id = $2 AND u.normalized_name = f.normalized_name));
       DELETE FROM document_folders f
       WHERE f.owner_id = $1
         AND EXISTS (SELECT 1 FROM document_folders u
                     WHERE u.owner_id = $2 AND u.normalized_name = f.normalized_name);
       UPDATE document_folders SET owner_id = $2 WHERE owner_id = $1;

       -- Favorites and learning history are keyed (owner_id, stage_id): the
       -- account's own row (if any) wins, the rest move.
       INSERT INTO course_favorites (owner_id, stage_id, created_at)
       SELECT $2, stage_id, created_at FROM course_favorites WHERE owner_id = $1
       ON CONFLICT (owner_id, stage_id) DO NOTHING;
       DELETE FROM course_favorites WHERE owner_id = $1;

       INSERT INTO course_learning (owner_id, stage_id, last_learned_at, learn_count)
       SELECT $2, stage_id, last_learned_at, learn_count FROM course_learning WHERE owner_id = $1
       ON CONFLICT (owner_id, stage_id) DO NOTHING;
       DELETE FROM course_learning WHERE owner_id = $1;

       UPDATE owner_material SET owner_id = $2 WHERE owner_id = $1;

       -- Skill names are unique per owner among live rows; same
       -- account-wins rule as folders.
       DELETE FROM agent_user_skill a
       WHERE a.owner_id = $1 AND a.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM agent_user_skill u
                     WHERE u.owner_id = $2 AND u.deleted_at IS NULL AND u.name = a.name);
       UPDATE agent_user_skill SET owner_id = $2 WHERE owner_id = $1;`,
      [anonOwnerId, userOwnerId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
