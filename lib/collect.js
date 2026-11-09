/**
 * Quote collection on top of a QQ / OneBot channel.
 *
 * A "quote" in this archive is a group message that carries at least one image.
 * We store the image next to the database and keep the message text, the
 * speaker and the original message id (which also acts as the dedupe key), so
 * re-running a sync never downloads or stores the same message twice.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { downloadImageBytes, extractImages, extractText, senderIdOf, speakerOf } from './onebot.js';

const MAX_CONTENT_LENGTH = 4000;
const FALLBACK_CONTENT = '[图片语录]';
const MAX_RECORDED_ERRORS = 5;

function safeSegment(value) {
  const text = String(value ?? '').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 80);
  return text || 'unknown';
}

function imageExtensionOf(extension) {
  const text = String(extension ?? '').toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(text) ? text : 'jpg';
}

/**
 * Pull recent image messages from one group into the archive.
 *
 * @param {object} options
 * @param {object} options.channel  OneBot client from lib/onebot.js
 * @param {object} options.store    store from lib/store.js
 * @param {string} options.groupId
 * @param {number} [options.limit]
 * @param {number} [options.maxImageBytes]
 * @param {boolean} [options.downloadImages]
 * @param {Function} [options.fetchImpl]
 */
export async function syncGroup({ channel, store, groupId, limit = 50, maxImageBytes, downloadImages = true, fetchImpl } = {}) {
  const id = String(groupId ?? '').trim();
  if (!id) throw new Error('group id is required');
  if (!channel || typeof channel.getGroupMsgHistory !== 'function') throw new Error('QQ channel is not configured');
  if (!store || typeof store.addQuote !== 'function') throw new Error('quote store is not available');

  const messages = await channel.getGroupMsgHistory({ groupId: id, count: limit });
  const list = (Array.isArray(messages) ? messages : []).slice();
  list.sort(
    (a, b) =>
      Number(a?.time ?? 0) - Number(b?.time ?? 0) || Number(a?.message_id ?? 0) - Number(b?.message_id ?? 0),
  );

  let selfId = '';
  try {
    const login = await channel.getLoginInfo();
    selfId = String(login?.user_id ?? '').trim();
  } catch {
    // Attribution is best-effort: keep going without the login info.
  }

  try {
    const groups = await channel.getGroupList();
    const found = Array.isArray(groups) ? groups.find((row) => String(row?.group ?? '') === id) : undefined;
    if (found?.name) store.setGroupName(id, found.name);
  } catch {
    // Group names are cosmetic.
  }

  const result = {
    group: id,
    scanned: list.length,
    added: 0,
    deduped: 0,
    skipped: 0,
    downloaded: 0,
    failed: 0,
    errors: [],
    quotes: [],
  };

  for (const message of list) {
    const messageId = String(message?.message_id ?? '').trim();
    const images = extractImages(message);
    if (images.length === 0) {
      result.skipped += 1;
      continue;
    }
    if (selfId && senderIdOf(message) === selfId) {
      // Do not archive the bot's own messages.
      result.skipped += 1;
      continue;
    }
    if (messageId && typeof store.findQuoteByMessageId === 'function' && store.findQuoteByMessageId(messageId)) {
      result.deduped += 1;
      continue;
    }

    const text = extractText(message);
    const content = (text || FALLBACK_CONTENT).slice(0, MAX_CONTENT_LENGTH);
    let imagePath = '';

    if (downloadImages) {
      try {
        const downloaded = await downloadImageBytes(channel, {
          message,
          segment: images[0],
          maxBytes: maxImageBytes,
          fetchImpl,
        });
        const fileName = `${safeSegment(messageId || message?.time || Date.now())}.${imageExtensionOf(downloaded.extension)}`;
        const relative = path.posix.join(safeSegment(id), fileName);
        const absolute = path.join(store.imagesDir, ...relative.split('/'));
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, downloaded.buffer);
        imagePath = relative;
        result.downloaded += 1;
      } catch (error) {
        result.failed += 1;
        if (result.errors.length < MAX_RECORDED_ERRORS) {
          result.errors.push({ messageId, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
    }

    const saved = store.addQuote({
      group: id,
      speaker: speakerOf(message),
      content,
      messageId,
      imagePath,
      source: 'qq',
      createdAt: message?.time,
    });
    if (saved.deduped) {
      result.deduped += 1;
    } else {
      result.added += 1;
      result.quotes.push({
        id: saved.id,
        messageId,
        speaker: speakerOf(message),
        imagePath,
      });
    }
  }

  return result;
}
