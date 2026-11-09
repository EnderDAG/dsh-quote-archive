'use strict';

/**
 * quote_collocter — 语录管理页面
 *
 * 通过 AstrBot 插件页面桥接 SDK（window.AstrBotPluginPage）调用插件注册的 Web API。
 * 路由（相对当前插件）：
 *   overview | quotes | image | quotes/delete | quotes/move | group/delete | settings
 */

(function () {
  const EP = {
    overview: 'overview',
    quotes: 'quotes',
    image: 'image',
    imagesBatch: 'images/batch',
    deleteQuotes: 'quotes/delete',
    moveQuotes: 'quotes/move',
    deleteGroup: 'group/delete',
    settings: 'settings',
    semanticStatus: 'semantic/status',
    semanticRun: 'semantic/run',
    semanticProgress: 'semantic/progress',
    semanticReset: 'semantic/reset',
    sent: 'sent',
    identityOverview: 'identity/overview',
    identityList: 'identity/list',
    identityDetail: 'identity/detail',
    identityAvatars: 'identity/avatars',
    identityMatch: 'identity/match',
    identitySync: 'identity/sync',
    identityMerge: 'identity/merge',
    identitySplit: 'identity/split',
    identityMatchNames: 'identity/match_names',
    quotesSubject: 'quotes/subject',
    quotesAutoSubject: 'quotes/auto_subject',
    quotesReview: 'quotes/review',
    quotesBindName: 'quotes/bind_name',
    quotesRebind: 'quotes/rebind',
    semanticBackfillSpeaker: 'semantic/backfill_speaker',
    identityClusters: 'identity/clusters',
    identityClusterMerge: 'identity/cluster_merge',
    identityCleanup: 'identity/cleanup',
    aliasCandidates: 'alias/candidates',
    aliasConfirm: 'alias/candidate_confirm',
    aliasReject: 'alias/candidate_reject',
    aliasLearn: 'alias/learn',
    statistics: 'statistics',
    identitySchedule: 'identity/schedule',
    collections: 'collections',
    weekly: 'weekly',
    weeklyTest: 'weekly/test',
    quotesSearch: 'quotes/search',
    trash: 'trash',
    trashRestore: 'trash/restore',
    trashPurge: 'trash/purge',
    tagQueue: 'tag/queue',
    insightsHeatmap: 'insights/heatmap',
    insightsTimeline: 'insights/timeline',
    insightsAnnual: 'insights/annual',
    insightsAnnualImage: 'insights/annual_image',
    quotesRestricted: 'quotes/restricted',
    quotesRating: 'quotes/rating',
    quotesAutoRating: 'quotes/auto_rating',
    collabMembers: 'collab/members',
    collabTokens: 'collab/tokens',
    collabAudit: 'collab/audit',
    collabBase: 'collab/base',
  };

  const THUMB_CONCURRENCY = 8;
  const TASK_POLL_MS = 1500;

  const state = {
    plugin: null,
    ctx: null,
    groups: [],
    groupId: null,
    dataRoot: '',
    thumbAvailable: true,
    page: 1,
    pageSize: 24,
    sort: 'new',
    keyword: '',
    items: [],
    total: 0,
    pages: 1,
    totalBytes: 0,
    selected: new Set(),
    loading: false,
    settings: null,
    mode: 'browse',
    minScore: 0.2,
    semantic: null,
    task: null,
    taskTimer: null,
    subjectFilter: '',
    filterPerson: '',
    filterTags: '',
    filterRange: 0,
    restrictedFilter: '0',
    collab: { open: false, members: [], tokens: [], audit: [], loading: false },
    trash: { open: false, loading: false, items: [], total: 0 },
    tag: { loading: false, timer: null, paused: false },
    insights: { open: false, heat: null, people: [], timeline: null, annual: null, loading: false },
    identitySync: { enabled: true, interval_hours: 24, last_sync_at: 0, next_sync_at: 0 },
    lightboxItem: null,
    lightboxGroupId: '',
    assign: {
      open: false,
      mode: 'single',
      names: [],
      q: '',
      items: [],
      loading: false,
      targetName: '',
    },
    stats: {
      open: false,
      loading: false,
      scope: '',
      top: 20,
      data: null,
    },
    collections: {
      open: false,
      loading: false,
      items: [],
      detailId: '',
      draft: false,
    },
    weekly: {
      loading: false,
      settings: null,
      groups: [],
      preview: {},
    },
    people: {
      open: false,
      q: '',
      page: 1,
      pageSize: 24,
      items: [],
      total: 0,
      pages: 1,
      selected: new Set(),
      detail: null,
      match: null,
      loading: false,
    },
  };

  const el = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ //
  // 基础设施
  // ------------------------------------------------------------------ //
  function waitForBridge(timeoutMs) {
    const limit = timeoutMs || 8000;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function loop() {
        if (window.AstrBotPluginPage) {
          resolve(window.AstrBotPluginPage);
          return;
        }
        if (Date.now() - started > limit) {
          reject(new Error('未能连接到 AstrBot 插件页面桥接 SDK'));
          return;
        }
        setTimeout(loop, 60);
      })();
    });
  }

  async function apiGet(path, params) {
    return state.plugin.apiGet(path, params || {});
  }

  async function apiPost(path, body) {
    return state.plugin.apiPost(path, body || {});
  }

  function toast(message, ms) {
    const node = el('toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => node.classList.add('hidden'), ms || 2600);
  }

  /**
   * 页面内确认框。
   * AstrBot 把插件页面放在 sandbox iframe（allow-scripts allow-forms allow-downloads）里加载，
   * 没有 allow-modals，window.confirm() 会被浏览器静默拦截并直接返回 false，
   * 导致「一键语义化 / 删除 / 移动 / 清空」等按钮看起来毫无反应。这里改用 DOM 对话框。
   */
  function uiConfirm(message, options) {
    const opts = options || {};
    return new Promise((resolve) => {
      const modal = el('confirm-modal');
      const body = el('confirm-message');
      const ok = el('confirm-ok');
      const cancel = el('confirm-cancel');
      if (!modal || !body || !ok || !cancel) {
        // 兜底：页面里没有对话框节点时退回原生 confirm（普通浏览器里可用）
        resolve(typeof window.confirm === 'function' ? window.confirm(String(message)) : false);
        return;
      }
      body.textContent = String(message == null ? '' : message);
      ok.textContent = opts.okText || '确定';
      cancel.textContent = opts.cancelText || '取消';
      ok.className = opts.danger === false ? 'btn' : 'btn danger';
      cancel.className = 'btn ghost';
      const prevFocus = document.activeElement;
      let settled = false;
      const cleanup = () => {
        settled = true;
        modal.classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKeydown, true);
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_) { /* ignore */ }
        }
      };
      const finish = (value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      };
      function onOk() { finish(true); }
      function onCancel() { finish(false); }
      function onBackdrop(event) { if (event.target === modal) finish(false); }
      function onKeydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); finish(true); }
      }
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKeydown, true);
      modal.classList.remove('hidden');
      try { ok.focus(); } catch (_) { /* ignore */ }
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function fmtBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / 1048576).toFixed(1) + ' MB';
    return (value / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(seconds) {
    const value = Number(seconds) || 0;
    if (!value) return '未知时间';
    const date = new Date(value * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function whoLabel(item) {
    if (item.display_name) return item.display_name;
    if (item.nickname) return item.nickname;
    if (item.user_id) return 'QQ ' + item.user_id;
    return '未知投稿人';
  }

  function subjectLabel(item) {
    const name = item.subject_display_name || item.subject_person_name || '';
    if (name) return name;
    const review = item.subject_review_name || item.subject_name || '';
    if (review) return review + '（待确认）';
    return '';
  }

  function isSubjectAssigned(item) {
    return Boolean(item && item.subject_user_id);
  }

  // ------------------------------------------------------------------ //
  // 头像缩略图（人物档案 / 语录卡片共用）
  // ------------------------------------------------------------------ //
  const avatarCache = new Map();

  async function loadAvatarBatch(shas) {
    const wanted = [];
    (shas || []).forEach((sha) => {
      const key = String(sha || '').toLowerCase();
      if (/^[0-9a-f]{16}$/.test(key) && !avatarCache.has(key) && !wanted.includes(key)) {
        wanted.push(key);
      }
    });
    for (let start = 0; start < wanted.length; start += 30) {
      const chunk = wanted.slice(start, start + 30);
      try {
        const data = await apiPost(EP.identityAvatars, { shas: chunk });
        const items = (data && data.items) || {};
        Object.keys(items).forEach((sha) => avatarCache.set(sha, items[sha]));
      } catch (error) {
        /* 头像加载失败不阻塞页面 */
      }
    }
    return avatarCache;
  }

  function avatarUrl(sha) {
    const key = String(sha || '').toLowerCase();
    return key ? avatarCache.get(key) || '' : '';
  }

  async function hydrateAvatars(scope) {
    const root = scope || document;
    const nodes = Array.from(root.querySelectorAll('[data-avatar-sha]'));
    if (!nodes.length) return;
    // 先让当前界面绘一帧，再补头像，避免打开弹层时被头像解码阻塞
    await new Promise((resolve) => setTimeout(resolve, 60));
    await loadAvatarBatch(nodes.map((node) => node.getAttribute('data-avatar-sha')));
    nodes.forEach((node) => {
      const src = avatarUrl(node.getAttribute('data-avatar-sha'));
      if (src) node.src = src;
      else node.classList.add('avatar-missing');
    });
  }

  function avatarNode(sha, className) {
    const safe = String(sha || '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(safe)) {
      const fallback = document.createElement('span');
      fallback.className = (className || '') + ' avatar avatar-fallback';
      fallback.textContent = '?';
      return fallback;
    }
    const img = document.createElement('img');
    img.className = (className || '') + ' avatar';
    img.alt = '';
    img.loading = 'lazy';
    img.setAttribute('data-avatar-sha', safe);
    const cached = avatarUrl(safe);
    if (cached) img.src = cached;
    else img.classList.add('avatar-missing');
    return img;
  }

  function semanticLine(item) {
    const status = String(item.semantic_status || 'pending');
    let text;
    if (status === 'done') {
      text = item.has_vector ? '语义：已索引' : '语义：仅描述';
      if (item.tone) text += ' · ' + item.tone;
      if (item.tags && item.tags.length) text += ' · ' + item.tags.slice(0, 3).join('/');
    } else if (status === 'failed') {
      text = '语义：失败（可重试）';
    } else {
      text = '语义：待处理';
    }
    return `<div class="semline ${escapeHtml(status)}">${escapeHtml(text)}</div>`;
  }

  // ------------------------------------------------------------------ //
  // 缩略图并发队列
  // ------------------------------------------------------------------ //
  const thumbQueue = [];
  let thumbActive = 0;
  const thumbCache = new Map();
  const THUMB_CACHE_MAX = 480;

  function thumbCacheKey(gid, name, mode) {
    return `${gid}|${name}|${mode}`;
  }

  function thumbCacheGet(key) {
    if (!thumbCache.has(key)) return null;
    const value = thumbCache.get(key);
    thumbCache.delete(key);
    thumbCache.set(key, value);
    return value;
  }

  function thumbCachePut(key, value) {
    thumbCache.set(key, value);
    while (thumbCache.size > THUMB_CACHE_MAX) {
      const oldest = thumbCache.keys().next().value;
      thumbCache.delete(oldest);
    }
  }

  function pumpThumbs() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
      const task = thumbQueue.shift();
      thumbActive += 1;
      Promise.resolve()
        .then(task)
        .catch(() => {})
        .finally(() => {
          thumbActive -= 1;
          pumpThumbs();
        });
    }
  }

  function enqueueThumb(task) {
    thumbQueue.push(task);
    pumpThumbs();
  }

  // 批量取图：40ms 内的请求合并成一次 images/batch（最多 15 张）
  const thumbBatchWaiters = new Map();

  function fetchThumbBatched(gid, name, mode) {
    const key = thumbCacheKey(gid, name, mode);
    const cached = thumbCacheGet(key);
    if (cached) return Promise.resolve(cached);
    const bucketKey = gid + '|' + mode;
    let bucket = thumbBatchWaiters.get(bucketKey);
    if (!bucket) {
      bucket = { names: new Map(), timer: 0 };
      thumbBatchWaiters.set(bucketKey, bucket);
    }
    return new Promise((resolve, reject) => {
      bucket.names.set(name, { resolve, reject });
      if (!bucket.timer) {
        bucket.timer = setTimeout(() => flushThumbBatch(gid, mode, bucket), 40);
      }
    });
  }

  async function flushThumbBatch(gid, mode, bucket) {
    bucket.timer = 0;
    const entries = Array.from(bucket.names.entries()).slice(0, 15);
    entries.forEach(([name]) => bucket.names.delete(name));
    if (!entries.length) {
      thumbBatchWaiters.delete(gid + '|' + mode);
      return;
    }
    try {
      const data = await apiGet(EP.imagesBatch, {
        group_id: gid,
        names: entries.map(([name]) => name).join(','),
        size: mode,
      });
      const items = (data && data.items) || {};
      entries.forEach(([name, waiter]) => {
        const url = items[name];
        if (url) {
          thumbCachePut(thumbCacheKey(gid, name, mode), url);
          waiter.resolve(url);
        } else {
          waiter.reject(new Error('missing ' + name));
        }
      });
    } catch (error) {
      // 旧版本服务端没有批量接口时，退回逐张读取
      await Promise.all(
        entries.map(async ([name, waiter]) => {
          try {
            const data = await apiGet(EP.image, { group_id: gid, name, size: mode });
            thumbCachePut(thumbCacheKey(gid, name, mode), data.data_url);
            waiter.resolve(data.data_url);
          } catch (inner) {
            waiter.reject(inner);
          }
        })
      );
    }
    if (bucket.names.size) {
      bucket.timer = setTimeout(() => flushThumbBatch(gid, mode, bucket), 40);
    } else {
      thumbBatchWaiters.delete(gid + '|' + mode);
    }
  }

  // ------------------------------------------------------------------ //
  // 下一页预取：首屏渲染后预取下一页的缩略图到缓存
  // ------------------------------------------------------------------ //
  let prefetchToken = '';
  let prefetchTimer = 0;

  function schedulePrefetch() {
    if (!state.groupId || !state.thumbAvailable) return;
    if (state.keyword || state.filterPerson || state.filterTags || state.filterRange) return;
    if (state.mode === 'semantic') return;
    if (state.page >= state.pages) return;
    const token = `${state.groupId}|${state.page}|${state.pageSize}`;
    if (token === prefetchToken) return;
    prefetchToken = token;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => runPrefetch(state.groupId, state.page, state.pageSize, state.sort), 900);
  }

  async function runPrefetch(gid, page, pageSize, sort) {
    try {
      const data = await apiGet(EP.quotes, {
        group_id: gid,
        page: page + 1,
        page_size: pageSize,
        sort: sort,
      });
      const items = data.items || [];
      const mode = state.thumbAvailable ? 'thumb' : 'original';
      const missing = items
        .map((item) => item.name)
        .filter((name) => !thumbCacheGet(thumbCacheKey(gid, name, mode)));
      for (let i = 0; i < missing.length; i += 15) {
        const chunk = missing.slice(i, i + 15);
        try {
          const batch = await apiGet(EP.imagesBatch, {
            group_id: gid,
            names: chunk.join(','),
            size: mode,
          });
          const got = (batch && batch.items) || {};
          Object.keys(got).forEach((name) => {
            if (got[name]) thumbCachePut(thumbCacheKey(gid, name, mode), got[name]);
          });
        } catch (error) {
          return;
        }
      }
    } catch (error) {
      /* 预取失败不影响正常浏览 */
    }
  }

  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            const task = entry.target.__thumbTask;
            if (task) enqueueThumb(task);
          });
        },
        { rootMargin: '400px' }
      )
    : null;

  // ------------------------------------------------------------------ //
  // 总览 / 群列表
  // ------------------------------------------------------------------ //
  async function loadOverview() {
    const data = await apiGet(EP.overview);
    state.groups = data.groups || [];
    state.dataRoot = data.data_root || '';
    state.thumbAvailable = data.thumbnail !== false;

    el('data-root').textContent = state.dataRoot || '-';
    el('badge-total').textContent = `${data.total_quotes || 0} 张 · ${fmtBytes(data.total_bytes)}`;
    el('badge-thumb').classList.toggle('hidden', !state.thumbAvailable);
    el('group-count').textContent = `${state.groups.length} 个群`;
    el('group-empty').classList.toggle('hidden', state.groups.length > 0);

    renderGroups();

    if (!state.groupId && state.groups.length) {
      await selectGroup(state.groups[0].group_id);
    } else if (state.groupId) {
      const still = state.groups.some((item) => item.group_id === state.groupId);
      if (!still) {
        state.groupId = null;
        if (state.groups.length) await selectGroup(state.groups[0].group_id);
        else resetMain();
      } else {
        renderMoveTargets();
      }
    }
  }

  function renderGroups() {
    const list = el('group-list');
    list.innerHTML = '';
    state.groups.forEach((group) => {
      const li = document.createElement('li');
      li.className = 'group-item' + (group.group_id === state.groupId ? ' active' : '');
      const modeText = ['关闭投稿', '仅管理员', '全员可投'][Number(group.settings && group.settings.mode) || 0];
      li.innerHTML =
        `<div><span class="gid">${escapeHtml(group.group_id)}</span>` +
        `<span class="sub muted">${escapeHtml(modeText)} · ${escapeHtml(fmtTime(group.latest_ts))}</span></div>` +
        `<span class="badge">${group.count} 张</span>`;
      li.addEventListener('click', () => selectGroup(group.group_id));
      list.appendChild(li);
    });
  }

  function renderMoveTargets() {
    const select = el('move-target');
    const previous = select.value;
    select.innerHTML = '<option value="">移动到…</option>';
    state.groups
      .filter((group) => group.group_id !== state.groupId)
      .forEach((group) => {
        const option = document.createElement('option');
        option.value = group.group_id;
        option.textContent = `${group.group_id}（${group.count} 张）`;
        select.appendChild(option);
      });
    if (previous && select.querySelector(`option[value="${previous}"]`)) select.value = previous;
  }

  async function selectGroup(groupId) {
    state.groupId = groupId;
    state.page = 1;
    state.selected.clear();
    state.keyword = '';
    el('search').value = '';
    renderGroups();
    renderMoveTargets();
    updateSelectionUi();
    await Promise.all([loadQuotes(), loadSettings(), loadSemanticStatus(), loadSent()]);
  }

  function resetMain() {
    state.items = [];
    state.total = 0;
    state.pages = 1;
    el('grid').innerHTML = '';
    el('grid-empty').classList.remove('hidden');
    el('grid-empty').textContent = '还没有任何群投稿过语录。';
    el('page-label').textContent = '-';
    el('settings-form').classList.add('hidden');
    el('settings-empty').classList.remove('hidden');
    el('settings-group').textContent = '未选择';
  }

  // ------------------------------------------------------------------ //
  // 语录列表
  // ------------------------------------------------------------------ //
  async function loadQuotes() {
    if (!state.groupId) return;
    state.pageSize = gridPageSize();
    state.loading = true;
    el('subtitle').textContent = `群 ${state.groupId} · 加载中…`;
    try {
      const useSearch =
        !!state.filterPerson ||
        !!state.filterTags ||
        !!state.filterRange ||
        (!!state.keyword && state.mode !== 'semantic');
      const data = useSearch
        ? await apiGet(EP.quotesSearch, {
            group_id: state.groupId,
            page: state.page,
            page_size: state.pageSize,
            q: state.keyword,
            tag: state.filterTags,
            person_id: state.filterPerson,
            assigned: state.subjectFilter,
            restricted: state.restrictedFilter,
            from_ts: state.filterRange
              ? Math.floor(Date.now() / 1000) - state.filterRange * 86400
              : 0,
            sort: state.sort,
          })
        : await apiGet(EP.quotes, {
            group_id: state.groupId,
            page: state.page,
            page_size: state.pageSize,
            sort: state.sort,
            q: state.keyword,
            mode: state.mode,
            min_score: state.minScore,
            assigned: state.subjectFilter,
            restricted: state.restrictedFilter,
          });
      state.items = data.items || [];
      state.total = data.total || 0;
      state.pages = data.pages || 1;
      state.totalBytes = data.total_bytes || 0;
      renderGrid();
      schedulePrefetch();
      const semanticNote = data.mode === 'semantic' && state.keyword ? ' · 语义检索' : '';
      el('subtitle').textContent =
        `${state.groups.length} 个群 · 当前群 ${state.groupId} · 共 ${state.total} 张${semanticNote}`;
    } catch (error) {
      toast('加载语录失败：' + (error && error.message ? error.message : error));
    } finally {
      state.loading = false;
    }
  }

  const GRID_MAX_COLS = 5;
  const GRID_ROWS_PER_PAGE = 3;
  const GRID_MIN_COL_W = 196;

  function gridColumns() {
    const grid = el('grid');
    const width = grid ? grid.clientWidth : 0;
    if (!width) return GRID_MAX_COLS;
    const cols = Math.floor((width + 14) / (GRID_MIN_COL_W + 14));
    return Math.max(1, Math.min(GRID_MAX_COLS, cols));
  }

  // 页大小 = 列数 × 3 排；5 列时最多 15 张，窄屏自动减少
  function gridPageSize() {
    return Math.max(GRID_ROWS_PER_PAGE, gridColumns() * GRID_ROWS_PER_PAGE);
  }

  let gridColsCache = 0;
  let gridResizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(gridResizeTimer);
    gridResizeTimer = setTimeout(() => {
      const cols = gridColumns();
      if (!state.groupId || cols === gridColsCache) return;
      gridColsCache = cols;
      loadQuotes();
    }, 260);
  });

  const RENDER_CHUNK = 12;
  const modalCacheAt = new Map();
  let renderCursor = 0;
  let renderSentinel = null;
  let renderMoreObserver = null;

  function modalFresh(key, ttl) {
    const at = modalCacheAt.get(key) || 0;
    return Date.now() - at < ttl;
  }

  function markModalFresh(key) {
    modalCacheAt.set(key, Date.now());
  }

  function clearRenderMore() {
    if (renderMoreObserver) {
      renderMoreObserver.disconnect();
      renderMoreObserver = null;
    }
    if (renderSentinel && renderSentinel.parentNode) {
      renderSentinel.parentNode.removeChild(renderSentinel);
    }
    renderSentinel = null;
  }

  function armRenderMore() {
    if (renderSentinel) return;
    const grid = el('grid');
    renderSentinel = document.createElement('div');
    renderSentinel.className = 'grid-sentinel';
    grid.insertAdjacentElement('afterend', renderSentinel);
    if ('IntersectionObserver' in window) {
      renderMoreObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) appendRenderChunk();
        },
        { rootMargin: '800px' }
      );
      renderMoreObserver.observe(renderSentinel);
    }
  }

  function appendRenderChunk() {
    const grid = el('grid');
    if (!grid) return;
    const slice = state.items.slice(renderCursor, renderCursor + RENDER_CHUNK);
    if (!slice.length) {
      clearRenderMore();
      return;
    }
    const frag = document.createDocumentFragment();
    slice.forEach((item) => frag.appendChild(buildCard(item)));
    grid.appendChild(frag);
    renderCursor += slice.length;
    hydrateAvatars(grid);
    if (renderCursor >= state.items.length) {
      clearRenderMore();
      return;
    }
    armRenderMore();
    requestAnimationFrame(() => {
      if (
        renderSentinel &&
        renderSentinel.getBoundingClientRect().top < window.innerHeight + 800
      ) {
        appendRenderChunk();
      }
    });
  }

  function renderGrid() {
    const grid = el('grid');
    clearRenderMore();
    grid.innerHTML = '';
    el('grid-empty').classList.toggle('hidden', state.items.length > 0);
    el('grid-empty').textContent = state.keyword ? '没有匹配的语录。' : '这里还没有语录。';
    el('page-label').textContent = `第 ${state.page} / ${state.pages} 页 · ${state.total} 张 · ${fmtBytes(state.totalBytes)}`;
    el('btn-prev').disabled = state.page <= 1;
    el('btn-next').disabled = state.page >= state.pages;
    renderCursor = 0;
    if (!renderGridVirtual()) {
      grid.style.gridTemplateColumns = `repeat(${gridColumns()}, minmax(0, 1fr))`;
      appendRenderChunk();
    }
  }

  // ------------------------------------------------------------------ //
  // 虚拟列表（v2.17.7）：固定行高 + 绝对定位，只为视口附近的卡片建 DOM
  // ------------------------------------------------------------------ //
  const VIRTUAL_MIN_ITEMS = 40;
  const VIRTUAL_BUFFER_ROWS = 2;
  const VIRTUAL_GAP = 14;
  const VIRTUAL_CARD_H = 324;
  const VIRTUAL_THUMB_H = 160;
  const VIRTUAL_MIN_COL_W = 196;
  let vRows = new Map();
  let vState = null;
  let vRaf = 0;
  let vResizeTimer = 0;

  function vMeasure() {
    const grid = el('grid');
    if (!grid) return null;
    const width = grid.clientWidth || 0;
    if (!width) return null;
    const cols = Math.max(
      1,
      Math.min(
        GRID_MAX_COLS,
        Math.floor((width + VIRTUAL_GAP) / (VIRTUAL_MIN_COL_W + VIRTUAL_GAP))
      )
    );
    const cardW = (width - VIRTUAL_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(state.items.length / cols) || 0;
    return { width, cols, cardW, rows };
  }

  function vRenderRange(m) {
    const grid = el('grid');
    if (!grid || !vState) return;
    const rowH = VIRTUAL_CARD_H + VIRTUAL_GAP;
    const top = grid.getBoundingClientRect().top;
    const offset = Math.max(0, -top);
    const viewH = window.innerHeight || 800;
    const r0 = Math.max(0, Math.floor(offset / rowH) - VIRTUAL_BUFFER_ROWS);
    const r1 = Math.min(
      m.rows - 1,
      Math.floor((offset + viewH) / rowH) + VIRTUAL_BUFFER_ROWS
    );
    if (vState.lastR0 === r0 && vState.lastR1 === r1) return;
    vState.lastR0 = r0;
    vState.lastR1 = r1;
    for (const [row, nodes] of vRows) {
      if (row < r0 || row > r1) {
        nodes.forEach((node) => node.remove());
        vRows.delete(row);
      }
    }
    for (let row = r0; row <= r1; row++) {
      if (vRows.has(row)) continue;
      const nodes = [];
      const frag = document.createDocumentFragment();
      for (let col = 0; col < m.cols; col++) {
        const index = row * m.cols + col;
        if (index >= state.items.length) break;
        const card = buildCard(state.items[index]);
        card.style.position = 'absolute';
        card.style.width = m.cardW + 'px';
        card.style.height = VIRTUAL_CARD_H + 'px';
        card.style.left = col * (m.cardW + VIRTUAL_GAP) + 'px';
        card.style.top = row * rowH + 'px';
        frag.appendChild(card);
        nodes.push(card);
      }
      grid.appendChild(frag);
      vRows.set(row, nodes);
    }
    hydrateAvatars(grid);
  }

  function vScheduleRender() {
    if (vRaf) return;
    vRaf = requestAnimationFrame(() => {
      vRaf = 0;
      if (!vState) return;
      const m = vMeasure();
      if (!m) return;
      if (m.cols !== vState.cols || Math.abs(m.width - vState.width) > 1) {
        vRebuild();
        return;
      }
      vRenderRange(m);
    });
  }

  function vRebuild() {
    if (!vState) return;
    const grid = el('grid');
    const m = vMeasure();
    if (!grid || !m) return;
    Object.assign(vState, m);
    for (const nodes of vRows.values()) nodes.forEach((node) => node.remove());
    vRows = new Map();
    const height = m.rows * (VIRTUAL_CARD_H + VIRTUAL_GAP) - VIRTUAL_GAP;
    grid.style.height = Math.max(0, height) + 'px';
    vState.lastR0 = -1;
    vState.lastR1 = -1;
    vRenderRange(m);
  }

  function vClear() {
    if (vResizeTimer) {
      clearTimeout(vResizeTimer);
      vResizeTimer = 0;
    }
    if (vState) {
      window.removeEventListener('scroll', vState.onScroll);
      window.removeEventListener('resize', vState.onResize);
    }
    vState = null;
    vRows = new Map();
    const grid = el('grid');
    if (grid) {
      grid.classList.remove('grid-virtual');
      grid.style.height = '';
      grid.style.removeProperty('--v-thumb-h');
    }
  }

  function renderGridVirtual() {
    const grid = el('grid');
    if (!grid || state.items.length < VIRTUAL_MIN_ITEMS) {
      vClear();
      return false;
    }
    vClear();
    const m = vMeasure();
    if (!m || !m.rows) return false;
    vState = Object.assign({}, m);
    vState.onScroll = () => vScheduleRender();
    vState.onResize = () => {
      clearTimeout(vResizeTimer);
      vResizeTimer = setTimeout(() => {
        if (vState) vRebuild();
      }, 160);
    };
    grid.classList.add('grid-virtual');
    grid.style.setProperty('--v-thumb-h', VIRTUAL_THUMB_H + 'px');
    grid.style.height =
      Math.max(0, m.rows * (VIRTUAL_CARD_H + VIRTUAL_GAP) - VIRTUAL_GAP) + 'px';
    window.addEventListener('scroll', vState.onScroll, { passive: true });
    window.addEventListener('resize', vState.onResize);
    vRenderRange(m);
    return true;
  }

  function buildCard(item) {
    const card = document.createElement('figure');
    card.className = 'card' + (state.selected.has(item.name) ? ' selected' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.name);
    checkbox.title = item.name;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.name);
      else state.selected.delete(item.name);
      card.classList.toggle('selected', checkbox.checked);
      updateSelectionUi();
    });

    const image = document.createElement('img');
    image.className = 'thumb';
    image.alt = item.name;
    image.loading = 'lazy';
    image.addEventListener('click', () => openLightbox(item));

    const caption = document.createElement('figcaption');
    caption.className = 'meta';
    const who = document.createElement('div');
    who.className = 'who subject-who';
    const assigned = isSubjectAssigned(item);
    if (item.subject_avatar_sha) {
      who.appendChild(avatarNode(item.subject_avatar_sha, 'card-avatar'));
    } else if (!assigned) {
      who.appendChild(avatarNode('', 'card-avatar'));
    }
    const whoText = document.createElement('span');
    whoText.textContent = assigned ? subjectLabel(item) : (subjectLabel(item) || '未指定归属');
    if (!assigned) whoText.className = 'subject-unassigned';
    who.appendChild(whoText);
    who.title = assigned ? '语录归属人物（点此修改）' : '点此指定语录归属人物';
    who.addEventListener('click', () => openAssign('single', [item.name]));
    caption.appendChild(who);
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(item.ts)} · ${fmtBytes(item.size)}`;
    caption.appendChild(when);
    if (item.caption) {
      const tagline = document.createElement('div');
      tagline.className = 'tagline';
      tagline.textContent = item.caption;
      caption.appendChild(tagline);
    }
    if (item.user_id) {
      const byLine = document.createElement('div');
      byLine.className = 'byline';
      byLine.textContent = '投稿：' + whoLabel(item);
      caption.appendChild(byLine);
    }
    caption.insertAdjacentHTML('beforeend', semanticLine(item));

    card.appendChild(checkbox);
    card.appendChild(image);
    card.appendChild(caption);
    if (item.restricted) {
      const flag = document.createElement('span');
      flag.className = 'restricted-flag';
      flag.textContent = '限制级';
      card.appendChild(flag);
    }

    if (item.score != null) {
      const score = document.createElement('span');
      score.className = 'semscore';
      score.textContent = '相似 ' + Number(item.score).toFixed(3);
      score.title = '向量相似度';
      card.appendChild(score);
    }

    const task = async () => {
      const mode = state.thumbAvailable ? 'thumb' : 'original';
      const cacheKey = thumbCacheKey(state.groupId, item.name, mode);
      try {
        const cached = thumbCacheGet(cacheKey);
        if (cached) {
          image.src = cached;
          return;
        }
        const url = await fetchThumbBatched(state.groupId, item.name, mode);
        image.src = url;
      } catch (error) {
        if (state.thumbAvailable) {
          state.thumbAvailable = false;
          el('badge-thumb').classList.add('hidden');
          try {
            const fallback = await apiGet(EP.image, {
              group_id: state.groupId,
              name: item.name,
              size: 'original',
            });
            image.src = fallback.data_url;
            return;
          } catch (inner) {
            /* 落到下面的失败提示 */
          }
        }
        image.alt = '加载失败：' + item.name;
      }
    };

    if (observer) {
      image.__thumbTask = task;
      observer.observe(image);
    } else {
      enqueueThumb(task);
    }
    return card;
  }

  function updateSelectionUi() {
    el('selection-count').textContent = `已选 ${state.selected.size}`;
    el('btn-assign').disabled = state.selected.size === 0;
    const addToCollection = el('btn-add-to-collection');
    if (addToCollection) addToCollection.disabled = state.selected.size === 0;
    const markRestrictedBtn = el('btn-mark-restricted');
    if (markRestrictedBtn) markRestrictedBtn.disabled = state.selected.size === 0;
    const unmarkRestrictedBtn = el('btn-unmark-restricted');
    if (unmarkRestrictedBtn) unmarkRestrictedBtn.disabled = state.selected.size === 0;
  }

  async function openLightbox(item, groupId) {
    const box = el('lightbox');
    const img = el('lightbox-img');
    const gid = groupId || state.groupId;
    state.lightboxItem = item;
    state.lightboxGroupId = gid;
    img.src = '';
    el('lightbox-meta').textContent = '正在加载原图…';
    box.classList.remove('hidden');
    try {
      const data = await apiGet(EP.image, {
        group_id: gid,
        name: item.name,
        size: 'original',
      });
      img.src = data.data_url;
      const size = data.width && data.height ? `${data.width}×${data.height} · ` : '';
      const subject = isSubjectAssigned(item)
        ? `归属：${subjectLabel(item)}（QQ ${item.subject_user_id}）`
        : item.subject_name
          ? `归属待确认：${item.subject_name}`
          : '归属：未指定';
      let text =
        `${subject} · ${fmtTime(item.ts)} · ${size}${fmtBytes(item.size)} · ${item.name}`;
      if (item.user_id) text += `\n投稿人：${whoLabel(item)}（QQ ${item.user_id}）`;
      if (item.caption) text += `\n描述：${item.caption}`;
      if (item.tags && item.tags.length) text += `\n标签：${item.tags.join('、')}`;
      if (item.semantic_text) text += `\n图中文字：${item.semantic_text}`;
      if (item.score != null) text += `\n相似度：${Number(item.score).toFixed(4)}`;
      el('lightbox-meta').textContent = text;
    } catch (error) {
      el('lightbox-meta').textContent = '加载失败：' + (error && error.message ? error.message : error);
    }
  }

  function closeLightbox() {
    el('lightbox').classList.add('hidden');
    el('lightbox-img').src = '';
    state.lightboxItem = null;
    state.lightboxGroupId = '';
  }

  // ------------------------------------------------------------------ //
  // 批量操作
  // ------------------------------------------------------------------ //
  async function deleteSelected() {
    const names = Array.from(state.selected);
    if (!names.length) {
      toast('请先选择要删除的语录');
      return;
    }
    if (!(await uiConfirm(`确定删除选中的 ${names.length} 张语录吗？此操作不可恢复。`))) return;
    try {
      const result = await apiPost(EP.deleteQuotes, { group_id: state.groupId, names });
      toast(`已删除 ${(result.deleted || []).length} 张`);
      state.selected.clear();
      updateSelectionUi();
      await loadOverview();
      await loadQuotes();
    } catch (error) {
      toast('删除失败：' + (error && error.message ? error.message : error));
    }
  }

  async function moveSelected() {
    const names = Array.from(state.selected);
    const target = el('move-target').value;
    if (!names.length) {
      toast('请先选择要移动的语录');
      return;
    }
    if (!target) {
      toast('请先选择目标群');
      return;
    }
    if (!(await uiConfirm(`把选中的 ${names.length} 张语录移动到 ${target}？`))) return;
    try {
      const result = await apiPost(EP.moveQuotes, {
        from_group: state.groupId,
        to_group: target,
        names,
      });
      toast(`已移动 ${(result.moved || []).length} 张到 ${target}`);
      state.selected.clear();
      updateSelectionUi();
      await loadOverview();
      await loadQuotes();
    } catch (error) {
      toast('移动失败：' + (error && error.message ? error.message : error));
    }
  }

  async function deleteWholeGroup() {
    if (!state.groupId) return;
    if (!(await uiConfirm(`确定清空群 ${state.groupId} 的全部语录吗？此操作不可恢复！`))) return;
    if (!(await uiConfirm('再确认一次：目录会被整个删除。'))) return;
    try {
      const result = await apiPost(EP.deleteGroup, { group_id: state.groupId, confirm: true });
      toast(`已清空 ${result.deleted || 0} 张语录`);
      state.groupId = null;
      state.selected.clear();
      updateSelectionUi();
      await loadOverview();
    } catch (error) {
      toast('清空失败：' + (error && error.message ? error.message : error));
    }
  }

  // ------------------------------------------------------------------ //
  // 群设置
  // ------------------------------------------------------------------ //
  async function loadSettings() {
    if (!state.groupId) return;
    try {
      const data = await apiGet(EP.settings, { group_id: state.groupId });
      state.settings = data;
      el('settings-form').classList.remove('hidden');
      el('settings-empty').classList.add('hidden');
      el('settings-group').textContent = '群 ' + state.groupId;
      const radios = document.querySelectorAll('input[name="mode"]');
      radios.forEach((radio) => {
        radio.checked = Number(radio.value) === Number(data.mode);
      });
      el('set-coldown').value = data.coldown;
      el('set-prob').value = data.poke_prob;
      el('set-remember').checked = data.remember !== false;
      el('set-recall').checked = data.recall !== false;
      el('set-auto-recall').checked = data.auto_recall === true;
      el('set-auto-tag').checked = data.auto_tag !== false;
      el('set-trash-days').value = Number(data.trash_keep_days || 30);
      el('set-alias-learn').checked = data.alias_learn !== false;
      el('set-alias-every').value = Number(data.alias_learn_every || 40);
      el('set-auto-semantic').checked = data.auto_semantic !== false;
      el('set-auto-semantic-hours').value = Number(data.auto_semantic_hours || 24);
      el('set-auto-rating').checked = data.auto_rating !== false;
      el('set-allow-restricted').checked = !!data.allow_restricted;
    } catch (error) {
      toast('读取群设置失败：' + (error && error.message ? error.message : error));
    }
  }

  async function rebindQuotes() {
    const ok = await uiConfirm(
      '将按「俗名 → QQ 当前昵称」重新核对所有语录的归属，并刷新语义索引里的 speaker。\n' +
        '语录较多时可能需要几秒，开始吗？',
      { okText: '开始重填' }
    );
    if (!ok) return;
    toast('正在重填全部归属…');
    try {
      const data = await apiPost(EP.quotesRebind, {});
      toast(
        `重填完成：扫描 ${data.scanned} 条 / 新归属 ${data.assigned} 条 / 改名 ${data.renamed} 条` +
          ` / 语义 ${data.semantic} 条`
      );
      await loadOverview();
      if (state.groupId) {
        try {
          await loadQuotes();
        } catch (_) {
          /* ignore */
        }
      }
    } catch (error) {
      toast('重填失败：' + (error && error.message ? error.message : error));
    }
  }

  async function markRestricted(value) {
    if (!state.groupId || state.selected.size === 0) return;
    const names = Array.from(state.selected);
    try {
      const data = await apiPost(EP.quotesRestricted, {
        group_id: state.groupId,
        names,
        restricted: value,
      });
      toast(`${value ? '已标为限制级' : '已取消限制级'} ${data.updated} 条`);
      state.selected.clear();
      updateSelectionUi();
      await loadQuotes();
    } catch (error) {
      toast('标记失败：' + (error && error.message ? error.message : error));
    }
  }

  async function scanRating() {
    const ok = await uiConfirm(
      '将按描述/标签关键词重新识别全部语录的限制级标记（手动标记的不会被覆盖）。开始吗？',
      { okText: '开始识别' }
    );
    if (!ok) return;
    toast('正在识别限制级…');
    try {
      const data = await apiPost(EP.quotesAutoRating, {
        group_id: state.groupId,
        overwrite: false,
      });
      toast(
        `识别完成：扫描 ${data.scanned} / 更新 ${data.updated} / 限制级 ${data.restricted} 条`
      );
      await loadQuotes();
    } catch (error) {
      toast('识别失败：' + (error && error.message ? error.message : error));
    }
  }

  async function saveSettings() {
    if (!state.groupId) return;
    const checked = document.querySelector('input[name="mode"]:checked');
    const body = {
      group_id: state.groupId,
      mode: checked ? Number(checked.value) : 0,
      coldown: Number(el('set-coldown').value || 0),
      poke_prob: Number(el('set-prob').value || 0),
      remember: !!el('set-remember').checked,
      recall: !!el('set-recall').checked,
      auto_recall: !!el('set-auto-recall').checked,
      auto_tag: !!el('set-auto-tag').checked,
      trash_keep_days: Number(el('set-trash-days').value || 30),
      alias_learn: !!el('set-alias-learn').checked,
      alias_learn_every: Number(el('set-alias-every').value || 40),
      auto_semantic: !!el('set-auto-semantic').checked,
      auto_semantic_hours: Number(el('set-auto-semantic-hours').value || 24),
      auto_rating: !!el('set-auto-rating').checked,
        allow_restricted: !!el('set-allow-restricted').checked,
    };
    try {
      const data = await apiPost(EP.settings, body);
      toast(
        `设置已保存（权限 ${data.mode} / 冷却 ${data.coldown}s / 概率 ${data.poke_prob}` +
          `${data.remember === false ? ' / 不记忆语录' : ' / 记忆语录'}` +
          `${data.recall === false ? ' / 不召回语录' : ' / 可召回语录'}` +
          `${data.auto_recall === true ? ' / 自动补发' : ''}）`
      );
      await loadOverview();
    } catch (error) {
      toast('保存失败：' + (error && error.message ? error.message : error));
    }
  }

  // ------------------------------------------------------------------ //
  // 语义化（V2）
  // ------------------------------------------------------------------ //
  async function loadSemanticStatus() {
    try {
      const data = await apiGet(EP.semanticStatus, { group_id: state.groupId || '' });
      state.semantic = data;
      renderSemanticStatus();
    } catch (error) {
      el('semantic-status').textContent =
        '读取语义状态失败：' + (error && error.message ? error.message : error);
    }
  }

  function renderSemanticStatus() {
    const data = state.semantic;
    if (!data) return;
    const provider = el('semantic-provider');
    const embedding = data.embedding || {};
    if (embedding.ready) {
      provider.className = 'badge ok';
      provider.textContent = `向量 ${embedding.model || embedding.id} · ${embedding.dimension} 维`;
    } else {
      provider.className = 'badge err';
      provider.textContent = '未找到向量模型';
    }

    const totals = data.totals || {};
    const group = state.groupId
      ? (data.groups || []).find((item) => item.group_id === state.groupId)
      : null;
    if (group) {
      el('semantic-group-line').textContent =
        `语义索引：已处理 ${group.done} · 待处理 ${group.pending} · 失败 ${group.failed}` +
        (group.vectorless ? ` · 无向量 ${group.vectorless}` : '') +
        (group.stale ? ` · 维度过期 ${group.stale}` : '');
    } else {
      el('semantic-group-line').textContent =
        `语义索引：已处理 ${totals.done || 0} · 待处理 ${totals.pending || 0} · 失败 ${totals.failed || 0}`;
    }

    if (!data.caption_provider_id) {
      el('semantic-status').textContent =
        '未配置视觉模型：请先在 AstrBot 的模型设置里指定图片描述模型。';
    } else if (!data.task || !data.task.running) {
      el('semantic-status').textContent =
        `视觉模型 ${data.caption_provider_id} · 共 ${totals.total || 0} 张，` +
        `待处理 ${totals.pending || 0} 张，失败 ${totals.failed || 0} 张。`;
    }
    renderTask(data.task);
    if (data.task && data.task.running) startTaskPolling();
  }

  function renderTask(task) {
    const running = !!(task && task.running);
    const total = Number((task && task.total) || 0);
    const processed = Number((task && task.processed) || 0);
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const fill = el('semantic-bar');
    fill.style.width = percent + '%';
    fill.classList.toggle('running', running);
    el('btn-semantic-run').disabled = running;
    el('btn-semantic-cancel').classList.toggle('hidden', !running);
    if (running) {
      el('semantic-status').textContent =
        `语义化进行中：${processed}/${total}（成功 ${task.ok || 0}，失败 ${task.failed || 0}）` +
        (task.current ? ` · 当前 ${task.current}` : '');
    } else if (task && task.finished_at) {
      el('semantic-status').textContent =
        `上次语义化：共 ${task.total || 0} 张，成功 ${task.ok || 0}，失败 ${task.failed || 0}` +
        (task.error ? ` · 错误 ${task.error}` : '');
    }
  }

  function stopTaskPolling() {
    if (state.taskTimer) {
      clearInterval(state.taskTimer);
      state.taskTimer = null;
    }
  }

  function startTaskPolling() {
    if (state.taskTimer) return;
    state.taskTimer = setInterval(async () => {
      try {
        const data = await apiGet(EP.semanticProgress);
        state.task = data.task || null;
        renderTask(state.task);
        if (!state.task || !state.task.running) {
          stopTaskPolling();
          await loadSemanticStatus();
          await loadOverview();
          await loadQuotes();
          toast('语义化任务已结束');
        }
      } catch (error) {
        stopTaskPolling();
      }
    }, TASK_POLL_MS);
  }

  async function runSemantic() {
    const scope = el('semantic-scope').value || 'pending';
    const target = state.groupId || '';
    const label = target ? `群 ${target}` : '全部群';
    if (!(await uiConfirm(`对${label}执行一键语义化（范围：${scope}）？会调用视觉与向量模型，耗时取决于图片数量。`))) {
      return;
    }
    try {
      const data = await apiPost(EP.semanticRun, { group_id: target, scope });
      state.task = data.task || null;
      renderTask(state.task);
      toast('语义化任务已启动');
      startTaskPolling();
    } catch (error) {
      toast('启动失败：' + (error && error.message ? error.message : error));
    }
  }

  async function cancelSemantic() {
    try {
      const data = await apiPost(EP.semanticRun, { action: 'cancel' });
      state.task = data.task || state.task;
      renderTask(state.task);
      toast('已请求取消，等待当前批次结束');
    } catch (error) {
      toast('取消失败：' + (error && error.message ? error.message : error));
    }
  }

  async function resetSemantic() {
    if (!state.groupId) {
      toast('请先选择一个群');
      return;
    }
    if (!(await uiConfirm(`清空群 ${state.groupId} 的语义索引吗？（语录图片不会被删除）`))) return;
    try {
      const data = await apiPost(EP.semanticReset, { group_id: state.groupId, confirm: true });
      toast(`已清空 ${data.cleared || 0} 条语义索引`);
      await loadSemanticStatus();
      await loadQuotes();
    } catch (error) {
      toast('清空失败：' + (error && error.message ? error.message : error));
    }
  }

  // ------------------------------------------------------------------ //
  // 发送记忆（V3）
  // ------------------------------------------------------------------ //
  async function loadSent() {
    try {
      const data = await apiGet(EP.sent, { group_id: state.groupId || '' });
      state.sent = data;
      renderSentStatus();
    } catch (error) {
      el('sent-line').textContent = '发送记忆：读取失败';
    }
  }

  function renderSentStatus() {
    const data = state.sent || {};
    const scope = state.groupId ? `群 ${state.groupId}` : '全部会话';
    let text = `发送记忆（${scope}）：已记录 ${data.total || 0} 条`;
    if (data.pending) text += ` · 待注入 ${data.pending} 条`;
    const hours = data.max_age ? Math.round(data.max_age / 3600) : 6;
    text += ` · 上限 ${data.keep || 5} 条 / ${hours} 小时`;
    el('sent-line').textContent = text;
  }

  async function clearSent() {
    const scope = state.groupId ? `群 ${state.groupId}` : '全部会话';
    if (!(await uiConfirm(`确定清空${scope}的发送记忆吗？`))) return;
    try {
      const data = await apiPost(EP.sent, { group_id: state.groupId || '' });
      toast(`已清空 ${data.cleared || 0} 条发送记忆`);
      await loadSent();
      await loadTagStatus();
      await loadFilterPeople();
    } catch (error) {
      toast('清空失败：' + (error && error.message ? error.message : error));
    }
  }

  function applySemanticMode() {
    state.mode = el('semantic-mode').checked ? 'semantic' : 'browse';
    const on = state.mode === 'semantic';
    el('search').placeholder = on
      ? '语义检索：描述你想要的画面 / 台词，回车搜索…'
      : '搜索投稿人 / 文件名 / 标签 / 图中文字…';
    el('min-score-wrap').classList.toggle('hidden', !on);
    el('min-score').value = state.minScore;
  }

  // ------------------------------------------------------------------ //
  // 语录归属：把语录指定给「被拍的那个人」
  // ------------------------------------------------------------------ //
  function openAssign(mode, names) {
    const list = (names || []).filter(Boolean);
    if (!list.length) {
      toast('请先选择语录');
      return;
    }
    state.assign = { open: true, mode, names: list, q: '', items: [], loading: false };
    el('assign-target').textContent =
      mode === 'multi'
        ? `为选中的 ${list.length} 张语录指定归属人物：`
        : '为这条语录指定归属人物：';
    el('assign-search').value = '';
    el('assign-modal').classList.remove('hidden');
    loadAssignCandidates();
    el('assign-search').focus();
  }

  function closeAssign() {
    state.assign.open = false;
    el('assign-modal').classList.add('hidden');
  }

  async function loadAssignCandidates() {
    if (!state.assign.open) return;
    const list = el('assign-list');
    list.innerHTML = '<p class="muted hint">读取人物…</p>';
    state.assign.loading = true;
    try {
      const data = await apiGet(EP.identityList, {
        q: state.assign.q,
        group_id: state.groupId || '',
        page: 1,
        page_size: 60,
      });
      state.assign.items = data.items || [];
      renderAssignList();
    } catch (error) {
      list.innerHTML =
        `<p class="muted hint">读取失败：${escapeHtml(error && error.message ? error.message : error)}</p>`;
    } finally {
      state.assign.loading = false;
    }
  }

  function renderAssignList() {
    const list = el('assign-list');
    list.innerHTML = '';
    const clearRow = document.createElement('button');
    clearRow.type = 'button';
    clearRow.className = 'assign-row assign-clear';
    clearRow.textContent = '清除归属（把语录标记为未指定）';
    clearRow.addEventListener('click', () => assignToTarget({ clear: true }));
    list.appendChild(clearRow);
    const rows = state.assign.items;
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted hint';
      empty.textContent = '没有找到人物；可以先在「语录人物」里同步身份。';
      list.appendChild(empty);
      return;
    }
    rows.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'assign-row';
      row.appendChild(avatarNode(item.avatar_sha, 'assign-avatar'));
      const info = document.createElement('div');
      info.className = 'assign-info';
      const uids = (item.user_ids || []).join(' / ');
      info.innerHTML =
        `<div class="person-name">${escapeHtml(personLabel(item))}</div>` +
        `<div class="person-meta">QQ ${escapeHtml(uids)} · ${item.quote_count || 0} 条语录</div>`;
      row.appendChild(info);
      row.addEventListener('click', () =>
        assignToTarget({ person_id: item.person_id, display_name: personLabel(item) })
      );
      list.appendChild(row);
      hydrateAvatars(row);
    });
  }

  async function assignToTarget(target) {
    const names = state.assign.names.slice();
    if (!names.length) return;
    const gid = state.lightboxGroupId || state.groupId;
    try {
      if (target && target.clear) {
        await apiPost(EP.quotesSubject, { group_id: gid, names, clear: true });
        toast(`已清除 ${names.length} 张语录的归属`);
      } else if (state.assign.mode === 'cluster') {
        const body = { group_id: gid, names };
        if (target.person_id) body.person_id = target.person_id;
        else if (target.user_id) body.user_id = target.user_id;
        const result = await apiPost(EP.identityClusterMerge, body);
        toast(
          `已把 ${(result.names || names).length} 个昵称变体归并到「${result.display_name || '人物'}」，` +
            `${result.updated || 0} 条语录归到一处，并记住这些昵称`
        );
      } else if (state.assign.mode === 'name') {
        const body = { subject_name: state.assign.targetName };
        if (target.person_id) body.person_id = target.person_id;
        else if (target.user_id) body.user_id = target.user_id;
        if (gid) body.group_id = gid;
        const result = await apiPost(EP.quotesBindName, body);
        toast(
          `已把「${result.subject_name}」名下 ${result.updated} 条语录归到「${result.display_name}」，并记住这个昵称`
        );
      } else {
        const body = { group_id: gid, names };
        if (target.person_id) body.person_id = target.person_id;
        else if (target.user_id) body.user_id = target.user_id;
        const result = await apiPost(EP.quotesSubject, body);
        toast(
          `已把 ${result.updated || names.length} 张语录归到「${result.display_name || '人物'}」`
        );
      }
      closeAssign();
      closeLightbox();
      state.selected.clear();
      updateSelectionUi();
      await loadQuotes();
      if (state.people.open) await loadPeople();
    } catch (error) {
      toast('指定归属失败：' + (error && error.message ? error.message : error));
    }
  }

  function openReview() {
    if (!state.groupId) {
      toast('先选择一个群');
      return;
    }
    state.assign = {
      open: true,
      mode: 'review',
      names: [],
      q: '',
      items: [],
      loading: false,
      targetName: '',
    };
    el('assign-target').textContent =
      '待确认归属：点一个截图昵称，再把 TA 名下的语录批量归到某个人物。';
    el('assign-search').value = '';
    el('assign-modal').classList.remove('hidden');
    loadReviewNames();
  }

  async function loadReviewNames() {
    const list = el('assign-list');
    list.innerHTML = '<p class="muted hint">读取待确认归属…</p>';
    try {
      const data = await apiGet(EP.quotesReview, {
        group_id: state.groupId || '',
        limit: 120,
      });
      state.assign.items = data.items || [];
      list.innerHTML = '';
      const head = document.createElement('p');
      head.className = 'muted hint';
      head.textContent =
        `共 ${data.total_names || 0} 个截图昵称、${data.total_quotes || 0} 条语录待确认。` +
        '点昵称 → 选人物，即可批量归属并记住这个昵称。';
      list.appendChild(head);
      try {
        const clusterData = await apiGet(EP.identityClusters, {
          group_id: state.groupId || '',
          limit: 40,
        });
        const groups = (clusterData.items || []).filter(
          (item) => (item.names || []).length >= 2
        );
        if (groups.length) {
          const title = document.createElement('p');
          title.className = 'muted hint cluster-title';
          title.textContent =
            `另外发现 ${groups.length} 组「同一人被读错」的形近昵称，点一下就能直接归并：`;
          list.appendChild(title);
          groups.forEach((cluster) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'assign-row cluster-row';
            const info = document.createElement('div');
            info.className = 'assign-info';
            info.innerHTML =
              `<div class="person-name">${escapeHtml(cluster.display_name || cluster.keep || '')}</div>` +
              `<div class="person-meta cluster-meta">${(cluster.names || [])
                .map((name) => escapeHtml(name))
                .join(' / ')} · ${cluster.quote_count || 0} 条 · 点此一键归并</div>`;
            row.appendChild(info);
            row.addEventListener('click', () => mergeCluster(cluster));
            list.appendChild(row);
          });
        }
      } catch (clusterError) {
        /* 聚类只是加分项，失败不影响待确认列表 */
      }
      if (!state.assign.items.length) {
        const empty = document.createElement('p');
        empty.className = 'muted hint';
        empty.textContent = '没有待确认的归属；可以先点「按语义回填归属」。';
        list.appendChild(empty);
        return;
      }
      state.assign.items.forEach((row) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'assign-row';
        const info = document.createElement('div');
        info.className = 'assign-info';
        info.innerHTML =
          `<div class="person-name">${escapeHtml(row.subject_name)}</div>` +
          `<div class="person-meta">${row.count || 0} 条 · 群 ${escapeHtml((row.groups || []).join('、'))}</div>`;
        btn.appendChild(info);
        btn.addEventListener('click', async () => {
          state.assign.names = [row.subject_name];
          state.assign.targetName = row.subject_name;
          state.assign.mode = 'name';
          el('assign-target').textContent =
            `把昵称「${row.subject_name}」下的 ${row.count || 0} 条语录归到：`;
          el('assign-search').value = '';
          state.assign.q = '';
          await loadAssignCandidates();
        });
        list.appendChild(btn);
      });
    } catch (error) {
      list.innerHTML =
        `<p class="muted hint">读取失败：${escapeHtml(error && error.message ? error.message : error)}</p>`;
    }
  }

  async function mergeCluster(cluster) {
    const names = (cluster.names || []).slice();
    if (!names.length) return;
    const who = cluster.display_name || cluster.keep || '该人物';
    const ok = await uiConfirm(
      `把下面 ${names.length} 个「看起来同一个人」的昵称归并到「${who}」？

