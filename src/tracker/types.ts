export type AnnounceEvent = 'started' | 'completed' | 'stopped';

export interface AnnounceParams {
  infoHash: Buffer;
  peerId: Buffer;
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  event?: AnnounceEvent;
  numWant?: number;
}

export interface PeerAddress {
  host: string;
  port: number;
}

export interface AnnounceResult {
  /** Seconds to wait before the next regular announce. */
  interval: number;
  minInterval?: number;
  peers: PeerAddress[];
  seeders?: number;
  leechers?: number;
  warning?: string;
}

export interface AnnounceOptions {
  /** Per-attempt timeout in milliseconds. */
  timeout?: number;
  signal?: AbortSignal;
}

export class TrackerError extends Error {
  override name = 'TrackerError';
}

/** Parses BEP 23 compact IPv4 peers (6 bytes each) or BEP 7 IPv6 peers (18 bytes each). */
export function parseCompactPeers(buf: Buffer, family: 4 | 6 = 4): PeerAddress[] {
  const size = family === 4 ? 6 : 18;
  const peers: PeerAddress[] = [];
  for (let i = 0; i + size <= buf.length; i += size) {
    const port = buf.readUInt16BE(i + size - 2);
    if (port === 0) continue;
    let host: string;
    if (family === 4) {
      host = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
    } else {
      const groups: string[] = [];
      for (let j = 0; j < 16; j += 2) groups.push(buf.readUInt16BE(i + j).toString(16));
      host = groups.join(':');
    }
    peers.push({ host, port });
  }
  return peers;
}
