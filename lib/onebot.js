/**
 * Minimal OneBot v11 HTTP client plus message helpers.
 *
 * The DSH version of this plugin reuses the same QQ transport that
 * Derpyu520/qq-bridge (SnowLuma OneBot v11 gateway) uses: a local OneBot HTTP
 * API, usually `http://127.0.0.1:3000`, with an optional Bearer access token.
 * No QQ login, no protocol re-implementation and no third-party dependency:
 * this module only speaks the documented OneBot HTTP actions.
 *
 * It also contains a small forward-WebSocket client (`createOneBotWsClient`)
 * that subscribes to SnowLuma's WS endpoint (usually port 3001) for group
 * message events such as `notice/group_msg_emoji_like`, which the HTTP API
 * cannot deliver.
 */

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';
const DEFAULT_WS_PORT = 3001;
const DEFAULT_TIMEOUT_MS = 15000;
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

export class OneBotError extends Error {
  constructor(message, { action, status, retcode } = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = action;
    this.status = status;
    this.retcode = retcode;
  }
}

function maskUrl(value) {
  return String(value ?? '').replace(/\/\/[^/]*@/, '//***@');
}

function numbers(value) {
  const text = String(value ?? '').trim();
  if (/^\d{1,20}$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return value;
}

/**
 * @param {{httpUrl?: string, accessToken?: string, timeoutMs?: number, fetchImpl?: Function}} [options]
 */
export function createOneBotClient(options = {}) {
  const base = String(options.httpUrl ?? DEFAULT_HTTP_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('channel.httpUrl must be an http(s) URL, for example http://127.0.0.1:3000');
  }
  const accessToken = String(options.accessToken ?? '').trim();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const fetcher = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new Error('global fetch is unavailable; the plugin requires Node 22 or newer');
  }

  async function request(action, params = {}) {
    const headers = { 'content-type': 'application/json' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      response = await fetcher(`${base}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new OneBotError(`cannot reach OneBot HTTP API at ${maskUrl(base)} (${reason})`, { action });
    }

    const raw = await response.text();
    let payload = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new OneBotError(`invalid JSON from OneBot action "${action}"`, {
          action,
          status: response.status,
        });
      }
    }
    const retcode = payload?.retcode;
    const wording = String(payload?.wording ?? payload?.msg ?? payload?.message ?? '').trim();
    if (!response.ok) {
      throw new OneBotError(`HTTP ${response.status} from OneBot action "${action}"${wording ? `: ${wording}` : ''}`, {
        action,
        status: response.status,
        retcode,
      });
    }
    if (payload && typeof payload === 'object' && 'status' in payload && payload.status !== 'ok') {
      throw new OneBotError(
        `OneBot action "${action}" failed${wording ? `: ${wording}` : ''}${retcode !== undefined ? ` (retcode ${retcode})` : ''}`,
        { action, status: response.status, retcode },
      );
    }
    if (retcode !== undefined && retcode !== 0) {
      throw new OneBotError(
        `OneBot action "${action}" failed${wording ? `: ${wording}` : ''} (retcode ${retcode})`,
        { action, status: response.status, retcode },
      );
    }
    return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  }

  /** Account that is currently logged into the gateway. */
  function getLoginInfo() {
    return request('get_login_info');
  }

  /** Groups the bot account has joined. */
  async function getGroupList() {
    const data = await request('get_group_list');
    const rows = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
    return rows
      .map((row) => ({
        group: String(row?.group_id ?? '').trim(),
        name: String(row?.group_name ?? row?.name ?? '').trim(),
      }))
      .filter((row) => row.group !== '');
  }

  /** Recent history of one group, newest first as returned by the gateway. */
  async function getGroupMsgHistory({ groupId, count = 50, messageSeq } = {}) {
    const params = { group_id: numbers(groupId), count: Math.max(1, Math.min(200, Number(count) || 50)) };
    if (messageSeq !== undefined && messageSeq !== null) params.message_seq = numbers(messageSeq);
    const data = await request('get_group_msg_history', params);
    const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
    return messages;
  }

  /** Read one message back (used to refresh a stale image segment). */
  function getMsg(messageId) {
    return request('get_msg', { message_id: numbers(messageId) });
  }

  /** Resolve a OneBot image file id into a URL or base64 payload. */
  function getImage(file) {
    return request('get_image', { file: String(file ?? '') });
  }

  /** Send a raw OneBot message array to a group. */
  function sendGroupMsg(groupId, message) {
    return request('send_group_msg', { group_id: numbers(groupId), message, auto_escape: false });
  }

  function sendGroupText(groupId, content) {
    return sendGroupMsg(groupId, [{ type: 'text', data: { text: String(content ?? '') } }]);
  }

  /** Send one image buffer to a group, optionally followed by a text caption. */
  function sendGroupImage(groupId, buffer, { caption = '' } = {}) {
    const data = Buffer.from(buffer);
    if (data.length === 0) throw new Error('image buffer is empty');
    const message = [{ type: 'image', data: { file: `base64://${data.toString('base64')}`, summary: '[语录]' } }];
    const text = String(caption ?? '').trim();
    if (text) message.push({ type: 'text', data: { text } });
    return sendGroupMsg(groupId, message);
  }

  return {
    httpUrl: maskUrl(base),
    getLoginInfo,
    getGroupList,
    getGroupMsgHistory,
    getMsg,
    getImage,
    sendGroupMsg,
    sendGroupText,
    sendGroupImage,
  };
}

/** Text segments of one OneBot message, joined together. */
export function extractText(message) {
  const segments = Array.isArray(message?.message) ? message.message : [];
  return segments
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment?.data?.text ?? ''))
    .join('')
    .trim();
}