` +
        names.join(' / ') +
        `

会把这 ${cluster.quote_count || 0} 条语录归到同一个档案，并记住这些昵称（之后同昵称直接识别）。`
    );
    if (!ok) return;
    try {
      const body = { group_id: state.groupId || '', names };
      if (cluster.person_id) body.person_id = cluster.person_id;
      else if (cluster.user_id) body.user_id = cluster.user_id;
      const result = await apiPost(EP.identityClusterMerge, body);
      toast(
        `已归并 ${names.length} 个昵称到「${result.display_name || who}」，` +
          `${result.updated || 0} 条语录归到一处`
      );
      await loadReviewNames();
      if (state.people.open) await loadPeople();
    } catch (error) {
      toast('归并失败：' + (error && error.message ? error.message : error));
    }
  }

  async function tidyAliases() {
    const btn = el('btn-people-tidy');
    const groupId = state.groupId || '';
    btn.disabled = true;
    try {
      const preview = await apiPost(EP.identityCleanup, { group_id: groupId, dry_run: true });
      const samples = (preview.samples || []).slice(0, 8).join('、');
      const message =
        `整理旧昵称会影响已归属语录的别名表：
` +
        `· 把 ${preview.bound_quotes || 0} 条语录的截图昵称迁入别名表` +
        `（${preview.alias_names || 0} 个昵称 / ${preview.alias_users || 0} 个 QQ 号）
