/**
 * Read-only JSON routes for the browser half of dsh-quote-archive.
 *
 * The host half owns the SQLite archive and the image directory; the browser
 * panel cannot read either one directly, so it fetches these two same-origin
 * routes. Both are GET-only and fenced to loopback (the shipped Web GUI binds
 * 127.0.0.1), matching the route family convention used by other plugins such
 * as dsh-client-ui-skill-explorer.
 *
 * Paths are mirrored in client.js; keep both literal lists in sync.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Route paths registered on the host web server. */
export const ROUTES = {
  list: '/quote-archive/list',
  image: '/quote-archive/image',
};

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Whether an address string names the loopback range (127/8, ::1, mapped). */
function isLoopbackAddress(address) {
  const text = String(address ?? '');
  if (text === '::1') return true;
  const ipv4 = text.startsWith('::ffff:') ? text.slice('::ffff:'.length) : text;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ipv4);
  return match !== null && match[1] === '127';
}

/** Whether the request's Host header names a loopback authority. */
function isLoopbackHost(hostHeader) {
  const text = String(hostHeader ?? '').trim().toLowerCase();
  if (!text) return false;
  const hostname = text.startsWith('[') ? text.slice(0, text.indexOf(']') + 1) : text.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Trust fence for the browser routes: loopback socket and loopback host. */
function isLoopbackRequest(request) {
  const socket = request?.socket;
  if (!isLoopbackAddress(socket?.remoteAddress)) return false;
  return isLoopbackHost(request?.headers?.host);
}

function writeJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(0, Math.trunc(number)));
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Wrap one route handler with the fence, method check, and error answer. */
function routeHandler(method, handler) {
  return async (request, response) => {
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
      return;
    }
    if (request.method !== method) {
      writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
      return;
    }
    try {
      await handler(request, response);
    } catch (error) {
      writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/**
 * Build the quote archive route list.
 * @param {{getStore: () => object, getLastSync: () => (object|null)}} context
 * @returns {Array<{kind: 'exact', path: string, handler: Function}>}
 */
export function createWebRoutes(context) {
  const { getStore, getLastSync } = context;

  return [
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: routeHandler('GET', async (request, response) => {
        const store = getStore();
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const query = readText(url.searchParams.get('query') ?? '');
        const group = readText(url.searchParams.get('group') ?? '');
        const speaker = readText(url.searchParams.get('speaker') ?? '');
        const tag = readText(url.searchParams.get('tag') ?? '');
        const limit = readInteger(url.searchParams.get('limit'), DEFAULT_LIMIT) || DEFAULT_LIMIT;
        const offset = readInteger(url.searchParams.get('offset'), 0);

        const quotes = query
          ? store.searchQuotes({ query, group, speaker, tag, limit })
          : store.listQuotes({ group, speaker, tag, limit, offset });
        const summary = store.stats();
        const lastSync = getLastSync();
        writeJson(response, 200, {
          ok: true,
          total: summary.totals.quotes,
          page: { limit, offset, count: quotes.length, query, group, speaker, tag },
          quotes: quotes.map((quote) => ({
            id: quote.id,
            group: quote.group,
            speaker: quote.speaker,
            content: quote.content,
            tags: quote.tags,
            createdAt: quote.createdAt,
            source: quote.source,
            hasImage: Boolean(quote.imagePath),
            imageUrl: quote.imagePath ? `quote-archive/image?id=${quote.id}` : '',
          })),
          groups: store.listGroups(),
          stats: { totals: summary.totals, topSpeakers: summary.topSpeakers },
          lastSync: lastSync
            ? {
                at: lastSync.at ?? 0,
                added: lastSync.added ?? 0,
                error: lastSync.error ?? '',
              }
            : null,
        });
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.image,
      handler: routeHandler('GET', async (request, response) => {
        const store = getStore();
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const quote = store.getQuote(url.searchParams.get('id'));
        if (!quote || !quote.imagePath) {
          writeJson(response, 404, { ok: false, error: 'quote image not found' });
          return;
        }
        const root = path.resolve(store.imagesDir);
        const target = path.resolve(root, ...String(quote.imagePath).split('/'));
        if (target !== root && !target.startsWith(root + path.sep)) {
          writeJson(response, 404, { ok: false, error: 'quote image not found' });
          return;
        }
        let buffer;
        try {
          buffer = await readFile(target);
        } catch {
          writeJson(response, 404, { ok: false, error: 'quote image file is missing' });
          return;
        }
        response.writeHead(200, {
          'content-type': MIME_BY_EXT[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'content-length': buffer.length,
          'cache-control': 'private, max-age=3600',
        });
        response.end(buffer);
      }),
    },
  ];
}
