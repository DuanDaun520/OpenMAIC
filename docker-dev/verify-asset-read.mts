// 端到端验证:走应用自身的 S3 资产读取路径(loadS3AssetByteStore),
// 从本地 PG 抽一个 content_hash,经 MinIO 读回字节并比对长度。
import pg from 'pg';
import { loadS3AssetByteStore } from '@openmaic/storage/asset/s3-bytes';

async function main() {
  const pool = new pg.Pool({
    connectionString: 'postgres://openmaic:openmaic-dev@localhost:5434/openmaic',
  });
  const { rows } = await pool.query(
    'SELECT content_hash, byte_size FROM asset_blobs ORDER BY byte_size DESC LIMIT 1',
  );
  const row = rows[0];
  console.log(`抽样: ${row.content_hash} (pg 记录 ${row.byte_size} 字节)`);

  const store = await loadS3AssetByteStore('openmaic-assets');
  const bytes = await store.read(row.content_hash);
  if (bytes === null) throw new Error('读回为 null —— key 不存在');
  if (bytes.byteLength !== Number(row.byte_size)) {
    throw new Error(`长度不符: 期望 ${row.byte_size}, 读回 ${bytes.byteLength}`);
  }
  console.log(`✓ 应用读取路径正常: 读回 ${bytes.byteLength} 字节,与 PG 记录一致`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
