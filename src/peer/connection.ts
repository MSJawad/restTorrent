// One TCP connection to a remote peer: handshake, choke/interest state, and
// typed events for each incoming message.

import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { Bitfield } from '../bitfield.ts';
import {
  buildHandshake,
  encodeMessage,
  MessageReader,
  ProtocolError,
  type Handshake,
  type Message,
} from './protocol.ts';

export interface PeerConnectionOptions {
  infoHash: Buffer;
  peerId: Buffer;
  pieceCount: number;
  connectTimeout?: number;
  /** Close the connection when the peer sends nothing for this long. */
  idleTimeout?: number;
}

type PeerEvents = {
  ready: [];
  /** Carries only the pieces that were not already known from earlier messages. */
  bitfield: [added: Bitfield];
  have: [index: number];
  choke: [];
  unchoke: [];
  piece: [index: number, begin: number, block: Buffer];
  /** The error is null when close() was called locally rather than caused by the peer or the network. */
  close: [error: Error | null];
};

const KEEP_ALIVE_INTERVAL = 90_000;

export class PeerConnection extends EventEmitter<PeerEvents> {
  readonly host: string;
  readonly port: number;
  readonly bitfield: Bitfield;
  remotePeerId: Buffer | null = null;

  amInterested = false;
  peerChoking = true;
  /** Bytes of piece data received from this peer, for speed and stats. */
  downloaded = 0;

  #socket: Socket | null = null;
  #reader = new MessageReader();
  #options: Required<PeerConnectionOptions>;
  #closed = false;
  #idleTimer: NodeJS.Timeout | null = null;
  #keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(host: string, port: number, options: PeerConnectionOptions) {
    super();
    this.host = host;
    this.port = port;
    this.bitfield = new Bitfield(options.pieceCount);
    this.#options = { connectTimeout: 10_000, idleTimeout: 120_000, ...options };
  }

  get address(): string {
    return this.host.includes(':') ? `[${this.host}]:${this.port}` : `${this.host}:${this.port}`;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Opens the connection and sends our handshake. Emits `ready` once the peer's handshake checks out. */
  connect(): void {
    const socket = connect({ host: this.host, port: this.port });
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.#options.connectTimeout, () => {
      this.close(new Error('connection timed out'));
    });
    socket.on('connect', () => {
      socket.write(buildHandshake(this.#options.infoHash, this.#options.peerId));
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => this.close(err));
    socket.on('close', () => this.close(new Error('connection closed by peer')));
  }

  send(message: Message): void {
    if (this.#closed || !this.#socket) return;
    this.#socket.write(encodeMessage(message));
  }

  interested(): void {
    if (this.amInterested) return;
    this.amInterested = true;
    this.send({ type: 'interested' });
  }

  notInterested(): void {
    if (!this.amInterested) return;
    this.amInterested = false;
    this.send({ type: 'not-interested' });
  }

  close(error: Error | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#keepAliveTimer) clearInterval(this.#keepAliveTimer);
    this.#socket?.destroy();
    this.emit('close', error);
  }

  #onData(chunk: Buffer): void {
    this.#resetIdle();
    let items: Array<Handshake | Message>;
    try {
      items = this.#reader.push(chunk);
    } catch (err) {
      this.close(err as Error);
      return;
    }
    for (const item of items) {
      if (this.#closed) return;
      try {
        if ('infoHash' in item) this.#onHandshake(item);
        else this.#onMessage(item);
      } catch (err) {
        this.close(err as Error);
      }
    }
  }

  #onHandshake(handshake: Handshake): void {
    if (!handshake.infoHash.equals(this.#options.infoHash)) {
      throw new ProtocolError('peer is serving a different torrent');
    }
    this.remotePeerId = handshake.peerId;
    // Connected and greeted: from here on, only the idle timeout applies.
    this.#socket?.setTimeout(0);
    this.#keepAliveTimer = setInterval(() => this.send({ type: 'keep-alive' }), KEEP_ALIVE_INTERVAL);
    this.#keepAliveTimer.unref();
    this.emit('ready');
  }

  #onMessage(message: Message): void {
    if (this.remotePeerId === null) throw new ProtocolError('message before handshake');
    switch (message.type) {
      case 'choke':
        this.peerChoking = true;
        this.emit('choke');
        break;
      case 'unchoke':
        this.peerChoking = false;
        this.emit('unchoke');
        break;
      case 'have':
        if (message.index >= this.bitfield.size) throw new ProtocolError('have index out of range');
        if (!this.bitfield.has(message.index)) {
          this.bitfield.set(message.index);
          this.emit('have', message.index);
        }
        break;
      case 'bitfield': {
        if (message.bitfield.length !== this.bitfield.buffer.length) {
          throw new ProtocolError('bitfield has the wrong length');
        }
        const incoming = new Bitfield(this.bitfield.size, message.bitfield);
        const added = new Bitfield(this.bitfield.size);
        for (let i = 0; i < incoming.size; i++) {
          if (incoming.has(i) && !this.bitfield.has(i)) {
            this.bitfield.set(i);
            added.set(i);
          }
        }
        this.emit('bitfield', added);
        break;
      }
      case 'piece':
        this.downloaded += message.block.length;
        this.emit('piece', message.index, message.begin, message.block);
        break;
      default:
        // keep-alive, interested, request, cancel and unknown messages need no
        // action: this client downloads only, so it keeps peers choked.
        break;
    }
  }

  #resetIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close(new Error('peer idle')), this.#options.idleTimeout);
    this.#idleTimer.unref();
  }
}
