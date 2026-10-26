import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { encode, type BencodeDict } from '../src/bencode.ts';
import { MetainfoError, parseMetainfo, pieceSize } from '../src/metainfo.ts';
import { makeTorrent, randomFiles } from './helpers/fixtures.ts';

const hashes = (n: number) => Buffer.alloc(20 * n, 1);

function torrentWith(info: BencodeDict, extra: BencodeDict = {}): Buffer {
  return encode({ announce: Buffer.from('http://tracker.test/announce'), ...extra, info });
}

describe('parseMetainfo', () => {
  it('parses a single-file torrent', () => {
    const fixture = makeTorrent({
      name: 'movie.mp4',
      files: randomFiles({ 'movie.mp4': 40_000 }),
      pieceLength: 16_384,
      announce: ['udp://tracker.test:6969/announce'],
      single: true,
    });
    const meta = fixture.meta;
    assert.equal(meta.name, 'movie.mp4');
    assert.equal(meta.length, 40_000);
    assert.equal(meta.pieceHashes.length, 3);
    assert.deepEqual(meta.files, [{ path: ['movie.mp4'], length: 40_000, offset: 0 }]);
    assert.deepEqual(meta.announce, [['udp://tracker.test:6969/announce']]);
    assert.equal(pieceSize(meta, 0), 16_384);
    assert.equal(pieceSize(meta, 2), 40_000 - 2 * 16_384);
  });

  it('parses a multi-file torrent with running offsets', () => {
    const fixture = makeTorrent({
      name: 'album',
      files: randomFiles({ 'a.flac': 1000, 'disc 2/b.flac': 0, 'disc 2/c.flac': 2500 }),
      pieceLength: 1024,
    });
    assert.deepEqual(
      fixture.meta.files.map((f) => [f.path.join('/'), f.length, f.offset]),
      [
        ['album/a.flac', 1000, 0],
        ['album/disc 2/b.flac', 0, 1000],
        ['album/disc 2/c.flac', 2500, 1000],
      ],
    );
    assert.equal(fixture.meta.length, 3500);
  });

  it('hashes the original info bytes, even when they are not in canonical order', () => {
    // Keys out of order: a re-encoded info dictionary would hash differently.
    const info = 'd4:name1:x6:lengthi5e12:piece lengthi16384e6:pieces20:' + 'a'.repeat(20) + 'e';
    const data = Buffer.from(`d4:info${info}e`, 'latin1');
    const meta = parseMetainfo(data);
    assert.equal(meta.infoHashHex, createHash('sha1').update(info, 'latin1').digest('hex'));
  });

  it('reads announce-list tiers in place of announce', () => {
    const data = torrentWith(
      { name: Buffer.from('x'), length: 1, 'piece length': 16, pieces: hashes(1) },
      {
        'announce-list': [
          [Buffer.from('udp://a.test:1/announce')],
          [Buffer.from('wss://webrtc.test'), Buffer.from('http://b.test/announce')],
        ],
      },
    );
    assert.deepEqual(parseMetainfo(data).announce, [['udp://a.test:1/announce'], ['http://b.test/announce']]);
  });

  it('rejects path components that would escape the download directory', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'C:evil', 'nul\u0000byte']) {
      const data = torrentWith({
        name: Buffer.from('safe'),
        'piece length': 16,
        pieces: hashes(1),
        files: [{ length: 1, path: [Buffer.from(bad)] }],
      });
      assert.throws(() => parseMetainfo(data), MetainfoError, JSON.stringify(bad));
    }
    const badName = torrentWith({ name: Buffer.from('..'), length: 1, 'piece length': 16, pieces: hashes(1) });
    assert.throws(() => parseMetainfo(badName), /not a safe file name/);
  });

  it('rejects a piece count that does not match the size', () => {
    const data = torrentWith({ name: Buffer.from('x'), length: 100, 'piece length': 16, pieces: hashes(2) });
    assert.throws(() => parseMetainfo(data), /needs 7/);
  });

  it('rejects files that are not torrents', () => {
    assert.throws(() => parseMetainfo(Buffer.from('<html>')), MetainfoError);
    assert.throws(() => parseMetainfo(encode({ announce: Buffer.from('x') })), /missing info/);
    assert.throws(
      () => parseMetainfo(torrentWith({ name: Buffer.from('x'), length: 1, 'piece length': 16 })),
      /v2-only/,
    );
  });
});
