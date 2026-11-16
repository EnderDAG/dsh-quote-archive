/**
 * Annual report image renderer (pure JS, zero dependencies).
 *
 * Turns the object produced by `store.annualReport()` into a self-contained
 * SVG poster (`data:image/svg+xml;base64,...`) that the management page can drop
 * straight into an `<img>` tag. Rendering happens without canvas / ImageMagick,
 * so it also works inside sandboxes that only ship Node.
 *
 * Palette: paper #FBF5ED / ink #111111 / lime #D0E516.
 */

export const REPORT_WIDTH = 1080;
export const REPORT_HEIGHT = 1500;

const PAPER = '#FBF5ED';
const PAPER_WARM = '#F3EADA';
const INK = '#111111';
const INK_SOFT = '#5A544A';
const LIME = '#D0E516';
const RULE = '#D8CEBC';

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length <= limit) return text;
  return `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

function asArray(value, length) {
  const out = Array.from({ length }, (_, index) => Number(Array.isArray(value) ? value[index] : 0) || 0);
  return out;
}

function text(x, y, content, { size = 20, weight = 400, fill = INK, anchor = 'start', letterSpacing = 0 } = {}) {
  const spacing = letterSpacing ? ` letter-spacing="${letterSpacing}"` : '';
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing}>${escapeXml(content)}</text>`;
}

function rect(x, y, width, height, fill, extra = '') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
}

function line(x1, y1, x2, y2, stroke = RULE, width = 2) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`;
}

function percent(value, digits = 1) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${(ratio * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

/** Summary numbers used by the header cards and the share subtitle. */
export function annualHighlights(report = {}) {
  const total = Number(report.total) || 0;
  const groupTotal = Number(report.group_total) || 0;
  const hours = asArray(report.hours, 24);
  const months = asArray(report.months, 12);
  const weekdays = asArray(report.weekdays, 7);
  const topTag = Array.isArray(report.top_tags) && report.top_tags[0] ? String(report.top_tags[0].tag ?? '') : '';
  return {
    total,
    group_total: groupTotal,
    share: Number(report.share) || 0,
    share_text: percent(report.share),
    rank: Number(report.rank) || 0,
    ranked_total: Number(report.ranked_total) || 0,
    per_month: total ? Math.round((total / 12) * 10) / 10 : 0,
    top_hour: total ? hours.indexOf(Math.max(...hours)) : -1,
    top_month: total ? months.indexOf(Math.max(...months)) : -1,
    top_weekday: total ? weekdays.indexOf(Math.max(...weekdays)) : -1,
    top_tag: topTag,
  };
}

function renderMonthChart(report, originY) {
  const months = asArray(report.months, 12);
  const max = Math.max(1, ...months);
  const areaX = 72;
  const areaWidth = REPORT_WIDTH - areaX * 2;
  const barWidth = 52;
  const step = areaWidth / 12;
  const baseline = originY + 176;
  const maxHeight = 132;
  const parts = [line(areaX, baseline, areaX + areaWidth, baseline, RULE, 2)];
  for (let index = 0; index < 12; index += 1) {
    const value = months[index];
    const height = value ? Math.max(6, Math.round((value / max) * maxHeight)) : 2;
    const x = Math.round(areaX + step * index + (step - barWidth) / 2);
    const y = baseline - height;
    parts.push(
      rect(x, y, barWidth, height, value ? LIME : '#E8DFCF', value ? `rx="3"` : ''),
      text(x + barWidth / 2, y - 10, value ? String(value) : '', {
        size: 15,
        weight: 600,
        anchor: 'middle',
        fill: INK_SOFT,
      }),
      text(x + barWidth / 2, baseline + 24, `${index + 1}月`, {
        size: 15,
        anchor: 'middle',
        fill: INK_SOFT,
      }),
    );
  }
  return parts.join('');
}

function renderHourChart(report, originY) {
  const hours = asArray(report.hours, 24);
  const max = Math.max(1, ...hours);
  const areaX = 72;
  const areaWidth = REPORT_WIDTH - areaX * 2;
  const step = areaWidth / 24;
  const barWidth = Math.max(14, Math.round(step - 12));
  const baseline = originY + 96;
  const maxHeight = 70;
  const parts = [line(areaX, baseline, areaX + areaWidth, baseline, RULE, 2)];
  for (let index = 0; index < 24; index += 1) {
    const value = hours[index];
    const height = value ? Math.max(4, Math.round((value / max) * maxHeight)) : 2;
    const x = Math.round(areaX + step * index + (step - barWidth) / 2);
    parts.push(rect(x, baseline - height, barWidth, height, value ? INK : '#E2D8C6', 'rx="2"'));
    if (index % 3 === 0) {
      parts.push(text(x + barWidth / 2, baseline + 22, `${index}`, { size: 14, anchor: 'middle', fill: INK_SOFT }));
    }
  }
  parts.push(text(areaX + areaWidth, baseline + 22, '23', { size: 14, anchor: 'end', fill: INK_SOFT }));
  return parts.join('');
}

function renderSubmitters(report, originY) {
  const rows = (Array.isArray(report.submitters) ? report.submitters : []).slice(0, 5);
  if (!rows.length) {
    return text(72, originY + 26, '这一年还没有收到投稿', { size: 17, fill: INK_SOFT });
  }
  const max = Math.max(1, ...rows.map((row) => Number(row.count) || 0));
  const barMax = 440;
  const parts = [];
  rows.forEach((row, index) => {
    const y = originY + index * 42;
    const width = Math.max(6, Math.round(((Number(row.count) || 0) / max) * barMax));
    parts.push(
      text(72, y + 17, truncate(row.name, 12), { size: 17, weight: 600 }),
      rect(300, y + 3, width, 20, LIME, 'rx="3"'),
      text(300 + width + 12, y + 19, `${Number(row.count) || 0} 张`, { size: 15, fill: INK_SOFT }),
    );
  });
  return parts.join('');
}

function renderCaptions(report, originY) {
  const rows = (Array.isArray(report.captions) ? report.captions : []).slice(-3).reverse();
  if (!rows.length) {
    return text(72, originY + 26, '暂时没有可展示的语录文字', { size: 17, fill: INK_SOFT });
  }
  const parts = [];
  rows.forEach((row, index) => {
    const y = originY + index * 52;
    const tags = (Array.isArray(row.tags) ? row.tags : [])
      .slice(0, 3)
      .map((tag) => `#${tag}`)
      .join(' ');
    parts.push(
      rect(72, y, 6, 34, LIME),
      text(94, y + 20, `「${truncate(row.caption, 34)}」`, { size: 18, weight: 500 }),
      text(94, y + 42, `${truncate(row.name, 26)}${tags ? ` · ${tags}` : ''}`, { size: 13, fill: INK_SOFT }),
    );
  });
  return parts.join('');
}

