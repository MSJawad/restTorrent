// BitTorrent peer wire protocol messages (BEP 3).

const PROTOCOL = Buffer.from('BitTorrent protocol', 'latin1');
export const HANDSHAKE_LENGTH = 49 + PROTOCOL.length;
/** Large enough for a 16 KiB block or the bitfield of a torrent with 8 million pieces. */
export const MAX_MESSAGE_LENGTH = 1 << 20;

export const MessageId = {
  Choke: 0,
  Unchoke: 1,
  Interested: 2,
  NotInterested: 3,
  Have: 4,
  Bitfield: 5,
  Request: 6,
  Piece: 7,
  Cancel: 8,
  Port: 9,
} as const;

export type Message =
  | { type: 'keep-alive' }
  | { type: 'choke' }
  | { type: 'unchoke' }
  | { type: 'interested' }
  | { type: 'not-interested' }
  | { type: 'have'; index: number }
  | { type: 'bitfield'; bitfield: Buffer }
  | { type: 'request'; index: number; begin: number; length: number }
  | { type: 'piece'; index: number; begin: number; block: Buffer }
  | { type: 'cancel'; index: number; begin: number; length: number }
  | { type: 'unknown'; id: number; payload: Buffer };

export interface Handshake {
  infoHash: Buffer;
  peerId: Buffer;
  reserved: Buffer;
}

export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

export function buildHandshake(infoHash: Buffer, peerId: Buffer): Buffer {
  const buf = Buffer.alloc(HANDSHAKE_LENGTH);
  buf.writeUInt8(PROTOCOL.length, 0);
  PROTOCOL.copy(buf, 1);
  // 8 reserved bytes stay zero: no protocol extensions are advertised.
  infoHash.copy(buf, 28);
  peerId.copy(buf, 48);
  return buf;
}

export function parseHandshake(buf: Buffer): Handshake {
  if (buf.length < HANDSHAKE_LENGTH || buf[0] !== PROTOCOL.length) {
    throw new ProtocolError('invalid handshake');
  }
  if (!buf.subarray(1, 20).equals(PROTOCOL)) throw new ProtocolError('peer does not speak BitTorrent');
  return {
    reserved: Buffer.from(buf.subarray(20, 28)),
    infoHash: Buffer.from(buf.subarray(28, 48)),
    peerId: Buffer.from(buf.subarray(48, 68)),
  };
}

export function encodeMessage(message: Message): Buffer {
  switch (message.type) {
    case 'keep-alive':
      return Buffer.alloc(4);
    case 'choke':
      return simple(MessageId.Choke);
    case 'unchoke':
      return simple(MessageId.Unchoke);
    case 'interested':
      return simple(MessageId.Interested);
    case 'not-interested':
      return simple(MessageId.NotInterested);
    case 'have': {
      const buf = header(MessageId.Have, 4);
      buf.writeUInt32BE(message.index, 5);
      return buf;
    }
    case 'bitfield': {
      const buf = header(MessageId.Bitfield, message.bitfield.length);
      message.bitfield.copy(buf, 5);
      return buf;
    }
    case 'request':
    case 'cancel': {
      const buf = header(message.type === 'request' ? MessageId.Request : MessageId.Cancel, 12);
      buf.writeUInt32BE(message.index, 5);
      buf.writeUInt32BE(message.begin, 9);
      buf.writeUInt32BE(message.length, 13);
      return buf;
    }
    case 'piece': {
      const buf = header(MessageId.Piece, 8 + message.block.length);
      buf.writeUInt32BE(message.index, 5);
      buf.writeUInt32BE(message.begin, 9);
      message.block.copy(buf, 13);
      return buf;
    }
    case 'unknown': {
      const buf = header(message.id, message.payload.length);
      message.payload.copy(buf, 5);
      return buf;
    }
  }
}

function header(id: number, payloadLength: number): Buffer {
  const buf = Buffer.alloc(5 + payloadLength);
  buf.writeUInt32BE(1 + payloadLength, 0);
  buf.writeUInt8(id, 4);
  return buf;
}

function simple(id: number): Buffer {
  return header(id, 0);
}

/** Decodes one message body (everything after the 4-byte length prefix). */
export function decodeMessage(body: Buffer): Message {
  if (body.length === 0) return { type: 'keep-alive' };
  const id = body[0] as number;
  const payload = body.subarray(1);
  const need = (length: number) => {
    if (payload.length !== length) throw new ProtocolError(`message ${id} has bad length`);
  };
  switch (id) {
    case MessageId.Choke:
      need(0);
      return { type: 'choke' };
    case MessageId.Unchoke:
      need(0);
      return { type: 'unchoke' };
    case MessageId.Interested:
      need(0);
      return { type: 'interested' };
    case MessageId.NotInterested:
      need(0);
      return { type: 'not-interested' };
    case MessageId.Have:
      need(4);
      return { type: 'have', index: payload.readUInt32BE(0) };
    case MessageId.Bitfield:
      return { type: 'bitfield', bitfield: Buffer.from(payload) };
    case MessageId.Request:
    case MessageId.Cancel:
      need(12);
      return {
        type: id === MessageId.Request ? 'request' : 'cancel',
        index: payload.readUInt32BE(0),
        begin: payload.readUInt32BE(4),
        length: payload.readUInt32BE(8),
      };
    case MessageId.Piece:
      if (payload.length < 8) throw new ProtocolError('piece message too short');
      return {
        type: 'piece',
        index: payload.readUInt32BE(0),
        begin: payload.readUInt32BE(4),
        block: Buffer.from(payload.subarray(8)),
      };
    default:
      return { type: 'unknown', id, payload: Buffer.from(payload) };
  }
}

/**
 * Splits a TCP byte stream into the handshake followed by length-prefixed
 * messages, however the bytes happen to be chunked.
 */
export class MessageReader {
  #chunks: Buffer[] = [];
  #buffered = 0;
  #handshakeDone = false;

  /** Feeds bytes in and returns every complete item now available. */
  push(chunk: Buffer): Array<Handshake | Message> {
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    const out: Array<Handshake | Message> = [];
    for (;;) {
      if (!this.#handshakeDone) {
        if (this.#buffered < 1) break;
        const first = this.#peek(1)[0] as number;
        if (first !== PROTOCOL.length) throw new ProtocolError('invalid handshake');
        if (this.#buffered < HANDSHAKE_LENGTH) break;
        out.push(parseHandshake(this.#take(HANDSHAKE_LENGTH)));
        this.#handshakeDone = true;
        continue;
      }
      if (this.#buffered < 4) break;
      const length = this.#peek(4).readUInt32BE(0);
      if (length > MAX_MESSAGE_LENGTH) throw new ProtocolError(`message too large (${length} bytes)`);
      if (this.#buffered < 4 + length) break;
      this.#take(4);
      out.push(decodeMessage(this.#take(length)));
    }
    return out;
  }

  #peek(length: number): Buffer {
    if ((this.#chunks[0] as Buffer).length < length) {
      this.#chunks = [Buffer.concat(this.#chunks)];
    }
    return (this.#chunks[0] as Buffer).subarray(0, length);
  }

  #take(length: number): Buffer {
    if (length === 0) return Buffer.alloc(0); // keep-alive body; there may be no chunk left
    const out = Buffer.from(this.#peek(length));
    const first = this.#chunks[0] as Buffer;
    if (first.length === length) this.#chunks.shift();
    else this.#chunks[0] = first.subarray(length);
    this.#buffered -= length;
    return out;
  }
}
