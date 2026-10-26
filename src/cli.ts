#!/usr/bin/env node
// Command-line entry point: download one torrent, inspect a .torrent file,
// or run the REST API server.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createApiServer } from './api/server.ts';
import { Client, generatePeerId } from './client.ts';
import { formatBytes, formatDuration } from './format.ts';
import { parseMetainfo, type Metainfo } from './metainfo.ts';
import { Torrent, type TorrentStats } from './torrent.ts';

const USAGE = `Usage:
  resttorrent download <file.torrent> [--out <dir>] [--port <n>]
  resttorrent serve [--host <addr>] [--port <n>] [--dir <dir>] [--peer-port <n>]
  resttorrent info <file.torrent>

Commands:
  download   Download a torrent into --out (default: current directory).
             Re-running it on a partial download resumes where it stopped.
  serve      Run the REST API and progress page (default http://127.0.0.1:9080),
             saving downloads into --dir (default: ./downloads).
  info       Print what a .torrent file contains.

Options:
  --port       download: port reported to trackers (default 6881)
               serve: HTTP port for the API (default 9080)
  --peer-port  serve: port reported to trackers (default 6881)
  -h, --help   Show this help
  -v, --version`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      dir: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string', short: 'p' },
      'peer-port': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    console.log(version());
    return 0;
  }
  const [command, file] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }
  switch (command) {
    case 'download':
      if (!file) return usageError('download needs a .torrent file');
      return download(file, values.out ?? '.', port(values.port, 6881));
    case 'info':
      if (!file) return usageError('info needs a .torrent file');
      printInfo(parseMetainfo(await readFile(file)));
      return 0;
    case 'serve':
      return serve(
        values.host ?? '127.0.0.1',
        port(values.port, 9080),
        values.dir ?? 'downloads',
        port(values['peer-port'], 6881),
      );
    default:
      return usageError(`unknown command "${command}"`);
  }
}

function usageError(message: string): number {
  console.error(`resttorrent: ${message}\n\n${USAGE}`);
  return 1;
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port "${value}"`);
  return n;
}

function printInfo(meta: Metainfo): void {
  const lines = [
    ['Name', meta.name],
    ['Info hash', meta.infoHashHex],
    ['Size', `${formatBytes(meta.length)} (${meta.length} bytes)`],
    ['Pieces', `${meta.pieceHashes.length} x ${formatBytes(meta.pieceLength)}`],
    ['Private', meta.private ? 'yes' : 'no'],
    ['Trackers', meta.announce.flat().join('\n           ') || '(none)'],
  ];
  for (const [label, value] of lines) console.log(`${(label as string).padEnd(10)} ${value}`);
  console.log(`Files      ${meta.files.length}`);
  for (const f of meta.files) console.log(`  ${formatBytes(f.length).padStart(10)}  ${f.path.join('/')}`);
}

async function download(file: string, out: string, peerPort: number): Promise<number> {
  const meta = parseMetainfo(await readFile(file));
  const torrent = new Torrent(meta, { downloadDir: out, peerId: generatePeerId(), port: peerPort });
  console.log(`${meta.name}  ${formatBytes(meta.length)}, ${meta.pieceHashes.length} pieces, ${meta.files.length} file(s)`);
  console.log(`Saving to ${displayPath(out)}`);

  const tty = process.stdout.isTTY;
  const started = Date.now();
  let lastLog = 0;
  const render = (final = false) => {
    const stats = torrent.stats();
    const line = progressLine(stats, tty ? process.stdout.columns : 100);
    if (tty) {
      process.stdout.write(`\r\x1b[2K${line}`);
    } else if (final || Date.now() - lastLog >= 5000) {
      console.log(line);
      lastLog = Date.now();
    }
  };
  const timer = setInterval(() => render(), 500);

  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    if (tty) process.stdout.write('\n');
    console.log('Stopping (press Ctrl-C again to force)...');
    void torrent.destroy().then(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let resumed = false;
  let resumedBytes = 0;
  const result = await new Promise<'done' | 'error'>((done) => {
    torrent.on('done', () => done('done'));
    torrent.on('state', (state) => {
      if (state === 'error') done('error');
      if (state === 'downloading' && !resumed) {
        resumed = true;
        const { pieces, downloaded } = torrent.stats();
        const { have, total } = pieces;
        resumedBytes = downloaded;
        if (have > 0) {
          if (tty) process.stdout.write('\r\x1b[2K');
          console.log(`Resuming: ${have} of ${total} pieces already on disk and verified`);
        }
      }
    });
    void torrent.start();
  });
  clearInterval(timer);
  render(true);
  if (tty) process.stdout.write('\n');
  await torrent.destroy();
  if (result === 'error') {
    console.error(`Download failed: ${torrent.error}`);
    return 1;
  }
  const seconds = (Date.now() - started) / 1000;
  const fetched = meta.length - resumedBytes;
  console.log(
    `Done in ${formatDuration(seconds)} (${formatBytes(fetched / Math.max(seconds, 1))}/s average), ` +
      `all ${meta.pieceHashes.length} pieces verified.`,
  );
  return 0;
}

/** A path relative to the working directory when it is inside it, otherwise absolute. */
function displayPath(path: string): string {
  const rel = relative(process.cwd(), resolve(path));
  return rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? resolve(path) : rel;
}

function progressLine(stats: TorrentStats, columns: number): string {
  if (stats.state === 'checking') {
    return `Checking existing data ${stats.pieces.checked}/${stats.pieces.total} pieces`;
  }
  const pct = `${(stats.progress * 100).toFixed(1).padStart(5)}%`;
  const parts = [`${formatBytes(stats.downloaded)} / ${formatBytes(stats.size)}`];
  if (stats.state !== 'completed') {
    parts.push(
      `${formatBytes(stats.downloadSpeed)}/s`,
      `${stats.peers.connected} peer${stats.peers.connected === 1 ? '' : 's'}`,
      `ETA ${formatDuration(stats.eta)}`,
    );
  }
  if (stats.peers.connected === 0 && stats.tracker.lastError) parts.push(`tracker: ${stats.tracker.lastError}`);
  const tail = `${pct}  ${parts.join('  ')}`;
  const barWidth = Math.max(10, Math.min(30, columns - tail.length - 4));
  const filled = Math.round(stats.progress * barWidth);
  const line = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)} ${tail}`;
  return line.length > columns - 1 ? line.slice(0, columns - 1) : line;
}

async function serve(host: string, httpPort: number, dir: string, peerPort: number): Promise<number> {
  const client = new Client({ downloadDir: dir, port: peerPort });
  await client.restore();
  const server = createApiServer(client);
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(httpPort, host, () => ready());
  });
  const address = server.address();
  const shown = typeof address === 'object' && address ? address.port : httpPort;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  console.log(`restTorrent API listening on http://${urlHost}:${shown}`);
  console.log(`Downloads are saved in ${client.downloadDir}`);
  return new Promise((exit) => {
    const stop = () => {
      console.log('\nShutting down...');
      server.closeAllConnections();
      server.close();
      void client.close().then(() => exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`resttorrent: ${err.message}`);
    process.exit(1);
  },
);