` +
        `· 清理 ${preview.drop_names || 0} 个疑似被读错的形近昵称
` +
        `· 屏蔽 ${preview.title_aliases || 0} 个群头衔/等级昵称，解除 ${preview.title_quotes || 0} 条错误归属
` +
        (samples ? `
样例：${samples}
` : '') +
        `
是否执行？（只影响别名与绑定关系，不删除语录）`;
      if (!(await uiConfirm(message))) return;
      const result = await apiPost(EP.identityCleanup, { group_id: groupId, dry_run: false });
      toast(
        `整理完成：迁移 ${result.bound_quotes || 0} 条、新增 ${result.alias_names || 0} 个别名、` +
          `清理 ${result.drop_names || 0} 个昵称、屏蔽头衔 ${result.titles_cleaned || 0} 个并解绑 ${result.quotes_unbound || 0} 条`
      );
      if (state.people.open) await loadPeople();
      if (!el('assign-modal').classList.contains('hidden')) await loadReviewNames();
    } catch (error) {
      toast('整理旧别名失败：' + (error && error.message ? error.message : error));
    } finally {
      btn.disabled = false;
    }
  }

  async function clearLightboxSubject() {
    const item = state.lightboxItem;
    if (!item) {
      toast('先在列表里点开一条语录');
      return;
    }
    if (!(await uiConfirm('清除这条语录的归属人物？'))) return;
    state.assign = {
      open: false,
      mode: 'single',
      names: [item.name],
      q: '',
      items: [],
      loading: false,
    };
    await assignToTarget({ clear: true });
  }

  async function backfillSubjects() {
    const btn = el('btn-people-backfill');
    btn.disabled = true;
    el('people-status').textContent = '正在按已有语义化结果回填语录归属（不调用视觉模型，较快）…';
    try {
      const data = await apiPost(EP.quotesAutoSubject, {
        group_id: state.groupId || '',
        limit: 200,
      });
      const pending = (data.ambiguous || 0) + (data.no_name || 0);
      toast(
        `回填完成：扫描 ${data.scanned} 条，自动归属 ${data.assigned} 条，` +
          `待确认 ${pending} 条，跳过 ${data.skipped} 条`
      );
      await loadPeople();
      if (state.groupId) await loadQuotes();
    } catch (error) {
      el('people-status').textContent =
        '回填失败：' + (error && error.message ? error.message : error);
    } finally {
      btn.disabled = false;
    }
  }

  async function backfillSpeakers() {
    const btn = el('btn-people-speaker');
    const ok = await uiConfirm(
      '把已归属人物的最新昵称写回每条语录的语义 speaker 吗？（不重算向量，速度很快；之后 AI 语义召回与昵称匹配都会用这个规范名）'
    );
    if (!ok) return;
    btn.disabled = true;
    el('people-status').textContent = '正在把人物档案写回语义 speaker…';
    try {
      const data = await apiPost(EP.semanticBackfillSpeaker, {
        group_id: state.groupId || '',
      });
      toast(
        `已回填 ${data.updated || 0} 条语义 speaker（已扫描 ${data.scanned || 0} 条，跳过 ${data.skipped || 0} 条）`
      );
      el('people-status').textContent = `语义 speaker 已回填 ${data.updated || 0} 条。`;
      if (state.people.open && state.people.detail) {
        await loadPersonDetail(state.people.detail.person_id);
      }
    } catch (error) {
      el('people-status').textContent =
        '回填失败：' + (error && error.message ? error.message : error);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ //
  // 人物档案
  // ------------------------------------------------------------------ //
  function personLabel(item) {
    if (item.display_name) return item.display_name;
    if (item.user_ids && item.user_ids.length) return 'QQ ' + item.user_ids[0];
    return '未知';
  }

  function closeOtherSheets(except) {
    const sheet = {
      people: ['people-modal', closePeople],
      stats: ['stats-modal', closeStats],
      collections: ['collections-modal', closeCollections],
      insights: ['insights-modal', closeInsights],
      trash: ['trash-modal', closeTrash],
      collab: ['collab-modal', closeCollab],
    };
    Object.keys(sheet).forEach((key) => {
      if (key === except) return;
      const item = sheet[key];
      const node = el(item[0]);
      if (node && !node.classList.contains('hidden')) item[1]();
    });
  }

  function openPeople() {
    closeOtherSheets('people');
    state.people.open = true;
    el('people-modal').classList.remove('hidden');
    if (state.people.items.length) renderPeople();
    else loadPeople();
    if (!modalFresh('people', 60000)) {
      loadIdentitySchedule();
      loadAliasCandidates();
      markModalFresh('people');
    }
  }

  function closePeople() {
    state.people.open = false;
    el('people-modal').classList.add('hidden');
  }

  async function loadAliasCandidates() {
    try {
      const data = await apiGet(EP.aliasCandidates, {
        group_id: state.groupId || '',
        status: 'pending',
        limit: 100,
      });
      state.aliases = data.items || [];
      renderAliasCandidates();
    } catch (error) {
      state.aliases = [];
      renderAliasCandidates();
      toast('读取待确认俗名失败：' + (error && error.message ? error.message : error));
    }
  }

  function renderAliasCandidates() {
    const list = el('alias-list');
    const items = state.aliases || [];
    list.innerHTML = '';
    el('alias-count').textContent = String(items.length);
    el('alias-empty').classList.toggle('hidden', items.length > 0);
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'alias-item';
      const main = document.createElement('div');
      main.className = 'alias-main';
      const name = document.createElement('span');
      name.className = 'alias-name';
      name.textContent = item.alias_name || '';
      const target = document.createElement('span');
      target.className = 'alias-target';
      target.textContent = '→ ' + (item.display_name || item.target_user_id || '');
      const conf = document.createElement('span');
      conf.className = 'badge muted';
      conf.textContent = Math.round(Number(item.confidence || 0) * 100) + '%';
      main.appendChild(name);
      main.appendChild(target);
      main.appendChild(conf);
      if (item.evidence) {
        const evidence = document.createElement('p');
        evidence.className = 'alias-evidence';
        evidence.textContent = '“' + item.evidence + '”';
        main.appendChild(evidence);
      }
      const actions = document.createElement('div');
      actions.className = 'alias-actions';
      const ok = document.createElement('button');
      ok.className = 'btn small';
      ok.type = 'button';
      ok.textContent = '确认';
      ok.dataset.aliasAction = 'confirm';
      ok.dataset.id = String(item.id);
      const no = document.createElement('button');
      no.className = 'btn ghost small';
      no.type = 'button';
      no.textContent = '忽略';
      no.dataset.aliasAction = 'reject';
      no.dataset.id = String(item.id);
      actions.appendChild(ok);
      actions.appendChild(no);
      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  async function confirmAlias(id) {
    try {
      await apiPost(EP.aliasConfirm, { id });
      toast('已确认俗名，之后会用这个称呼识别该群友');
      await loadAliasCandidates();
    } catch (error) {
      toast('确认失败：' + (error && error.message ? error.message : error));
    }
  }

  async function rejectAlias(id) {
    try {
      await apiPost(EP.aliasReject, { id });
      toast('已忽略这条候选');
      await loadAliasCandidates();
    } catch (error) {
      toast('忽略失败：' + (error && error.message ? error.message : error));
    }
  }

  async function learnAliasesNow() {
    if (!state.groupId) {
      toast('先在左侧选择一个群');
      return;
    }
    const button = el('btn-alias-learn');
    button.disabled = true;
    try {
      const data = await apiPost(EP.aliasLearn, { group_id: state.groupId });
      if (data && data.skipped) {
        const reasons = {
          not_due: '消息还不够多，稍后再试',
          too_few_messages: '最近消息太少，先聊几句',
          no_provider: '未配置可用的对话模型',
        };
        toast('这次没有学习：' + (reasons[data.reason] || data.reason || '未知原因'));
      } else {
        toast('学习完成：新增 ' + Number((data && data.added) || 0) + ' 条候选');
      }
      await loadAliasCandidates();
    } catch (error) {
      toast('学习失败：' + (error && error.message ? error.message : error));
    } finally {
      button.disabled = false;
    }
  }

  async function loadPeople() {
    if (state.people.loading) return;
    state.people.loading = true;
    el('people-status').textContent = '读取人物档案…';
    try {
      const data = await apiGet(EP.identityList, {
        q: state.people.q,
        group_id: state.groupId || '',
        page: state.people.page,
        page_size: state.people.pageSize,
      });
      state.people.items = data.items || [];
      state.people.total = data.total || 0;
      state.people.pages = data.pages || 1;
      renderPeople();
      const overview = await apiGet(EP.identityOverview).catch(() => null);
      if (overview) {
        el('people-count').textContent =
          `${overview.persons} 人 · ${overview.users} 个 QQ · ${overview.with_avatar} 张头像`;
        el('people-status').textContent =
          `按人物归纳语录：已归属 ${overview.assigned_quotes || 0} 条（${overview.quote_users || 0} 人）。` +
          `头像指纹（dHash）相似阈值 ${overview.threshold}，已命名 ${overview.named} 人；` +
          `点人物卡片可查看 TA 的全部语录与昵称/头像历史。` +
          (overview.updated_at ? ` 最近更新 ${fmtTime(overview.updated_at)}。` : '');
      }
    } catch (error) {
      el('people-status').textContent =
        '读取失败：' + (error && error.message ? error.message : error);
    } finally {
      state.people.loading = false;
    }
  }

  function renderPeople() {
    const grid = el('people-grid');
    grid.innerHTML = '';
    const items = state.people.items;
    el('people-empty').classList.toggle('hidden', items.length > 0);
    el('people-page-label').textContent =
      `第 ${state.people.page} / ${state.people.pages} 页 · ${state.people.total} 人`;
    el('people-prev').disabled = state.people.page <= 1;
    el('people-next').disabled = state.people.page >= state.people.pages;
    items.forEach((item) => grid.appendChild(buildPersonCard(item)));
    hydrateAvatars(grid);
    updatePeopleSelectionUi();
  }

  function buildPersonCard(item) {
    const userIds = item.user_ids || [];
    const allSelected = userIds.length > 0 && userIds.every((uid) => state.people.selected.has(uid));
    const card = document.createElement('div');
    card.className = 'person-card' + (allSelected ? ' selected' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = allSelected;
    checkbox.title = '勾选多个卡片后可合并为同一个人';
    checkbox.addEventListener('change', () => {
      userIds.forEach((uid) => {
        if (checkbox.checked) state.people.selected.add(uid);
        else state.people.selected.delete(uid);
      });
      card.classList.toggle('selected', checkbox.checked);
      updatePeopleSelectionUi();
    });

    const body = document.createElement('div');
    body.className = 'person-body';
    const groups = (item.groups || []).length;
    body.innerHTML =
      `<div class="person-name">${escapeHtml(personLabel(item))}` +
      `${item.is_merged ? ' <span class="chip">合并</span>' : ''}</div>` +
      `<div class="person-meta">编号 ${escapeHtml(item.pid || item.person_id)} · ${userIds.length} 个 QQ</div>` +
      `<div class="person-meta">${item.quote_count || 0} 条语录 · ${groups} 个群 · 最近 ${escapeHtml(fmtTime(item.last_seen))}</div>`;
    body.addEventListener('click', () => loadPersonDetail(item.pid || item.person_id));

    card.appendChild(checkbox);
    card.appendChild(avatarNode(item.avatar_sha, 'person-avatar'));
    card.appendChild(body);
    return card;
  }

  async function loadPersonDetail(personId) {
    el('people-detail').innerHTML = '<p class="muted hint">读取中…</p>';
    try {
      const data = await apiGet(EP.identityDetail, { person_id: personId });
      state.people.detail = data;
      renderPersonDetail();
    } catch (error) {
      state.people.detail = null;
      el('people-detail').innerHTML =
        `<p class="muted hint">读取失败：${escapeHtml(error && error.message ? error.message : error)}</p>`;
    }
  }

  function renderPersonDetail() {
    const data = state.people.detail;
    const box = el('people-detail');
    box.innerHTML = '';
    if (!data) {
      box.innerHTML =
        '<p class="muted hint">点左侧人物卡片查看档案：昵称历史、头像墙、投稿数；选中多个卡片可合并成同一个人。</p>';
      return;
    }
    const users = data.users || [];
    const first = users[0] || {};
    const names = first.names || [];
    const displayName = names.length ? names[names.length - 1].name : 'QQ ' + (first.user_id || '');
    const head = document.createElement('div');
    head.className = 'detail-head';
    head.appendChild(avatarNode(first.current_avatar || '', 'detail-avatar'));
    const title = document.createElement('div');
    title.className = 'detail-title-wrap';
    title.innerHTML =
      `<div class="detail-title">${escapeHtml(displayName)}</div>` +
      `<div class="muted hint">编号 ${escapeHtml(data.pid || data.person_id || '')}` +
      ` · ${data.is_merged ? users.length + ' 个 QQ' : '1 个 QQ'} · 共 ${data.quote_count || 0} 条语录</div>`;
    head.appendChild(title);
    box.appendChild(head);

    users.forEach((user) => {
      const section = document.createElement('div');
      section.className = 'detail-user';
      const rowHead = document.createElement('div');
      rowHead.className = 'detail-user-head';
      rowHead.innerHTML =
        `<span class="chip">QQ ${escapeHtml(user.user_id)}</span>` +
        `<span class="muted hint">${user.quote_count || 0} 条语录 · 最近 ${escapeHtml(fmtTime(user.last_seen))}</span>`;
      const split = document.createElement('button');
      split.className = 'btn ghost mini';
      split.type = 'button';
      split.textContent = '拆分该 QQ';
      split.addEventListener('click', () => splitIdentity({ user_id: user.user_id }));
      rowHead.appendChild(split);
      section.appendChild(rowHead);

      const nameRow = document.createElement('div');
      nameRow.className = 'chip-row';
      const nameItems = (user.names || []).slice().reverse();
      if (nameItems.length) {
        nameItems.forEach((item) => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = `${item.name}${Number(item.count) > 1 ? ' ×' + item.count : ''}`;
          chip.title = `首次 ${fmtTime(item.first_seen)} · 最近 ${fmtTime(item.last_seen)}`;
          nameRow.appendChild(chip);
        });
      } else {
        nameRow.innerHTML = '<span class="muted hint">暂无昵称记录</span>';
      }
      section.appendChild(nameRow);

      if ((user.groups || []).length) {
        const groupRow = document.createElement('div');
        groupRow.className = 'chip-row';
        user.groups.forEach((gid) => {
          const chip = document.createElement('span');
          chip.className = 'chip soft';
          chip.textContent = '群 ' + gid;
          groupRow.appendChild(chip);
        });
        section.appendChild(groupRow);
      }

      const wall = document.createElement('div');
      wall.className = 'avatar-wall';
      const avatars = (user.avatars || []).slice().reverse();
      if (avatars.length) {
        avatars.forEach((entry, index) => {
          const wrap = document.createElement('div');
          wrap.className = 'avatar-item' + (index === 0 && entry.sha === user.current_avatar ? ' current' : '');
          wrap.title = '点击按这个头像找相似的 QQ 号';
          wrap.appendChild(avatarNode(entry.sha, 'wall-avatar'));
          const label = document.createElement('div');
          label.className = 'avatar-time';
          label.textContent = entry.default ? '默认头像' : fmtTime(entry.last_seen);
          wrap.appendChild(label);
          wrap.addEventListener('click', () => matchAvatarSha(entry.sha));
          wall.appendChild(wrap);
        });
      } else {
        wall.innerHTML = '<span class="muted hint">还没有头像记录（可点「同步身份」拉取）</span>';
      }
      section.appendChild(wall);
      box.appendChild(section);
      hydrateAvatars(section);
    });

    if ((data.quotes || []).length) {
      const quoteBox = document.createElement('div');
      quoteBox.className = 'detail-quotes';
      const label = document.createElement('div');
      label.className = 'detail-user-head';
      label.innerHTML =
        `<span class="chip">TA 的语录</span>` +
        `<span class="muted hint">共 ${data.quotes.length} 条（跨群，点缩略图看大图）</span>`;
      quoteBox.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'detail-quote-grid';
      data.quotes.forEach((quote) => {
        const wrap = document.createElement('div');
        wrap.className = 'detail-quote';
        wrap.title = `群 ${quote.group_id} · ${fmtTime(quote.ts)}`;
        const img = document.createElement('img');
        img.alt = quote.name;
        img.loading = 'lazy';
        img.addEventListener('click', () =>
          openLightbox(
            {
              name: quote.name,
              ts: quote.ts,
              size: 0,
              caption: quote.caption || '',
              subject_user_id: '',
              subject_name: quote.subject_name || '',
            },
            quote.group_id
          )
        );
        wrap.appendChild(img);
        grid.appendChild(wrap);
        enqueueThumb(async () => {
          try {
            const resp = await apiGet(EP.image, {
              group_id: quote.group_id,
              name: quote.name,
              size: 'thumb',
            });
            img.src = resp.data_url;
          } catch (error) {
            /* 缩略图失败忽略 */
          }
        });
      });
      quoteBox.appendChild(grid);
      box.appendChild(quoteBox);
    }

    renderMatchPanel();
    updatePeopleSelectionUi();
  }

  function renderMatchPanel() {
    const match = state.people.match;
    if (!match || !state.people.detail) return;
    const box = el('people-detail');
    const panel = document.createElement('div');
    panel.className = 'match-panel';
    const head = document.createElement('div');
    head.className = 'detail-user-head';
    head.innerHTML = `<span class="chip warn">以图找人</span>` +
      `<span class="muted hint">相似度阈值 ${match.threshold}，命中 ${(match.candidates || []).length} 个账号</span>`;
    const close = document.createElement('button');
    close.className = 'btn ghost mini';
    close.type = 'button';
    close.textContent = '收起';
    close.addEventListener('click', () => {
      state.people.match = null;
      document.querySelectorAll('.match-panel').forEach((node) => node.remove());
    });
    head.appendChild(close);
    panel.appendChild(head);
    if (!(match.candidates || []).length) {
      const empty = document.createElement('p');
      empty.className = 'muted hint';
      empty.textContent = '没有找到相似头像的账号；可以放宽阈值或先同步头像。';
      panel.appendChild(empty);
    } else {
      (match.candidates || []).forEach((candidate) => {
        const row = document.createElement('div');
        row.className = 'match-row';
        row.appendChild(avatarNode(candidate.sha, 'match-avatar'));
        const info = document.createElement('div');
        info.className = 'match-info';
        info.innerHTML =
          `<div class="person-name">${escapeHtml(candidate.display_name || 'QQ ' + candidate.user_id)}</div>` +
          `<div class="person-meta">QQ ${escapeHtml(candidate.user_id)} · 距离 ${candidate.distance}</div>`;
        row.appendChild(info);
        const merge = document.createElement('button');
        merge.className = 'btn ghost mini';
        merge.type = 'button';
        merge.textContent = '并入当前人物';
        merge.addEventListener('click', () => mergeIntoDetail(candidate.user_id));
        row.appendChild(merge);
        panel.appendChild(row);
      });
    }
    box.insertBefore(panel, box.firstChild);
    hydrateAvatars(panel);
  }

  async function matchAvatarSha(sha) {
    try {
      const data = await apiPost(EP.identityMatch, { sha });
      state.people.match = data;
      if (state.people.detail) renderPersonDetail();
      else {
        el('people-detail').innerHTML =
          `<p class="muted hint">按头像指纹匹配到 ${(data.candidates || []).length} 个账号；先在左侧选一个人物再查看详情。</p>`;
      }
      toast(`以图找人：命中 ${(data.candidates || []).length} 个账号`);
    } catch (error) {
      toast('以图找人失败：' + (error && error.message ? error.message : error));
    }
  }

  async function matchByFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = await apiPost(EP.identityMatch, { image: reader.result });
        state.people.match = data;
        if (!state.people.detail) {
          el('people-detail').innerHTML =
            `<p class="muted hint">命中 ${(data.candidates || []).length} 个相似头像；先在左侧选一个人物再点头像查看以图找人。</p>`;
        } else {
          renderPersonDetail();
        }
        toast(`以图找人：命中 ${(data.candidates || []).length} 个账号`);
      } catch (error) {
        toast('以图找人失败：' + (error && error.message ? error.message : error));
      }
    };
    reader.readAsDataURL(file);
  }

  async function syncIdentities() {
    el('btn-people-sync').disabled = true;
    el('people-status').textContent = '正在同步群成员、昵称与头像，第一次会比较慢…';
    try {
      const data = await apiPost(EP.identitySync, { limit: 120, members: true });
      const memberText = data.member_users
        ? `群成员 ${data.member_users} 人（新增 ${data.new_users || 0}）`
        : '群成员列表不可用（收到一条群消息后重试）';
      toast(
        `同步完成：${memberText}，拉取头像 ${data.synced || 0}/${data.tried || 0}` +
          (data.remaining ? `，还有 ${data.remaining} 个待同步（多点几次）` : '')
      );
      await loadPeople();
    } catch (error) {
      el('people-status').textContent = '同步失败：' + (error && error.message ? error.message : error);
    } finally {
      el('btn-people-sync').disabled = false;
    }
  }

  function renderIdentitySchedule() {
    const info = state.identitySync || {};
    el('identity-auto-sync').checked = info.enabled !== false;
    el('identity-sync-interval').value = info.interval_hours || 24;
    const parts = [];
    if (info.last_sync_at) parts.push(`上次同步 ${fmtTime(info.last_sync_at)}`);
    if (info.enabled === false) parts.push('已暂停自动同步');
    else if (info.next_sync_at) parts.push(`下次 ${fmtTime(info.next_sync_at)}`);
    el('identity-sync-hint').textContent = parts.join(' · ');
  }

  async function loadIdentitySchedule() {
    try {
      const data = await apiGet(EP.identitySchedule);
      state.identitySync = {
        enabled: data.enabled !== false,
        interval_hours: data.interval_hours || 24,
        last_sync_at: data.last_sync_at || 0,
        next_sync_at: data.next_sync_at || 0,
        last_result: data.last_result || {},
      };
      renderIdentitySchedule();
    } catch (error) {
      el('identity-sync-hint').textContent = '自动同步设置读取失败';
    }
  }

  async function saveIdentitySchedule(patch) {
    try {
      const data = await apiPost(EP.identitySchedule, patch);
      state.identitySync = {
        enabled: data.enabled !== false,
        interval_hours: data.interval_hours || 24,
        last_sync_at: data.last_sync_at || 0,
        next_sync_at: data.next_sync_at || 0,
        last_result: data.last_result || {},
      };
      renderIdentitySchedule();
      toast(
        data.enabled === false
          ? '已暂停自动同步'
          : `自动同步已保存：每 ${data.interval_hours} 小时一次`
      );
    } catch (error) {
      toast('保存自动同步设置失败：' + (error && error.message ? error.message : error));
    }
  }

  function updatePeopleSelectionUi() {
    const count = state.people.selected.size;
    el('people-selected-line').textContent = count
      ? `已选 ${count} 个 QQ 号，可合并为同一个人。`
      : '已选 0 个 QQ。';
    el('btn-people-merge').disabled = count < 2;
    const detail = state.people.detail;
    el('btn-people-split').disabled = !(detail && detail.is_merged);
  }

  async function mergeIntoDetail(userId) {
    const detail = state.people.detail;
    if (!detail || !userId) return;
    const user_ids = Array.from(new Set([...(detail.user_ids || []), userId]));
    if (user_ids.length < 2) return;
    try {
      await apiPost(EP.identityMerge, { user_ids });
      toast(`已把 QQ ${userId} 并入当前人物`);
      state.people.match = null;
      await loadPeople();
      await loadPersonDetail(detail.person_id);
    } catch (error) {
      toast('合并失败：' + (error && error.message ? error.message : error));
    }
  }

  async function mergePeople() {
    const uids = Array.from(state.people.selected);
    if (uids.length < 2) {
      toast('至少选中两个 QQ 号');
      return;
    }
    if (!(await uiConfirm(`把这 ${uids.length} 个 QQ 号合并为同一个人？合并后共用昵称历史与头像墙。`))) {
      return;
    }
    try {
      await apiPost(EP.identityMerge, { user_ids: uids });
      state.people.selected.clear();
      state.people.detail = null;
      el('people-detail').innerHTML = '<p class="muted hint">已合并，点左侧卡片查看新的身份。</p>';
      toast('合并成功');
      await loadPeople();
    } catch (error) {
      toast('合并失败：' + (error && error.message ? error.message : error));
    }
  }

  async function splitIdentity(payload) {
    if (!(await uiConfirm('确认拆分这个身份？拆分后各自保留自己的昵称与头像历史。'))) return;
    try {
      await apiPost(EP.identitySplit, payload || {});
      state.people.detail = null;
      state.people.match = null;
      el('people-detail').innerHTML = '<p class="muted hint">已拆分，点左侧卡片查看。</p>';
      toast('拆分成功');
      await loadPeople();
    } catch (error) {
      toast('拆分失败：' + (error && error.message ? error.message : error));
    }
  }

  async function splitCurrentPerson() {
    const detail = state.people.detail;
    if (!detail) {
      toast('先在左侧选择一个人物');
      return;
    }
    await splitIdentity({ person_id: detail.person_id });
  }

  // ------------------------------------------------------------------ //
  // 事件绑定与启动
  // ------------------------------------------------------------------ //
  // ------------------------------------------------------------------ //
  // 专题合集
  // ------------------------------------------------------------------ //
  function openCollections() {
    closeOtherSheets('collections');
    state.collections.open = true;
    el('collections-modal').classList.remove('hidden');
    if (!state.groupId) {
      el('collections-status').textContent = '请先在左侧选择一个群聊。';
      return;
    }
    loadCollections();
  }

  function closeCollections() {
    state.collections.open = false;
    el('collections-modal').classList.add('hidden');
  }

  async function loadCollections() {
    if (!state.groupId) {
      el('collections-status').textContent = '请先在左侧选择一个群聊。';
      return;
    }
    state.collections.loading = true;
    try {
      const data = await apiGet(EP.collections, { group_id: state.groupId });
      state.collections.items = data.collections || [];
      renderCollectionList();
      el('collections-count').textContent = state.collections.items.length + ' 个';
      el('collections-status').textContent =
        '把同类语录整理成主题合集，群里用「/合集 名称」随机看图。';
      if (state.collections.detailId) {
        const exists = state.collections.items.some(
          (row) => row.collection_id === state.collections.detailId
        );
        if (exists) await selectCollection(state.collections.detailId);
        else el('collection-detail').classList.add('hidden');
      } else {
        el('collection-detail').classList.add('hidden');
      }
    } catch (error) {
      el('collections-status').textContent =
        '读取合集失败：' + (error && error.message ? error.message : error);
    } finally {
      state.collections.loading = false;
    }
  }

  function renderCollectionList() {
    const list = el('collections-list');
    list.innerHTML = '';
    if (!state.collections.items.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '还没有合集，点「新建合集」开始。';
      list.appendChild(empty);
      return;
    }
    state.collections.items.forEach((row) => {
      const li = document.createElement('li');
      li.className =
        'collection-row' + (state.collections.detailId === row.collection_id ? ' active' : '');
      const title = document.createElement('strong');
      title.textContent = row.name;
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = (row.count || 0) + ' 张';
      li.appendChild(title);
      li.appendChild(count);
      if (row.desc) {
        const desc = document.createElement('p');
        desc.className = 'muted';
        desc.textContent = row.desc;
        li.appendChild(desc);
      }
      li.addEventListener('click', () => selectCollection(row.collection_id));
      list.appendChild(li);
    });
  }

  async function selectCollection(collectionId) {
    state.collections.detailId = collectionId;
    state.collections.draft = false;
    renderCollectionList();
    el('collection-detail').classList.remove('hidden');
    el('collection-name').value = '';
    el('collection-desc').value = '';
    el('btn-collection-delete').disabled = false;
    el('btn-collection-add-selected').disabled = state.selected.size === 0;
    try {
      const data = await apiGet(EP.collections, {
        group_id: state.groupId,
        collection_id: collectionId,
      });
      const row = data.collection || {};
      el('collection-name').value = row.name || '';
      el('collection-desc').value = row.desc || '';
      renderCollectionItems(row);
    } catch (error) {
      el('collections-status').textContent =
        '读取合集详情失败：' + (error && error.message ? error.message : error);
    }
  }

  function renderCollectionItems(row) {
    const box = el('collection-items');
    box.innerHTML = '';
    const ids = row.ids || [];
    if (!ids.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = '这个合集还没有语录：在语录列表勾选后点「加入合集」。';
      box.appendChild(empty);
      return;
    }
    ids.forEach((name) => {
      const wrap = document.createElement('figure');
      wrap.className = 'collection-item';
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.alt = name;
      image.addEventListener('click', () =>
        openLightbox({ name: name, ts: 0, size: 0 }, state.groupId)
      );
      wrap.appendChild(image);
      const remove = document.createElement('button');
      remove.className = 'btn tiny ghost';
      remove.type = 'button';
      remove.textContent = '移除';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        await collectionAction({
          action: 'remove',
          collection_id: row.collection_id,
          remove_ids: [name],
        });
      });
      wrap.appendChild(remove);
      box.appendChild(wrap);
      apiGet(EP.image, { group_id: state.groupId, name: name, size: 'thumb' })
        .then((data) => {
          image.src = data.data_url;
        })
        .catch(() => {
          image.alt = '加载失败：' + name;
        });
    });
  }

  function newCollectionDraft() {
    if (!state.groupId) {
      toast('先选择一个群聊');
      return;
    }
    state.collections.detailId = '';
    state.collections.draft = true;
    renderCollectionList();
    el('collection-detail').classList.remove('hidden');
    el('collection-name').value = '';
    el('collection-desc').value = '';
    el('btn-collection-delete').disabled = true;
    el('btn-collection-add-selected').disabled = true;
    el('collection-items').innerHTML =
      '<p class="muted">保存后即可把勾选的语录加入这个合集。</p>';
    try {
      el('collection-name').focus();
    } catch (_) {
      /* ignore */
    }
  }

  async function collectionAction(body) {
    if (!state.groupId) return null;
    body.group_id = state.groupId;
    try {
      const data = await apiPost(EP.collections, body);
      state.collections.items = data.collections || state.collections.items;
      renderCollectionList();
      el('collections-count').textContent = state.collections.items.length + ' 个';
      if (data.collection) {
        state.collections.detailId = data.collection.collection_id;
        state.collections.draft = false;
        await selectCollection(state.collections.detailId);
      }
      return data;
    } catch (error) {
      toast('操作失败：' + (error && error.message ? error.message : error));
      return null;
    }
  }

  async function saveCollection() {
    const name = (el('collection-name').value || '').trim();
    const desc = (el('collection-desc').value || '').trim();
    if (!name) {
      toast('请填写合集名称');
      return;
    }
    if (state.collections.draft) {
      await collectionAction({
        action: 'create',
        name: name,
        desc: desc,
        ids: Array.from(state.selected),
      });
    } else if (state.collections.detailId) {
      await collectionAction({
        action: 'update',
        collection_id: state.collections.detailId,
        name: name,
        desc: desc,
      });
    } else {
      toast('先新建合集或选择一个合集');
      return;
    }
    toast('合集已保存');
  }

  async function deleteCollection() {
    if (!state.collections.detailId) return;
    const ok = await uiConfirm('删除这个专题合集？合集中的语录不会被删除。');
    if (!ok) return;
    await collectionAction({ action: 'delete', collection_id: state.collections.detailId });
    state.collections.detailId = '';
    el('collection-detail').classList.add('hidden');
    toast('合集已删除');
  }

  async function addSelectedToCollection() {
    if (!state.selected.size) {
      toast('先在语录列表勾选语录');
      return;
    }
    if (!state.collections.detailId) {
      toast('先在左侧选择或新建一个合集');
      return;
    }
    const data = await collectionAction({
      action: 'add',
      collection_id: state.collections.detailId,
      add_ids: Array.from(state.selected),
    });
    if (data) toast('已加入 ' + state.selected.size + ' 张语录');
  }

  // ------------------------------------------------------------------ //
  // 每周语录周报
  // ------------------------------------------------------------------ //
  async function loadWeekly() {
    if (state.weekly.loading) return;
    state.weekly.loading = true;
    try {
      const data = await apiGet(EP.weekly, {});
      state.weekly.settings = data.settings || {};
      state.weekly.groups = data.groups || [];
      state.weekly.preview = data.previews || {};
      state.weekly.weekLabel = data.week_label || '';
      renderWeekly();
    } catch (error) {
      el('weekly-status').textContent =
        '读取周报设置失败：' + (error && error.message ? error.message : error);
    } finally {
      state.weekly.loading = false;
    }
  }

  function renderWeekly() {
    const settings = state.weekly.settings || {};
    el('weekly-enabled').checked = !!settings.enabled;
    el('weekly-weekday').value = String(settings.weekday || 1);
    el('weekly-hour').value = settings.hour == null ? 9 : settings.hour;
    const box = el('weekly-groups');
    box.innerHTML = '';
    const selected = new Set(settings.groups || []);
    (state.weekly.groups || []).forEach((gid) => {
      const label = document.createElement('label');
      label.className = 'switch weekly-group';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = gid;
      input.checked = selected.has(gid);
      const span = document.createElement('span');
      span.textContent = '群 ' + gid;
      label.appendChild(input);
      label.appendChild(span);
      box.appendChild(label);
    });
    const preview = el('weekly-preview');
    const keys = Object.keys(state.weekly.preview || {});
    preview.textContent = keys.length ? state.weekly.preview[keys[0]] : '';
    el('weekly-status').textContent =
      (state.weekly.weekLabel || '') +
      ' · ' +
      (settings.enabled ? '已启用' : '未启用') +
      (settings.last_week ? '（上次已推送 ' + settings.last_week + '）' : '');
  }

  function weeklyGroups() {
    return Array.from(el('weekly-groups').querySelectorAll('input[type=checkbox]'))
      .filter((input) => input.checked)
      .map((input) => input.value);
  }

  async function saveWeekly() {
    const body = {
      enabled: el('weekly-enabled').checked,
      weekday: Number(el('weekly-weekday').value || 1),
      hour: Number(el('weekly-hour').value || 9),
      groups: weeklyGroups(),
    };
    try {
      const data = await apiPost(EP.weekly, body);
      state.weekly.settings = data.settings || state.weekly.settings;
      renderWeekly();
      toast('周报设置已保存');
    } catch (error) {
      toast('保存失败：' + (error && error.message ? error.message : error));
    }
  }

  async function testWeekly() {
    const button = el('btn-weekly-test');
    button.disabled = true;
    try {
      const data = await apiPost(EP.weeklyTest, {});
      const results = data.results || [];
      const ok = results.filter((item) => item.ok).length;
      toast('已推送 ' + ok + '/' + results.length + ' 个群');
      await loadWeekly();
    } catch (error) {
      toast('推送失败：' + (error && error.message ? error.message : error));
    } finally {
      button.disabled = false;
    }
  }

  // ------------------------------------------------------------------ //
  // 语录统计（V9）
  // ------------------------------------------------------------------ //
  function openStats() {
    closeOtherSheets('stats');
    state.stats.open = true;
    el('stats-modal').classList.remove('hidden');
    fillStatsScopes();
    if (!modalFresh('stats', 60000)) {
      loadStats();
      loadWeekly();
      markModalFresh('stats');
    }
  }

  function closeStats() {
    state.stats.open = false;
    el('stats-modal').classList.add('hidden');
  }

  function fillStatsScopes() {
    const select = el('stats-scope');
    select.innerHTML = '<option value="">全部群</option>';
    (state.groups || []).forEach((group) => {
      const option = document.createElement('option');
      option.value = group.group_id;
      option.textContent = '群 ' + group.group_id + '（' + (group.count || 0) + ' 张）';
      select.appendChild(option);
    });
    select.value = state.stats.scope;
  }

  async function loadStats() {
    if (state.stats.loading) return;
    state.stats.loading = true;
    el('stats-status').textContent = '正在统计…';
    el('btn-stats-refresh').disabled = true;
    try {
      const data = await apiGet(EP.statistics, {
        group_id: state.stats.scope,
        top: state.stats.top,
        days: 30,
      });
      state.stats.data = data;
      renderStats();
      const totals = data.totals || {};
      el('stats-count').textContent = (totals.quotes || 0) + ' 张 · ' + (totals.persons || 0) + ' 人';
      el('stats-status').textContent =
        '共 ' + (totals.quotes || 0) + ' 张语录，已归属 ' + (totals.assigned || 0) + ' 张（' +
        Math.round((totals.assigned_rate || 0) * 100) + '%），今日新增 ' + (totals.today || 0) +
        ' 张；统计时间 ' + fmtTime(data.generated_at) + '。';
    } catch (error) {
      el('stats-status').textContent =
        '统计失败：' + (error && error.message ? error.message : error);
    } finally {
      state.stats.loading = false;
      el('btn-stats-refresh').disabled = false;
    }
  }

  function renderStats() {
    const data = state.stats.data;
    if (!data) return;
    const totals = data.totals || {};

    const cards = el('stats-cards');
    cards.innerHTML = '';
    const cardDefs = [
      ['语录总数', (totals.quotes || 0) + ' 张', (totals.groups || 0) + ' 个群'],
      ['已归属', (totals.assigned || 0) + ' 张',
        Math.round((totals.assigned_rate || 0) * 100) + '% · 未归属 ' + (totals.unassigned || 0) + ' 张'],
      ['人物', (totals.persons || 0) + ' 位', '按人物排行'],
      ['投稿人', (totals.contributors || 0) + ' 位', '投稿 ' + (totals.submissions || 0) + ' 次'],
      ['今日 / 近 7 天', (totals.today || 0) + ' / ' + (totals.last7 || 0) + ' 张', '新增趋势'],
      ['语义化', (totals.semantic || 0) + ' 张',
        '覆盖 ' + Math.round((totals.semantic_rate || 0) * 100) + '%'],
      ['占用空间', fmtBytes(totals.bytes || 0), '图片合计'],
    ];
    cardDefs.forEach((def) => {
      const card = document.createElement('div');
      card.className = 'stat-card';
      card.innerHTML =
        '<div class="stat-label">' + escapeHtml(def[0]) + '</div>' +
        '<div class="stat-value">' + escapeHtml(def[1]) + '</div>' +
        '<div class="stat-hint">' + escapeHtml(def[2]) + '</div>';
      cards.appendChild(card);
    });

    const ranking = data.ranking || [];
    renderRankTable(el('stats-ranking'), ranking, 'person');
    const contributors = data.contributors || [];
    renderRankTable(el('stats-contributors'), contributors, 'contributor');

    const trend = data.trend || [];
    const trendBox = el('stats-trend');
    trendBox.innerHTML = '';
    const trendMax = trend.reduce((acc, item) => Math.max(acc, item.count), 0);
    let trendSum = 0;
    trend.forEach((item) => {
      trendSum += item.count;
      const bar = document.createElement('div');
      bar.className = 'trend-bar';
      bar.title = item.date + '：' + item.count + ' 张';
      const fill = document.createElement('div');
      fill.className = 'trend-fill' + (item.count ? ' has-data' : '');
      fill.style.height = trendMax ? Math.max(3, Math.round((item.count / trendMax) * 100)) + '%' : '3px';
      bar.appendChild(fill);
      trendBox.appendChild(bar);
    });
    el('stats-trend-total').textContent = '共 ' + trendSum + ' 张';

    renderGroupTable(el('stats-groups'), data.groups || []);
  }

  function renderRankTable(target, rows, kind) {
    target.innerHTML = '';
    if (!rows.length) {
      target.innerHTML = '<p class="muted hint">' +
        (kind === 'contributor' ? '还没有投稿记录。' : '还没有已归属的语录。') + '</p>';
      return;
    }
    const base = rows.reduce((acc, row) => acc + (Number(row.count) || 0), 0) || 1;
    const headLabel = kind === 'contributor' ? '投稿人' : '语录人物';
    const countLabel = kind === 'contributor' ? '投稿数' : '语录数';
    const table = document.createElement('table');
    table.className = 'stats-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th class="col-rank">排名</th>' +
      '<th class="col-person">' + headLabel + '</th>' +
      '<th class="col-count">' + countLabel + '</th>' +
      '<th class="col-share">占比</th>' +
      '<th class="col-groups">群数</th>' +
      '<th class="col-last">最近</th>' +
      '</tr></thead>';
    const body = document.createElement('tbody');
    rows.forEach((row) => {
      const name = row.display_name || '群友';
      const groups = Array.isArray(row.groups) ? row.groups : [];
      const rowEl = document.createElement('tr');
      const share = Math.round(((Number(row.count) || 0) / base) * 100);
      const last = row.last_ts ? fmtTime(row.last_ts) : '-';
      const rank = Number(row.rank) || 0;
      const rankClass = rank <= 3 ? ' stats-rank-top' : '';
      rowEl.innerHTML =
        '<td class="col-rank"><span class="stats-rank' + rankClass + '">' + rank + '</span></td>' +
        '<td class="col-person"><div class="stats-person"></div></td>' +
        '<td class="col-count"><b>' + (Number(row.count) || 0) + '</b></td>' +
        '<td class="col-share">' +
          '<div class="stats-share"><span style="width:' + Math.max(4, share) + '%"></span></div>' +
          '<span class="muted">' + share + '%</span>' +
        '</td>' +
        '<td class="col-groups">' + (groups.length || 1) + '</td>' +
        '<td class="col-last muted">' + escapeHtml(last) + '</td>';
      const person = rowEl.querySelector('.stats-person');
      person.appendChild(avatarNode(row.avatar_sha, 'stats-avatar'));
      const info = document.createElement('div');
      info.className = 'stats-person-info';
      const pid = row.person_id ? '<div class="stats-pid muted">' + escapeHtml(String(row.person_id)) + '</div>' : '';
      const qq = row.user_ids && row.user_ids.length ? '<div class="stats-pid muted">QQ ' + escapeHtml(String(row.user_ids[0])) + '</div>' : '';
      info.innerHTML = '<div class="stats-name">' + escapeHtml(String(name)) + '</div>' + (pid || qq);
      person.appendChild(info);
      body.appendChild(rowEl);
    });
    table.appendChild(body);
    target.appendChild(table);
    hydrateAvatars(target);
  }

  function renderGroupTable(target, groups) {
    target.innerHTML = '';
    if (!groups.length) {
      target.innerHTML = '<p class="muted hint">没有群数据。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'stats-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>群号</th><th>语录</th><th>已归属</th><th>语义化</th><th>投稿人</th><th>占用</th>' +
      '</tr></thead>';
    const body = document.createElement('tbody');
    groups.forEach((group) => {
      const tr = document.createElement('tr');
      const rate = group.quotes ? Math.round((group.assigned / group.quotes) * 100) : 0;
      tr.innerHTML =
        '<td class="stats-group-id">群 ' + escapeHtml(String(group.group_id)) + '</td>' +
        '<td><b>' + group.quotes + '</b></td>' +
        '<td>' + group.assigned + ' <span class="muted">(' + rate + '%)</span></td>' +
        '<td>' + group.semantic + '</td>' +
        '<td>' + group.submitters + '</td>' +
        '<td class="muted">' + escapeHtml(fmtBytes(group.bytes)) + '</td>';
      body.appendChild(tr);
    });
    table.appendChild(body);
    target.appendChild(table);
  }



  // ------------------------------------------------------------------ //
  // 数据可视化（E1）+ 年度报告（C3）
  // ------------------------------------------------------------------ //
  const HEAT_LEVELS = ['heat-l0', 'heat-l1', 'heat-l2', 'heat-l3', 'heat-l4'];

  function heatLevel(value, max) {
    if (!value) return 0;
    const ratio = value / Math.max(1, max);
    if (ratio < 0.25) return 1;
    if (ratio < 0.5) return 2;
    if (ratio < 0.75) return 3;
    return 4;
  }

  async function openInsights() {
    closeOtherSheets('insights');
    state.insights.open = true;
    el('insights-modal').classList.remove('hidden');
    if (!el('annual-year').children.length) {
      const now = new Date();
      for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y -= 1) {
        const option = document.createElement('option');
        option.value = String(y);
        option.textContent = y + ' 年';
        el('annual-year').appendChild(option);
      }
    }
    if (!state.insights.people.length) await loadInsightsPeople();
    if (!modalFresh('insights', 120000)) {
      await loadHeatmap();
      markModalFresh('insights');
    }
  }

  function closeInsights() {
    state.insights.open = false;
    el('insights-modal').classList.add('hidden');
  }

  async function loadInsightsPeople() {
    try {
      const data = await apiGet(EP.identityList, { page: 1, page_size: 300 });
      state.insights.people = data.items || [];
      [el('timeline-person'), el('annual-person')].forEach((select) => {
        select.innerHTML = '<option value="">选择人物…</option>';
        state.insights.people.forEach((person) => {
          const option = document.createElement('option');
          option.value = person.pid || '';
          option.textContent = (person.display_name || person.name || person.pid) + ` · ${person.pid || ''}`;
          select.appendChild(option);
        });
      });
    } catch (error) {
      toast('读取人物列表失败：' + (error && error.message ? error.message : error));
    }
  }

  async function loadHeatmap() {
    try {
      const params = { days: 365 };
      if (state.groupId) params.group_id = state.groupId;
      const data = await apiGet(EP.insightsHeatmap, params);
      state.insights.heat = data;
      renderHeatmap(data);
    } catch (error) {
      toast('读取热力图失败：' + (error && error.message ? error.message : error));
    }
  }

  function renderHeatmap(data) {
    const grid = el('heatmap-grid');
    grid.innerHTML = '';
    const hours = (data && data.hours) || [];
    const max = Math.max(1, ...hours.flat());
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    const table = document.createElement('table');
    table.className = 'heatmap-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th'));
    weekdays.forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    hours.forEach((row, hour) => {
      const tr = document.createElement('tr');
      const head = document.createElement('th');
      head.textContent = hour + '点';
      tr.appendChild(head);
      row.forEach((value, weekday) => {
        const td = document.createElement('td');
        const cell = document.createElement('i');
        cell.className = 'heat-cell ' + HEAT_LEVELS[heatLevel(value, max)];
        cell.title = `${weekdays[weekday]} ${hour}:00 · ${value} 张`;
        td.appendChild(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    grid.appendChild(table);
    el('insights-count').textContent = `${(data && data.total) || 0} 张`;
    el('heatmap-hint').textContent =
      `共 ${(data && data.total) || 0} 张 · 最活跃 ${data?.peak_hour ?? '-'} 点 · 星期${weekdays[data?.peak_weekday ?? 0]} · 单日最高 ${(data && data.max_day) || 0} 张`;
    renderCalendar((data && data.calendar) || []);
    renderHeatmapSide(data || {});
  }

  function renderHeatmapSide(data) {
    const side = el('heatmap-side');
    if (!side) return;
    side.innerHTML = '';
    const weekdays = data.weekdays || ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const weekdaySums = data.weekday_sums || [];
    const hourSums = data.hour_sums || [];
    const weekMax = Math.max(1, ...weekdaySums);
    const hourMax = Math.max(1, ...hourSums);
    const block = document.createElement('div');
    block.className = 'hm-side-block';
    block.innerHTML = '<h4>星期分布 <span class="muted">按星期合计</span></h4>';
    weekdays.forEach((label, index) => {
      const value = Number(weekdaySums[index] || 0);
      const row = document.createElement('div');
      row.className = 'hm-bar-row';
      row.innerHTML = '<span class="hm-bar-label">' + label + '</span>' +
        '<span class="hm-bar-track"><i class="hm-bar-fill" style="width:' + Math.round((value / weekMax) * 100) + '%"></i></span>' +
        '<span class="hm-bar-count">' + value + '</span>';
      block.appendChild(row);
    });
    side.appendChild(block);

    const ranked = hourSums
      .map((value, hour) => ({ hour, value: Number(value || 0) }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
    const second = document.createElement('div');
    second.className = 'hm-side-block';
    second.innerHTML = '<h4>活跃时段 <span class="muted">TOP 6</span></h4>';
    ranked.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'hm-bar-row';
      row.innerHTML = '<span class="hm-bar-label">' + String(item.hour).padStart(2, '0') + ':00</span>' +
        '<span class="hm-bar-track"><i class="hm-bar-fill" style="width:' + Math.round((item.value / hourMax) * 100) + '%"></i></span>' +
        '<span class="hm-bar-count">' + item.value + '</span>';
      second.appendChild(row);
    });
    side.appendChild(second);
  }

  function renderCalendar(rows) {
    const grid = el('calendar-grid');
    grid.innerHTML = '';
    if (!rows.length) {
      grid.innerHTML = '<p class="empty">暂无数据。</p>';
      return;
    }
    const byDate = new Map(rows.map((row) => [row.date, row.count]));
    const max = Math.max(1, ...rows.map((row) => row.count));
    const last = new Date(rows[rows.length - 1].date + 'T00:00:00');
    const weeks = 26;
    const start = new Date(last);
    start.setDate(start.getDate() - weeks * 7 + 1);
    while (start.getDay() !== 1) start.setDate(start.getDate() - 1);
    const wrap = document.createElement('div');
    wrap.className = 'calendar-weeks';
    for (let week = 0; week < weeks; week += 1) {
      const column = document.createElement('div');
      column.className = 'calendar-week';
      for (let day = 0; day < 7; day += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + week * 7 + day);
        const key = date.toISOString().slice(0, 10);
        const cell = document.createElement('i');
        cell.className = 'heat-cell ' + HEAT_LEVELS[heatLevel(byDate.get(key) || 0, max)];
        cell.title = `${key} · ${byDate.get(key) || 0} 张`;
        column.appendChild(cell);
      }
      wrap.appendChild(column);
    }
    grid.appendChild(wrap);
  }

  async function loadTimeline() {
    const pid = el('timeline-person').value;
    if (!pid) {
      toast('请先选择人物');
      return;
    }
    try {
      const params = { pid };
      if (state.groupId) params.group_id = state.groupId;
      const data = await apiGet(EP.insightsTimeline, params);
      state.insights.timeline = data;
      renderTimeline(data);
    } catch (error) {
      toast('读取时间线失败：' + (error && error.message ? error.message : error));
    }
  }

  function renderTimeline(data) {
    const body = el('timeline-body');
    body.innerHTML = '';
    el('timeline-hint').textContent =
      `${data.display_name || ''} · 共 ${data.total || 0} 张` +
      (data.first_ts ? ` · ${fmtTime(data.first_ts)} 起` : '');
    const months = data.months || [];
    const max = Math.max(1, ...months.map((row) => row.count || 0));
    const chart = document.createElement('div');
    chart.className = 'timeline-months';
    months.forEach((row) => {
      const item = document.createElement('div');
      item.className = 'timeline-month';
      const bar = document.createElement('i');
      bar.className = 'timeline-bar';
      bar.style.height = `${Math.max(4, Math.round((row.count / max) * 90))}px`;
      bar.title = `${row.month} · ${row.count} 张`;
      const label = document.createElement('span');
      label.textContent = row.month.slice(5);
      const count = document.createElement('b');
      count.textContent = row.count ? String(row.count) : '';
      item.appendChild(count);
      item.appendChild(bar);
      item.appendChild(label);
      chart.appendChild(item);
    });
    body.appendChild(chart);
    const tags = document.createElement('div');
    tags.className = 'timeline-tags';
    (data.top_tags || []).slice(0, 8).forEach((row) => {
      const tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = `#${row.tag} ${row.count}`;
      tags.appendChild(tag);
    });
    body.appendChild(tags);
  }

  async function loadAnnualPreview() {
    const pid = el('annual-person').value;
    if (!pid) {
      toast('请先选择人物');
      return;
    }
    el('btn-annual-load').disabled = true;
    el('annual-hint').textContent = '生成中…';
    try {
      const params = { pid, year: Number(el('annual-year').value) || new Date().getFullYear() };
      if (state.groupId) params.group_id = state.groupId;
      const data = await apiGet(EP.insightsAnnualImage, params);
      const preview = el('annual-preview');
      preview.innerHTML = '';
      const image = document.createElement('img');
      image.className = 'annual-image';
      image.alt = '年度报告';
      image.src = data.image;
      preview.appendChild(image);
      const download = document.createElement('a');
      download.className = 'btn ghost';
      download.textContent = '下载图片';
      download.href = data.image;
      download.download = data.filename || 'annual.png';
      preview.appendChild(download);
      const report = data.report || {};
      el('annual-hint').textContent =
        `${report.display_name || ''} · ${report.year} 年 · ${report.total || 0} 张` +
        (report.rank ? ` · 全群第 ${report.rank} 名` : '');
    } catch (error) {
      el('annual-hint').textContent = '生成失败：' + (error && error.message ? error.message : error);
    } finally {
      el('btn-annual-load').disabled = false;
    }
  }

  // ------------------------------------------------------------------ //
  // 回收站（A3）
  // ------------------------------------------------------------------ //
  async function openTrash() {
    closeOtherSheets('trash');
    state.trash.open = true;
    el('trash-modal').classList.remove('hidden');
    if (!modalFresh('trash', 30000)) {
      await loadTrash();
      markModalFresh('trash');
    }
  }

  function closeTrash() {
    state.trash.open = false;
    el('trash-modal').classList.add('hidden');
  }

  async function loadTrash() {
    if (!state.groupId) {
      toast('请先在左侧选择一个群');
      return;
    }
    state.trash.loading = true;
    try {
      const data = await apiGet(EP.trash, { group_id: state.groupId });
      state.trash.items = data.items || [];
      state.trash.total = data.total || 0;
      renderTrash();
    } catch (error) {
      toast('读取回收站失败：' + (error && error.message ? error.message : error));
    } finally {
      state.trash.loading = false;
    }
  }

  function renderTrash() {
    el('trash-count').textContent = `${state.trash.total} 项`;
    el('trash-hint').textContent = state.trash.total ? '恢复后语录会回到原群（语义索引需重新生成）' : '';
    const body = el('trash-body');
    body.innerHTML = '';
    if (!state.trash.items.length) {
      body.innerHTML = '<p class="empty">回收站是空的。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'trash-table';
    const head = document.createElement('thead');
    head.innerHTML = '<tr><th>文件名</th><th>人物 / 投稿人</th><th>删除时间</th><th>操作</th></tr>';
    table.appendChild(head);
    const tbody = document.createElement('tbody');
    state.trash.items.forEach((item) => {
      const meta = item.meta || {};
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.className = 'trash-name';
      name.textContent = item.name;
      const who = document.createElement('td');
      who.textContent =
        meta.subject_name || meta.nickname || meta.user_id || '未记录';
      const when = document.createElement('td');
      when.textContent = item.deleted_at ? fmtTime(item.deleted_at) : '-';
      const ops = document.createElement('td');
      const restore = document.createElement('button');
      restore.className = 'btn ghost small';
      restore.type = 'button';
      restore.textContent = '恢复';
      restore.addEventListener('click', () => restoreTrashItem(item.name));
      const purge = document.createElement('button');
      purge.className = 'btn danger small';
      purge.type = 'button';
      purge.textContent = '彻底删除';
      purge.addEventListener('click', () => purgeTrashItem(item.name));
      ops.appendChild(restore);
      ops.appendChild(purge);
      tr.appendChild(name);
      tr.appendChild(who);
      tr.appendChild(when);
      tr.appendChild(ops);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  async function restoreTrashItem(name) {
    try {
      await apiPost(EP.trashRestore, { group_id: state.groupId, names: [name] });
      toast('已恢复 ' + name);
      await loadTrash();
      await loadOverview();
      if (state.groupId) await loadQuotes();
      await loadTagStatus();
    } catch (error) {
      toast('恢复失败：' + (error && error.message ? error.message : error));
    }
  }

  async function purgeTrashItem(name) {
    if (!(await uiConfirm('彻底删除后不可恢复，确定删除 ' + name + ' ？'))) return;
    try {
      await apiPost(EP.trashPurge, { group_id: state.groupId, names: [name] });
      toast('已彻底删除');
      await loadTrash();
    } catch (error) {
      toast('删除失败：' + (error && error.message ? error.message : error));
    }
  }

  async function emptyTrashAll() {
    if (!state.groupId) return;
    if (!(await uiConfirm('清空本群回收站？该操作不可恢复。'))) return;
    try {
      await apiPost(EP.trashPurge, { group_id: state.groupId, all: true });
      toast('回收站已清空');
      await loadTrash();
    } catch (error) {
      toast('清空失败：' + (error && error.message ? error.message : error));
    }
  }

  // ------------------------------------------------------------------ //
  // 打标签队列（B1）
  // ------------------------------------------------------------------ //
  async function loadTagStatus() {
    try {
      const data = await apiGet(EP.tagQueue, { group_id: state.groupId || '' });
      state.tag.paused = data && data.paused === true;
      const pending = Number((data && data.pending) || 0);
      const done = Number((data && data.done) || 0);
      const failed = Number((data && data.failed) || 0);
      const running = data && data.running;
      el('tag-queue-line').textContent =
        `标签队列：待处理 ${pending} · 已完成 ${done} · 失败 ${failed}` +
        (running ? ' · 运行中' : '') +
        (state.tag.paused ? ' · 已暂停' : '');
      el('btn-tag-pause').textContent = state.tag.paused ? '恢复打标签' : '暂停打标签';
      if ((pending > 0 || running) && !state.tag.timer) {
        state.tag.timer = setInterval(loadTagStatus, 3000);
      }
      if (pending === 0 && !running && state.tag.timer) {
        clearInterval(state.tag.timer);
        state.tag.timer = null;
      }
    } catch (error) {
      el('tag-queue-line').textContent = '标签队列：读取失败';
    }
  }

  async function scanTags() {
    if (!state.groupId) {
      toast('请先在左侧选择一个群');
      return;
    }
    try {
      const data = await apiPost(EP.tagQueue, { action: 'enqueue', group_id: state.groupId });
      toast(`已入队 ${data.queued || 0} 张`);
      await loadTagStatus();
    } catch (error) {
      toast('扫描失败：' + (error && error.message ? error.message : error));
    }
  }

  async function toggleTagPause() {
    try {
      await apiPost(EP.tagQueue, { action: state.tag.paused ? 'resume' : 'pause' });
      await loadTagStatus();
    } catch (error) {
      toast('操作失败：' + (error && error.message ? error.message : error));
    }
  }

  async function loadFilterPeople() {
    try {
      const data = await apiGet(EP.identityList, { page: 1, page_size: 200 });
      const select = el('filter-person');
      const current = state.filterPerson;
      select.innerHTML = '<option value="">全部人物</option>';
      (data.items || []).forEach((person) => {
        const option = document.createElement('option');
        option.value = person.pid || person.person_id || '';
        option.textContent = person.display_name || person.name || option.value;
        select.appendChild(option);
      });
      select.value = current;
    } catch (error) {
      /* 忽略：筛选器拉取失败不影响主流程 */
    }
  }

  // ------------------------------------------------------------------ //
  // 协作维护（v2.20.0）
  // ------------------------------------------------------------------ //
  function collabTime(ts) {
    const value = Number(ts || 0);
    if (!value) return '-';
    const d = new Date(value * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openCollab() {
    closeOtherSheets('collab');
    state.collab.open = true;
    el('collab-modal').classList.remove('hidden');
    loadCollab().catch((error) => toast('读取协作配置失败：' + (error && error.message ? error.message : error)));
  }

  function closeCollab() {
    state.collab.open = false;
    el('collab-modal').classList.add('hidden');
  }

  async function loadCollab(force) {
    if (!state.groupId) {
      toast('请先在左侧选择一个群');
      return;
    }
    if (!force && modalFresh('collab', 20000) && state.collab.members.length) {
      renderCollab();
      return;
    }
    state.collab.loading = true;
    try {
      const [members, tokens, audit, base] = await Promise.all([
        apiGet(EP.collabMembers, { group_id: state.groupId }),
        apiGet(EP.collabTokens, { group_id: state.groupId }),
        apiGet(EP.collabAudit, { group_id: state.groupId, limit: 40 }),
        apiGet(EP.collabBase),
      ]);
      state.collab.members = members.items || [];
      state.collab.tokens = tokens.items || [];
      state.collab.audit = audit.items || [];
      state.collab.publicBase = base.public_base || '';
      el('collab-base').value = state.collab.publicBase;
      renderCollab();
      markModalFresh('collab');
    } finally {
      state.collab.loading = false;
    }
  }

  function renderCollab() {
    const members = state.collab.members || [];
    el('collab-member-count').textContent = members.length ? `共 ${members.length} 人` : '';
    el('collab-member-body').innerHTML = members.length
      ? members.map((item) => `<div class="collab-row">
          <div class="collab-main"><b>${escapeHtml(item.qq)}</b><span class="chip">${escapeHtml(item.role_label || item.role || '')}</span></div>
          <div class="collab-meta muted">来源 ${escapeHtml(item.added_by || '-')} · ${collabTime(item.added_at)}</div>
          <button class="btn ghost" type="button" data-member-remove="${escapeHtml(item.qq)}">移除</button>
        </div>`).join('')
      : '<p class="muted hint">还没有维护成员。可以在这里添加，或在群里用 /维护 添加。</p>';

    const tokens = state.collab.tokens || [];
    el('collab-token-body').innerHTML = tokens.length
      ? tokens.map((item) => {
        const expiry = item.permanent ? '长期' : (item.expired ? '已过期' : `剩 ${Math.max(1, Math.round(Number(item.expires_in || 0) / 3600))} 小时`);
        const stateText = Number(item.revoked || 0) ? '已吊销' : expiry;
        const last = item.last_used ? collabTime(item.last_used) : '未使用';
        const action = Number(item.revoked || 0) ? '' : `<button class="btn ghost" type="button" data-token-revoke="${escapeHtml(item.id)}">吊销</button>`;
        return `<div class="collab-row">
          <div class="collab-main"><b>${escapeHtml(item.qq)}</b><span class="chip">${escapeHtml(item.role_label || item.role || '')}</span><span class="muted">${escapeHtml(stateText)}</span></div>
          <div class="collab-meta muted">最后使用 ${last} · 使用 ${Number(item.use_count || 0)} 次</div>
          ${action}
        </div>`;
      }).join('')
      : '<p class="muted hint">还没有邀请记录。</p>';

    const actionText = { assign: '归属', restricted: '限制级', undo: '撤销', member_set: '成员设置', member_remove: '移除成员', token_create: '生成邀请', token_revoke: '吊销邀请', semantic_retry: '语义重试', login: '登录' };
    const audit = state.collab.audit || [];
    el('collab-audit-body').innerHTML = audit.length
      ? audit.map((item) => {
        const undoable = (item.action === 'assign' || item.action === 'restricted') && !Number(item.undone || 0);
        const flag = Number(item.undone || 0) ? '（已撤销）' : '';
        return `<div class="collab-row">
          <div class="collab-main"><b>${escapeHtml(item.actor_name || item.actor_qq || '-')}</b><span class="chip">${escapeHtml(actionText[item.action] || item.action || '')}${flag}</span></div>
          <div class="collab-meta muted">${collabTime(item.ts)} · ${escapeHtml(item.target || '')}</div>
          ${undoable ? `<button class="btn ghost" type="button" data-audit-undo="${Number(item.id || 0)}">撤销</button>` : ''}
        </div>`;
      }).join('')
      : '<p class="muted hint">暂无操作记录。</p>';
  }

  async function addCollabMember() {
    const qq = (el('collab-qq').value || '').trim();
    if (!/^\d{5,}$/.test(qq)) {
      toast('请输入正确的 QQ 号');
      return;
    }
    try {
      await apiPost(EP.collabMembers, { group_id: state.groupId, action: 'add', qq, role: el('collab-role').value });
      el('collab-qq').value = '';
      toast('已保存成员');
      await loadCollab(true);
    } catch (error) {
      toast('保存失败：' + (error && error.message ? error.message : error));
    }
  }

  async function removeCollabMember(qq) {
    const okay = await uiConfirm(`移除维护成员 ${qq}？TA 之后将无法进入协作页。`, '移除');
    if (!okay) return;
    try {
      await apiPost(EP.collabMembers, { group_id: state.groupId, action: 'remove', qq });
      toast('已移除');
      await loadCollab(true);
    } catch (error) {
      toast('移除失败：' + (error && error.message ? error.message : error));
    }
  }

  function copyTextValue(text) {
    return new Promise((resolve) => {
      const fallback = () => {
        let ok = false;
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.left = '0';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (error) {
          ok = false;
        }
        resolve(ok);
      };
      try {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(() => resolve(true)).catch(fallback);
        } else {
          fallback();
        }
      } catch (error) {
        fallback();
      }
    });
  }

  async function saveCollabBase() {
    const value = (el('collab-base').value || '').trim();
    try {
      const data = await apiPost(EP.collabBase, { public_base: value });
      state.collab.publicBase = data.public_base || '';
      el('collab-base').value = state.collab.publicBase;
      toast(data.public_base ? '协作页外网地址已保存' : '已清除协作页外网地址');
    } catch (error) {
      toast('保存失败：' + (error && error.message ? error.message : error));
    }
  }

  async function createCollabInvite() {
    const qq = (el('collab-token-qq').value || '').trim();
    if (!/^\d{5,}$/.test(qq)) {
      toast('请输入正确的 QQ 号');
      return;
    }
    const hours = Number(el('collab-token-hours').value || 168);
    try {
      const data = await apiPost(EP.collabTokens, {
        group_id: state.groupId,
        action: 'create',
        qq,
        role: el('collab-token-role').value,
        hours,
      });
      const box = el('collab-invite-result');
      box.classList.remove('hidden');
      box.innerHTML = `<div class="collab-invite-line"><span>邀请链接（${hours > 0 ? Math.round(hours / 24) + ' 天有效' : '长期有效'}）</span>
        <code class="collab-link">${escapeHtml(data.link)}</code>
        <button class="btn" type="button" data-copy-link="${escapeHtml(data.link)}">复制</button></div>`;
      toast('邀请已生成');
      await loadCollab(true);
    } catch (error) {
      toast('生成失败：' + (error && error.message ? error.message : error));
    }
  }

  async function revokeCollabToken(tokenId) {
    const okay = await uiConfirm('吊销这个邀请？已登录的会话将在过期前仍可继续使用。', '吊销');
    if (!okay) return;
    try {
      await apiPost(EP.collabTokens, { group_id: state.groupId, action: 'revoke', token_id: tokenId });
      toast('已吊销');
      await loadCollab(true);
    } catch (error) {
      toast('吊销失败：' + (error && error.message ? error.message : error));
    }
  }

  async function undoCollabAudit(id) {
    const okay = await uiConfirm('撤销这次操作？会尽量恢复到操作前的状态。', '撤销');
    if (!okay) return;
    try {
      const data = await apiPost(EP.collabAudit, { id });
      toast(`已撤销，写回 ${data.changed || 0} 条`);
      await loadCollab(true);
      if (state.items.length) await loadQuotes(state.page);
    } catch (error) {
      toast('撤销失败：' + (error && error.message ? error.message : error));
    }
  }

  function bindEvents() {
    el('btn-collab').addEventListener('click', () => openCollab());
    el('btn-collab-close').addEventListener('click', closeCollab);
    el('btn-collab-refresh').addEventListener('click', () => loadCollab(true).catch((error) => toast(String(error))));
    el('btn-collab-add').addEventListener('click', addCollabMember);
    el('btn-collab-invite').addEventListener('click', createCollabInvite);
    el('btn-collab-base').addEventListener('click', saveCollabBase);
    el('collab-member-body').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-member-remove]');
      if (btn) removeCollabMember(btn.getAttribute('data-member-remove'));
    });
    el('collab-token-body').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-token-revoke]');
      if (btn) revokeCollabToken(btn.getAttribute('data-token-revoke'));
    });
    el('collab-audit-body').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-audit-undo]');
      if (btn) undoCollabAudit(Number(btn.getAttribute('data-audit-undo')));
    });
    el('collab-invite-result').addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-copy-link]');
      if (!btn) return;
      const link = btn.getAttribute('data-copy-link') || '';
      const ok = await copyTextValue(link);
      if (ok) {
        toast('链接已复制');
        return;
      }
      const code = btn.parentElement ? btn.parentElement.querySelector('.collab-link') : null;
      if (code) {
        try {
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (error) {}
      }
      toast('浏览器限制了剪贴板，已选中链接，请按 Ctrl+C 复制');
    });
    const railArchive = el('rail-archive');
    if (railArchive) {
      railArchive.addEventListener('click', () => {
        closeOtherSheets('');
      });
    }
    el('btn-refresh').addEventListener('click', async () => {
      await loadOverview();
      if (state.groupId) await loadQuotes();
      if (state.stats.open) await loadStats();
      if (state.collab.open) await loadCollab(true);
      toast('已刷新');
    });

    let searchTimer = 0;
    el('search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const next = el('search').value.trim();
        if (next === state.keyword) return;
        state.keyword = next;
        state.page = 1;
        await loadQuotes();
      }, 320);
    });
    el('search').addEventListener('change', async () => {
      state.keyword = el('search').value.trim();
      state.page = 1;
      await loadQuotes();
    });
    el('search').addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        state.keyword = el('search').value.trim();
        state.page = 1;
        await loadQuotes();
      }
    });

    el('sort').addEventListener('change', async () => {
      state.sort = el('sort').value;
      state.page = 1;
      await loadQuotes();
    });

    el('page-size').addEventListener('change', async () => {
      state.pageSize = gridPageSize();
      state.page = 1;
      await loadQuotes();
    });

    el('btn-select-all').addEventListener('click', () => {
      state.items.forEach((item) => state.selected.add(item.name));
      document.querySelectorAll('.card').forEach((card) => {
        card.classList.add('selected');
        const box = card.querySelector('input[type="checkbox"]');
        if (box) box.checked = true;
      });
      updateSelectionUi();
    });

    el('btn-clear').addEventListener('click', () => {
      state.selected.clear();
      document.querySelectorAll('.card').forEach((card) => {
        card.classList.remove('selected');
        const box = card.querySelector('input[type="checkbox"]');
        if (box) box.checked = false;
      });
      updateSelectionUi();
    });

    el('btn-delete').addEventListener('click', deleteSelected);
    el('btn-move').addEventListener('click', moveSelected);
    el('btn-delete-group').addEventListener('click', deleteWholeGroup);
    el('btn-save-settings').addEventListener('click', saveSettings);
    el('btn-rebind-quotes').addEventListener('click', rebindQuotes);
    el('btn-mark-restricted').addEventListener('click', () => markRestricted(true));
    el('btn-unmark-restricted').addEventListener('click', () => markRestricted(false));
    el('btn-scan-rating').addEventListener('click', scanRating);
    el('restricted-filter').addEventListener('change', async () => {
      state.restrictedFilter = el('restricted-filter').value || '0';
      state.page = 1;
      await loadQuotes();
    });
    el('btn-sent-clear').addEventListener('click', clearSent);

    el('btn-semantic-run').addEventListener('click', runSemantic);
    el('btn-semantic-cancel').addEventListener('click', cancelSemantic);
    el('btn-semantic-reset').addEventListener('click', resetSemantic);
    el('semantic-mode').addEventListener('change', async () => {
      applySemanticMode();
      state.page = 1;
      await loadQuotes();
    });
    el('min-score').addEventListener('change', async () => {
      state.minScore = Number(el('min-score').value || 0);
      if (state.mode === 'semantic') {
        state.page = 1;
        await loadQuotes();
      }
    });

    el('btn-prev').addEventListener('click', async () => {
      if (state.page <= 1) return;
      state.page -= 1;
      await loadQuotes();
    });
    el('btn-next').addEventListener('click', async () => {
      if (state.page >= state.pages) return;
      state.page += 1;
      await loadQuotes();
    });

    el('lightbox-close').addEventListener('click', closeLightbox);
    el('lightbox').addEventListener('click', (event) => {
      if (event.target === el('lightbox')) closeLightbox();
    });
    el('lightbox-assign').addEventListener('click', () => {
      const item = state.lightboxItem;
      if (item) openAssign('single', [item.name]);
    });
    el('lightbox-clear-subject').addEventListener('click', clearLightboxSubject);

    el('subject-filter').addEventListener('change', async () => {
      state.subjectFilter = el('subject-filter').value;
      state.page = 1;
      await loadQuotes();
    });
    el('btn-assign').addEventListener('click', () =>
      openAssign('multi', Array.from(state.selected))
    );

    el('assign-cancel').addEventListener('click', closeAssign);
    el('assign-modal').addEventListener('click', (event) => {
      if (event.target === el('assign-modal')) closeAssign();
    });
    el('assign-search').addEventListener('change', () => {
      state.assign.q = el('assign-search').value.trim();
      loadAssignCandidates();
    });
    el('assign-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        state.assign.q = el('assign-search').value.trim();
        loadAssignCandidates();
      }
    });

    el('btn-people').addEventListener('click', openPeople);
    el('people-close').addEventListener('click', closePeople);
    el('people-modal').addEventListener('click', (event) => {
      if (event.target === el('people-modal')) closePeople();
    });
    el('people-search').addEventListener('change', () => {
      state.people.q = el('people-search').value.trim();
      state.people.page = 1;
      loadPeople();
    });
    el('people-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        state.people.q = el('people-search').value.trim();
        state.people.page = 1;
        loadPeople();
      }
    });
    el('btn-people-sync').addEventListener('click', syncIdentities);
    el('btn-alias-refresh').addEventListener('click', loadAliasCandidates);
    el('btn-alias-learn').addEventListener('click', learnAliasesNow);
    el('alias-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-alias-action]');
      if (!button) return;
      const id = Number(button.getAttribute('data-id') || 0);
      if (!id) return;
      if (button.getAttribute('data-alias-action') === 'confirm') confirmAlias(id);
      else rejectAlias(id);
    });
    el('identity-auto-sync').addEventListener('change', () =>
      saveIdentitySchedule({ enabled: el('identity-auto-sync').checked })
    );
    el('identity-sync-interval').addEventListener('change', () =>
      saveIdentitySchedule({ interval_hours: Number(el('identity-sync-interval').value) || 24 })
    );
    el('btn-people-backfill').addEventListener('click', backfillSubjects);
    el('btn-people-review').addEventListener('click', openReview);
    el('btn-people-tidy').addEventListener('click', tidyAliases);
    el('btn-people-speaker').addEventListener('click', backfillSpeakers);
    el('btn-people-match').addEventListener('click', () => el('people-file').click());
    el('people-file').addEventListener('change', () => {
      const file = el('people-file').files && el('people-file').files[0];
      el('people-file').value = '';
      matchByFile(file);
    });
    el('people-prev').addEventListener('click', () => {
      if (state.people.page <= 1) return;
      state.people.page -= 1;
      loadPeople();
    });
    el('people-next').addEventListener('click', () => {
      if (state.people.page >= state.people.pages) return;
      state.people.page += 1;
      loadPeople();
    });
    el('btn-people-merge').addEventListener('click', mergePeople);
    el('btn-people-split').addEventListener('click', splitCurrentPerson);
    el('btn-people-clear-sel').addEventListener('click', () => {
      state.people.selected.clear();
      renderPeople();
    });

    el('btn-stats').addEventListener('click', openStats);
    el('btn-collections').addEventListener('click', openCollections);
    el('collections-close').addEventListener('click', closeCollections);
    el('btn-collections-refresh').addEventListener('click', loadCollections);
    el('btn-collections-new').addEventListener('click', newCollectionDraft);
    el('btn-collection-save').addEventListener('click', saveCollection);
    el('btn-collection-delete').addEventListener('click', deleteCollection);
    el('btn-collection-add-selected').addEventListener('click', addSelectedToCollection);
    el('btn-add-to-collection').addEventListener('click', openCollections);
    el('btn-weekly-save').addEventListener('click', saveWeekly);
    el('btn-weekly-test').addEventListener('click', testWeekly);
    el('collections-modal').addEventListener('click', (event) => {
      if (event.target === el('collections-modal')) closeCollections();
    });
    el('stats-close').addEventListener('click', closeStats);
    el('stats-modal').addEventListener('click', (event) => {
      if (event.target === el('stats-modal')) closeStats();
    });
    el('btn-stats-refresh').addEventListener('click', loadStats);
    el('stats-scope').addEventListener('change', () => {
      state.stats.scope = el('stats-scope').value;
      loadStats();
    });
    el('stats-top').addEventListener('change', () => {
      state.stats.top = parseInt(el('stats-top').value, 10) || 20;
      loadStats();
    });

    el('btn-trash').addEventListener('click', openTrash);
    el('trash-close').addEventListener('click', closeTrash);
    el('btn-trash-refresh').addEventListener('click', loadTrash);
    el('btn-trash-empty').addEventListener('click', emptyTrashAll);
    el('trash-modal').addEventListener('click', (event) => {
      if (event.target === el('trash-modal')) closeTrash();
    });
    el('filter-person').addEventListener('change', async () => {
      state.filterPerson = el('filter-person').value;
      state.page = 1;
      await loadQuotes();
    });
    const applyTagFilter = async () => {
      state.filterTags = (el('filter-tag').value || '').trim();
      state.page = 1;
      await loadQuotes();
    };
    el('filter-tag').addEventListener('change', applyTagFilter);
    el('filter-tag').addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') await applyTagFilter();
    });
    el('filter-range').addEventListener('change', async () => {
      state.filterRange = Number(el('filter-range').value) || 0;
      state.page = 1;
      await loadQuotes();
    });
    el('btn-insights').addEventListener('click', openInsights);
    el('insights-close').addEventListener('click', closeInsights);
    el('btn-insights-refresh').addEventListener('click', loadHeatmap);
    el('btn-timeline-load').addEventListener('click', loadTimeline);
    el('btn-annual-load').addEventListener('click', loadAnnualPreview);
    el('insights-modal').addEventListener('click', (event) => {
      if (event.target === el('insights-modal')) closeInsights();
    });
    el('btn-tag-scan').addEventListener('click', scanTags);
    el('btn-tag-pause').addEventListener('click', toggleTagPause);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (state.assign.open) {
          closeAssign();
          return;
        }
        if (state.stats.open) {
          closeStats();
          return;
        }
        if (state.people.open) {
          closePeople();
          return;
        }
        if (state.insights.open) {
          closeInsights();
          return;
        }
        if (state.trash.open) {
          closeTrash();
          return;
        }
        closeLightbox();
      }
    });
  }

  function applyContext(context) {
    state.ctx = context || {};
    if (state.ctx.isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    if (state.ctx.pageTitle) document.title = state.ctx.pageTitle;
  }

  async function boot() {
    try {
      state.plugin = await waitForBridge();
      if (typeof state.plugin.ready === 'function') await state.plugin.ready();
      applyContext(typeof state.plugin.getContext === 'function' ? state.plugin.getContext() : {});
      if (typeof state.plugin.onContext === 'function') {
        state.plugin.onContext((context) => applyContext(context));
      }
      bindEvents();
      applySemanticMode();
      resetMain();
      await loadOverview();
      await loadSemanticStatus();
      await loadSent();
      if (!state.groupId) {
        el('subtitle').textContent = '还没有任何群投稿过语录';
      }
    } catch (error) {
      el('subtitle').textContent = '初始化失败：' + (error && error.message ? error.message : error);
      toast('初始化失败：' + (error && error.message ? error.message : error), 6000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
