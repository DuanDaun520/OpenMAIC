import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

// The jobs directory constant is read at module scope, so the override must be
// in place before the store module is imported. vi.hoisted runs above the
// import statements — node builtins come in via dynamic import there, and the
// awaited result is available to the imports below.
const { jobsDir, afterCallbacks } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const jobsDir = mkdtempSync(join(tmpdir(), 'openmaic-classroom-jobs-'));
  process.env.OPENMAIC_CLASSROOM_JOBS_DIR = jobsDir;
  return { jobsDir, afterCallbacks: [] as Array<() => unknown> };
});

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (callback: () => unknown) => {
      afterCallbacks.push(callback);
    },
  };
});

import { GET } from '@/app/api/generate-classroom/[jobId]/route';
import {
  createClassroomGenerationJob,
  deleteClassroomGenerationJob,
  markClassroomGenerationJobSucceeded,
  readClassroomGenerationJob,
  sweepExpiredClassroomGenerationJobs,
} from '@/lib/server/classroom-job-store';

const INPUT = { requirement: 'Teach me fractions' } as Parameters<
  typeof createClassroomGenerationJob
>[1];

function jobPath(jobId: string) {
  return path.join(jobsDir, `${jobId}.json`);
}

async function getJob(jobId: string) {
  return GET(new NextRequest(`http://localhost/api/generate-classroom/${jobId}`) as never, {
    params: Promise.resolve({ jobId }),
  });
}

/** Run (and drain) the `after()` callbacks captured during the last GET. */
async function flushAfterCallbacks() {
  const callbacks = afterCallbacks.splice(0);
  for (const callback of callbacks) await callback();
}

beforeEach(async () => {
  afterCallbacks.length = 0;
  await fs.rm(jobsDir, { recursive: true, force: true });
  await fs.mkdir(jobsDir, { recursive: true });
});

describe('classroom job file retention', () => {
  it('deletes the job file after a terminal GET delivers its response', async () => {
    await createClassroomGenerationJob('job-terminal', INPUT);
    await markClassroomGenerationJobSucceeded('job-terminal', {
      id: 'classroom1',
      url: '/classroom/classroom1',
      scenesCount: 3,
    } as never);

    const response = await getJob('job-terminal');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ done: true });
    expect(existsSync(jobPath('job-terminal'))).toBe(true);

    await flushAfterCallbacks();
    expect(existsSync(jobPath('job-terminal'))).toBe(false);
  });

  it('keeps the job file after a non-terminal GET', async () => {
    await createClassroomGenerationJob('job-running', INPUT);

    const response = await getJob('job-running');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ done: false });
    await flushAfterCallbacks();

    expect(existsSync(jobPath('job-running'))).toBe(true);
  });

  it('sweeps job files older than the stale threshold and keeps fresh ones', async () => {
    await createClassroomGenerationJob('job-fresh', INPUT);
    await createClassroomGenerationJob('job-old', INPUT);
    // Sweep runs fire-and-forget on create; it must not have removed the
    // fresh-touched file either way. The crashed atomic-write leftover gets
    // the same stale timestamp — a FRESH tmp must survive (it may belong to
    // an in-flight writeJsonFileAtomic).
    const stale = new Date(Date.now() - 45 * 60 * 1000);
    await fs.utimes(jobPath('job-old'), stale, stale);
    const tmpPath = path.join(jobsDir, 'leftover.tmp');
    await fs.writeFile(tmpPath, '{}');
    await fs.utimes(tmpPath, stale, stale);

    await sweepExpiredClassroomGenerationJobs();

    expect(existsSync(jobPath('job-fresh'))).toBe(true);
    expect(existsSync(jobPath('job-old'))).toBe(false);
    expect(existsSync(path.join(jobsDir, 'leftover.tmp'))).toBe(false);
  });

  it('treats a missing jobs directory as a no-op sweep', async () => {
    await fs.rm(jobsDir, { recursive: true, force: true });
    await expect(sweepExpiredClassroomGenerationJobs()).resolves.toBeUndefined();
  });

  it('deleteClassroomGenerationJob tolerates an already-removed file', async () => {
    await expect(deleteClassroomGenerationJob('job-never-existed')).resolves.toBeUndefined();
    expect(await readClassroomGenerationJob('job-never-existed')).toBeNull();
  });
});