function renderReactionHighlights(report, originY) {
  const reactions = report.reactions && typeof report.reactions === 'object' ? report.reactions : {};
  const topQuote = Array.isArray(reactions.top_quotes) && reactions.top_quotes[0] ? reactions.top_quotes[0] : null;
  const topPerson = Array.isArray(reactions.top_persons) && reactions.top_persons[0] ? reactions.top_persons[0] : null;
  const topCommenter =
    Array.isArray(reactions.top_commenters) && reactions.top_commenters[0] ? reactions.top_commenters[0] : null;
  const items = [
    ['获赞最多语录', topQuote ? `${truncate(topQuote.caption || topQuote.filename, 18)} · ${topQuote.count}` : '—'],
    ['最受欢迎人物', topPerson ? `${truncate(topPerson.display_name || topPerson.uid, 14)} · ${topPerson.count}` : '—'],
    ['评论最多人物', topCommenter ? `${truncate(topCommenter.display_name || topCommenter.uid, 14)} · ${topCommenter.count}` : '—'],
  ];
  return items
    .map(([label, value], index) => {
      const y = originY + index * 34;
      return `${text(72, y + 18, label, { size: 15, fill: INK_SOFT })}${text(320, y + 18, value, { size: 17, weight: 600 })}`;
    })
    .join('');
}

/**
 * Render the annual report poster.
 *
 * @param {object} report result of `store.annualReport()`
 * @returns {string} SVG markup (UTF-8, no external assets)
 */
