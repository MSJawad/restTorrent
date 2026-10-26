// HTTP tracker protocol (BEP 3, with BEP 23 compact peers and BEP 7 IPv6 peers).

import { decode, type BencodeDict, type BencodeValue } from '../bencode.ts';
import {
  parseCompactPeers,
  TrackerError,
  type AnnounceOptions,
  type AnnounceParams,
  type AnnounceResult,
  type PeerAddress,
} from './types.ts';

const DEFAULT_TIMEOUT = 15_000;
const MAX_RESPONSE_BYTES = 1 << 20;

/**
 * Percent-encodes raw bytes for a query string. info_hash and peer_id are
 * binary, so they cannot go through encodeURIComponent, which expects text.
 */
export function encodeBinary(buf: Buffer): string {
  let out = '';
  for (const byte of buf) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9.\-_~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function buildAnnounceUrl(announce: string, params: AnnounceParams): string {
  const query = [
    `info_hash=${encodeBinary(params.infoHash)}`,
    `peer_id=${encodeBinary(params.peerId)}`,
    `port=${params.port}`,
    `uploaded=${params.uploaded}`,
    `downloaded=${params.downloaded}`,
    `left=${params.left}`,
    'compact=1',
    `numwant=${params.numWant ?? 50}`,
  ];
  if (params.event) query.push(`event=${params.event}`);
  return `${announce}${announce.includes('?') ? '&' : '?'}${query.join('&')}`;
}

export function parseAnnounceResponse(body: Buffer): AnnounceResult {
  let value: BencodeValue;
  try {
    value = decode(body);
  } catch (err) {
    throw new TrackerError(`invalid tracker response: ${(err as Error).message}`);
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value) || Array.isArray(value)) {
    throw new TrackerError('invalid tracker response: not a dictionary');
  }
  const dict = value;
  const failure = dict['failure reason'];
  if (Buffer.isBuffer(failure)) throw new TrackerError(`tracker error: ${failure.toString('utf8')}`);

  const interval = dict.interval;
  if (typeof interval !== 'number') throw new TrackerError('invalid tracker response: no interval');

  const peers: PeerAddress[] = [];
  if (Buffer.isBuffer(dict.peers)) {
    peers.push(...parseCompactPeers(dict.peers, 4));
  } else if (Array.isArray(dict.peers)) {
    // Original non-compact form: a list of {ip, port, peer id} dictionaries.
    for (const entry of dict.peers) {
      if (typeof entry !== 'object' || Buffer.isBuffer(entry) || Array.isArray(entry)) continue;
      const peer = entry as BencodeDict;
      if (Buffer.isBuffer(peer.ip) && typeof peer.port === 'number' && peer.port > 0) {
        peers.push({ host: peer.ip.toString('utf8'), port: peer.port });
      }
    }
  }
  if (Buffer.isBuffer(dict.peers6)) peers.push(...parseCompactPeers(dict.peers6, 6));

  const result: AnnounceResult = { interval, peers };
  if (typeof dict['min interval'] === 'number') result.minInterval = dict['min interval'];
  if (typeof dict.complete === 'number') result.seeders = dict.complete;
  if (typeof dict.incomplete === 'number') result.leechers = dict.incomplete;
  if (Buffer.isBuffer(dict['warning message'])) {
    result.warning = dict['warning message'].toString('utf8');
  }
  return result;
}

export async function announceHttp(
  announce: string,
  params: AnnounceParams,
  options: AnnounceOptions = {},
): Promise<AnnounceResult> {
  const timeout = AbortSignal.timeout(options.timeout ?? DEFAULT_TIMEOUT);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let body: Buffer;
  try {
    const res = await fetch(buildAnnounceUrl(announce, params), {
      signal,
      headers: { 'user-agent': 'restTorrent' },
    });
    if (!res.ok) throw new TrackerError(`tracker returned HTTP ${res.status}`);
    body = await readBody(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof TrackerError) throw err;
    if (timeout.aborted) throw new TrackerError(`tracker ${announce} timed out`);
    throw new TrackerError(`tracker ${announce} unreachable: ${(err as Error).message}`);
  }
  return parseAnnounceResponse(body);
}

/** Reads the body up to `limit` bytes; the tracker is untrusted, so give up as soon as it sends more. */
async function readBody(res: Response, limit: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') ?? 0) > limit) {
    await res.body?.cancel();
    throw new TrackerError('tracker response too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > limit) throw new TrackerError('tracker response too large');
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}
