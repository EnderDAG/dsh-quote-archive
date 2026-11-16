// Transport abstraction for outbound quote delivery.
//
// Two drivers can deliver a quote:
//
//   - `onebot` — the SnowLuma / OneBot v11 HTTP gateway wrapped by
//     `lib/onebot.js`. This is the original channel and the only one that can
//     also read history, login info and group lists.
//   - `im` — the optional dsh-im bridge (`ctx.im`). dsh-im is a *bridge core*:
//     it routes messages through channel adapters (Feishu, Telegram, mock, ...)
//     into chats the user bound to a session. It cannot address arbitrary QQ
//     groups, so an `im` send always goes to the single chat configured through
//     `channel.imPlatform` + `channel.imChatId`. Images travel as
//     `attachments: [{ kind: 'image', path }]`, which the adapter may or may not
//     render as a native image.
//
// Driver selection follows `channel.driver`:
//
//   - `auto`   (default) onebot when the OneBot gateway is configured,
//              otherwise `im` when dsh-im is installed and a bound chat exists.
//   - `onebot` always onebot.
//   - `im`     always im.
//
// Everything here is dependency-free: dsh-im is only ever reached through the
// service object injected by the host, never imported.

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Accepted `channel.driver` values. */
export const DRIVERS = ['auto', 'onebot', 'im'];

/** How long a rendered image may sit in the im outbox before it is pruned. */
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

const IM_EVENTS = ['im/message', 'im/dispatch', 'im/im/dispatch'];

function readString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Normalize a configured driver name, falling back to `auto`. */
export function normalizeDriver(value) {
  const driver = String(value ?? '')
    .trim()
    .toLowerCase();
  return DRIVERS.includes(driver) ? driver : 'auto';
}

/**
 * Resolve the dsh-im delivery target from the channel config.
 * Both `imPlatform` and `imChatId` are required: dsh-im addresses a
 * `(platform, chatId)` pair, and there is no implicit default chat.
 */
export function imTargetOf(channelConfig) {
  const config = channelConfig && typeof channelConfig === 'object' ? channelConfig : {};
  const platform = readString(config.imPlatform);
  const chatId = readString(config.imChatId);
  return platform && chatId ? { platform, chatId } : null;
}

/** Detect a sensible file extension for an outbound image asset. */
export function imageExtension(filename, buffer) {
  const name = readString(filename);
  const match = /[.]([A-Za-z0-9]{2,5})$/.exec(name);
  if (match) {
    const ext = match[1].toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  }
  const bytes = buffer && buffer.length >= 2 ? buffer : null;
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes && bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  return 'png';
}

function safeName(value, fallback) {
  const name = readString(value, fallback);
  const cleaned = name.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || fallback).slice(-80);
}

/**
 * Build the dsh-im driver.
 *
 * @param {object} options
 * @param {() => object | null} options.getIm   returns `ctx.im` (or null)
 * @param {() => object} options.getConfig      returns the resolved plugin config
 * @param {() => string} options.getOutboxDir   directory for temporary image attachments
 * @param {object} [options.logger]
 */
export function createImDriver({ getIm, getConfig, getOutboxDir, logger = console } = {}) {
  const channelConfig = () => {
    const config = typeof getConfig === 'function' ? getConfig() : null;
    return (config && config.channel) || {};
  };
  const service = () => {
    try {
      return (typeof getIm === 'function' ? getIm() : null) || null;
    } catch {
      return null;
    }
  };
  const target = () => imTargetOf(channelConfig());
  const available = () => Boolean(service() && target());

  const listChannels = () => {
    const im = service();
    const channels = im && im.channels;
    if (!channels || typeof channels.keys !== 'function') return [];
    try {
      return [...channels.keys()].map(String);
    } catch {
      return [];
    }
  };

  const pruneOutbox = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - OUTBOX_TTL_MS;
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        const info = statSync(file);
        if (info.isFile() && info.mtimeMs < cutoff) unlinkSync(file);
      } catch {
        // Best effort only: a leftover file must never break a send.
      }
    }
  };

  const writeOutbox = (name, buffer) => {
    const dir = typeof getOutboxDir === 'function' ? String(getOutboxDir() || '') : '';
    if (!dir) throw new Error('IM 通道缺少附件暂存目录');
    mkdirSync(dir, { recursive: true });
    pruneOutbox(dir);
    const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const file = path.join(dir, `${stamp}-${name}`);
    writeFileSync(file, buffer);
    return file;
  };

  const requireReady = () => {
    const im = service();
    const chat = target();
    if (!im) {
      throw new Error('IM 通道不可用：宿主未加载 dsh-im（安装并启用 dsh-im 后重试）');
    }
    if (!chat) {
      throw new Error('IM 通道未绑定会话：请在插件配置中设置 channel.imPlatform 与 channel.imChatId（dsh-im 的 platform + chatId）');
    }
    if (typeof im.send !== 'function') {
      throw new Error('IM 通道不可用：dsh-im 服务缺少 send() 方法');
    }
    return { im, chat };
  };

  const describe = () => {
    const chat = target();
    return {
      driver: 'im',
      available: available(),
      platform: chat ? chat.platform : '',
      chat_id: chat ? chat.chatId : '',
      channels: listChannels(),
    };
  };

  const sendImage = async (groupId, buffer, options = {}) => {
    const { im, chat } = requireReady();
    const bytes = buffer instanceof Uint8Array ? buffer : null;
    if (!bytes) throw new Error('IM 通道发送失败：缺少图片数据');
    const ext = imageExtension(options && options.filename, bytes);
    const name = safeName(options && options.filename, `quote-${Date.now()}.${ext}`);
    const file = writeOutbox(name, bytes);
    const caption = readString(options && options.caption, '');
    const attachment = { kind: 'image', name, path: file };
    if (caption) attachment.text = caption;
    const payload = { text: caption, attachments: [attachment] };
    const result = await im.send(chat, payload);
    return { message_id: String((result && result.messageId) || ''), driver: 'im' };
  };

  const sendText = async (groupId, content) => {
    const { im, chat } = requireReady();
    const text = String(content ?? '');
    const result = await im.send(chat, { text });
    return { message_id: String((result && result.messageId) || ''), driver: 'im' };
  };

  return {
    name: 'im',
    available,
    assertReady: () => { requireReady(); },
    describe,
    status: describe,
    sendImage,
    sendText,
    logger,
  };
}