export function buildAnnualSvg(report = {}) {
  const summary = annualHighlights(report);
  const year = Number(report.year) || new Date().getFullYear();
  const scope = report.group_id ? `群 ${report.group_id}` : '全部群聊';
  const personName = String(report.display_name || '').trim() || '未指定人物';
  const personId = String(report.person_id || report.pid || '').trim();
  const reactions = report.reactions && typeof report.reactions === 'object' ? report.reactions : {};
  const reactionCount = Number(reactions.reactions) || 0;
  const commentCount = Number(reactions.comments) || 0;
  const hourLabel = summary.top_hour >= 0 ? `${summary.top_hour}:00–${summary.top_hour}:59` : '—';
  const monthLabel = summary.top_month >= 0 ? `${summary.top_month + 1} 月` : '—';
  const weekdayLabel = summary.top_weekday >= 0 ? WEEKDAY_LABELS[summary.top_weekday] : '—';
  const cards = [
    ['年度语录', String(summary.total), `全群 ${summary.group_total} 张`],
    ['全群排名', summary.rank ? `第 ${summary.rank} 名` : '—', `共 ${summary.ranked_total} 人`],
    ['平均每月', String(summary.per_month), `占全群 ${summary.share_text}`],
  ];

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${REPORT_WIDTH}" height="${REPORT_HEIGHT}" viewBox="0 0 ${REPORT_WIDTH} ${REPORT_HEIGHT}" role="img" aria-label="${escapeXml(`${year} 年度语录报告`)}">`);
  parts.push(rect(0, 0, REPORT_WIDTH, REPORT_HEIGHT, PAPER));
  parts.push(rect(0, 0, REPORT_WIDTH, 14, INK));

  // ---- header ---------------------------------------------------- //
  parts.push(text(72, 118, String(year), { size: 108, weight: 800, letterSpacing: 2 }));
  parts.push(text(74, 168, '年度语录报告', { size: 34, weight: 600 }));
  parts.push(text(74, 206, `${scope} · 本群专属年度小结 · DSH QUOTE ARCHIVE`, { size: 16, fill: INK_SOFT }));
  parts.push(rect(REPORT_WIDTH - 236, 72, 164, 52, LIME, 'rx="8"'));
  parts.push(text(REPORT_WIDTH - 154, 106, 'ANNUAL', { size: 20, weight: 700, anchor: 'middle', letterSpacing: 3 }));
  parts.push(line(72, 236, REPORT_WIDTH - 72, 236, INK, 3));

  // ---- person + cards -------------------------------------------- //
  parts.push(text(72, 300, truncate(personName, 20), { size: 42, weight: 700 }));
  parts.push(
    text(74, 332, `${personId ? `ID ${personId}` : '未绑定人物'} · 全年被拍成语录 ${summary.total} 张 · 占全群 ${summary.share_text}`, {
      size: 17,
      fill: INK_SOFT,
    }),
  );

  const cardY = 372;
  const cardWidth = 296;
  const cardGap = 26;
  cards.forEach(([label, value, hint], index) => {
    const x = 72 + index * (cardWidth + cardGap);
    parts.push(rect(x, cardY, cardWidth, 132, PAPER_WARM, 'rx="10"'));
    parts.push(rect(x, cardY, cardWidth, 6, INK));
    parts.push(text(x + 22, cardY + 42, label, { size: 16, fill: INK_SOFT, letterSpacing: 1 }));
    parts.push(text(x + 22, cardY + 92, value, { size: 40, weight: 700 }));
    parts.push(text(x + 22, cardY + 116, hint, { size: 14, fill: INK_SOFT }));
  });

  // ---- highlights ------------------------------------------------- //
  const highlightY = 546;
  parts.push(rect(72, highlightY, REPORT_WIDTH - 144, 92, INK, 'rx="10"'));
  const highlights = [
    ['最活跃时段', hourLabel],
    ['最活跃月份', monthLabel],
    ['最活跃星期', weekdayLabel],
    ['最爱标签', summary.top_tag ? `#${truncate(summary.top_tag, 10)}` : '—'],
  ];
  highlights.forEach(([label, value], index) => {
    const x = 108 + index * 232;
    parts.push(text(x, highlightY + 34, label, { size: 13, fill: '#B9B2A5', letterSpacing: 1 }));
    parts.push(text(x, highlightY + 68, value, { size: 24, weight: 700, fill: PAPER }));
  });

  // ---- monthly chart ---------------------------------------------- //
  parts.push(text(72, 704, '逐月语录', { size: 24, weight: 700 }));
  parts.push(text(REPORT_WIDTH - 72, 704, 'MONTHLY', { size: 14, fill: INK_SOFT, anchor: 'end', letterSpacing: 2 }));
  parts.push(renderMonthChart(report, 716));

  // ---- hour chart -------------------------------------------------- //
  parts.push(text(72, 968, '24 小时分布', { size: 24, weight: 700 }));
  parts.push(text(REPORT_WIDTH - 72, 968, 'HOURS', { size: 14, fill: INK_SOFT, anchor: 'end', letterSpacing: 2 }));
  parts.push(renderHourChart(report, 982));

  // ---- submitters + reactions ------------------------------------- //
  parts.push(text(72, 1148, '最常投稿你的人', { size: 22, weight: 700 }));
  parts.push(renderSubmitters(report, 1164));
  parts.push(text(572, 1148, '年度之最', { size: 22, weight: 700 }));
  parts.push(renderReactionHighlights(report, 1164));
  parts.push(
    text(572, 1286, `全年收到 ${reactionCount} 个表情回应 · ${commentCount} 条引用评论`, { size: 15, fill: INK_SOFT }),
  );

  // ---- captions ---------------------------------------------------- //
  parts.push(text(72, 1332, '代表语录', { size: 22, weight: 700 }));
  parts.push(renderCaptions(report, 1348));

  // ---- footer ------------------------------------------------------ //
  parts.push(line(72, 1424, REPORT_WIDTH - 72, 1424, RULE, 2));
  parts.push(
    text(72, 1458, `统计区间 ${year}-01-01 ~ ${year}-12-31 · ${scope} · 共 ${summary.group_total} 张图片语录`, {
      size: 15,
      fill: INK_SOFT,
    }),
  );
  parts.push(text(REPORT_WIDTH - 72, 1458, 'DSH quote-archive', { size: 15, fill: INK_SOFT, anchor: 'end' }));
  parts.push(rect(0, REPORT_HEIGHT - 14, REPORT_WIDTH, 14, LIME));
  parts.push('</svg>');
  return parts.join('\n');
}

/** `data:` URL for the management page's `<img src>`. */
export function annualImageDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(String(svg ?? ''), 'utf8').toString('base64')}`;
}

/** Download name used by the management page. */
export function annualFileName(year) {
  const value = Number(year);
  const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : new Date().getFullYear();
  return `annual-${safe}.svg`;
}
