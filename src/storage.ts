// Maps pieces onto the files of a torrent and reads and writes them on disk.
//
// A torrent's payload is the concatenation of all its files. A piece is a
// fixed-size window over that payload, so one piece can span the end of one
// file and the start of the next (or several small files).

import { createHash } from 'node:crypto';
import { mkdir, open, rm, rmdir, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Bitfield } from './bitfield.ts';
import { pieceSize, type Metainfo, type TorrentFile } from './metainfo.ts';

export interface FileSegment {
  fileIndex: number;
  /** Offset within the file. */
  fileOffset: number;
  /** Offset within the requested range. */
  rangeOffset: number;
  length: number;
}

/** Splits the payload range [offset, offset + length) into per-file segments. */
export function mapRange(files: TorrentFile[], offset: number, length: number): FileSegment[] {
  const segments: FileSegment[] = [];
  // Binary search for the last file starting at or before offset.
  let lo = 0;
  let hi = files.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((files[mid] as TorrentFile).offset <= offset) lo = mid;
    else hi = mid - 1;
  }
  let rangeOffset = 0;
  for (let i = lo; i < files.length && rangeOffset < length; i++) {
    const file = files[i] as TorrentFile;
    const start = offset + rangeOffset;
    const fileOffset = start - file.offset;
    if (fileOffset >= file.length) continue; // zero-length file or before range
    const segLength = Math.min(file.length - fileOffset, length - rangeOffset);
    segments.push({ fileIndex: i, fileOffset, rangeOffset, length: segLength });
    rangeOffset += segLength;
  }
  return segments;
}

export function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

export class Storage {
  readonly meta: Metainfo;
  readonly dir: string;
  readonly paths: string[];
  #handles = new Map<number, Promise<FileHandle>>();

  constructor(meta: Metainfo, dir: string) {
    this.meta = meta;
    this.dir = resolve(dir);
    this.paths = meta.files.map((file) => {
      const full = join(this.dir, ...file.path);
      // Metainfo parsing already rejects unsafe components; this is a second
      // line of defence against writing outside the download directory.
      if (!full.startsWith(this.dir + sep)) throw new Error(`unsafe path ${full}`);
      return full;
    });
  }

  /** Creates every file (including empty ones) so the layout matches the torrent. */
  async allocate(): Promise<void> {
    for (let i = 0; i < this.paths.length; i++) await this.#handle(i);
  }

  async writePiece(index: number, data: Buffer): Promise<void> {
    const offset = index * this.meta.pieceLength;
    for (const seg of mapRange(this.meta.files, offset, data.length)) {
      const handle = await this.#handle(seg.fileIndex);
      await handle.write(data, seg.rangeOffset, seg.length, seg.fileOffset);
    }
  }

  /** Reads a piece back, or returns null when the files on disk are too short. */
  async readPiece(index: number): Promise<Buffer | null> {
    const length = pieceSize(this.meta, index);
    const offset = index * this.meta.pieceLength;
    const data = Buffer.alloc(length);
    for (const seg of mapRange(this.meta.files, offset, length)) {
      const path = this.paths[seg.fileIndex] as string;
      const size = await fileSize(path);
      if (size < seg.fileOffset + seg.length) return null;
      const handle = await this.#handle(seg.fileIndex);
      const { bytesRead } = await handle.read(data, seg.rangeOffset, seg.length, seg.fileOffset);
      if (bytesRead !== seg.length) return null;
    }
    return data;
  }

  /**
   * Hashes the pieces already on disk and returns those that match. This is
   * how an interrupted download resumes without trusting any saved state.
   */
  async verify(onProgress?: (checked: number) => void): Promise<Bitfield> {
    const have = new Bitfield(this.meta.pieceHashes.length);
    const anyData = await Promise.all(this.paths.map(fileSize));
    if (anyData.every((size) => size === 0)) return have;
    for (let i = 0; i < this.meta.pieceHashes.length; i++) {
      const data = await this.readPiece(i);
      if (data && sha1(data).equals(this.meta.pieceHashes[i] as Buffer)) have.set(i);
      onProgress?.(i + 1);
    }
    return have;
  }

  async close(): Promise<void> {
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    await Promise.all(handles.map(async (pending) => (await pending).close().catch(() => {})));
  }

  /**
   * Deletes the torrent's files, then any directories the torrent created
   * that are now empty. Files the torrent does not list are left alone.
   */
  async remove(): Promise<void> {
    await this.close();
    const dirs = new Set<string>();
    for (const path of this.paths) {
      await rm(path, { force: true });
      for (let d = dirname(path); d.startsWith(this.dir + sep); d = dirname(d)) dirs.add(d);
    }
    // Deepest first, so children are removed before their parents.
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      await rmdir(d).catch(() => {});
    }
  }

  #handle(fileIndex: number): Promise<FileHandle> {
    let handle = this.#handles.get(fileIndex);
    if (!handle) {
      handle = openForWrite(this.paths[fileIndex] as string);
      this.#handles.set(fileIndex, handle);
      handle.catch(() => this.#handles.delete(fileIndex));
    }
    return handle;
  }
}

async function openForWrite(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true });
  try {
    return await open(path, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return await open(path, 'w+');
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
