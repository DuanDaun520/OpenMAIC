/**
 * /admin — P0 dashboard. Deployment facts + live row counts, read directly
 * from the shared pool (server component — no API hop for the numbers).
 * Every stat degrades to a dash when its query fails, so a half-broken
 * database still renders a useful page.
 */
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { isAdminSecretConfigured } from '@/lib/admin/crypto';
import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { rebalanceUsageDailyAgg } from '@/lib/admin/usage-db';

export const dynamic = 'force-dynamic';

interface DashboardCounts {
  admins: number;
  users: number;
  providers: number;
  audits7d: number;
  usageCallsToday: number;
  usageQuantityToday: number;
  coursesPublished: number;
}

async function loadCounts(): Promise<{ counts?: DashboardCounts; error?: string }> {
  if (!isDatabaseConfigured()) {
    return {
      error:
        '未配置 DATABASE_URL：管理后台运行在纯浏览器模式下不可用，请在 .env.local 中配置数据库后重启。',
    };
  }
  try {
    const pool = await getAdminPool();
    const [admins, users, providers, audits, usage, courses] = await Promise.all([
      pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM admin_users'),
      pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM user_accounts'),
      pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM provider_configs'),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM audit_logs WHERE created_at > now() - interval '7 days'",
      ),
      pool.query<{ calls: string; quantity: string }>(
        `SELECT COALESCE(SUM(calls), 0)::text AS calls, COALESCE(SUM(quantity), 0)::text AS quantity
         FROM usage_daily_agg WHERE day = CURRENT_DATE`,
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM course_publications WHERE status = 'published'",
      ),
    ]);
    // Best-effort rebalance so the "today" numbers survive stale per-insert
    // upserts (e.g. rows written by a crashed request).
    try {
      await rebalanceUsageDailyAgg();
    } catch {
      // Aggregation table problems must not take the dashboard down.
    }
    return {
      counts: {
        admins: Number(admins.rows[0]?.count ?? 0),
        users: Number(users.rows[0]?.count ?? 0),
        providers: Number(providers.rows[0]?.count ?? 0),
        audits7d: Number(audits.rows[0]?.count ?? 0),
        usageCallsToday: Number(usage.rows[0]?.calls ?? 0),
        usageQuantityToday: Number(usage.rows[0]?.quantity ?? 0),
        coursesPublished: Number(courses.rows[0]?.count ?? 0),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export default async function AdminDashboardPage() {
  const { counts, error } = await loadCounts();

  const stats = [
    { label: '管理员账号', value: counts?.admins },
    { label: '平台用户', value: counts?.users },
    { label: 'DB 管理的模型配置', value: counts?.providers },
    { label: '近 7 天管理操作', value: counts?.audits7d },
    { label: '今日生成调用', value: counts?.usageCallsToday },
    { label: '今日计量用量', value: counts?.usageQuantityToday },
    { label: '已推荐课程', value: counts?.coursesPublished },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">概览</h1>
        <p className="text-muted-foreground text-sm">
          管理后台：认证、模型配置、用户、用量、额度、课程
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>数据库不可用</AlertTitle>
          <AlertDescription className="break-all">{error}</AlertDescription>
        </Alert>
      ) : null}
      {!isAdminSecretConfigured() ? (
        <Alert>
          <AlertTitle>未设置 OPENMAIC_ADMIN_SECRET</AlertTitle>
          <AlertDescription>
            模型 Provider 的 API Key 将以明文标记存入数据库（仅限本地开发）。正式部署前请在
            .env.local 设置该变量，已存的明文 Key 重新保存一次即自动加密。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                {stat.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums">
                {stat.value === undefined ? '—' : stat.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="text-muted-foreground max-w-2xl space-y-1 text-sm">
        <p>· 「模型配置」写入 DB 后立即生效（免重启），删除配置则回落到 env / YAML。</p>
        <p>
          · 「用量统计 / 额度管理」基于生成接口的用量台账；额度门禁需环境变量与策略开关同时打开。
        </p>
        <p>
          ·
          「课程管理」覆盖所有者的推荐状态、分类标签与信息编辑，可预览（以所有者身份打开）与完整删除。
        </p>
      </div>
    </div>
  );
}