/** Image segments of one OneBot message. */
export function extractImages(message) {
  const segments = Array.isArray(message?.message) ? message.message : [];
  return segments.filter((segment) => segment?.type === 'image' && segment?.data && typeof segment.data === 'object');
}

/** Speaker label for message attribution. */
export function speakerOf(message) {
  const sender = message?.sender ?? {};
  const name = String(sender.card ?? '').trim() || String(sender.nickname ?? '').trim() || String(sender.user_id ?? '').trim();
  return name;
}

/** Numeric QQ id of the sender, or '' when unknown. */
export function senderIdOf(message) {
  const id = String(message?.sender?.user_id ?? '').trim();
  return /^\d{1,20}$/.test(id) ? id : '';
}

/** Best-effort image extension from magic bytes, content type or URL. */
export function detectImageExtension({ buffer, contentType = '', url = '' } = {}) {
  const data = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('gif')) return 'gif';
  if (type.includes('webp')) return 'webp';
  if (type.includes('bmp')) return 'bmp';
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url ?? ''));
  const ext = match ? match[1].toLowerCase() : '';
  return IMAGE_EXTENSIONS.has(ext) ? ext : 'jpg';
}

/**
 * Download one image referenced by an OneBot image segment.
 *
 * Preference order: the segment's public URL, then `get_image` (base64/url),
 * then re-reading the message via `get_msg`. Returns the raw bytes plus the
 * detected extension.
 *
 * @returns {Promise<{buffer: Buffer, extension: string}>}
 */
