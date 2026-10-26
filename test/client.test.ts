import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, DuplicateTorrentError } from '../src/client.ts';
import type { Torrent } from '../src/torrent.ts';
import { makeTorrent, randomFiles } from './helpers/fixtures.ts';

describe('Client', () => {
  let dir: string;
  let client: Client;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resttorrent-client-'));
    client = new Client({ downloadDir: dir });
  });
  after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a duplicate added while the first add is still being saved', async () => {
    const fixture = makeTorrent({ name: 'twice', files: randomFiles({ 'a.bin': 20_000 }), pieceLength: 16_384 });
    const results = await Promise.allSettled([
      client.add(fixture.torrent, { paused: true }),
      client.add(fixture.torrent, { paused: true }),
    ]);
    const added = results.filter((r): r is PromiseFulfilledResult<Torrent> => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(added.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(refused[0]!.reason instanceof DuplicateTorrentError);
    assert.equal(client.list().length, 1);
    assert.equal(client.get(fixture.meta.infoHashHex), added[0]!.value);
    assert.deepEqual((await readdir(client.stateDir)).sort(), [
      `${fixture.meta.infoHashHex}.json`,
      `${fixture.meta.infoHashHex}.torrent`,
    ]);

    // The refused add must not leave a reservation behind.
    await client.remove(added[0]!.value);
    const again = await client.add(fixture.torrent, { paused: true });
    assert.equal(client.get(fixture.meta.infoHashHex), again);
  });

  it('refuses to re-add a torrent until its removal has released the files', async () => {
    const fixture = makeTorrent({ name: 'readd', files: randomFiles({ 'a.bin': 20_000 }), pieceLength: 16_384 });
    const id = fixture.meta.infoHashHex;
    const first = await client.add(fixture.torrent, { paused: true });
    const removing = client.remove(first, { deleteFiles: true });
    assert.equal(client.get(id), undefined);
    await assert.rejects(client.add(fixture.torrent, { paused: true }), DuplicateTorrentError);
    await removing;

    // Once the removal is done the same torrent can be added again, and its state survives.
    const again = await client.add(fixture.torrent, { paused: true });
    assert.equal(client.get(id), again);
    const saved = await readdir(client.stateDir);
    assert.ok(saved.includes(`${id}.torrent`) && saved.includes(`${id}.json`), 'state files of the re-added torrent');
  });
});
