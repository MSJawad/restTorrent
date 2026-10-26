// One torrent's download: checks what is already on disk, announces to
// trackers, keeps a pool of peer connections busy with block requests,
// verifies each finished piece against its SHA-1 hash and writes it to disk.

import { EventEmitter } from 'node:events';
import { Bitfield } from './bitfield.ts';
import { pieceSize, type Metainfo } from './metainfo.ts';
import { PeerConnection } from './peer/connection.ts';
import { blockKey, PiecePicker, type BlockRequest } from './piece-picker.ts';
import { mapRange, sha1, Storage } from './storage.ts';
import { TrackerList, type AnnounceEvent, type PeerAddress } from './tracker/index.ts';

export type TorrentState = 'checking' | 'downloading' | 'paused' | 'completed' | 'error';

export interface TorrentOptions {
  downloadDir: string;
  peerId: Buffer;
  /** Port reported to trackers. */
  port: number;
  maxPeers?: number;
  /** Outstanding block requests per peer. */
  pipeline?: number;
  requestTimeout?: number;
  trackerTimeout?: number;
  /** Lower bound on the re-announce interval, in seconds. */
  minAnnounceInterval?: number;
}

export interface TorrentStats {
  id: string;
  name: string;
  state: TorrentState;
  error: string | null;
  size: number;
  /** Bytes in verified pieces. */
  downloaded: number;
  progress: number;
  pieces: { total: number; have: number; checked: number };
  /** Pieces that failed their SHA-1 check and were downloaded again. */
  corruptPieces: number;
  peers: { connected: number; known: number };
  /** Payload bytes per second, averaged over the last few seconds. */
  downloadSpeed: number;
  /** Estimated seconds until completion, or null when unknown. */
  eta: number | null;
  tracker: { lastAnnounce: string | null; lastError: string | null; peersReturned: number };
  files: Array<{ path: string; size: number; downloaded: number }>;
}

type TorrentEvents = {
  state: [state: TorrentState];
  piece: [index: number];
  done: [];
};

interface ActivePeer {
  conn: PeerConnection;
  /** Requests in flight to this peer, by blockKey, with the time each was sent. */
  outstanding: Map<string, { request: BlockRequest; sentAt: number }>;
  /** Verified and failed pieces this peer contributed blocks to. */
  goodPieces: number;
  hashFailures: number;
}

interface KnownPeer extends PeerAddress {
  failures: number;
  nextAttempt: number;
  banned: boolean;
}

const MAINTENANCE_INTERVAL = 1000;
const SPEED_WINDOW = 5;
const MAX_KNOWN_PEERS = 500;
const MAX_HASH_FAILURES = 3;
const ANNOUNCE_RETRY_DELAYS = [15, 30, 60, 120, 300];

export class Torrent extends EventEmitter<TorrentEvents> {
  readonly meta: Metainfo;
  readonly storage: Storage;
  readonly picker: PiecePicker;
  state: TorrentState = 'checking';
  error: string | null = null;

  #options: Required<TorrentOptions>;
  #trackers: TrackerList;
  #peers = new Map<string, ActivePeer>();
  #known = new Map<string, KnownPeer>();
  /** Peers that sent blocks of each in-progress piece, to blame on a hash failure. */
  #contributors = new Map<number, Set<string>>();
  #pendingWrites = new Set<Promise<void>>();
  #verifiedBytes = 0;
  #checked = 0;
  #received = 0;
  #corruptPieces = 0;
  #speedSamples: number[] = [];
  #maintenance: NodeJS.Timeout | null = null;
  #announceTimer: NodeJS.Timeout | null = null;
  #announceFailures = 0;
  #abort: AbortController | null = null;
  #tracker = { lastAnnounce: null as string | null, lastError: null as string | null, peersReturned: 0 };
  #destroyed = false;
  /** Set when pause is requested while the initial check is still running. */
  #pauseAfterCheck = false;

