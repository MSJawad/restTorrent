import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApiServer } from '../src/api/server.ts';
import { Client } from '../src/client.ts';
import { makeTorrent, randomFiles, startHttpTracker, startSeeder, type FakeHttpTracker, type Seeder } from './helpers/fixtures.ts';

describe('REST API', () => {
  let dir: string;
  let client: Client;
  let server: Server;
  let base: string;
  let seeder: Seeder;
  let tracker: FakeHttpTracker;

  const files = randomFiles({ 'a.bin': 100_000, 'b/c.bin': 60_000 });
  let fixture = makeTorrent({ name: 'api-test', files, pieceLength: 16_384 });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resttorrent-api-'));
    seeder = await startSeeder(fixture);
    tracker = await startHttpTracker([{ host: '127.0.0.1', port: seeder.port }]);
    // Same files, but announcing to the fake tracker. The info hash is unchanged.
    fixture = makeTorrent({ name: 'api-test', files, pieceLength: 16_384, announce: [tracker.url] });
    client = new Client({ downloadDir: dir });
    server = createApiServer(client);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await client.close();
    await seeder.close();
    await tracker.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (path: string, body?: Buffer, type = 'application/x-bittorrent') =>
    fetch(base + path, { method: 'POST', ...(body ? { body, headers: { 'content-type': type } } : {}) });

  async function waitForState(id: string, state: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${base}/api/torrents/${id}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (body.state === state) return body;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`torrent never reached ${state}`);
  }

  it('serves the progress page', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /restTorrent/);
  });

  it('adds a torrent, downloads it and reports progress', async () => {
    const res = await post('/api/torrents', fixture.torrent);
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: string; name: string; size: number };
    assert.equal(created.id, fixture.meta.infoHashHex);
    assert.equal(res.headers.get('location'), `/api/torrents/${created.id}`);
    assert.equal(created.name, 'api-test');
    assert.equal(created.size, 160_000);

    const done = await waitForState(created.id, 'completed');
    assert.equal(done.progress, 1);
    assert.deepEqual(done.pieces, { total: 10, have: 10, checked: 10 });
    assert.deepEqual(done.files, [
      { path: 'api-test/a.bin', size: 100_000, downloaded: 100_000 },
      { path: 'api-test/b/c.bin', size: 60_000, downloaded: 60_000 },
    ]);
    assert.ok((await readFile(join(dir, 'api-test', 'a.bin'))).equals(files[0]!.data));

    const list = (await (await fetch(base + '/api/torrents')).json()) as { torrents: Array<{ id: string }> };
    assert.deepEqual(
      list.torrents.map((t) => t.id),
      [created.id],
    );
  });

  it('rejects duplicates, bad uploads and unknown ids', async () => {
    assert.equal((await post('/api/torrents', fixture.torrent)).status, 409);
    const bad = await post('/api/torrents', Buffer.from('not a torrent'));
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /not a valid torrent/);
    assert.equal((await post('/api/torrents', fixture.torrent, 'text/plain')).status, 415);
    assert.equal((await fetch(`${base}/api/torrents/${'0'.repeat(40)}`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    const wrongMethod = await fetch(base + '/api/torrents', { method: 'PUT' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
  });

  it('refuses uploads over the size limit', async () => {
    const res = await post('/api/torrents', Buffer.alloc(11 * 1024 * 1024));
    assert.equal(res.status, 413);
  });

  it('pauses and resumes, and refuses to pause a finished torrent', async () => {
    const other = makeTorrent({
      name: 'paused-one',
      files: randomFiles({ 'x.bin': 50_000 }),
      pieceLength: 16_384,
      announce: [tracker.url],
    });
    const res = await post('/api/torrents?paused=true', other.torrent);
    const { id } = (await res.json()) as { id: string };
    await waitForState(id, 'paused');
    const resumed = await post(`/api/torrents/${id}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(((await resumed.json()) as { state: string }).state, 'downloading');
    const paused = await post(`/api/torrents/${id}/pause`);
    assert.equal(((await paused.json()) as { state: string }).state, 'paused');

    const finished = await post(`/api/torrents/${fixture.meta.infoHashHex}/pause`);
    assert.equal(finished.status, 409);
    assert.match(((await finished.json()) as { error: string }).error, /completed/);
    assert.equal((await fetch(`${base}/api/torrents/${id}`, { method: 'DELETE' })).status, 204);
  });

  it('streams progress as server-sent events', async () => {
    const res = await fetch(base + '/api/events');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = Buffer.from(value!).toString();
    assert.match(text, /^event: torrents\ndata: /);
    const data = JSON.parse(text.split('data: ')[1]!) as { torrents: Array<{ id: string }> };
    assert.equal(data.torrents[0]?.id, fixture.meta.infoHashHex);
  });

  it('blocks cross-origin requests and foreign Host headers', async () => {
    const cross = await fetch(`${base}/api/torrents/${fixture.meta.infoHashHex}/pause`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(cross.status, 403);
    // fetch() does not let a caller override Host, so use a raw request.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/torrents`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebound, 403);
    const sameOrigin = await fetch(`${base}/api/torrents`, { headers: { origin: base } });
    assert.equal(sameOrigin.status, 200);
  });

  it('remembers torrents across restarts and removes them with their files', async () => {
    const id = fixture.meta.infoHashHex;
    const restarted = new Client({ downloadDir: dir });
    await restarted.restore();
    const torrent = restarted.get(id);
    assert.ok(torrent, 'the torrent was restored from the state directory');
    await new Promise<void>((resolve) => torrent.once('done', resolve));
    assert.equal(torrent.stats().pieces.have, 10, 'restored by re-checking the files on disk');
    await restarted.close();

    const res = await fetch(`${base}/api/torrents/${id}?deleteFiles=true`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    await assert.rejects(access(join(dir, 'api-test', 'a.bin')));
    const list = (await (await fetch(base + '/api/torrents')).json()) as { torrents: unknown[] };
    assert.deepEqual(list.torrents, []);
  });
});