export async function downloadImageBytes(client, { message, segment, maxBytes = 10 * 1024 * 1024, timeoutMs = 20000, fetchImpl } = {}) {
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const limit = Math.max(1, Number(maxBytes) || 10 * 1024 * 1024);
  const candidates = [];
  const data = segment?.data ?? {};
  if (typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) candidates.push(data.url);

  async function fetchUrl(url) {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(Math.max(1000, timeoutMs)) : undefined;
    const response = await fetcher(url, { method: 'GET', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} while downloading the quote image`);
    const contentType = response.headers?.get?.('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('downloaded quote image is empty');
    if (buffer.length > limit) throw new Error(`quote image is larger than the ${limit} byte limit`);
    return { buffer, extension: detectImageExtension({ buffer, contentType, url }) };
  }

  for (const url of candidates) {
    try {
      return await fetchUrl(url);
    } catch {
      // Try the next candidate.
    }
  }

  if (typeof data.file === 'string' && data.file) {
    try {
      const info = await client.getImage(data.file);
      if (info && typeof info.base64 === 'string' && info.base64.trim()) {
        const encoded = info.base64.trim().replace(/^base64:\/\//, '');
        const buffer = Buffer.from(encoded, 'base64');
        if (buffer.length > 0) {
          if (buffer.length > limit) throw new Error(`quote image is larger than the ${limit} byte limit`);
          return { buffer, extension: detectImageExtension({ buffer, url: String(info.url ?? '') }) };
        }
      }
      if (info && typeof info.url === 'string' && /^https?:\/\//i.test(info.url)) {
        return await fetchUrl(info.url);
      }
    } catch {
      // Fall through to get_msg.
    }
  }

  if (message && message.message_id !== undefined) {
    try {
      const fresh = await client.getMsg(message.message_id);
      const image = extractImages(fresh)[0];
      if (image && image !== segment) {
        return await downloadImageBytes(client, { message: fresh, segment: image, maxBytes: limit, timeoutMs, fetchImpl });
      }
    } catch {
      // Give up below.
    }
  }

  throw new Error('cannot download the quote image: the OneBot gateway returned neither a usable URL nor base64 data');
}

/** Reply ("引用") target message id of one OneBot message, or ''. */
export function extractReplyId(message) {
  const segments = Array.isArray(message?.message) ? message.message : [];
  for (const segment of segments) {
    if (segment?.type !== 'reply') continue;
    const id = String(segment?.data?.id ?? segment?.data?.message_id ?? '').trim();
    if (id) return id;
  }
  return '';
}

/** True when one gateway event is an emoji-like notice. */
export function isEmojiLikeNotice(event) {
  return Boolean(
    event && typeof event === 'object' && event.post_type === 'notice' && event.notice_type === 'group_msg_emoji_like',
  );
}

/**
 * Derive the OneBot forward-WebSocket endpoint from the HTTP endpoint.
 *
 * SnowLuma exposes HTTP on 3000 and WS on 3001 by default, so the HTTP port is
 * shifted by one; an explicit `port` (channel.wsUrl) always wins.
 *
 * @param {string} httpUrl
 * @param {{port?: number}} [options]
 */
export function deriveWsUrl(httpUrl, { port } = {}) {
  let parsed;
  try {
    parsed = new URL(String(httpUrl ?? '').trim() || DEFAULT_HTTP_URL);
  } catch {
    parsed = new URL(DEFAULT_HTTP_URL);
  }
  const secure = parsed.protocol === 'https:';
  const httpPort = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
  const override = Number(port);
  let wsPort;
  if (Number.isFinite(override) && override > 0 && override <= 65535) {
    wsPort = Math.trunc(override);
  } else if (httpPort === 443) {
    wsPort = 8443;
  } else if (httpPort >= 65535) {
    wsPort = DEFAULT_WS_PORT;
  } else {
    wsPort = httpPort + 1;
  }
  return `${secure ? 'wss' : 'ws'}://${parsed.hostname}:${wsPort}/`;
}

function maskWsUrl(value) {
  return String(value ?? '').replace(/(access_token=)[^&]*/i, '$1***');
}

function parseWsPayload(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data instanceof ArrayBuffer) {
    try {
      return JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(data)) {
    try {
      return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
    } catch {
      return null;
    }
  }
  if (data && typeof data.text === 'function') {
    return data
      .text()
      .then((text) => parseWsPayload(text))
      .catch(() => null);
  }
  return null;
}

/**
 * OneBot v11 forward-WebSocket listener used for live reaction notices.
 *
 * Only needs the built-in global `WebSocket` (Node 22+). The access token is
 * passed as `?access_token=`, which SnowLuma's wsServers accepts alongside the
 * Bearer header, because the standard WebSocket constructor cannot add headers.
 * Reconnects with capped exponential backoff; when the socket is unavailable
 * every method degrades to a no-op so the rest of the plugin keeps working.
 *
 * @param {{
 *   wsUrl?: string,
 *   accessToken?: string,
 *   WebSocketImpl?: Function,
 *   onNotice?: Function,
 *   onEvent?: Function,
 *   logger?: object|null,
 *   reconnect?: boolean,
 *   minDelayMs?: number,
 *   maxDelayMs?: number,
 * }} [options]
 */
export function createOneBotWsClient(options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const token = String(options.accessToken ?? '').trim();
  const logger = options.logger === null ? null : options.logger || console;
  const onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const reconnect = options.reconnect !== false;
  const minDelay = Math.max(100, Number(options.minDelayMs) || 1000);
  const maxDelay = Math.max(minDelay, Number(options.maxDelayMs) || 60000);

  const connectionUrl = (() => {
    const raw = String(options.wsUrl ?? '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
      if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
      return url.toString();
    } catch {
      return '';
    }
  })();
  const displayUrl = maskWsUrl(connectionUrl);
  const available = typeof WebSocketImpl === 'function' && connectionUrl !== '';

  let socket = null;
  let stopped = true;
  let connected = false;
  let attempts = 0;
  let timer = null;
  let lastError = available ? '' : 'WebSocket 不可用或 wsUrl 无效';
  let eventCount = 0;
  let noticeCount = 0;

  const remember = (error) => {
    lastError = error instanceof Error ? error.message : String(error ?? '');
  };

  const scheduleReconnect = () => {
    if (!reconnect || stopped || !available) return;
    attempts += 1;
    const delay = Math.min(maxDelay, minDelay * 2 ** Math.min(attempts - 1, 6));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const dispatch = (event) => {
    if (!event || typeof event !== 'object') return;
    eventCount += 1;
    if (onEvent) {
      try {
        const result = onEvent(event);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        // A listener must never kill the socket.
      }
    }
    if (!isEmojiLikeNotice(event)) return;
    noticeCount += 1;
    try {
      const result = onNotice(event);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => logger?.warn?.('[quote-archive] emoji notice failed:', error));
      }
    } catch (error) {
      logger?.warn?.('[quote-archive] emoji notice failed:', error);
    }
  };

  function connect() {
    if (stopped || !available) return;
    let current;
    try {
      current = new WebSocketImpl(connectionUrl);
    } catch (error) {
      remember(error);
      scheduleReconnect();
      return;
    }
    socket = current;

    const handleOpen = () => {
      if (socket !== current) return;
      connected = true;
      attempts = 0;
      lastError = '';
      logger?.info?.(`[quote-archive] reaction socket connected: ${displayUrl}`);
    };
    const handleMessage = (event) => {
      if (socket !== current) return;
      const data = event?.data !== undefined ? event.data : event;
      const payload = parseWsPayload(data);
      if (payload && typeof payload.then === 'function') {
        payload.then(dispatch).catch((error) => logger?.warn?.('[quote-archive] bad ws payload:', error));
        return;
      }
      dispatch(payload);
    };
    const handleClose = () => {
      if (socket !== current) return;
      socket = null;
      connected = false;
      if (stopped) return;
      // Silent degradation: the WS endpoint is optional, so a closed socket is
      // retried with backoff but never escalates to a warning.
      scheduleReconnect();
    };
    const handleError = (event) => {
      const detail = event?.message || event?.error?.message || event?.error || 'websocket error';
      remember(detail);
    };

    try {
      current.onopen = handleOpen;
      current.onmessage = handleMessage;
      current.onclose = handleClose;
      current.onerror = handleError;
      if (current.readyState === 1) handleOpen();
    } catch (error) {
      remember(error);
      scheduleReconnect();
    }
  }

  return {
    available,
    url: displayUrl,
    start() {
      if (!available) return false;
      if (!stopped) return false;
      stopped = false;
      attempts = 0;
      connect();
      return true;
    },
    stop() {
      stopped = true;
      connected = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close();
        } catch {
          // Already closed.
        }
      }
    },
    status() {
      return {
        available,
        url: displayUrl,
        connected,
        attempts,
        last_error: lastError,
        events: eventCount,
        notices: noticeCount,
      };
    },
  };
}
