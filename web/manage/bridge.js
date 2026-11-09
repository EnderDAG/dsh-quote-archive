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

  function hideUnportedModules() {
    var selector = '[data-module]';
    var nodes = document.querySelectorAll(selector);
    Array.prototype.forEach.call(nodes, function (node) {
      var moduleName = node.getAttribute('data-module');
      if (moduleName && moduleName !== 'archive') {
        node.style.display = 'none';
      }
    });
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideUnportedModules);
  } else {
    hideUnportedModules();
  }
})();