  constructor(meta: Metainfo, options: TorrentOptions) {
    super();
    this.meta = meta;
    this.#options = {
      maxPeers: 40,
      pipeline: 32,
      requestTimeout: 30_000,
      trackerTimeout: 15_000,
      minAnnounceInterval: 60,
      ...options,
    };
    this.storage = new Storage(meta, options.downloadDir);
    this.#trackers = new TrackerList(meta.announce);
    this.picker = new PiecePicker(
      { pieceCount: meta.pieceHashes.length, pieceLength: meta.pieceLength, length: meta.length },
      new Bitfield(meta.pieceHashes.length),
    );
  }

  get id(): string {
    return this.meta.infoHashHex;
  }

  /** Re-checks existing data on disk, then starts downloading unless `paused`. */
  async start({ paused = false } = {}): Promise<void> {
    this.#pauseAfterCheck = paused;
    this.#setState('checking');
    this.#checked = 0;
    this.#verifiedBytes = 0;
    for (let i = 0; i < this.picker.have.size; i++) this.picker.have.clear(i);
    try {
      const have = await this.storage.verify((checked) => (this.#checked = checked));
      if (this.#destroyed) return;
      for (let i = 0; i < have.size; i++) {
        if (have.has(i)) {
          this.picker.complete(i);
          this.#verifiedBytes += pieceSize(this.meta, i);
        }
      }
      this.#checked = this.meta.pieceHashes.length;
      await this.storage.allocate();
    } catch (err) {
      this.#fail(err as Error);
      return;
    }
    if (this.#destroyed) return;
    if (this.picker.have.complete) {
      await this.storage.close();
      this.#setState('completed');
      this.emit('done');
    } else if (this.#pauseAfterCheck) {
      this.#setState('paused');
    } else {
      this.#begin();
    }
  }

  /** Pauses downloading. Returns false when the torrent is not in a pausable state. */
  pause(): boolean {
    if (this.state === 'checking') {
      this.#pauseAfterCheck = true;
      return true;
    }
    if (this.state !== 'downloading') return this.state === 'paused';
    this.#halt('stopped');
    this.#setState('paused');
    return true;
  }

  /** Resumes a paused torrent, or retries one that failed. Returns false when there is nothing to resume. */
  resume(): boolean {
    if (this.state === 'checking') {
      this.#pauseAfterCheck = false;
      return true;
    }
    if (this.state === 'error') {
      // A failed check or disk write is retried from scratch.
      this.error = null;
      void this.start();
      return true;
    }
    if (this.state !== 'paused') return this.state === 'downloading';
    // The last piece may have landed on disk just after the pause.
    if (this.picker.have.complete) void this.#finish();
    else this.#begin();
    return true;
  }

  /** Stops all activity and releases files. Optionally deletes the downloaded data. */
  async destroy({ deleteFiles = false } = {}): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#halt(this.state === 'downloading' ? 'stopped' : null);
    await Promise.allSettled(this.#pendingWrites);
    if (deleteFiles) await this.storage.remove();
    else await this.storage.close();
  }

  /** Adds a peer to try, as if a tracker had returned it. */
  addPeer(peer: PeerAddress): void {
    const key = addressKey(peer);
    if (this.#known.has(key) || this.#known.size >= MAX_KNOWN_PEERS) return;
    this.#known.set(key, { ...peer, failures: 0, nextAttempt: 0, banned: false });
    if (this.state === 'downloading') this.#connectPeers();
  }

  stats(): TorrentStats {
    const total = this.meta.pieceHashes.length;
    const speed = this.#speed();
    const left = this.meta.length - this.#verifiedBytes;
    return {
      id: this.id,
      name: this.meta.name,
      state: this.state,
      error: this.error,
      size: this.meta.length,
      downloaded: this.#verifiedBytes,
      progress: this.#verifiedBytes / this.meta.length,
      pieces: { total, have: this.picker.have.count, checked: this.#checked },
      corruptPieces: this.#corruptPieces,
      peers: { connected: this.#readyPeers(), known: this.#known.size },
      downloadSpeed: Math.round(speed),
      eta: left === 0 ? 0 : speed > 0 ? Math.ceil(left / speed) : null,
      tracker: { ...this.#tracker },
      files: this.#fileStats(),
    };
  }

  #begin(): void {
    this.#setState('downloading');
    this.#abort = new AbortController();
    this.#announceFailures = 0;
    this.#speedSamples = [];
    this.#maintenance = setInterval(() => this.#maintain(), MAINTENANCE_INTERVAL);
    void this.#announce('started');
    this.#connectPeers();
  }

  /** Stops timers, trackers and peers. Sends a final announce when `event` is set. */
  #halt(event: AnnounceEvent | null): void {
    if (this.#maintenance) clearInterval(this.#maintenance);
    if (this.#announceTimer) clearTimeout(this.#announceTimer);
    this.#maintenance = null;
    this.#announceTimer = null;
    this.#abort?.abort();
    this.#abort = null;
    for (const peer of [...this.#peers.values()]) peer.conn.close();
    this.#peers.clear();
    if (event && !this.#trackers.empty) {
      // Best effort and short: the tracker only uses this to tidy its peer list.
      this.#trackers
        .announce(this.#announceParams(event), { timeout: 3000 })
        .catch(() => {});
    }
  }

  #setState(state: TorrentState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  #fail(err: Error): void {
    this.error = err.message;
    this.#halt(null);
    this.#setState('error');
  }

  #announceParams(event?: AnnounceEvent) {
    return {
      infoHash: this.meta.infoHash,
      peerId: this.#options.peerId,
      port: this.#options.port,
      uploaded: 0,
      downloaded: this.#received,
      left: this.meta.length - this.#verifiedBytes,
      ...(event ? { event } : {}),
    };
  }

  async #announce(event?: AnnounceEvent): Promise<void> {
    const signal = this.#abort?.signal;
    if (!signal) return;
    if (this.#trackers.empty) {
      this.#tracker.lastError = 'torrent has no HTTP or UDP trackers';
      return;
    }
    let delay: number;
    try {
      const results = await this.#trackers.announce(
        this.#announceParams(event),
        { timeout: this.#options.trackerTimeout, signal },
        (result) => {
          if (signal.aborted) return;
          this.#tracker.lastAnnounce = new Date().toISOString();
          this.#tracker.peersReturned = result.peers.length;
          this.#tracker.lastError = null;
          for (const peer of result.peers) this.addPeer(peer);
        },
      );
      this.#announceFailures = 0;
      const interval = Math.min(...results.map((r) => r.minInterval ?? r.interval));
      delay = Math.min(Math.max(interval, this.#options.minAnnounceInterval), 3600);
    } catch (err) {
      if (signal.aborted) return;
      this.#tracker.lastError = (err as Error).message;
      const retry = ANNOUNCE_RETRY_DELAYS[Math.min(this.#announceFailures, ANNOUNCE_RETRY_DELAYS.length - 1)];
      this.#announceFailures++;
      delay = Math.max(retry as number, Math.min(this.#options.minAnnounceInterval, 15));
    }
    if (signal.aborted) return;
    this.#announceTimer = setTimeout(() => void this.#announce(), delay * 1000);
  }

  #maintain(): void {
    this.#speedSamples.push(this.#received);
    if (this.#speedSamples.length > SPEED_WINDOW + 1) this.#speedSamples.shift();

    const now = Date.now();
    for (const peer of this.#peers.values()) {
      let expired = false;
      for (const [key, entry] of peer.outstanding) {
        if (now - entry.sentAt > this.#options.requestTimeout) {
          peer.outstanding.delete(key);
          this.picker.release(entry.request);
          expired = true;
        }
      }
      if (expired) this.#fillRequests(peer);
    }
    // Give idle peers work again, e.g. after endgame or a hash failure freed blocks.
    for (const peer of this.#peers.values()) {
      if (peer.outstanding.size === 0) this.#fillRequests(peer);
    }
    this.#connectPeers();
  }

  #connectPeers(): void {
    if (this.state !== 'downloading') return;
    const now = Date.now();
    for (const [key, known] of this.#known) {
      if (this.#peers.size >= this.#options.maxPeers) return;
      if (known.banned || this.#peers.has(key) || known.nextAttempt > now) continue;
      this.#connect(key, known);
    }
  }

  #connect(key: string, known: KnownPeer): void {
    const conn = new PeerConnection(known.host, known.port, {
      infoHash: this.meta.infoHash,
      peerId: this.#options.peerId,
      pieceCount: this.meta.pieceHashes.length,
    });
    const peer: ActivePeer = { conn, outstanding: new Map(), goodPieces: 0, hashFailures: 0 };
    this.#peers.set(key, peer);

    conn.on('ready', () => {
      known.failures = 0;
    });
    conn.on('bitfield', (added) => {
      this.picker.addPeer(added);
      this.#updateInterest(peer);
    });
    conn.on('have', (index) => {
      this.picker.addHave(index);
      if (!this.picker.have.has(index)) conn.interested();
      this.#fillRequests(peer);
    });
    conn.on('unchoke', () => this.#fillRequests(peer));
    conn.on('choke', () => this.#releaseAll(peer));
    conn.on('piece', (index, begin, block) => this.#onBlock(key, peer, index, begin, block));
    conn.on('close', () => {
      this.#releaseAll(peer);
      this.picker.removePeer(conn.bitfield);
      if (this.#peers.get(key) === peer) this.#peers.delete(key);
      if (conn.remotePeerId === null) known.failures++;
      // Back off from peers that keep failing; reconnect sooner to ones that worked.
      known.nextAttempt = Date.now() + Math.min(15_000 * 2 ** known.failures, 600_000);
      if (known.failures >= 5) this.#known.delete(key);
    });
    conn.connect();
  }

  #updateInterest(peer: ActivePeer): void {
    if (this.picker.isInteresting(peer.conn.bitfield)) {
      peer.conn.interested();
      this.#fillRequests(peer);
    } else {
      peer.conn.notInterested();
    }
  }

  #fillRequests(peer: ActivePeer): void {
    const { conn } = peer;
    if (this.state !== 'downloading' || conn.closed || conn.peerChoking || !conn.amInterested) return;
    const room = this.#options.pipeline - peer.outstanding.size;
    if (room <= 0) return;
    const keys = new Set(peer.outstanding.keys());
    const now = Date.now();
    for (const request of this.picker.pick(conn.bitfield, room, keys)) {
      peer.outstanding.set(blockKey(request.index, request.begin), { request, sentAt: now });
      conn.send({ type: 'request', ...request });
    }
  }

  #releaseAll(peer: ActivePeer): void {
    for (const { request } of peer.outstanding.values()) this.picker.release(request);
    peer.outstanding.clear();
  }

  #onBlock(key: string, peer: ActivePeer, index: number, begin: number, block: Buffer): void {
    const bkey = blockKey(index, begin);
    peer.outstanding.delete(bkey);
    const piece = this.picker.receive(index, begin, block);
    if (piece !== undefined) {
      this.#received += block.length;
      let contributors = this.#contributors.get(index);
      if (!contributors) this.#contributors.set(index, (contributors = new Set()));
      contributors.add(key);
      // Endgame: other peers may have the same block in flight; cancel those.
      for (const other of this.#peers.values()) {
        const entry = other.outstanding.get(bkey);
        if (other !== peer && entry) {
          other.outstanding.delete(bkey);
          other.conn.send({ type: 'cancel', ...entry.request });
        }
      }
    }
    if (piece) this.#onPiece(index, piece);
    this.#fillRequests(peer);
  }

  #onPiece(index: number, data: Buffer): void {
    const contributors = this.#contributors.get(index) ?? new Set<string>();
    this.#contributors.delete(index);
    if (!sha1(data).equals(this.meta.pieceHashes[index] as Buffer)) {
      this.picker.reset(index);
      this.#corruptPieces++;
      // Several peers may have sent blocks of the piece, so ban a peer only
      // once its bad pieces clearly outnumber its good ones.
      for (const key of contributors) {
        const peer = this.#peers.get(key);
        if (!peer) continue;
        peer.hashFailures++;
        if (peer.hashFailures >= MAX_HASH_FAILURES && peer.hashFailures > peer.goodPieces) {
          const known = this.#known.get(key);
          if (known) known.banned = true;
          peer.conn.close(new Error('sent too many corrupt pieces'));
        }
      }
      return;
    }
    for (const key of contributors) {
      const peer = this.#peers.get(key);
      if (peer) peer.goodPieces++;
    }
    const write = this.storage.writePiece(index, data).then(
      () => {
        this.#pendingWrites.delete(write);
        if (this.#destroyed) return;
        this.picker.complete(index);
        this.#verifiedBytes += data.length;
        this.emit('piece', index);
        for (const peer of this.#peers.values()) {
          peer.conn.send({ type: 'have', index });
          if (peer.conn.amInterested && !this.picker.isInteresting(peer.conn.bitfield)) {
            peer.conn.notInterested();
          }
        }
        if (this.picker.have.complete) void this.#finish();
      },
      (err: Error) => {
        this.#pendingWrites.delete(write);
        if (!this.#destroyed) this.#fail(new Error(`cannot write to disk: ${err.message}`));
      },
    );
    this.#pendingWrites.add(write);
  }

  async #finish(): Promise<void> {
    if (this.state !== 'downloading' && this.state !== 'paused') return;
    this.#halt('completed');
    await Promise.allSettled(this.#pendingWrites);
    await this.storage.close();
    this.#setState('completed');
    this.emit('done');
  }

  #readyPeers(): number {
    let count = 0;
    for (const peer of this.#peers.values()) if (peer.conn.remotePeerId !== null) count++;
    return count;
  }

  #speed(): number {
    const samples = this.#speedSamples;
    if (this.state !== 'downloading' || samples.length < 2) return 0;
    const first = samples[0] as number;
    const last = samples[samples.length - 1] as number;
    return (last - first) / ((samples.length - 1) * (MAINTENANCE_INTERVAL / 1000));
  }

  #fileStats(): TorrentStats['files'] {
    const counts = this.meta.files.map(() => 0);
    const have = this.picker.have;
    for (let i = 0; i < have.size; i++) {
      if (!have.has(i)) continue;
      for (const seg of mapRange(this.meta.files, i * this.meta.pieceLength, pieceSize(this.meta, i))) {
        counts[seg.fileIndex] = (counts[seg.fileIndex] as number) + seg.length;
      }
    }
    return this.meta.files.map((file, i) => ({
      path: file.path.join('/'),
      size: file.length,
      downloaded: counts[i] as number,
    }));
  }
}

function addressKey(peer: PeerAddress): string {
  return peer.host.includes(':') ? `[${peer.host}]:${peer.port}` : `${peer.host}:${peer.port}`;
}
