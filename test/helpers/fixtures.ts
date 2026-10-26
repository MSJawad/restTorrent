// Builders and fakes shared by the tests: a .torrent builder, a minimal
// seeding peer and a fake HTTP tracker. They run in-process and only bind to
// 127.0.0.1, so the tests never touch the network.

import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { encode, type BencodeDict } from '../../src/bencode.ts';
import { parseMetainfo, type Metainfo } from '../../src/metainfo.ts';
import { buildHandshake, encodeMessage, MessageReader } from '../../src/peer/protocol.ts';
import type { BlockRequest } from '../../src/piece-picker.ts';

export interface FixtureFile {
  path: string[];
  data: Buffer;
}

export interface Fixture {
  torrent: Buffer;
  meta: Metainfo;
  payload: Buffer;
  files: FixtureFile[];
}

/** Random files of the given sizes, so every piece hash is distinct. */
export function randomFiles(sizes: Record<string, number>): FixtureFile[] {
  return Object.entries(sizes).map(([path, size]) => ({ path: path.split('/'), data: randomBytes(size) }));
}

export function makeTorrent(options: {
  name: string;
  files: FixtureFile[];
  pieceLength: number;
  announce?: string[];
  single?: boolean;
}): Fixture {
  const payload = Buffer.concat(options.files.map((f) => f.data));
  const hashes: Buffer[] = [];
  for (let i = 0; i < payload.length; i += options.pieceLength) {
    hashes.push(createHash('sha1').update(payload.subarray(i, i + options.pieceLength)).digest());
  }
  const info: BencodeDict = {
    name: Buffer.from(options.name),
    'piece length': options.pieceLength,
    pieces: Buffer.concat(hashes),
  };
  if (options.single) {
    info.length = payload.length;
  } else {
    info.files = options.files.map((f) => ({
      length: f.data.length,
      path: f.path.map((p) => Buffer.from(p)),
    }));
  }
  const dict: BencodeDict = { info };
  const [first, ...rest] = options.announce ?? [];
  if (first) dict.announce = Buffer.from(first);
  if (rest.length > 0) dict['announce-list'] = [first, ...rest].map((url) => [Buffer.from(url as string)]);
  const torrent = encode(dict);
  return { torrent, meta: parseMetainfo(torrent), payload, files: options.files };
}

export interface Seeder {
  port: number;
  requests: BlockRequest[];
  connections: number;
  close(): Promise<void>;
}

/**
 * A minimal seeding peer: answers the handshake, advertises every piece,
 * unchokes as soon as the client is interested, and serves requested blocks.
 * `corrupt` makes it send garbage for chosen pieces, to exercise hash checks.
 * `silent` makes it stop after the handshake, so the client stays connected
 * to a peer that never offers anything.
 */
export async function startSeeder(
  fixture: Fixture,
  options: { corrupt?: (index: number) => boolean; peerId?: Buffer; silent?: boolean } = {},
): Promise<Seeder> {
  const { meta, payload } = fixture;
  const peerId = options.peerId ?? Buffer.from('-TS0001-' + 'x'.repeat(12));
  const sockets = new Set<Socket>();
  const seeder: Seeder = { port: 0, requests: [], connections: 0, close: async () => {} };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    seeder.connections++;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const reader = new MessageReader();
    socket.on('data', (chunk) => {
      let items;
      try {
        items = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const item of items) {
        if ('infoHash' in item) {
          if (!item.infoHash.equals(meta.infoHash)) {
            socket.destroy();
            return;
          }
          socket.write(buildHandshake(meta.infoHash, peerId));
          if (options.silent) continue;
          const bits = Buffer.alloc(Math.ceil(meta.pieceHashes.length / 8));
          for (let i = 0; i < meta.pieceHashes.length; i++) bits[i >> 3]! |= 0x80 >> (i & 7);
          socket.write(encodeMessage({ type: 'bitfield', bitfield: bits }));
        } else if (item.type === 'interested') {
          socket.write(encodeMessage({ type: 'unchoke' }));
        } else if (item.type === 'request') {
          seeder.requests.push({ index: item.index, begin: item.begin, length: item.length });
          const start = item.index * meta.pieceLength + item.begin;
          let block = Buffer.from(payload.subarray(start, start + item.length));
          if (options.corrupt?.(item.index)) block = randomBytes(block.length);
          socket.write(encodeMessage({ type: 'piece', index: item.index, begin: item.begin, block }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  seeder.port = (server.address() as AddressInfo).port;
  seeder.close = () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return seeder;
}

export interface FakeHttpTracker {
  url: string;
  announces: URLSearchParams[];
  close(): Promise<void>;
}

/** An HTTP tracker that hands out a fixed list of peers as compact entries. */
export async function startHttpTracker(
  peers: Array<{ host: string; port: number }>,
  options: { interval?: number; minInterval?: number } = {},
): Promise<FakeHttpTracker> {
  const announces: URLSearchParams[] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    announces.push(url.searchParams);
    const compact = Buffer.concat(
      peers.map((p) => {
        const buf = Buffer.alloc(6);
        p.host.split('.').forEach((octet, i) => buf.writeUInt8(Number(octet), i));
        buf.writeUInt16BE(p.port, 4);
        return buf;
      }),
    );
    const reply: BencodeDict = { interval: options.interval ?? 1800, complete: peers.length, incomplete: 0, peers: compact };
    if (options.minInterval !== undefined) reply['min interval'] = options.minInterval;
    res.end(encode(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/announce`,
    announces,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
