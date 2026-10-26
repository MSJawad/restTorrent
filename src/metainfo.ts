// Parses .torrent (metainfo) files: BEP 3 single- and multi-file torrents,
// plus the BEP 12 announce-list.

import { createHash } from 'node:crypto';
import { decodeDictWithSpans, type BencodeDict, type BencodeValue } from './bencode.ts';

export interface TorrentFile {
  /** Path components relative to the download directory, starting with the torrent name. */
  path: string[];
  length: number;
  /** Offset of the file's first byte in the torrent's concatenated payload. */
  offset: number;
}

export interface Metainfo {
  infoHash: Buffer;
  infoHashHex: string;
  name: string;
  pieceLength: number;
  pieceHashes: Buffer[];
  files: TorrentFile[];
  length: number;
  /** Tracker URLs grouped in tiers, in the order they should be tried. */
  announce: string[][];
  private: boolean;
}

export class MetainfoError extends Error {
  override name = 'MetainfoError';
}

export function parseMetainfo(data: Buffer): Metainfo {
  let decoded: ReturnType<typeof decodeDictWithSpans>;
  try {
    decoded = decodeDictWithSpans(data);
  } catch (err) {
    throw new MetainfoError(`not a valid torrent file: ${(err as Error).message}`);
  }
  const { dict, spans } = decoded;
  const info = dict.info;
  const infoSpan = spans.get('info');
  if (!isDict(info) || !infoSpan) throw new MetainfoError('missing info dictionary');

  const infoHash = createHash('sha1').update(data.subarray(infoSpan[0], infoSpan[1])).digest();

  const name = safeComponent(text(info['name.utf-8'] ?? info.name, 'info.name'), 'info.name');
  const pieceLength = positiveInt(info['piece length'], 'info.piece length');
  const pieces = info.pieces;
  if (!Buffer.isBuffer(pieces)) {
    throw new MetainfoError('missing info.pieces (BitTorrent v2-only torrents are not supported)');
  }
  if (pieces.length === 0 || pieces.length % 20 !== 0) {
    throw new MetainfoError('info.pieces length is not a multiple of 20');
  }
  const pieceHashes: Buffer[] = [];
  for (let i = 0; i < pieces.length; i += 20) pieceHashes.push(pieces.subarray(i, i + 20));

  const files: TorrentFile[] = [];
  let length = 0;
  if (info.files !== undefined) {
    if (!Array.isArray(info.files) || info.files.length === 0) {
      throw new MetainfoError('info.files must be a non-empty list');
    }
    for (const [i, entry] of info.files.entries()) {
      if (!isDict(entry)) throw new MetainfoError(`info.files[${i}] is not a dictionary`);
      // BEP 47 padding files are real payload bytes, so they stay in the
      // layout; they are simply written to disk like any other file.
      const fileLength = nonNegativeInt(entry.length, `info.files[${i}].length`);
      const rawPath = entry['path.utf-8'] ?? entry.path;
      if (!Array.isArray(rawPath) || rawPath.length === 0) {
        throw new MetainfoError(`info.files[${i}].path must be a non-empty list`);
      }
      const path = rawPath.map((part, j) =>
        safeComponent(text(part, `info.files[${i}].path[${j}]`), `info.files[${i}].path[${j}]`),
      );
      files.push({ path: [name, ...path], length: fileLength, offset: length });
      length += fileLength;
    }
  } else {
    length = nonNegativeInt(info.length, 'info.length');
    files.push({ path: [name], length, offset: 0 });
  }
  if (length === 0) throw new MetainfoError('torrent has no data');
  if (!Number.isSafeInteger(length)) throw new MetainfoError('torrent is too large');

  const expectedPieces = Math.ceil(length / pieceLength);
  if (expectedPieces !== pieceHashes.length) {
    throw new MetainfoError(
      `torrent has ${pieceHashes.length} piece hashes but its size needs ${expectedPieces}`,
    );
  }

  return {
    infoHash,
    infoHashHex: infoHash.toString('hex'),
    name,
    pieceLength,
    pieceHashes,
    files,
    length,
    announce: parseAnnounce(dict),
    private: info.private === 1,
  };
}

/** Byte length of a piece; only the last piece may be shorter. */
export function pieceSize(meta: Metainfo, index: number): number {
  if (index === meta.pieceHashes.length - 1) {
    return meta.length - meta.pieceLength * index;
  }
  return meta.pieceLength;
}

function parseAnnounce(dict: BencodeDict): string[][] {
  const tiers: string[][] = [];
  const seen = new Set<string>();
  const accept = (value: BencodeValue): string | null => {
    if (!Buffer.isBuffer(value)) return null;
    const url = value.toString('utf8').trim();
    if (!/^(https?|udp):\/\//i.test(url) || seen.has(url)) return null;
    seen.add(url);
    return url;
  };
  // BEP 12: when announce-list is present, it replaces announce.
  if (Array.isArray(dict['announce-list'])) {
    for (const tier of dict['announce-list']) {
      if (!Array.isArray(tier)) continue;
      const urls = tier.map(accept).filter((url): url is string => url !== null);
      if (urls.length > 0) tiers.push(shuffle(urls));
    }
  }
  if (tiers.length === 0 && dict.announce !== undefined) {
    const url = accept(dict.announce);
    if (url) tiers.push([url]);
  }
  return tiers;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

function isDict(value: BencodeValue | undefined): value is BencodeDict {
  return typeof value === 'object' && !Buffer.isBuffer(value) && !Array.isArray(value);
}

function text(value: BencodeValue | undefined, field: string): string {
  if (!Buffer.isBuffer(value)) throw new MetainfoError(`${field} must be a string`);
  return value.toString('utf8');
}

function positiveInt(value: BencodeValue | undefined, field: string): number {
  if (typeof value !== 'number' || value <= 0) {
    throw new MetainfoError(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(value: BencodeValue | undefined, field: string): number {
  if (typeof value !== 'number' || value < 0) {
    throw new MetainfoError(`${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Rejects path components that could escape the download directory or that
 * no file system can store. The torrent file comes from the user (or the REST
 * API), so it is untrusted input.
 */
function safeComponent(part: string, field: string): string {
  if (
    part === '' ||
    part === '.' ||
    part === '..' ||
    /[/\\\0]/.test(part) ||
    /^[a-zA-Z]:/.test(part)
  ) {
    throw new MetainfoError(`${field} is not a safe file name: ${JSON.stringify(part)}`);
  }
  return part;
}
