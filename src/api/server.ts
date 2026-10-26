// REST API and progress page. Plain node:http keeps the client free of
// runtime dependencies; the route table is small enough not to need a framework.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { DuplicateTorrentError, type Client } from '../client.ts';
import { MetainfoError } from '../metainfo.ts';
import type { Torrent } from '../torrent.ts';

const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const EVENT_INTERVAL = 1000;
const TORRENT_TYPES = new Set(['application/x-bittorrent', 'application/octet-stream']);

const PUBLIC_DIR = new URL('../../public/', import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function summary(client: Client, torrent: Torrent) {
  const { files, ...stats } = torrent.stats();
  return { ...stats, fileCount: files.length, addedAt: client.addedAt(torrent.id) ?? null };
}

export function detail(client: Client, torrent: Torrent) {
  const stats = torrent.stats();
  return { ...stats, fileCount: stats.files.length, addedAt: client.addedAt(torrent.id) ?? null };
}

export function createApiServer(client: Client): Server {
  const staticCache = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    handle(client, staticCache, req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      sendJson(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
    });
  });
  return server;
}

async function handle(
  client: Client,
  staticCache: Map<string, Buffer>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  checkOrigin(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  const asset = STATIC_FILES[path];
  if (asset) {
    allow(method, ['GET', 'HEAD']);
    let body = staticCache.get(asset.file);
    if (!body) {
      body = readFileSync(new URL(asset.file, PUBLIC_DIR));
      staticCache.set(asset.file, body);
    }
    res.writeHead(200, {
      'content-type': asset.type,
      'content-length': body.length,
      'content-security-policy': "default-src 'self'; img-src 'self' data:",
      'x-content-type-options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }

  if (path === '/api/torrents') {
    allow(method, ['GET', 'POST']);
    if (method === 'GET') {
      sendJson(res, 200, { torrents: client.list().map(({ torrent }) => summary(client, torrent)) });
      return;
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!TORRENT_TYPES.has(type)) {
      throw new HttpError(415, 'send the .torrent file as the request body with Content-Type: application/x-bittorrent');
    }
    const body = await readBody(req, MAX_TORRENT_BYTES);
    let torrent: Torrent;
    try {
      torrent = await client.add(body, { paused: url.searchParams.get('paused') === 'true' });
    } catch (err) {
      if (err instanceof MetainfoError) throw new HttpError(400, err.message);
      if (err instanceof DuplicateTorrentError) throw new HttpError(409, err.message);
      throw err;
    }
    res.setHeader('location', `/api/torrents/${torrent.id}`);
    sendJson(res, 201, detail(client, torrent));
    return;
  }

  if (path === '/api/events') {
    allow(method, ['GET']);
    streamEvents(client, req, res);
    return;
  }

  const match = /^\/api\/torrents\/([0-9a-fA-F]{40})(?:\/(pause|resume))?$/.exec(path);
  if (match) {
    const torrent = client.get(match[1] as string);
    if (!torrent) throw new HttpError(404, 'no torrent with that id');
    const action = match[2];
    if (action) {
      allow(method, ['POST']);
      const ok = action === 'pause' ? await client.pause(torrent) : await client.resume(torrent);
      if (!ok) throw new HttpError(409, `cannot ${action} a torrent that is ${torrent.state}`);
      sendJson(res, 200, detail(client, torrent));
      return;
    }
    allow(method, ['GET', 'DELETE']);
    if (method === 'GET') {
      sendJson(res, 200, detail(client, torrent));
    } else {
      await client.remove(torrent, { deleteFiles: url.searchParams.get('deleteFiles') === 'true' });
      res.writeHead(204).end();
    }
    return;
  }

  throw new HttpError(404, 'not found');
}

/**
 * The API can write files to disk, so refuse requests a web page on another
 * origin could make on the user's behalf (CSRF), and requests whose Host
 * header names some other site (DNS rebinding against a loopback server).
 */
function checkOrigin(req: IncomingMessage): void {
  const host = req.headers.host;
  if (!host) throw new HttpError(400, 'missing Host header');
  const local = req.socket.localAddress ?? '';
  const loopback = local === '::1' || local.startsWith('127.') || local === '::ffff:127.0.0.1';
  if (loopback) {
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      throw new HttpError(403, 'unexpected Host header');
    }
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" or garbage: treat as foreign
    }
    if (originHost !== host) throw new HttpError(403, 'cross-origin requests are not allowed');
  }
}

function allow(method: string, methods: string[]): void {
  if (!methods.includes(method)) {
    throw new HttpError(405, `use ${methods.join(' or ')}`, { allow: methods.join(', ') });
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new HttpError(413, `torrent files are limited to ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `torrent files are limited to ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

/** Server-sent events: the full torrent list once a second. */
function streamEvents(client: Client, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const send = () => {
    const torrents = client.list().map(({ torrent }) => summary(client, torrent));
    res.write(`event: torrents\ndata: ${JSON.stringify({ torrents })}\n\n`);
  };
  send();
  const timer = setInterval(send, EVENT_INTERVAL);
  req.on('close', () => clearInterval(timer));
}
