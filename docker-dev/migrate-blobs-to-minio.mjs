// 一次性迁移:把 asset_blobs.bytes 存量字节上传 MinIO(openmaic-assets 桶,
// key = content_hash),成功后将 PG 侧 bytes 置 NULL —— 与 S3 模式的预期形态一致。
//
// 用法(在仓库目录下):
//   DATABASE_URL=postgres://openmaic:openmaic-dev@localhost:5434/openmaic \
//   AWS_ENDPOINT_URL_S3=http://localhost:9200 AWS_REGION=us-east-1 \
//   AWS_ACCESS_KEY_ID=openmaic AWS_SECRET_ACCESS_KEY=openmaic-dev-secret \
//   node docker-dev/migrate-blobs-to-minio.mjs
//
// 可重复执行:bytes 已为 NULL 的行跳过;同 key 重复上传为幂等覆盖(内容寻址)。
import pg from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.ASSET_S3_BUCKET ?? 'openmaic-assets';
const CONCURRENCY = 6;

const client = new S3Client({});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(
  'SELECT content_hash, byte_size, bytes FROM asset_blobs WHERE bytes IS NOT NULL ORDER BY content_hash',
);
console.log(`待迁移 blob:${rows.length} 个,合计 ${rows.reduce((n, r) => n + r.byte_size, 0)} 字节`);

let uploaded = 0;
let failed = 0;
const nullReady = [];

async function uploadOne(row) {
  const bytes = new Uint8Array(row.bytes);
  // int8 经 node-pg 返回为字符串,先转数值再比较。
  if (bytes.byteLength !== Number(row.byte_size)) {
    throw new Error(`${row.content_hash}: 长度不符 pg=${row.byte_size} 实际=${bytes.byteLength}`);
  }
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: row.content_hash, Body: bytes, ContentLength: bytes.byteLength }),
  );
  nullReady.push(row.content_hash);
  uploaded += 1;
  if (uploaded % 50 === 0) console.log(`  已上传 ${uploaded}/${rows.length}...`);
}

const queue = [...rows];
const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
  while (queue.length > 0) {
    const row = queue.shift();
    try {
      await uploadOne(row);
    } catch (error) {
      failed += 1;
      console.error(`上传失败 ${row.content_hash}:`, error.message);
    }
  }
});
await Promise.all(workers);

if (nullReady.length > 0) {
  // 只置空全部成功的批次中零失败的那些;有失败时保守起见仍置空已成功的
  // (字节已在 MinIO,内容寻址幂等,PG 行不再需要持有字节)。
  for (let i = 0; i < nullReady.length; i += 100) {
    const slice = nullReady.slice(i, i + 100);
    await pool.query('UPDATE asset_blobs SET bytes = NULL WHERE content_hash = ANY($1)', [slice]);
  }
}

const left = await pool.query('SELECT count(*) AS n FROM asset_blobs WHERE bytes IS NOT NULL');
console.log(`完成:上传 ${uploaded},失败 ${failed},PG 中仍持有字节的行 ${left.rows[0].n}`);
if (failed > 0) {
  console.error('存在失败项,修复后重跑本脚本即可(幂等)。');
  process.exitCode = 1;
}
await pool.end();
