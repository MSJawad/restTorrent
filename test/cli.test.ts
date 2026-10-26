// The CLI the way a user runs it: a separate process. Its final tracker
// announce has to reach the tracker before that process exits.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTorrent, randomFiles, startHttpTracker, startSeeder } from './helpers/fixtures.ts';

// Node runs the TypeScript source directly, so this needs no build; dist/cli.js is the same code.
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface CliRun {
  child: ChildProcess;
  output: () => string;
  /** The exit code, or null when the process had to be killed after `timeout`. */
  exitCode: (timeout?: number) => Promise<number | null>;
}

function runCli(args: string[], cwd: string): CliRun {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return {
    child,
    output: () => output,
    exitCode: async (timeout = 15_000) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      try {
        return await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function waitUntil(condition: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('CLI download', () => {
  let dir: string;
  before(async () => (dir = await mkdtemp(join(tmpdir(), 'resttorrent-cli-'))));
  after(() => rm(dir, { recursive: true, force: true }));

  /** A seeder behind a fake tracker, and a .torrent file on disk that announces to it. */
  async function swarm(name: string, seederOptions: { silent?: boolean } = {}) {
    const files = randomFiles({ 'a.bin': 200_000, 'b.bin': 77_777 });
    const pieceLength = 32 * 1024;
    const seeder = await startSeeder(makeTorrent({ name, files, pieceLength }), seederOptions);
    const tracker = await startHttpTracker([{ host: '127.0.0.1', port: seeder.port }]);
    // Same files, so the same info hash, but announcing to the fake tracker.
    const fixture = makeTorrent({ name, files, pieceLength, announce: [tracker.url] });
    const file = join(dir, `${name}.torrent`);
    await writeFile(file, fixture.torrent);
    const events = () => tracker.announces.map((q) => q.get('event'));
    const close = async () => {
      await tracker.close();
      await seeder.close();
    };
    return { fixture, file, tracker, events, close };
  }

  it('delivers the completed announce to the tracker before it exits', { timeout: 30_000 }, async () => {
    const { fixture, file, tracker, events, close } = await swarm('finish');
    const run = runCli(['download', file, '--out', 'out'], dir);
    try {
      assert.equal(await run.exitCode(), 0, run.output());
      assert.match(run.output(), /all 9 pieces verified/);
      for (const f of fixture.files) {
        const data = await readFile(join(dir, 'out', fixture.meta.name, ...f.path));
        assert.ok(data.equals(f.data), `${f.path.join('/')} differs`);
      }
      assert.deepEqual(events(), ['started', 'completed']);
      assert.equal(tracker.announces.at(-1)?.get('left'), '0');
    } finally {
      run.child.kill('SIGKILL');
      await close();
    }
  });

  it('delivers the stopped announce to the tracker when interrupted with Ctrl-C', { timeout: 30_000 }, async () => {
    // A peer that never offers any piece keeps the download going until the signal.
    const { file, tracker, events, close } = await swarm('interrupt', { silent: true });
    const run = runCli(['download', file, '--out', 'out'], dir);
    try {
      await waitUntil(() => tracker.announces.length === 1);
      run.child.kill('SIGINT');
      assert.equal(await run.exitCode(), 130, run.output());
      assert.deepEqual(events(), ['started', 'stopped']);
    } finally {
      run.child.kill('SIGKILL');
      await close();
    }
  });
});
