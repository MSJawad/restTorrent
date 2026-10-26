import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { encode } from '../src/bencode.ts';
import { announceHttp, buildAnnounceUrl, encodeBinary, parseAnnounceResponse } from '../src/tracker/http.ts';
import { announceTo, TrackerList, TrackerError, parseCompactPeers } from '../src/tracker/index.ts';
import { announceUdp, buildAnnounceRequest, buildConnectRequest, parseResponse } from '../src/tracker/udp.ts';

const params = {
  infoHash: Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex'),
  peerId: Buffer.from('-RT1000-abcdefghijkl'),
  port: 6881,
  uploaded: 0,
  downloaded: 1024,
  left: 5_000_000_000,
  event: 'started' as const,
};

function compact(peers: Array<[string, number]>): Buffer {
  return Buffer.concat(
    peers.map(([host, port]) => {
      const buf = Buffer.alloc(6);
      host.split('.').forEach((o, i) => buf.writeUInt8(Number(o), i));
      buf.writeUInt16BE(port, 4);
      return buf;
    }),
  );
}

describe('compact peers', () => {
  it('parses IPv4 and IPv6 entries and skips port 0', () => {
    assert.deepEqual(parseCompactPeers(compact([['10.0.0.1', 6881], ['192.168.1.2', 0]])), [
      { host: '10.0.0.1', port: 6881 },
    ]);
    const v6 = Buffer.alloc(18);
    v6.writeUInt16BE(0x2001, 0);
    v6.writeUInt16BE(0xdb8, 2);
    v6.writeUInt16BE(1, 14);
    v6.writeUInt16BE(51413, 16);
    assert.deepEqual(parseCompactPeers(v6, 6), [{ host: '2001:db8:0:0:0:0:0:1', port: 51413 }]);
  });
});

