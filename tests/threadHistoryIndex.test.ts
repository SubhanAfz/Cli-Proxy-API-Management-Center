import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('persistent server index reconstructs every thread and protects cached history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-runner-'));
  try {
    const build = await Bun.build({
      entrypoints: [new URL('./helpers/threadHistoryIndexRunner.ts', import.meta.url).pathname],
      target: 'node',
      outdir: directory,
    });
    expect(build.success).toBe(true);
    const process = Bun.spawn(['node', join(directory, 'threadHistoryIndexRunner.js')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ code, stderr: code ? stderr : '' }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('PASS: complete index');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
