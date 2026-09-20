/**
 * Admin-console database access — shared pool + idempotent schema bootstrap.
 *
 * The admin domain is Node-server-only by nature (auth sessions, credential
 * management), so unlike the pluggable persistence domains it lives directly
 * on top of the shared `pg` pool instead of the storage package's injected
 * query surface. Schema creation follows the repo convention: a single
 * `CREATE TABLE IF NOT EXISTS` block, memoized per process, executed lazily
 * on first admin touch — the same self-bootstrapping style as the
 * document/asset/runtime tables.
 */
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { hashAdminPassword } from '@/lib/admin/crypto';

/** Admin tables, created idempotently. Kept in one block on purpose: one
 * round-trip, one memoization point, and the same "fresh database just
 * works" property the persistence tables have. */
export const ADMIN_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS user_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  org_id UUID,
  owner_cookie TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS org_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES org_units(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'school',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_configs (
  capability TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  api_key_cipher TEXT,
  base_url TEXT,
  models JSONB NOT NULL DEFAULT '[]'::jsonb,
  proxy TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (capability, provider_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id UUID,
  admin_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- P1 — usage ledger, quotas, course organization
-- ---------------------------------------------------------------------------

-- One row per billable generation call, mirrored from the jsonl usage log
-- (see lib/server/usage-storage.ts) with the actor dimensions the jsonl rows
-- lack. owner_id is the product identity string "anon:<uuid>" today, an
-- authenticated principal later — NOT user_accounts.id, which no product
-- login populates yet.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  capability TEXT NOT NULL,
  source TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  owner_id TEXT,
  stage_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS usage_ledger_created_idx ON usage_ledger (created_at);
CREATE INDEX IF NOT EXISTS usage_ledger_owner_created_idx ON usage_ledger (owner_id, created_at);
CREATE INDEX IF NOT EXISTS usage_ledger_cap_created_idx ON usage_ledger (capability, created_at);

-- Read-optimized daily rollup, refreshed alongside each insert (one UPSERT
-- per row at P1 volumes) and rebuilt wholesale by the usage API's
-- rebalance statement when history needs backfilling.
CREATE TABLE IF NOT EXISTS usage_daily_agg (
  day DATE NOT NULL,
  capability TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  quantity_sum NUMERIC NOT NULL DEFAULT 0,
  calls BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, capability, provider_id)
);

-- One row per generation-route HTTP call, unlike usage_ledger including the
-- FAILED calls (which carry no billable usage) and the wall-clock duration,
-- so the admin console can see where generation time goes per course. Written
-- fire-and-forget by lib/server/generation-trace.ts via
-- lib/admin/generation-trace-db.ts; never read on the generation path.
-- stage_id is the course (document stage) id; NULL for calls from clients
-- that predate stage correlation. Retention ~30 days (opportunistic prune).
CREATE TABLE IF NOT EXISTS generation_trace (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage_id TEXT,
  owner_id TEXT,
  step TEXT NOT NULL,
  page INTEGER,
  provider_id TEXT,
  model_id TEXT,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  http_status INTEGER,
  error_code TEXT,
  error_snippet TEXT
);
CREATE INDEX IF NOT EXISTS generation_trace_stage_created_idx ON generation_trace (stage_id, created_at);
CREATE INDEX IF NOT EXISTS generation_trace_created_idx ON generation_trace (created_at);

-- Quotas bind to the product identity string (owner_id), not to
-- user_accounts: enforcement works for today's anonymous owners and keeps
-- working unchanged once real logins replace the anonymous cookie.
CREATE TABLE IF NOT EXISTS user_quotas (
  owner_key TEXT PRIMARY KEY,
  balance NUMERIC NOT NULL DEFAULT 0,
  daily_last_reset DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS quota_grants (
  id BIGSERIAL PRIMARY KEY,
  owner_key TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  granted_by TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quota_grants_owner_idx ON quota_grants (owner_key, granted_at);
CREATE TABLE IF NOT EXISTS quota_policies (
  id TEXT PRIMARY KEY DEFAULT 'global',
  daily_amount NUMERIC NOT NULL DEFAULT 0,
  initial_amount NUMERIC NOT NULL DEFAULT 0,
  enforcement BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO quota_policies (id) VALUES ('global') ON CONFLICT DO NOTHING;

-- Course organization. document_stages stays untouched (storage-domain
-- schema); classification and publication state live in side tables keyed
-- by stage id.
CREATE TABLE IF NOT EXISTS course_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES course_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS course_category_map (
  stage_id TEXT PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES course_categories(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_category_map_category_idx ON course_category_map (category_id);
CREATE TABLE IF NOT EXISTS course_publications (
  stage_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_publications_status_idx ON course_publications (status);

-- Course tags: flat labels, many-to-many with courses. A course carries any
-- number of tags; deleting a tag drops only the association (courses stay).
CREATE TABLE IF NOT EXISTS course_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS course_tag_map (
  stage_id TEXT NOT NULL,
  tag_id UUID NOT NULL REFERENCES course_tags(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, tag_id)
);
CREATE INDEX IF NOT EXISTS course_tag_map_tag_idx ON course_tag_map (tag_id);

-- ---------------------------------------------------------------------------
-- My-courses side tables — per-course user state the storage schema has no
-- home for. cover_url is keyed by stage alone (one cover per course, shared
-- by every viewer); favorites and learning history are per owner_id.
-- ---------------------------------------------------------------------------

-- Per-course presentation overrides. Rows appear lazily when a user sets a
-- cover; the /api/explore shelf joins this to decorate published cards.
CREATE TABLE IF NOT EXISTS course_user_meta (
  stage_id TEXT PRIMARY KEY,
  cover_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS course_favorites (
  owner_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, stage_id)
);
CREATE INDEX IF NOT EXISTS course_favorites_owner_idx ON course_favorites (owner_id, created_at);
CREATE TABLE IF NOT EXISTS course_learning (
  owner_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  last_learned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  learn_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_id, stage_id)
);
CREATE INDEX IF NOT EXISTS course_learning_owner_idx ON course_learning (owner_id, last_learned_at);

-- Admin-curated voice catalog overlay for TTS providers (音色管理). A row
-- overrides the built-in registry entry's metadata (name/gender/language/
-- description), hides it from pickers, or — when its voice_id is not a
-- preset — adds a brand-new selectable voice to that provider.
CREATE TABLE IF NOT EXISTS voice_overrides (
  provider_id TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  name TEXT,
  language TEXT,
  gender TEXT,
  description TEXT,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, voice_id)
);

-- ---------------------------------------------------------------------------
-- Account presentation identity: avatar / AI nickname / bio. Appended as
-- idempotent ALTERs so existing deployments converge under the same lazy
-- bootstrap. Every account always carries an avatar (backfilled + defaulted);
-- nickname/bio stay NULL until the user personalizes them.
-- ---------------------------------------------------------------------------
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT;
UPDATE user_accounts SET avatar_url = '/avatars/user-3.png' WHERE avatar_url IS NULL;
ALTER TABLE user_accounts ALTER COLUMN avatar_url SET DEFAULT '/avatars/user-3.png';
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS bio TEXT;

-- 推荐到首页: homepage curation on top of publication. 'published' puts a
-- course on the 学习天地 shelf; 'featured' additionally picks it for the
-- homepage's recommended grid. Same idempotent-ALTER convergence as above.
ALTER TABLE course_publications ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;

-- 制作课程权限与配额：默认禁止、默认上限 3，管理员在用户管理里逐账号开通。
-- 配额按用户名下未删除（stage_meta.deleted_at IS NULL）的课程数计——软删除即释放。
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS can_create_courses BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS course_creation_quota INTEGER NOT NULL DEFAULT 3;

-- Per-provider extra credentials that don't fit the single api_key column —
-- today only AliDocMind's AccessKey pair. Map of field name → encrypted
-- value, encrypted with OPENMAIC_ADMIN_SECRET exactly like api_key_cipher,
-- so a leaked dump leaks neither. Decrypted only when the overlay applies.
ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS extra_secrets JSONB;
`;

let schemaPromise: Promise<Pool> | undefined;

/**
 * Seed the first super admin. `ADMIN_BOOTSTRAP_USERNAME` /
 * `ADMIN_BOOTSTRAP_PASSWORD` win; without them a local-dev default of
 * admin/admin123 is created so a fresh deployment can actually log in —
 * loudly logged, and surfaced in the admin UI. Set the env pair (or create
 * then disable the default user) before exposing the console publicly.
 */
async function seedBootstrapAdmin(pool: Pool): Promise<void> {
  const existing = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM admin_users',
  );
  if (existing.rows[0]?.count !== '0') return;

  const username = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim() || 'admin';
  const usingDefaultPassword = !process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim() || 'admin123';
  const passwordHash = hashAdminPassword(password);
  await pool.query(
    'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
    [username, passwordHash, 'super_admin'],
  );
  if (usingDefaultPassword) {
    console.warn(
      '[admin] 已用默认账号 admin/admin123 创建首个管理员（仅限本地开发）。' +
        '请设置 ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD 后重建，或登录后立即修改密码。',
    );
  } else {
    console.info(`[admin] 已按 ADMIN_BOOTSTRAP_USERNAME 创建首个管理员：${username}`);
  }
}

/**
 * Memoized per process: return the shared pool after making sure the admin
 * schema exists. Rejects loudly when DATABASE_URL is not configured — the
 * admin console is a DB-mode feature by definition (there is no
 * browser-local fallback for server-side auth).
 */
export function getAdminPool(): Promise<Pool> {
  if (schemaPromise) return schemaPromise;
  const initialization = (async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured — the admin console requires DB mode');
    }
    const { pool } = await getServerPersistenceProvider(connectionString);
    await pool.query(ADMIN_PG_SCHEMA);
    await seedBootstrapAdmin(pool);
    return pool;
  })();
  schemaPromise = initialization;
  // A failed bootstrap clears the memo so a later request retries (e.g. the
  // database coming up after this process did).
  initialization.catch(() => {
    if (schemaPromise === initialization) schemaPromise = undefined;
  });
  return initialization;
}

export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL?.trim();
}
