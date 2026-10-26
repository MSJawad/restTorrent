// Full downloads against in-process seeders and a fake tracker on 127.0.0.1.
// The Docker-based test in test/e2e checks the same path against independent
// software (Transmission and opentracker).

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generatePeerId } from '../src/client.ts';
import { Torrent } from '../src/torrent.ts';
import { makeTorrent, randomFiles, startHttpTracker, startSeeder, type Fixture } from './helpers/fixtures.ts';

function waitFor(torrent: Torrent, timeout = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (torrent.state === 'completed') return resolve();
    const timer = setTimeout(() => reject(new Error(`timed out in state ${torrent.state}`)), timeout);
    torrent.once('done', () => {
      clearTimeout(timer);
      resolve();
    });
    torrent.on('state', (state) => {
      if (state === 'error') {
        clearTimeout(timer);
        reject(new Error(torrent.error ?? 'error'));
      }
    });
  });
}

async function waitUntil(condition: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function assertFilesMatch(dir: string, fixture: Fixture): Promise<void> {
  for (const file of fixture.files) {
    const data = await readFile(join(dir, fixture.meta.name, ...file.path));
    assert.ok(data.equals(file.data), `${file.path.join('/')} differs`);
  }
}

describe('downloading', () => {
  let dir: string;
  before(async () => (dir = await mkdtemp(join(tmpdir(), 'resttorrent-download-'))));
  after(() => rm(dir, { recursive: true, force: true }));

  const make = (name: string) =>
    makeTorrent({
      name,
      // Uneven sizes so pieces straddle file boundaries; one empty file.
      files: randomFiles({ 'readme.txt': 1234, 'empty': 0, 'video/part1.bin': 300_000, 'video/part2.bin': 177_777 }),
      pieceLength: 32 * 1024,
    });

  it('downloads a multi-file torrent from two seeders found through the tracker', async () => {
    const fixture = make('two-seeders');
    const seeders = [await startSeeder(fixture), await startSeeder(fixture)];
    const tracker = await startHttpTracker(seeders.map((s) => ({ host: '127.0.0.1', port: s.port })));
    const meta = { ...fixture.meta, announce: [[tracker.url]] };
    const torrent = new Torrent(meta, { downloadDir: dir, peerId: generatePeerId(), port: 6881 });
    try {
      await torrent.start();
      await waitFor(torrent);
      await assertFilesMatch(dir, fixture);
      const stats = torrent.stats();
      assert.equal(stats.progress, 1);
      assert.equal(stats.pieces.have, meta.pieceHashes.length);
      assert.ok(stats.files.every((f) => f.downloaded === f.size));
      assert.equal(tracker.announces[0]?.get('event'), 'started');
      // Both seeders were used.
      assert.ok(seeders.every((s) => s.requests.length > 0));
      // A completed announce follows (sent in the background).
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(tracker.announces.some((q) => q.get('event') === 'completed'));
      assert.equal(tracker.announces.at(-1)?.get('left'), '0');
    } finally {
      await torrent.destroy();
      await tracker.close();
      await Promise.all(seeders.map((s) => s.close()));
    }
  });

  it('rejects corrupt pieces from a bad peer and gets them from a good one', async () => {
    const fixture = make('bad-peer');
    const bad = await startSeeder(fixture, { corrupt: () => true });
    const good = await startSeeder(fixture);
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    try {
      await torrent.start();
      torrent.addPeer({ host: '127.0.0.1', port: bad.port });
      torrent.addPeer({ host: '127.0.0.1', port: good.port });
      await waitFor(torrent);
      await assertFilesMatch(dir, fixture);
      assert.ok(bad.requests.length > 0, 'the bad peer was asked for data');
      assert.ok(torrent.stats().corruptPieces > 0, 'corrupt pieces were detected and discarded');
    } finally {
      await torrent.destroy();
      await bad.close();
      await good.close();
    }
  });

  it('resumes a partial download by re-checking the data already on disk', async () => {
    const fixture = make('resume');
    // Pretend an earlier run wrote the first file and half of part1.bin.
    const target = join(dir, 'resume');
    await mkdir(join(target, 'video'), { recursive: true });
    await writeFile(join(target, 'readme.txt'), fixture.files[0]!.data);
    await writeFile(join(target, 'video', 'part1.bin'), fixture.files[2]!.data.subarray(0, 150_000));

    const seeder = await startSeeder(fixture);
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    try {
      await torrent.start();
      const resumedFrom = torrent.stats().pieces.have;
      // 1234 + 150000 bytes on disk cover 4 whole 32 KiB pieces.
      assert.equal(resumedFrom, 4);
      torrent.addPeer({ host: '127.0.0.1', port: seeder.port });
      await waitFor(torrent);
      await assertFilesMatch(dir, fixture);
      const requested = new Set(seeder.requests.map((r) => r.index));
      for (let i = 0; i < resumedFrom; i++) assert.ok(!requested.has(i), `piece ${i} was downloaded again`);
    } finally {
      await torrent.destroy();
      await seeder.close();
    }
  });

  it('re-announces after the interval the tracker asked for, not its minimum', async () => {
    const fixture = make('interval');
    const tracker = await startHttpTracker([], { interval: 10, minInterval: 1 });
    const torrent = new Torrent({ ...fixture.meta, announce: [[tracker.url]] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
      minAnnounceInterval: 1,
    });
    try {
      await torrent.start();
      await waitUntil(() => tracker.announces.length === 1);
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(tracker.announces.length, 1, 're-announced before the 10 s interval');
    } finally {
      await torrent.destroy();
      await tracker.close();
    }
  });

  it('reconnects at once after a pause to peers it disconnected itself', async () => {
    const fixture = make('reconnect');
    const peer = await startSeeder(fixture, { silent: true });
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    try {
      await torrent.start();
      torrent.addPeer({ host: '127.0.0.1', port: peer.port });
      await waitUntil(() => torrent.stats().peers.connected === 1);
      assert.equal(torrent.pause(), true);
      assert.equal(torrent.stats().peers.connected, 0);
      assert.equal(torrent.resume(), true);
      await waitUntil(() => peer.connections === 2 && torrent.stats().peers.connected === 1, 2000);
    } finally {
      await torrent.destroy();
      await peer.close();
    }
  });

  it('pauses and resumes', async () => {
    const fixture = make('pause');
    const seeder = await startSeeder(fixture);
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    try {
      await torrent.start({ paused: true });
      assert.equal(torrent.state, 'paused');
      torrent.addPeer({ host: '127.0.0.1', port: seeder.port });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(seeder.connections, 0, 'a paused torrent does not connect to peers');
      assert.equal(torrent.resume(), true);
      await waitFor(torrent);
      await assertFilesMatch(dir, fixture);
      assert.equal(torrent.pause(), false, 'a completed torrent cannot be paused');
    } finally {
      await torrent.destroy();
      await seeder.close();
    }
  });

  it('stops checking and releases its files when destroyed mid-check', async () => {
    const fixture = makeTorrent({ name: 'big-check', files: randomFiles({ 'a.bin': 4_000_000 }), pieceLength: 16_384 });
    const target = join(dir, 'big-check');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'a.bin'), fixture.files[0]!.data);
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    const started = torrent.start();
    assert.equal(torrent.state, 'checking');
    await torrent.destroy();
    await started;
    assert.ok(torrent.stats().pieces.checked < fixture.meta.pieceHashes.length, 'the check stopped early');
    assert.notEqual(torrent.state, 'error');
  });

  it('lets the check stop before deleting the files of a torrent destroyed mid-check', async () => {
    const fixture = makeTorrent({ name: 'delete-mid-check', files: randomFiles({ 'a.bin': 4_000_000 }), pieceLength: 16_384 });
    const target = join(dir, 'delete-mid-check');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'a.bin'), fixture.files[0]!.data);
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    let checkStopped = false;
    const started = torrent.start().then(() => (checkStopped = true));
    // Wait until a piece read is in flight, then pull the files out from under it.
    await waitUntil(() => torrent.stats().pieces.checked > 0);
    await torrent.destroy({ deleteFiles: true });
    assert.ok(checkStopped, 'destroy resolved while the check was still reading the files');
    await started;
    await assert.rejects(access(target), 'the deleted torrent left files behind');
  });

  it('finishes immediately when the data is already complete', async () => {
    const fixture = make('complete');
    const target = join(dir, 'complete');
    for (const file of fixture.files) {
      await mkdir(join(target, ...file.path.slice(0, -1)), { recursive: true });
      await writeFile(join(target, ...file.path), file.data);
    }
    const torrent = new Torrent({ ...fixture.meta, announce: [] }, {
      downloadDir: dir,
      peerId: generatePeerId(),
      port: 6881,
    });
    await torrent.start();
    assert.equal(torrent.state, 'completed');
    await torrent.destroy();
  });
});
