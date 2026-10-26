// UDP tracker protocol (BEP 15).

import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  parseCompactPeers,
  TrackerError,
  type AnnounceOptions,
  type AnnounceParams,
  type AnnounceResult,
} from './types.ts';

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;
const EVENTS = { none: 0, completed: 1, started: 2, stopped: 3 } as const;

/** BEP 15 waits 15 * 2^n seconds; a shorter base keeps a dead tracker from stalling a download. */
const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_RETRIES = 2;

export function buildConnectRequest(transactionId: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(PROTOCOL_ID, 0);
  buf.writeUInt32BE(ACTION_CONNECT, 8);
  buf.writeUInt32BE(transactionId, 12);
  return buf;
}

export function buildAnnounceRequest(
  connectionId: Buffer,
  transactionId: number,
  params: AnnounceParams,
  key: number,
): Buffer {
  const buf = Buffer.alloc(98);
  connectionId.copy(buf, 0);
  buf.writeUInt32BE(ACTION_ANNOUNCE, 8);
  buf.writeUInt32BE(transactionId, 12);
  params.infoHash.copy(buf, 16);
  params.peerId.copy(buf, 36);
  buf.writeBigUInt64BE(BigInt(params.downloaded), 56);
  buf.writeBigUInt64BE(BigInt(params.left), 64);
  buf.writeBigUInt64BE(BigInt(params.uploaded), 72);
  buf.writeUInt32BE(EVENTS[params.event ?? 'none'], 80);
  buf.writeUInt32BE(0, 84); // IP address: 0 means "use the sender's address"
  buf.writeUInt32BE(key, 88);
  buf.writeInt32BE(params.numWant ?? 50, 92);
  buf.writeUInt16BE(params.port, 96);
  return buf;
}

export type UdpResponse =
  | { action: 'connect'; transactionId: number; connectionId: Buffer }
  | { action: 'announce'; transactionId: number; result: AnnounceResult }
  | { action: 'error'; transactionId: number; message: string };

export function parseResponse(buf: Buffer, family: 4 | 6 = 4): UdpResponse {
  if (buf.length < 8) throw new TrackerError('UDP tracker response too short');
  const action = buf.readUInt32BE(0);
  const transactionId = buf.readUInt32BE(4);
  if (action === ACTION_CONNECT) {
    if (buf.length < 16) throw new TrackerError('UDP connect response too short');
    return { action: 'connect', transactionId, connectionId: Buffer.from(buf.subarray(8, 16)) };
  }
  if (action === ACTION_ANNOUNCE) {
    if (buf.length < 20) throw new TrackerError('UDP announce response too short');
    return {
      action: 'announce',
      transactionId,
      result: {
        interval: buf.readUInt32BE(8),
        leechers: buf.readUInt32BE(12),
        seeders: buf.readUInt32BE(16),
        peers: parseCompactPeers(buf.subarray(20), family),
      },
    };
  }
  if (action === ACTION_ERROR) {
    return { action: 'error', transactionId, message: buf.subarray(8).toString('utf8') };
  }
  throw new TrackerError(`unknown UDP tracker action ${action}`);
}

export async function announceUdp(
  announce: string,
  params: AnnounceParams,
  options: AnnounceOptions & { retries?: number } = {},
): Promise<AnnounceResult> {
  const url = new URL(announce);
  const port = Number(url.port);
  if (!port) throw new TrackerError(`UDP tracker URL has no port: ${announce}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let address: Awaited<ReturnType<typeof lookup>>;
  try {
    address = await lookup(hostname);
  } catch (err) {
    throw new TrackerError(`cannot resolve ${hostname}: ${(err as Error).message}`);
  }
  const family = address.family === 6 ? 6 : 4;
  const socket = createSocket(family === 6 ? 'udp6' : 'udp4');
  const exchange = new Exchange(socket, address.address, port, family, options);
  try {
    const connectTid = randomTid();
    const connect = await exchange.send(buildConnectRequest(connectTid), connectTid, 'connect');
    if (connect.action !== 'connect') throw new TrackerError('unexpected UDP tracker reply');
    const announceTid = randomTid();
    const key = randomBytes(4).readUInt32BE(0);
    const request = buildAnnounceRequest(connect.connectionId, announceTid, params, key);
    const reply = await exchange.send(request, announceTid, 'announce');
    if (reply.action !== 'announce') throw new TrackerError('unexpected UDP tracker reply');
    return reply.result;
  } finally {
    socket.close();
  }
}

function randomTid(): number {
  return randomBytes(4).readUInt32BE(0);
}

/** Sends a request and waits for the matching reply, retrying with exponential backoff. */
class Exchange {
  #socket: Socket;
  #host: string;
  #port: number;
  #family: 4 | 6;
  #timeout: number;
  #retries: number;
  #signal: AbortSignal | undefined;

  constructor(
    socket: Socket,
    host: string,
    port: number,
    family: 4 | 6,
    options: AnnounceOptions & { retries?: number },
  ) {
    this.#socket = socket;
    this.#host = host;
    this.#port = port;
    this.#family = family;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.#retries = options.retries ?? DEFAULT_RETRIES;
    this.#signal = options.signal;
  }

  async send(
    request: Buffer,
    transactionId: number,
    expected: 'connect' | 'announce',
  ): Promise<UdpResponse> {
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      const reply = await this.#attempt(request, transactionId, this.#timeout * 2 ** attempt);
      if (reply === null) continue;
      if (reply.action === 'error') throw new TrackerError(`tracker error: ${reply.message}`);
      if (reply.action !== expected) throw new TrackerError('unexpected UDP tracker reply');
      return reply;
    }
    throw new TrackerError(
      `UDP tracker ${this.#host}:${this.#port} did not respond after ${this.#retries + 1} attempts`,
    );
  }

  #attempt(request: Buffer, transactionId: number, timeout: number): Promise<UdpResponse | null> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#socket.off('message', onMessage);
        this.#socket.off('error', onError);
        this.#signal?.removeEventListener('abort', onAbort);
      };
      const onMessage = (msg: Buffer) => {
        let reply: UdpResponse;
        try {
          reply = parseResponse(msg, this.#family);
        } catch {
          return; // ignore garbage
        }
        if (reply.transactionId !== transactionId) return;
        cleanup();
        resolve(reply);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new TrackerError(`UDP tracker socket error: ${err.message}`));
      };
      const onAbort = () => {
        cleanup();
        reject(new TrackerError('announce aborted'));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);
      if (this.#signal?.aborted) return onAbort();
      this.#signal?.addEventListener('abort', onAbort);
      this.#socket.on('message', onMessage);
      this.#socket.on('error', onError);
      this.#socket.send(request, this.#port, this.#host);
    });
  }
}