/**
 * Build the transport used by the tool half and the admin API.
 *
 * The returned object mirrors the OneBot client's send surface
 * (`sendGroupImage`, `sendGroupText`) plus driver introspection, so callers can
 * stay unaware of which driver is currently active.
 */
export function createTransport({ getOnebot, getIm, getConfig, getOutboxDir, logger = console } = {}) {
  const im = createImDriver({ getIm, getConfig, getOutboxDir, logger });
  const channelConfig = () => {
    const config = typeof getConfig === 'function' ? getConfig() : null;
    return (config && config.channel) || {};
  };
  const configured = () => normalizeDriver(channelConfig().driver);
  const onebotAvailable = () => {
    const config = channelConfig();
    return Boolean(config && config.enabled !== false && readString(config.httpUrl));
  };

  const activeDriver = () => {
    const mode = configured();
    if (mode === 'onebot') return 'onebot';
    if (mode === 'im') return 'im';
    if (onebotAvailable()) return 'onebot';
    if (im.available()) return 'im';
    return 'onebot';
  };

  const requireOnebot = () => {
    const client = typeof getOnebot === 'function' ? getOnebot(true) : null;
    if (!client || typeof client.sendGroupImage !== 'function') {
      throw new Error('QQ 通道不可用：OneBot 网关未启用或无法连接');
    }
    return client;
  };

  const sendGroupImage = async (groupId, buffer, options) => {
    if (activeDriver() === 'im') {
      return im.sendImage(groupId, buffer, options || {});
    }
    const client = requireOnebot();
    const result = await client.sendGroupImage(groupId, buffer, options);
    return { ...(result && typeof result === 'object' ? result : {}), driver: 'onebot' };
  };

  const sendGroupText = async (groupId, content) => {
    if (activeDriver() === 'im') {
      return im.sendText(groupId, content);
    }
    const client = requireOnebot();
    const result = await client.sendGroupText(groupId, content);
    return { ...(result && typeof result === 'object' ? result : {}), driver: 'onebot' };
  };

  const assertReady = () => {
    if (activeDriver() === 'im') {
      im.assertReady();
      return 'im';
    }
    requireOnebot();
    return 'onebot';
  };

  const status = () => ({
    configured: configured(),
    active: activeDriver(),
    onebot: {
      available: onebotAvailable(),
      http_url: readString(channelConfig().httpUrl),
    },
    im: im.describe(),
  });

  return { activeDriver, assertReady, status, sendGroupImage, sendGroupText, im };
}

/**
 * Bridge dsh-im inbound events into reply-comment recording.
 *
 * dsh-im 1.0.x forwards adapter messages into `ctx.im.dispatchInbound()`; the
 * core only emits `im/dispatch` today, and the event payload carries no reply
 * target. This bridge therefore listens to the documented events and only acts
 * when a payload exposes a reply id (`replyTo` / `reply_to` / `quoteId`) that
 * matches a message we delivered (see `sent_quote`). When the payload lacks a
 * reply id (the common case in 1.0.x), it is silently ignored: there is nothing
 * safe to attach a comment to.
 */
export function attachImInbound({ ctx, getStore, logger = console, events = IM_EVENTS } = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {};
  const handle = (payload) => {
    try {
      const record = payload && typeof payload === 'object' ? payload.message || payload : null;
      if (!record || typeof record !== 'object') return 0;
      const replyTo = readString(record.replyTo ?? record.reply_to ?? record.quoteId ?? record.quote_id);
      const text = readString(record.text ?? record.content);
      if (!replyTo || !text) return 0;
      const store = typeof getStore === 'function' ? getStore() : null;
      if (!store || typeof store.lookupSentQuote !== 'function' || typeof store.recordComment !== 'function') return 0;
      const sent = store.lookupSentQuote(replyTo);
      if (!sent) return 0;
      const userId = readString(record.userId ?? record.user_id ?? record.senderId ?? record.sender_id);
      const changed = store.recordComment({
        groupId: sent.group_id,
        filename: sent.filename,
        userId,
        content: text,
        source: 'im',
      });
      if (changed > 0 && logger && typeof logger.info === 'function') {
        logger.info(`[quote-archive] recorded ${changed} IM reply comment(s)`);
      }
      return changed;
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[quote-archive] failed to record IM reply comment:', error instanceof Error ? error.message : error);
      }
      return 0;
    }
  };
  const disposers = [];
  for (const event of events) {
    const dispose = ctx.on(event, handle);
    disposers.push(typeof dispose === 'function' ? dispose : () => ctx.off?.(event, handle));
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Unsubscribing must never throw during plugin teardown.
      }
    }
  };
}
