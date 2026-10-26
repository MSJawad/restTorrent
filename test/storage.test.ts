import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TorrentFile } from '../src/metainfo.ts';
import { mapRange, Storage } from '../src/storage.ts';
import { makeTorrent, randomFiles } from './helpers/fixtures.ts';

const files = (lengths: number[]): TorrentFile[] => {
  let offset = 0;
  return lengths.map((length, i) => {
    const file = { path: [`f${i}`], length, offset };
    offset += length;
    return file;
  });
};

describe('mapRange', () => {
  it('maps a range inside one file', () => {
    assert.deepEqual(mapRange(files([100, 100]), 10, 20), [
      { fileIndex: 0, fileOffset: 10, rangeOffset: 0, length: 20 },
    ]);
  });

  it('splits a piece that spans several files', () => {
    assert.deepEqual(mapRange(files([10, 5, 30]), 8, 20), [
      { fileIndex: 0, fileOffset: 8, rangeOffset: 0, length: 2 },
      { fileIndex: 1, fileOffset: 0, rangeOffset: 2, length: 5 },
      { fileIndex: 2, fileOffset: 0, rangeOffset: 7, length: 13 },
    ]);
  });

  it('skips zero-length files', () => {
    assert.deepEqual(mapRange(files([10, 0, 0, 10]), 5, 10), [
      { fileIndex: 0, fileOffset: 5, rangeOffset: 0, length: 5 },
      { fileIndex: 3, fileOffset: 0, rangeOffset: 5, length: 5 },
    ]);
  });

  it('starts exactly on a file boundary', () => {
    assert.deepEqual(mapRange(files([10, 10, 10]), 20, 10), [
      { fileIndex: 2, fileOffset: 0, rangeOffset: 0, length: 10 },
    ]);
  });

  it('covers every byte exactly once for any range', () => {
    const layout = files([7, 0, 13, 1, 29, 0, 4]);
    const total = 54;
    for (let offset = 0; offset < total; offset++) {
      for (let length = 1; offset + length <= total; length++) {
        const segs = mapRange(layout, offset, length);
        assert.equal(segs.reduce((n, s) => n + s.length, 0), length);
        for (const s of segs) {
          const file = layout[s.fileIndex] as TorrentFile;
          assert.equal(file.offset + s.fileOffset, offset + s.rangeOffset);
          assert.ok(s.fileOffset + s.length <= file.length);
        }
      }
    }
  });
});

describe('Storage', () => {
  let dir: string;
  before(async () => (dir = await mkdtemp(join(tmpdir(), 'resttorrent-storage-'))));
  after(() => rm(dir, { recursive: true, force: true }));

  const fixture = makeTorrent({
    name: 'set',
    files: randomFiles({ 'a.bin': 3000, 'empty.txt': 0, 'sub/b.bin': 5000, 'sub/deeper/c.bin': 1200 }),
    pieceLength: 2048,
  });
  const piece = (i: number) => fixture.payload.subarray(i * 2048, (i + 1) * 2048);

  it('writes pieces to the right offsets of the right files', async () => {
    const storage = new Storage(fixture.meta, join(dir, 'write'));
    await storage.allocate();
    // Out of order on purpose.
    for (const i of [3, 0, 4, 2, 1]) await storage.writePiece(i, piece(i));
    await storage.close();
    for (const file of fixture.files) {
      const written = await readFile(join(dir, 'write', 'set', ...file.path));
      assert.ok(written.equals(file.data), file.path.join('/'));
    }
    assert.equal((await stat(join(dir, 'write', 'set', 'empty.txt'))).size, 0);
  });

  it('verifies what is on disk to resume a partial download', async () => {
    const target = join(dir, 'resume');
    const storage = new Storage(fixture.meta, target);
    // Nothing on disk yet.
    assert.equal((await storage.verify()).count, 0);
    await storage.writePiece(0, piece(0));
    await storage.writePiece(2, piece(2));
    await storage.writePiece(4, piece(4));
    // Corrupt one byte of piece 2, which lives in sub/b.bin.
    await storage.close();
    const b = join(target, 'set', 'sub', 'b.bin');
    const bytes = await readFile(b);
    bytes[4096 - 3000] = (bytes[4096 - 3000] as number) ^ 0xff;
    await writeFile(b, bytes);
    const have = await storage.verify();
    assert.deepEqual([0, 1, 2, 3, 4].filter((i) => have.has(i)), [0, 4]);
    await storage.close();
  });

  it('removes only the torrent files and the directories it emptied', async () => {
    const target = join(dir, 'remove');
    const storage = new Storage(fixture.meta, target);
    await storage.allocate();
    await writeFile(join(target, 'set', 'keep-me.txt'), 'not part of the torrent');
    await storage.remove();
    assert.deepEqual(await readdir(join(target, 'set')), ['keep-me.txt']);
  });

  it('reports a short file as missing data rather than failing', async () => {
    const target = join(dir, 'short');
    await mkdir(join(target, 'set'), { recursive: true });
    await writeFile(join(target, 'set', 'a.bin'), fixture.files[0]!.data.subarray(0, 100));
    const storage = new Storage(fixture.meta, target);
    assert.equal(await storage.readPiece(0), null);
    assert.equal((await storage.verify()).count, 0);
    await storage.close();
  });
});
