// Decides which blocks to request from which peer.
//
// Pieces are split into 16 KiB blocks, the unit peers transfer. The picker
// prefers finishing pieces already in progress, then starts the rarest piece
// the peer has (rarest-first spreads pieces through the swarm and avoids
// waiting on the one peer that has a scarce piece at the very end). Once every
// missing block is requested, it enters endgame mode and lets several peers
// race for the remaining blocks.

import { Bitfield } from './bitfield.ts';

export const BLOCK_SIZE = 16 * 1024;

export interface BlockRequest {
  index: number;
  begin: number;
  length: number;
}

export function blockKey(index: number, begin: number): string {
  return `${index}:${begin}`;
}

const MISSING = 0;
const REQUESTED = 1;
const RECEIVED = 2;

class PieceProgress {
  readonly index: number;
  readonly length: number;
  readonly data: Buffer;
  /** MISSING, REQUESTED or RECEIVED for each block. */
  readonly state: Uint8Array;
  /** How many peers currently have each block requested. */
  readonly requests: Uint16Array;
  received = 0;

  constructor(index: number, length: number) {
    this.index = index;
    this.length = length;
    this.data = Buffer.alloc(length);
    const blocks = Math.ceil(length / BLOCK_SIZE);
    this.state = new Uint8Array(blocks);
    this.requests = new Uint16Array(blocks);
  }

  get blocks(): number {
    return this.state.length;
  }

  request(block: number): BlockRequest {
    this.state[block] = REQUESTED;
    this.requests[block] = (this.requests[block] as number) + 1;
    const begin = block * BLOCK_SIZE;
    return { index: this.index, begin, length: Math.min(BLOCK_SIZE, this.length - begin) };
  }
}

export interface PickerLayout {
  pieceCount: number;
  pieceLength: number;
  length: number;
}

export class PiecePicker {
  readonly have: Bitfield;
  readonly availability: Uint32Array;
  #layout: PickerLayout;
  #active = new Map<number, PieceProgress>();

  constructor(layout: PickerLayout, have: Bitfield) {
    this.#layout = layout;
    this.have = have;
    this.availability = new Uint32Array(layout.pieceCount);
  }

  pieceLength(index: number): number {
    if (index === this.#layout.pieceCount - 1) {
      return this.#layout.length - this.#layout.pieceLength * index;
    }
    return this.#layout.pieceLength;
  }

  addPeer(bitfield: Bitfield): void {
    for (let i = 0; i < bitfield.size; i++) {
      if (bitfield.has(i)) this.availability[i] = (this.availability[i] as number) + 1;
    }
  }

  removePeer(bitfield: Bitfield): void {
    for (let i = 0; i < bitfield.size; i++) {
      if (bitfield.has(i) && (this.availability[i] as number) > 0) {
        this.availability[i] = (this.availability[i] as number) - 1;
      }
    }
  }

  addHave(index: number): void {
    this.availability[index] = (this.availability[index] as number) + 1;
  }

  /** True when the peer has at least one piece we still need. */
  isInteresting(peer: Bitfield): boolean {
    for (let i = 0; i < peer.size; i++) if (peer.has(i) && !this.have.has(i)) return true;
    return false;
  }

  /**
   * Picks up to `max` blocks to request from a peer. `outstanding` holds the
   * peer's current requests (as blockKey strings) so endgame mode never asks
   * the same peer twice for one block.
   */
  pick(peer: Bitfield, max: number, outstanding: ReadonlySet<string>): BlockRequest[] {
    const picked: BlockRequest[] = [];
    // 1. Unrequested blocks of pieces already in progress, most complete first.
    const active = [...this.#active.values()]
      .filter((p) => peer.has(p.index))
      .sort((a, b) => b.received / b.blocks - a.received / a.blocks);
    for (const piece of active) {
      for (let b = 0; b < piece.blocks && picked.length < max; b++) {
        if (piece.state[b] === MISSING) picked.push(piece.request(b));
      }
    }
    // 2. Start new pieces, rarest first.
    while (picked.length < max) {
      const index = this.#rarestNewPiece(peer);
      if (index === -1) break;
      const piece = new PieceProgress(index, this.pieceLength(index));
      this.#active.set(index, piece);
      for (let b = 0; b < piece.blocks && picked.length < max; b++) picked.push(piece.request(b));
    }
    // 3. Endgame: nothing left to start, so duplicate requests that are still in flight.
    if (picked.length < max && this.#allRequested()) {
      const mine = new Set(outstanding);
      for (const request of picked) mine.add(blockKey(request.index, request.begin));
      for (const piece of this.#active.values()) {
        if (!peer.has(piece.index)) continue;
        for (let b = 0; b < piece.blocks && picked.length < max; b++) {
          const key = blockKey(piece.index, b * BLOCK_SIZE);
          if (piece.state[b] === REQUESTED && !mine.has(key)) {
            picked.push(piece.request(b));
            mine.add(key);
          }
        }
      }
    }
    return picked;
  }

  /** Releases a request that will not be answered (peer choked, disconnected or timed out). */
  release(request: BlockRequest): void {
    const piece = this.#active.get(request.index);
    if (!piece) return;
    const b = request.begin / BLOCK_SIZE;
    if (piece.state[b] !== REQUESTED) return;
    piece.requests[b] = Math.max(0, (piece.requests[b] as number) - 1);
    if (piece.requests[b] === 0) piece.state[b] = MISSING;
  }

  /**
   * Stores a received block. Returns the whole piece once its last block
   * arrives, `null` while the piece is still incomplete, and `undefined` for
   * a block that was not wanted (duplicate, or never requested).
   */
  receive(index: number, begin: number, block: Buffer): Buffer | null | undefined {
    const piece = this.#active.get(index);
    if (!piece || begin % BLOCK_SIZE !== 0) return undefined;
    const b = begin / BLOCK_SIZE;
    const expected = Math.min(BLOCK_SIZE, piece.length - begin);
    if (b >= piece.blocks || block.length !== expected || piece.state[b] === RECEIVED) return undefined;
    block.copy(piece.data, begin);
    piece.state[b] = RECEIVED;
    piece.requests[b] = 0;
    piece.received++;
    return piece.received === piece.blocks ? piece.data : null;
  }

  /** Marks a verified piece as done. */
  complete(index: number): void {
    this.#active.delete(index);
    this.have.set(index);
  }

  /** Throws away a piece that failed its hash check so it is downloaded again. */
  reset(index: number): void {
    this.#active.delete(index);
  }

  #rarestNewPiece(peer: Bitfield): number {
    let best = -1;
    let bestAvailability = Infinity;
    let ties = 0;
    for (let i = 0; i < this.#layout.pieceCount; i++) {
      if (this.have.has(i) || this.#active.has(i) || !peer.has(i)) continue;
      const availability = this.availability[i] as number;
      if (availability < bestAvailability) {
        best = i;
        bestAvailability = availability;
        ties = 1;
      } else if (availability === bestAvailability) {
        // Reservoir sampling breaks ties at random, so peers spread out.
        ties++;
        if (Math.random() * ties < 1) best = i;
      }
    }
    return best;
  }

  #allRequested(): boolean {
    if (this.have.count + this.#active.size < this.#layout.pieceCount) return false;
    for (const piece of this.#active.values()) {
      if (piece.state.includes(MISSING)) return false;
    }
    return true;
  }
}
