// Bencode (BEP 3) encoder and decoder.
//
// Byte strings decode to Buffers because torrent files mix text with raw
// binary (piece hashes, compact peer lists). Integers decode to numbers and
// are rejected when they fall outside the safe integer range.

export type BencodeValue = number | Buffer | BencodeValue[] | BencodeDict;
export interface BencodeDict {
  [key: string]: BencodeValue;
}

export class BencodeError extends Error {
  override name = 'BencodeError';
}

const MAX_DEPTH = 64;

const CHAR_I = 0x69; // i
const CHAR_L = 0x6c; // l
const CHAR_D = 0x64; // d
const CHAR_E = 0x65; // e
const CHAR_COLON = 0x3a; // :
const CHAR_0 = 0x30;
const CHAR_9 = 0x39;

interface Decoded {
  value: BencodeValue;
  end: number;
}

export function decode(buf: Buffer): BencodeValue {
  const { value, end } = decodeAt(buf, 0, 0);
  if (end !== buf.length) {
    throw new BencodeError(`unexpected trailing data at offset ${end}`);
  }
  return value;
}

/**
 * Decodes a top-level dictionary and also returns the byte range of each of
 * its values in the input. The info hash must be computed over the original
 * bytes of the info dictionary, not over a re-encoding of it.
 */
export function decodeDictWithSpans(buf: Buffer): {
  dict: BencodeDict;
  spans: Map<string, [number, number]>;
} {
  if (buf[0] !== CHAR_D) {
    throw new BencodeError('expected a dictionary at offset 0');
  }
  const dict: BencodeDict = Object.create(null);
  const spans = new Map<string, [number, number]>();
  let pos = 1;
  while (buf[pos] !== CHAR_E) {
    if (pos >= buf.length) throw new BencodeError('unterminated dictionary');
    const key = decodeString(buf, pos);
    const keyText = key.value.toString('utf8');
    const value = decodeAt(buf, key.end, 1);
    dict[keyText] = value.value;
    spans.set(keyText, [key.end, value.end]);
    pos = value.end;
  }
  if (pos + 1 !== buf.length) {
    throw new BencodeError(`unexpected trailing data at offset ${pos + 1}`);
  }
  return { dict, spans };
}

function decodeAt(buf: Buffer, pos: number, depth: number): Decoded {
  if (depth > MAX_DEPTH) throw new BencodeError('nesting too deep');
  const c = buf[pos];
  if (c === undefined) throw new BencodeError(`unexpected end of data at offset ${pos}`);
  if (c === CHAR_I) return decodeInteger(buf, pos);
  if (c >= CHAR_0 && c <= CHAR_9) return decodeString(buf, pos);
  if (c === CHAR_L) {
    const list: BencodeValue[] = [];
    pos++;
    while (buf[pos] !== CHAR_E) {
      if (pos >= buf.length) throw new BencodeError('unterminated list');
      const item = decodeAt(buf, pos, depth + 1);
      list.push(item.value);
      pos = item.end;
    }
    return { value: list, end: pos + 1 };
  }
  if (c === CHAR_D) {
    const dict: BencodeDict = Object.create(null);
    pos++;
    while (buf[pos] !== CHAR_E) {
      if (pos >= buf.length) throw new BencodeError('unterminated dictionary');
      const key = decodeString(buf, pos);
      const value = decodeAt(buf, key.end, depth + 1);
      dict[key.value.toString('utf8')] = value.value;
      pos = value.end;
    }
    return { value: dict, end: pos + 1 };
  }
  throw new BencodeError(`unexpected byte 0x${c.toString(16)} at offset ${pos}`);
}

function decodeInteger(buf: Buffer, pos: number): { value: number; end: number } {
  const end = buf.indexOf(CHAR_E, pos + 1);
  if (end === -1) throw new BencodeError(`unterminated integer at offset ${pos}`);
  const text = buf.toString('latin1', pos + 1, end);
  if (!/^(0|-?[1-9][0-9]*)$/.test(text)) {
    throw new BencodeError(`invalid integer "${text}" at offset ${pos}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new BencodeError(`integer ${text} at offset ${pos} is out of range`);
  }
  return { value, end: end + 1 };
}

function decodeString(buf: Buffer, pos: number): { value: Buffer; end: number } {
  const colon = buf.indexOf(CHAR_COLON, pos);
  if (colon === -1) throw new BencodeError(`invalid string length at offset ${pos}`);
  const text = buf.toString('latin1', pos, colon);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new BencodeError(`invalid string length "${text}" at offset ${pos}`);
  }
  const length = Number(text);
  const start = colon + 1;
  if (start + length > buf.length) {
    throw new BencodeError(`string at offset ${pos} runs past the end of the data`);
  }
  return { value: buf.subarray(start, start + length), end: start + length };
}

export function encode(value: BencodeValue | string): Buffer {
  const parts: Buffer[] = [];
  encodeInto(value, parts);
  return Buffer.concat(parts);
}

function encodeInto(value: BencodeValue | string, parts: Buffer[]): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new BencodeError(`cannot encode non-integer ${value}`);
    parts.push(Buffer.from(`i${value}e`, 'latin1'));
  } else if (typeof value === 'string') {
    encodeInto(Buffer.from(value, 'utf8'), parts);
  } else if (Buffer.isBuffer(value)) {
    parts.push(Buffer.from(`${value.length}:`, 'latin1'), value);
  } else if (Array.isArray(value)) {
    parts.push(Buffer.from('l', 'latin1'));
    for (const item of value) encodeInto(item, parts);
    parts.push(Buffer.from('e', 'latin1'));
  } else {
    // Keys must be sorted as raw byte strings.
    const keys = Object.keys(value)
      .map((key) => Buffer.from(key, 'utf8'))
      .sort(Buffer.compare);
    parts.push(Buffer.from('d', 'latin1'));
    for (const key of keys) {
      encodeInto(key, parts);
      encodeInto(value[key.toString('utf8')] as BencodeValue, parts);
    }
    parts.push(Buffer.from('e', 'latin1'));
  }
}
