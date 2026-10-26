import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bitfield } from '../src/bitfield.ts';
import {
  buildHandshake,
  encodeMessage,
  MessageReader,
  ProtocolError,
  type Message,
} from '../src/peer/protocol.ts';

const infoHash = Buffer.alloc(20, 0xab);
const peerId = Buffer.from('-RT1000-abcdefghijkl');

describe('peer wire messages', () => {
  it('builds a 68-byte handshake', () => {
    const hs = buildHandshake(infoHash, peerId);
    assert.equal(hs.length, 68);
    assert.equal(hs[0], 19);
    assert.equal(hs.subarray(1, 20).toString(), 'BitTorrent protocol');
    assert.ok(hs.subarray(28, 48).equals(infoHash));
    assert.ok(hs.subarray(48).equals(peerId));
  });

  it('encodes messages with a length prefix and id', () => {
    assert.deepEqual([...encodeMessage({ type: 'interested' })], [0, 0, 0, 1, 2]);
    assert.deepEqual([...encodeMessage({ type: 'have', index: 258 })], [0, 0, 0, 5, 4, 0, 0, 1, 2]);
    assert.deepEqual(
      [...encodeMessage({ type: 'request', index: 1, begin: 16384, length: 16384 })],
      [0, 0, 0, 13, 6, 0, 0, 0, 1, 0, 0, 64, 0, 0, 0, 64, 0],
    );
    assert.deepEqual([...encodeMessage({ type: 'keep-alive' })], [0, 0, 0, 0]);
  });

  it('reassembles a handshake and messages split at every possible byte', () => {
    const messages: Message[] = [
      { type: 'bitfield', bitfield: Buffer.from([0b10100000]) },
      { type: 'unchoke' },
      { type: 'keep-alive' },
      { type: 'piece', index: 3, begin: 0, block: Buffer.from('hello block') },
      { type: 'have', index: 7 },
    ];
    const stream = Buffer.concat([buildHandshake(infoHash, peerId), ...messages.map(encodeMessage)]);
    for (let split = 1; split < stream.length; split++) {
      const reader = new MessageReader();
      const items = [...reader.push(stream.subarray(0, split)), ...reader.push(stream.subarray(split))];
      assert.equal(items.length, 6, `split at ${split}`);
      assert.ok('infoHash' in items[0]! && items[0].peerId.equals(peerId));
      assert.deepEqual(items.slice(1), messages);
    }
  });

  it('rejects a peer that is not speaking BitTorrent', () => {
    assert.throws(() => new MessageReader().push(Buffer.from('GET / HTTP/1.1\r\n')), ProtocolError);
  });

  it('rejects oversized messages instead of buffering them', () => {
    const reader = new MessageReader();
    reader.push(buildHandshake(infoHash, peerId));
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(64 * 1024 * 1024, 0);
    assert.throws(() => reader.push(huge), /too large/);
  });

  it('rejects messages whose payload has the wrong size', () => {
    const reader = new MessageReader();
    reader.push(buildHandshake(infoHash, peerId));
    assert.throws(() => reader.push(Buffer.from([0, 0, 0, 2, 4, 0])), /bad length/);
  });
});

describe('Bitfield', () => {
  it('uses the high bit of the first byte for piece 0 and ignores spare bits', () => {
    const bf = new Bitfield(10, Buffer.from([0b10000000, 0b01111111]));
    assert.ok(bf.has(0));
    assert.ok(bf.has(9));
    assert.equal(bf.count, 2);
    assert.equal(bf.buffer[1], 0b01000000);
  });

  it('tracks count and completeness', () => {
    const bf = new Bitfield(3);
    bf.set(0);
    bf.set(0);
    bf.set(2);
    assert.equal(bf.count, 2);
    assert.equal(bf.complete, false);
    bf.set(1);
    assert.equal(bf.complete, true);
    bf.clear(1);
    assert.equal(bf.count, 2);
  });
});
