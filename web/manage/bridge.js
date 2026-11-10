/**
 * Bridge shim for the ported AstrBot plugin page.
 *
 * The original page talks to AstrBot through `window.AstrBotPluginPage`; this
 * shim implements the same shape on top of the dsh-quote-archive host routes.
 * API URLs are document-relative so the page also works under a sub-path
 * (<base href="./">) deployment.
 */
(function () {
  'use strict';

  var API_BASE = new URL('../admin-api/', window.location.href);
  var PAGE_TITLE = '语录档案';

  async function request(method, route, payload) {
    var url = new URL(String(route || ''), API_BASE);
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    };
    if (method === 'GET') {
      var params = payload || {};
      Object.keys(params).forEach(function (key) {
        var value = params[key];
        if (value === undefined || value === null) return;
        url.searchParams.set(key, String(value));
      });
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload || {});
    }
    var response = await fetch(url.toString(), init);
    var text = await response.text();
    var data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error('接口返回了非 JSON 内容（HTTP ' + response.status + '）');
      }
    }
    if (!response.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || '接口请求失败（HTTP ' + response.status + '）');
    }
    return data;
  }

  var PORTED_MODULES = { archive: true, stats: true, insights: true, trash: true, people: true, collections: true, collab: true };

  function hideUnportedModules() {
    var selector = '[data-module]';
    var nodes = document.querySelectorAll(selector);
    Array.prototype.forEach.call(nodes, function (node) {
      var moduleName = node.getAttribute('data-module');
      if (moduleName && !PORTED_MODULES[moduleName]) {
        node.style.display = 'none';
      }
    });
    // Annual report needs server-side image rendering; hide that section for now.
    var annual = document.querySelector('#annual-preview');
    if (annual) {
      var section = annual.closest('section');
      if (section) section.style.display = 'none';
    }
    var meta = document.querySelector('.rail-meta');
    if (meta) meta.textContent = 'Q.C. / DSH';
  }

  window.AstrBotPluginPage = {
    apiGet: function (path, params) {
      return request('GET', path, params);
    },
    apiPost: function (path, body) {
      return request('POST', path, body);
    },
    ready: function () {
      return Promise.resolve();
    },
    getContext: function () {
      var dark = false;
      try {
        dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (error) {
        /* ignore */
      }
      return { isDark: dark, pageTitle: PAGE_TITLE };
    },
    onContext: function () {
      /* the theme is static inside the iframe */
    },
  };


  // ---------------------------------------------------------------- //
  // DSH quick actions: sync / random / send, layered on the ported page.
  // ---------------------------------------------------------------- //
  var QA = {
    status: 'dsh/status',
    random: 'dsh/random',
    send: 'dsh/send',
    sync: 'dsh/sync',
    discover: 'dsh/discover',
    enable: 'dsh/enable',
    disable: 'dsh/disable',
    collect: 'dsh/collect',
  };
  var qaState = { quote: null, busy: false };

  function qaNode(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function installQuickActions() {
    try {
      if (document.getElementById('dsh-quick-actions')) return;
      var style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-quote-archive/quick-actions.css');
      style.textContent = [
        '#dsh-quick-actions{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:278px;',
        'background:var(--paper,#fbf5ed);color:#111;border:1px solid rgba(17,17,17,.18);',
        'box-shadow:0 10px 30px rgba(17,17,17,.16);border-radius:14px;padding:12px 14px;',
        'font:13px/1.5 "Microsoft YaHei","Noto Sans SC",sans-serif;}',
        '#dsh-quick-actions .qa-title{display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:8px;}',
        '#dsh-quick-actions .qa-dot{width:8px;height:8px;border-radius:50%;background:#c9c4bd;display:inline-block;margin-right:6px;}',
        '#dsh-quick-actions.is-online .qa-dot{background:#d0e516;}',
        '#dsh-quick-actions .qa-row{display:flex;gap:6px;margin-top:8px;align-items:center;}',
        '#dsh-quick-actions .qa-home{flex:1;min-width:0;border:1px solid rgba(17,17,17,.18);border-radius:8px;padding:4px 8px;font-size:12px;background:rgba(255,255,255,.6);color:#111;}',
        '#dsh-quick-actions select{flex:1;min-width:0;padding:5px 6px;border:1px solid rgba(17,17,17,.24);background:#fff;border-radius:8px;}',
        '#dsh-quick-actions button{cursor:pointer;padding:5px 10px;border-radius:8px;border:1px solid rgba(17,17,17,.24);background:#fff;}',
        '#dsh-quick-actions button.primary{background:#111;color:#fbf5ed;border-color:#111;}',
        '#dsh-quick-actions button.lime{background:#d0e516;color:#111;border-color:#d0e516;font-weight:700;}',
        '#dsh-quick-actions button:disabled{opacity:.45;cursor:default;}',
        '#dsh-quick-actions .qa-preview{display:none;margin-top:8px;border-radius:10px;overflow:hidden;background:#111;}',
        '#dsh-quick-actions .qa-preview img{display:block;width:100%;max-height:150px;object-fit:cover;}',
        '#dsh-quick-actions .qa-caption{margin:6px 8px 8px;color:#fbf5ed;font-size:12px;word-break:break-word;}',
        '#dsh-quick-actions .qa-caption-input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:8px;border:1px solid rgba(17,17,17,.24);}',
        '#dsh-quick-actions .qa-status{color:rgba(17,17,17,.62);font-size:12px;margin-top:8px;min-height:16px;word-break:break-word;}',
        '#dsh-quick-actions .qa-check{display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;}',
        '#dsh-quick-actions .qa-interval{width:62px;padding:4px 6px;border:1px solid rgba(17,17,17,.24);border-radius:8px;font-size:12px;}',
        '#dsh-quick-actions .qa-save{font-size:12px;padding:4px 9px;}',
      ].join('');
      document.head.appendChild(style);

      var host = qaNode('section', '');
      host.id = 'dsh-quick-actions';
      var title = qaNode('div', 'qa-title');
      var titleText = qaNode('span', '', 'DSH 快捷操作');
      var online = qaNode('span', '');
      online.appendChild(qaNode('span', 'qa-dot'));
      var onlineText = qaNode('span', '', '连接中');
      online.appendChild(onlineText);
      title.appendChild(titleText);
      title.appendChild(online);
      host.appendChild(title);

      var row1 = qaNode('div', 'qa-row');
      var select = qaNode('select', '');
      select.id = 'dsh-qa-group';
      var syncBtn = qaNode('button', 'primary', '立即采集');
      syncBtn.type = 'button';
      row1.appendChild(select);
      row1.appendChild(syncBtn);
      host.appendChild(row1);

      var row2 = qaNode('div', 'qa-row');
      var randomBtn = qaNode('button', 'lime', '随机一条');
      randomBtn.type = 'button';
      var sendBtn = qaNode('button', '', '发送到群');
      sendBtn.type = 'button';
      sendBtn.disabled = true;
      row2.appendChild(randomBtn);
      row2.appendChild(sendBtn);
      host.appendChild(row2);

      var preview = qaNode('div', 'qa-preview');
      var image = document.createElement('img');
      image.alt = '';
      var caption = qaNode('div', 'qa-caption', '');
      preview.appendChild(image);
      preview.appendChild(caption);
      host.appendChild(preview);

      var row3 = qaNode('div', 'qa-row');
      var captionInput = qaNode('input', 'qa-caption-input', '');
      captionInput.type = 'text';
      captionInput.placeholder = '附言（可选）';
      row3.appendChild(captionInput);
      host.appendChild(row3);

      var row4 = qaNode('div', 'qa-row');
      var homeInput = qaNode('input', 'qa-home');
      homeInput.type = 'text';
      homeInput.placeholder = 'SnowLuma 目录（自动找不到时填，如 F:\\mission\\SnowLuma）';
      row4.appendChild(homeInput);
      var detectBtn = qaNode('button', '', '检测通道');
      detectBtn.type = 'button';
      row4.appendChild(detectBtn);
      host.appendChild(row4);

      var row5 = qaNode('div', 'qa-row');
      var autoLabel = qaNode('label', 'qa-check');
      var autoCollect = document.createElement('input');
      autoCollect.type = 'checkbox';
      autoLabel.appendChild(autoCollect);
      autoLabel.appendChild(qaNode('span', '', '自动采集'));
      var intervalInput = qaNode('input', 'qa-interval');
      intervalInput.type = 'number';
      intervalInput.min = '60';
      intervalInput.step = '30';
      intervalInput.title = '采集间隔（秒）';
      var saveCollect = qaNode('button', 'qa-save', '保存');
      saveCollect.type = 'button';
      row5.appendChild(autoLabel);
      row5.appendChild(intervalInput);
      row5.appendChild(saveCollect);
      host.appendChild(row5);

      var collectDirty = false;
      autoCollect.addEventListener('change', function () {
        collectDirty = true;
      });
      intervalInput.addEventListener('input', function () {
        collectDirty = true;
      });

      var status = qaNode('div', 'qa-status', '');
      host.appendChild(status);
      document.body.appendChild(host);

      var noticeText = '';
      var noticeUntil = 0;
      function setStatus(text) {
        status.textContent = text || '';
      }
      function setNotice(text) {
        noticeText = text || '';
        noticeUntil = Date.now() + 8000;
        setStatus(noticeText);
      }

      function syncButtons() {
        syncBtn.disabled = qaState.busy;
        randomBtn.disabled = qaState.busy;
        sendBtn.disabled = qaState.busy || !qaState.quote;
      }

      async function refreshStatus() {
        try {
          var data = await request('GET', QA.status);
          var channel = data.channel || {};
          host.classList.toggle('is-online', Boolean(channel.reachable));
          onlineText.textContent = channel.reachable
            ? 'QQ 通道已连接'
            : channel.enabled
              ? 'QQ 通道离线'
              : 'QQ 通道未启用';
          var list = Array.isArray(channel.group_list) ? channel.group_list : [];
          var seen = {};
          var keep = select.value;
          select.innerHTML = '';
          list.forEach(function (row) {
            var id = String((row && row.group) || '');
            if (!id || seen[id]) return;
            seen[id] = 1;
            var opt = document.createElement('option');
            opt.value = id;
            opt.textContent = (row.name || id) + '（' + id + '）';
            select.appendChild(opt);
          });
          if (select.options.length === 0) {
            (Array.isArray(channel.groups) ? channel.groups : []).forEach(function (id) {
              var opt = document.createElement('option');
              opt.value = String(id);
              opt.textContent = String(id);
              select.appendChild(opt);
            });
          }
          if (keep && Array.prototype.some.call(select.options, function (o) { return o.value === keep; })) {
            select.value = keep;
          } else if (!keep && Array.isArray(channel.groups) && channel.groups.length > 0) {
            var wanted = String(channel.groups[0]);
            if (Array.prototype.some.call(select.options, function (o) { return o.value === wanted; })) {
              select.value = wanted;
            }
          }
          var collect = data.collect || {};
          if (!collectDirty) {
            autoCollect.checked = Boolean(collect.autoCollect);
            if (collect.pollIntervalSec) intervalInput.value = String(collect.pollIntervalSec);
          }
          var onlineReady = Boolean(channel.reachable);
          autoCollect.disabled = !onlineReady;
          intervalInput.disabled = !onlineReady;
          saveCollect.disabled = !onlineReady;
          if (!channel.reachable || channel.error) {
            setStatus((channel.error || 'QQ 通道离线') + '；点「检测通道」自动发现');
          } else if (Date.now() < noticeUntil) {
            setStatus(noticeText);
          } else {
            var archive = data.archive || {};
            setStatus(
              '语录 ' +
                (archive.quotes || 0) +
                ' 条 · 群 ' +
                (archive.groups || 0) +
                ' 个' +
                (channel.source ? ' · 来源 ' + channel.source : ''),
            );
          }
        } catch (error) {
          host.classList.remove('is-online');
          onlineText.textContent = '状态读取失败';
          setStatus(error.message || String(error));
        }
      }

      syncBtn.addEventListener('click', async function () {
        if (qaState.busy) return;
        qaState.busy = true;
        syncButtons();
        setStatus('采集中…');
        try {
          var data = await request('POST', QA.sync, { group_id: select.value });
          setStatus('采集完成：新增 ' + (data.added || 0) + ' 条（库中 ' + (data.total || 0) + ' 条）');
        } catch (error) {
          setStatus('采集失败：' + (error.message || error));
        }
        qaState.busy = false;
        syncButtons();
        refreshStatus();
      });

      randomBtn.addEventListener('click', async function () {
        if (qaState.busy) return;
        qaState.busy = true;
        syncButtons();
        setStatus('抽取中…');
        try {
          var data = await request('GET', QA.random, { group_id: select.value });
          var quote = data.quote || null;
          if (!quote) throw new Error('没有可抽取的语录');
          var imageData = await request('GET', 'image', {
            group_id: quote.group_id,
            name: quote.name,
            size: 'original',
          });
          image.src = imageData.data_url;
          var label = '#' + quote.id;
          if (quote.speaker) label += ' ' + quote.speaker;
          if (quote.caption) label += ' · ' + quote.caption;
          caption.textContent = label;
          preview.style.display = 'block';
          qaState.quote = quote;
          setStatus('抽到 #' + quote.id + '，可以发送到群');
        } catch (error) {
          qaState.quote = null;
          preview.style.display = 'none';
          setStatus('抽取失败：' + (error.message || error));
        }
        qaState.busy = false;
        syncButtons();
      });

      sendBtn.addEventListener('click', async function () {
        if (qaState.busy || !qaState.quote) return;
        qaState.busy = true;
        syncButtons();
        setStatus('发送中…');
        try {
          var data = await request('POST', QA.send, {
            quote_id: qaState.quote.id,
            group_id: select.value,
            caption: captionInput.value.trim() || undefined,
          });
          setStatus('已发送 #' + (data.quote && data.quote.id) + ' 到群 ' + data.group_id + '（消息 ' + (data.message_id || '') + '）');
        } catch (error) {
          setStatus('发送失败：' + (error.message || error));
        }
        qaState.busy = false;
        syncButtons();
      });

      select.addEventListener('change', function () {
        qaState.quote = null;
        preview.style.display = 'none';
        syncButtons();
      });

      saveCollect.addEventListener('click', async function () {
        saveCollect.disabled = true;
        setStatus('保存采集中…');
        try {
          var payload = {
            autoCollect: Boolean(autoCollect.checked),
            pollIntervalSec: Number(intervalInput.value) || 300,
          };
          if (select.value) payload.group = select.value;
          var data = await request('POST', QA.collect, payload);
          if (!data || !data.ok) throw new Error((data && data.error) || '未知错误');
          var collect = data.collect || {};
          collectDirty = false;
          setNotice(
            '采集设置已保存：' +
              (collect.autoCollect ? '自动采集开' : '自动采集关') +
              '，间隔 ' +
              (collect.pollIntervalSec || intervalInput.value) +
              ' 秒',
          );
          await refreshStatus();
        } catch (error) {
          setStatus('保存失败：' + (error.message || error));
        } finally {
          saveCollect.disabled = false;
        }
      });

      detectBtn.addEventListener('click', async function () {
        if (qaState.busy) return;
        qaState.busy = true;
        syncButtons();
        detectBtn.disabled = true;
        setStatus('检测中…');
        try {
          var info = await request('GET', QA.discover);
          var channel = (info && info.channel) || {};
          if (channel.reachable) {
            var applied = await request('POST', QA.enable, {});
            var login = channel.login || {};
            setStatus(
              '已启用：' +
                (login.nickname || login.userId || 'QQ') +
                '（' +
                (channel.groups || 0) +
                ' 群）' +
                (channel.source ? '，来源 ' + channel.source : ''),
            );
            await refreshStatus();
          } else {
            var home = String(homeInput.value || '').trim();
            if (home) {
              await request('POST', QA.enable, { snowlumaHome: home });
              var probe = await request('GET', QA.discover);
              var probeChannel = (probe && probe.channel) || {};
              if (probeChannel.reachable) {
                var probeLogin = probeChannel.login || {};
                setStatus(
                  '已启用：' +
                    (probeLogin.nickname || probeLogin.userId || 'QQ') +
                    '（' +
                    (probeChannel.groups || 0) +
                    ' 群）' +
                    (probeChannel.source ? '，来源 ' + probeChannel.source : ''),
                );
                await refreshStatus();
              } else {
                setStatus('已保存 SnowLuma 目录，但仍未连接：' + (probeChannel.error || '请确认 OneBot HTTP 已启动'));
              }
            } else {
              setStatus(
                '未检测到可用通道：' +
                  (channel.error || '请先启动 SnowLuma 的 OneBot HTTP 服务') +
                  '；可在左侧填写 SnowLuma 目录后重试',
              );
            }
          }
        } catch (error) {
          setStatus('检测失败：' + (error.message || String(error)));
        }
        qaState.busy = false;
        detectBtn.disabled = false;
        syncButtons();
      });

      syncButtons();
      refreshStatus();
      window.setInterval(refreshStatus, 30000);
    } catch (error) {
      try {
        console.warn('[quote-archive] quick actions unavailable', error);
      } catch (ignored) {
        /* ignore */
      }
    }
  }

  function ready() {
    hideUnportedModules();
    installQuickActions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
