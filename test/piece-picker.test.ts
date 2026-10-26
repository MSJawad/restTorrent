import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bitfield } from '../src/bitfield.ts';
import { BLOCK_SIZE, blockKey, PiecePicker, type BlockRequest } from '../src/piece-picker.ts';

function peerWith(size: number, pieces: number[]): Bitfield {
  const bf = new Bitfield(size);
  for (const i of pieces) bf.set(i);
  return bf;
}

const keys = (requests: BlockRequest[]) => new Set(requests.map((r) => blockKey(r.index, r.begin)));

describe('PiecePicker', () => {
  // 4 pieces of 2 blocks each; the last piece is one partial block.
  const layout = { pieceCount: 4, pieceLength: 2 * BLOCK_SIZE, length: 3 * 2 * BLOCK_SIZE + 100 };

  it('splits pieces into blocks, with a short final block', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    const all = peerWith(4, [0, 1, 2, 3]);
    picker.addPeer(all);
    const requests = picker.pick(all, 100, new Set());
    assert.equal(requests.length, 7);
    const last = requests.find((r) => r.index === 3);
    assert.deepEqual(last, { index: 3, begin: 0, length: 100 });
  });

  it('picks the rarest piece first', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    picker.addPeer(peerWith(4, [0, 1, 2, 3]));
    picker.addPeer(peerWith(4, [0, 1, 3]));
    picker.addPeer(peerWith(4, [0, 3]));
    // Availability: 0 -> 3, 1 -> 2, 2 -> 1, 3 -> 3
    const requests = picker.pick(peerWith(4, [0, 1, 2, 3]), 2, new Set());
    assert.deepEqual(
      requests.map((r) => r.index),
      [2, 2],
    );
    const next = picker.pick(peerWith(4, [0, 1, 2, 3]), 2, new Set());
    assert.deepEqual(
      next.map((r) => r.index),
      [1, 1],
    );
  });

  it('only picks pieces the peer has and we lack', () => {
    const have = new Bitfield(4);
    have.set(1);
    const picker = new PiecePicker(layout, have);
    const requests = picker.pick(peerWith(4, [1, 2]), 10, new Set());
    assert.deepEqual([...new Set(requests.map((r) => r.index))], [2]);
  });

  it('finishes pieces in progress before starting new ones', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    const peer = peerWith(4, [0, 1, 2]);
    const [first] = picker.pick(peer, 1, new Set());
    const [second] = picker.pick(peer, 1, new Set());
    assert.equal(second?.index, first?.index);
    assert.equal(second?.begin, BLOCK_SIZE);
  });

  it('returns released blocks to the pool', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    const peer = peerWith(4, [0]);
    const requests = picker.pick(peer, 10, new Set());
    assert.equal(requests.length, 2);
    assert.equal(picker.pick(peer, 10, keys(requests)).length, 0);
    picker.release(requests[1]!);
    assert.deepEqual(picker.pick(peer, 10, new Set()), [requests[1]]);
  });

  it('assembles a piece and resets it after a failed hash check', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    const peer = peerWith(4, [0]);
    const [a, b] = picker.pick(peer, 10, new Set());
    assert.equal(picker.receive(0, a!.begin, Buffer.alloc(BLOCK_SIZE, 1)), null);
    assert.equal(picker.receive(0, a!.begin, Buffer.alloc(BLOCK_SIZE, 1)), undefined, 'duplicate');
    assert.equal(picker.receive(0, 5, Buffer.alloc(BLOCK_SIZE)), undefined, 'misaligned');
    const piece = picker.receive(0, b!.begin, Buffer.alloc(BLOCK_SIZE, 2));
    assert.equal(piece?.length, 2 * BLOCK_SIZE);
    picker.reset(0);
    assert.equal(picker.pick(peer, 10, new Set()).length, 2, 'piece is requested again');
    picker.complete(0);
    assert.ok(picker.have.has(0));
  });

  it('requests every unfinished piece again after being cleared', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    const peer = peerWith(4, [0, 1]);
    const requests = picker.pick(peer, 10, new Set());
    assert.equal(requests.length, 4);
    for (const r of requests.filter((r) => r.index === 0)) picker.receive(0, r.begin, Buffer.alloc(BLOCK_SIZE));
    assert.equal(picker.pick(peer, 10, new Set()).length, 0, 'everything is in flight or received');
    picker.clear();
    assert.deepEqual(keys(picker.pick(peer, 10, new Set())), keys(requests));
  });

  it('duplicates in-flight requests across peers in endgame mode, never to the same peer twice', () => {
    const small = { pieceCount: 1, pieceLength: 2 * BLOCK_SIZE, length: 2 * BLOCK_SIZE };
    const picker = new PiecePicker(small, new Bitfield(1));
    const peer = peerWith(1, [0]);
    const first = picker.pick(peer, 10, new Set());
    assert.equal(first.length, 2);
    // The same peer gets nothing more: every block is already in flight to it.
    assert.equal(picker.pick(peer, 10, keys(first)).length, 0);
    // Another peer races for the same blocks.
    const second = picker.pick(peer, 10, new Set());
    assert.deepEqual(second, first);
  });

  it('does not enter endgame while unrequested blocks remain', () => {
    const picker = new PiecePicker(layout, new Bitfield(4));
    const onlyFirst = peerWith(4, [0]);
    const first = picker.pick(onlyFirst, 10, new Set());
    assert.equal(picker.pick(onlyFirst, 10, keys(first)).length, 0);
    assert.equal(picker.pick(onlyFirst, 10, new Set()).length, 0, 'other pieces are still unrequested');
  });

  it('says whether a peer has anything we need', () => {
    const have = new Bitfield(4);
    have.set(0);
    const picker = new PiecePicker(layout, have);
    assert.equal(picker.isInteresting(peerWith(4, [0])), false);
    assert.equal(picker.isInteresting(peerWith(4, [0, 3])), true);
  });
});
