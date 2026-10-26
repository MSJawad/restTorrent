// Manages several torrents for the REST API. Each added .torrent file is
// saved in a state directory, so a restarted server picks its torrents up
// again and resumes them by re-checking the data already on disk.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseMetainfo } from './metainfo.ts';
import { Torrent, type TorrentOptions } from './torrent.ts';

export interface ClientOptions {
  downloadDir: string;
  /** Where added torrents are remembered. Defaults to `<downloadDir>/.resttorrent`. */
  stateDir?: string;
  /** Port reported to trackers. */
  port?: number;
  torrent?: Partial<Omit<TorrentOptions, 'downloadDir' | 'peerId' | 'port'>>;
}

export class DuplicateTorrentError extends Error {
  override name = 'DuplicateTorrentError';
}

interface SavedState {
  paused: boolean;
  addedAt: string;
}

/** Azureus-style peer id: client code "RT", version 1.0.0.0, then random characters. */
export function generatePeerId(): Buffer {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const suffix = [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join('');
  return Buffer.from(`-RT1000-${suffix}`, 'latin1');
}

export class Client {
  readonly peerId = generatePeerId();
  readonly downloadDir: string;
  readonly stateDir: string;
  #options: ClientOptions;
  #torrents = new Map<string, { torrent: Torrent; addedAt: string }>();

  constructor(options: ClientOptions) {
    this.#options = options;
    this.downloadDir = resolve(options.downloadDir);
    this.stateDir = resolve(options.stateDir ?? join(this.downloadDir, '.resttorrent'));
  }

  /** Re-adds every torrent saved by a previous run. */
  async restore(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.stateDir);
    } catch {
      return;
    }
    const saved: Array<{ data: Buffer; state: SavedState }> = [];
    for (const name of names.filter((n) => n.endsWith('.torrent'))) {
      const id = name.slice(0, -'.torrent'.length);
      try {
        const data = await readFile(join(this.stateDir, name));
        const state = JSON.parse(await readFile(join(this.stateDir, `${id}.json`), 'utf8')) as SavedState;
        saved.push({ data, state });
      } catch (err) {
        console.error(`skipping saved torrent ${name}: ${(err as Error).message}`);
      }
    }
    // Keep the order the torrents were added in.
    saved.sort((a, b) => a.state.addedAt.localeCompare(b.state.addedAt));
    for (const { data, state } of saved) {
      try {
        this.#start(data, state);
      } catch (err) {
        console.error(`skipping saved torrent: ${(err as Error).message}`);
      }
    }
  }

  /** Adds a torrent from the bytes of a .torrent file and starts it. */
  async add(data: Buffer, { paused = false } = {}): Promise<Torrent> {
    const meta = parseMetainfo(data);
    if (this.#torrents.has(meta.infoHashHex)) {
      throw new DuplicateTorrentError(`torrent ${meta.infoHashHex} is already added`);
    }
    const state: SavedState = { paused, addedAt: new Date().toISOString() };
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(join(this.stateDir, `${meta.infoHashHex}.torrent`), data);
    await this.#save(meta.infoHashHex, state);
    return this.#start(data, state);
  }

  get(id: string): Torrent | undefined {
    return this.#torrents.get(id.toLowerCase())?.torrent;
  }

  list(): Array<{ torrent: Torrent; addedAt: string }> {
    return [...this.#torrents.values()];
  }

  addedAt(id: string): string | undefined {
    return this.#torrents.get(id)?.addedAt;
  }

  /** Pauses a torrent and remembers that across restarts. Returns false when it cannot be paused. */
  async pause(torrent: Torrent): Promise<boolean> {
    if (!torrent.pause()) return false;
    await this.#save(torrent.id, { paused: true, addedAt: this.addedAt(torrent.id) as string });
    return true;
  }

  /** Resumes a torrent. Returns false when there is nothing to resume. */
  async resume(torrent: Torrent): Promise<boolean> {
    if (!torrent.resume()) return false;
    await this.#save(torrent.id, { paused: false, addedAt: this.addedAt(torrent.id) as string });
    return true;
  }

  async remove(torrent: Torrent, { deleteFiles = false } = {}): Promise<void> {
    this.#torrents.delete(torrent.id);
    await torrent.destroy({ deleteFiles });
    await rm(join(this.stateDir, `${torrent.id}.torrent`), { force: true });
    await rm(join(this.stateDir, `${torrent.id}.json`), { force: true });
  }

  /** Stops every torrent (telling trackers) and closes files. */
  async close(): Promise<void> {
    await Promise.all(this.list().map(({ torrent }) => torrent.destroy()));
    this.#torrents.clear();
  }

  #start(data: Buffer, state: SavedState): Torrent {
    const meta = parseMetainfo(data);
    const torrent = new Torrent(meta, {
      ...this.#options.torrent,
      downloadDir: this.downloadDir,
      peerId: this.peerId,
      port: this.#options.port ?? 6881,
    });
    this.#torrents.set(meta.infoHashHex, { torrent, addedAt: state.addedAt });
    void torrent.start({ paused: state.paused });
    return torrent;
  }

  async #save(id: string, state: SavedState): Promise<void> {
    await writeFile(join(this.stateDir, `${id}.json`), `${JSON.stringify(state)}\n`);
  }
}
