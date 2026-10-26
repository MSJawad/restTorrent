import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BencodeError, decode, decodeDictWithSpans, encode } from '../src/bencode.ts';

const b = (s: string) => Buffer.from(s, 'latin1');

describe('bencode decode', () => {
  it('decodes integers', () => {
    assert.equal(decode(b('i42e')), 42);
    assert.equal(decode(b('i0e')), 0);
    assert.equal(decode(b('i-7e')), -7);
    assert.equal(decode(b('i9007199254740991e')), Number.MAX_SAFE_INTEGER);
  });

  it('rejects malformed integers', () => {
    for (const bad of ['i-0e', 'i03e', 'ie', 'i1.5e', 'i12', 'i--1e', 'i9007199254740992e']) {
      assert.throws(() => decode(b(bad)), BencodeError, bad);
    }
  });

  it('decodes byte strings as Buffers, including binary data', () => {
    assert.deepEqual(decode(b('4:spam')), b('spam'));
    assert.deepEqual(decode(b('0:')), b(''));
    const binary = Buffer.concat([b('3:'), Buffer.from([0, 255, 10])]);
    assert.deepEqual(decode(binary), Buffer.from([0, 255, 10]));
  });

  it('rejects truncated or malformed strings', () => {
    for (const bad of ['5:spam', '4spam', '-1:a', '01:a', ':a']) {
      assert.throws(() => decode(b(bad)), BencodeError, bad);
    }
  });

  it('decodes lists and dictionaries', () => {
    assert.deepEqual(decode(b('l4:spami42ee')), [b('spam'), 42]);
    const dict = decode(b('d3:bar4:spam3:fooi42ee')) as Record<string, unknown>;
    assert.deepEqual({ ...dict }, { bar: b('spam'), foo: 42 });
    assert.deepEqual(decode(b('le')), []);
    assert.deepEqual({ ...(decode(b('de')) as object) }, {});
  });

  it('does not let keys like __proto__ touch the prototype', () => {
    const dict = decode(b('d9:__proto__i1ee')) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(dict), null);
    assert.equal(dict.__proto__, 1);
  });

  it('rejects trailing data, unterminated containers and unknown bytes', () => {
    for (const bad of ['i1ei2e', 'l', 'li1e', 'd3:foo', 'd3:fooe', 'x', '']) {
      assert.throws(() => decode(b(bad)), BencodeError, JSON.stringify(bad));
    }
  });

  it('limits nesting depth instead of overflowing the stack', () => {
    assert.throws(() => decode(b('l'.repeat(10_000) + 'e'.repeat(10_000))), /nesting too deep/);
  });
});

describe('bencode encode', () => {
  it('encodes every type', () => {
    assert.equal(encode(42).toString(), 'i42e');
    assert.equal(encode(-3).toString(), 'i-3e');
    assert.equal(encode('spam').toString(), '4:spam');
    assert.equal(encode([b('a'), 1]).toString(), 'l1:ai1ee');
  });

  it('sorts dictionary keys by raw bytes', () => {
    assert.equal(encode({ zeta: 1, alpha: 2, Beta: 3 }).toString(), 'd4:Betai3e5:alphai2e4:zetai1ee');
  });

  it('rejects non-integer numbers', () => {
    assert.throws(() => encode(1.5), BencodeError);
  });

  it('round-trips nested values', () => {
    const value = { list: [1, b('two'), { three: [b('\u0000ÿ')] }], n: 0 };
    const encoded = encode(value);
    assert.deepEqual(encode(decode(encoded)), encoded);
  });
});

describe('decodeDictWithSpans', () => {
  it('returns the byte range of each top-level value', () => {
    const data = b('d4:infod1:ai1ee4:name3:fooe');
    const { dict, spans } = decodeDictWithSpans(data);
    assert.ok(dict.info);
    const [start, end] = spans.get('info')!;
    assert.equal(data.subarray(start, end).toString(), 'd1:ai1ee');
  });
});