describe('HTTP tracker', () => {
  it('percent-encodes binary query values byte by byte', () => {
    assert.equal(encodeBinary(Buffer.from([0x00, 0x41, 0x7e, 0x20, 0xff])), '%00A~%20%FF');
    const url = buildAnnounceUrl('http://t.test/announce?passkey=x', params);
    assert.match(url, /^http:\/\/t\.test\/announce\?passkey=x&info_hash=%01%23Eg%89%AB%CD%EF/);
    assert.match(url, /&left=5000000000&compact=1&numwant=50&event=started$/);
  });

  it('parses compact, dictionary and IPv6 peer lists', () => {
    const result = parseAnnounceResponse(
      encode({
        interval: 1800,
        'min interval': 60,
        complete: 3,
        incomplete: 4,
        peers: compact([['1.2.3.4', 1000]]),
        peers6: Buffer.concat([Buffer.alloc(15), Buffer.from([1]), Buffer.from([0x1f, 0x90])]),
      }),
    );
    assert.deepEqual(result, {
      interval: 1800,
      minInterval: 60,
      seeders: 3,
      leechers: 4,
      peers: [
        { host: '1.2.3.4', port: 1000 },
        { host: '0:0:0:0:0:0:0:1', port: 8080 },
      ],
    });
    const dictPeers = parseAnnounceResponse(
      encode({ interval: 900, peers: [{ ip: Buffer.from('example.org'), port: 51413, 'peer id': Buffer.alloc(20) }] }),
    );
    assert.deepEqual(dictPeers.peers, [{ host: 'example.org', port: 51413 }]);
  });

  it('surfaces the failure reason', () => {
    assert.throws(
      () => parseAnnounceResponse(encode({ 'failure reason': Buffer.from('unregistered torrent') })),
      /unregistered torrent/,
    );
    assert.throws(() => parseAnnounceResponse(Buffer.from('<html>oops</html>')), TrackerError);
  });

  // Regression: the original client sent a UDP packet to HTTP trackers and waited forever.
  it('announces to a real HTTP server and returns its peers', async () => {
    let seenQuery = '';
    const server = createServer((req, res) => {
      seenQuery = req.url ?? '';
      res.end(encode({ interval: 1800, peers: compact([['127.0.0.1', 51413]]) }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const result = await announceHttp(`http://127.0.0.1:${port}/announce`, params);
    assert.deepEqual(result.peers, [{ host: '127.0.0.1', port: 51413 }]);
    assert.match(seenQuery, /info_hash=%01%23Eg/);
  });

  it('stops reading a response that grows past the size limit', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'd');
    let sent = 0;
    const server = createServer((req, res) => {
      res.on('error', () => {});
      if (req.url === '/declared') {
        // Says it will be huge but sends almost nothing, so only the header can reject it.
        res.writeHead(200, { 'content-length': String(2 * 1024 * 1024) });
        res.write(chunk);
        return;
      }
      const pump = () => {
        while (!res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) break;
        }
      };
      res.on('drain', pump);
      pump();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await assert.rejects(announceHttp(`http://127.0.0.1:${port}/endless`, params, { timeout: 5000 }), /too large/);
    await assert.rejects(announceHttp(`http://127.0.0.1:${port}/declared`, params, { timeout: 5000 }), /too large/);
    assert.ok(Date.now() - started < 4000, 'gave up without waiting for the timeout');
    assert.ok(sent < 32 * 1024 * 1024, `kept reading an endless response: ${sent} bytes`);
  });

  it('times out on a tracker that never answers', async () => {
    const server = createServer(() => {}); // accepts, never responds
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await assert.rejects(announceHttp(`http://127.0.0.1:${port}/a`, params, { timeout: 200 }), /timed out/);
    assert.ok(Date.now() - started < 2000);
  });
});

describe('UDP tracker packets', () => {
  it('builds a connect request with the protocol magic', () => {
    const req = buildConnectRequest(0xdeadbeef);
    assert.equal(req.toString('hex'), '0000041727101980' + '00000000' + 'deadbeef');
  });

  it('builds a 98-byte announce request with 64-bit counters', () => {
    const req = buildAnnounceRequest(Buffer.alloc(8, 7), 42, params, 99);
    assert.equal(req.length, 98);
    assert.equal(req.readUInt32BE(8), 1);
    assert.equal(req.readUInt32BE(12), 42);
    assert.ok(req.subarray(16, 36).equals(params.infoHash));
    assert.ok(req.subarray(36, 56).equals(params.peerId));
    assert.equal(req.readBigUInt64BE(56), 1024n);
    assert.equal(req.readBigUInt64BE(64), 5_000_000_000n); // does not fit in 32 bits
    assert.equal(req.readUInt32BE(80), 2); // started
    assert.equal(req.readInt32BE(92), 50);
    assert.equal(req.readUInt16BE(96), 6881);
  });

  it('parses connect, announce and error responses', () => {
    const connect = Buffer.alloc(16);
    connect.writeUInt32BE(0, 0);
    connect.writeUInt32BE(5, 4);
    connect.writeBigUInt64BE(0x1122334455667788n, 8);
    assert.deepEqual(parseResponse(connect), {
      action: 'connect',
      transactionId: 5,
      connectionId: Buffer.from('1122334455667788', 'hex'),
    });
    const announce = Buffer.concat([Buffer.alloc(20), compact([['8.8.4.4', 443]])]);
    announce.writeUInt32BE(1, 0);
    announce.writeUInt32BE(6, 4);
    announce.writeUInt32BE(900, 8);
    announce.writeUInt32BE(2, 12);
    announce.writeUInt32BE(10, 16);
    assert.deepEqual(parseResponse(announce), {
      action: 'announce',
      transactionId: 6,
      result: { interval: 900, leechers: 2, seeders: 10, peers: [{ host: '8.8.4.4', port: 443 }] },
    });
    const error = Buffer.concat([Buffer.alloc(8), Buffer.from('bad info hash')]);
    error.writeUInt32BE(3, 0);
    assert.deepEqual(parseResponse(error), { action: 'error', transactionId: 0, message: 'bad info hash' });
  });
});

/** A fake BEP 15 tracker. `drop` lets a test ignore the first N packets to exercise retries. */
async function startUdpTracker(options: { drop?: number; error?: string } = {}) {
  const socket: Socket = createSocket('udp4');
  const received: Buffer[] = [];
  let dropped = 0;
  socket.on('message', (msg, rinfo) => {
    received.push(msg);
    if (dropped < (options.drop ?? 0)) {
      dropped++;
      return;
    }
    const action = msg.readUInt32BE(8);
    const tid = msg.readUInt32BE(12);
    let reply: Buffer;
    if (options.error) {
      reply = Buffer.concat([Buffer.alloc(8), Buffer.from(options.error)]);
      reply.writeUInt32BE(3, 0);
      reply.writeUInt32BE(tid, 4);
    } else if (action === 0) {
      reply = Buffer.alloc(16);
      reply.writeUInt32BE(0, 0);
      reply.writeUInt32BE(tid, 4);
      reply.writeBigUInt64BE(0xabcdefn, 8);
    } else {
      assert.equal(msg.readBigUInt64BE(0), 0xabcdefn, 'announce uses the connection id');
      reply = Buffer.concat([Buffer.alloc(20), compact([['10.0.0.7', 6881]])]);
      reply.writeUInt32BE(1, 0);
      reply.writeUInt32BE(tid, 4);
      reply.writeUInt32BE(1200, 8);
    }
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return { url: `udp://127.0.0.1:${socket.address().port}/announce`, received, close: () => socket.close() };
}

describe('UDP tracker', () => {
  it('connects, announces and returns peers', async () => {
    const tracker = await startUdpTracker();
    after(tracker.close);
    const result = await announceUdp(tracker.url, params, { timeout: 500 });
    assert.deepEqual(result.peers, [{ host: '10.0.0.7', port: 6881 }]);
    assert.equal(result.interval, 1200);
    assert.ok(tracker.received[1]!.subarray(16, 36).equals(params.infoHash));
  });

  it('retries lost packets', async () => {
    const tracker = await startUdpTracker({ drop: 1 });
    after(tracker.close);
    const result = await announceUdp(tracker.url, params, { timeout: 100, retries: 2 });
    assert.equal(result.peers.length, 1);
    assert.equal(tracker.received.length, 3);
  });

  // Regression: the original client had no timeout and waited forever.
  it('gives up after its retries instead of hanging', async () => {
    const tracker = await startUdpTracker({ drop: Infinity });
    after(tracker.close);
    const started = Date.now();
    await assert.rejects(announceUdp(tracker.url, params, { timeout: 50, retries: 2 }), /did not respond after 3 attempts/);
    assert.ok(Date.now() - started < 1000);
    assert.equal(tracker.received.length, 3);
  });

  it('reports tracker errors', async () => {
    const tracker = await startUdpTracker({ error: 'torrent not registered' });
    after(tracker.close);
    await assert.rejects(announceUdp(tracker.url, params, { timeout: 500 }), /torrent not registered/);
  });
});

describe('TrackerList', () => {
  it('falls through to the next tracker in a tier and promotes the one that answered', async () => {
    const good = await startUdpTracker();
    const dead = await startUdpTracker({ drop: Infinity });
    after(() => {
      good.close();
      dead.close();
    });
    const list = new TrackerList([[dead.url, good.url]]);
    const seen: string[] = [];
    const results = await list.announce(params, { timeout: 50 }, (r) => seen.push(r.url));
    assert.deepEqual(seen, [good.url]);
    assert.equal(results[0]?.peers.length, 1);
    assert.deepEqual(list.tiers, [[good.url, dead.url]]);
  });

  it('rejects when every tracker fails, and unsupported schemes fail fast', async () => {
    await assert.rejects(announceTo('wss://tracker.test', params), /unsupported/);
    await assert.rejects(new TrackerList([]).announce(params), /no HTTP or UDP trackers/);
    const dead = await startUdpTracker({ drop: Infinity });
    after(dead.close);
    await assert.rejects(new TrackerList([[dead.url]]).announce(params, { timeout: 20 }), /all trackers failed/);
  });
});
