/**
 * dsh-quote-archive — browser half.
 *
 * Registers the sidebar row and the center-column page. The page itself is the
 * original AstrBot admin UI (copied under web/manage/) loaded in an iframe and
 * wired to the host through web/manage/bridge.js + lib/manage.js, so the whole
 * management experience works without re-implementing it in React.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quote-archive',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;

    /** Stable id shared by the sidebar row and the main-slot page. */
    const PANEL_ID = 'quote-archive';
    /** Locale namespace this plugin owns. */
    const NS = 'dsh-quote-archive';
    /** Document-relative URL of the ported management page. */
    const PAGE_URL = 'quote-archive/ui/index.html';
    /** Temporary self-diagnostic beacon (host logs the query). */
    const DIAG_URL = 'quote-archive/diag';

    function diag(payload) {
      try {
        const params = new URLSearchParams();
        for (const key of Object.keys(payload || {})) {
          const value = payload[key];
          if (value === undefined || value === null) continue;
          params.set(key, String(value).slice(0, 400));
        }
        params.set('t', String(Date.now()));
        void fetch(DIAG_URL + '?' + params.toString(), { method: 'GET' }).catch(() => {});
      } catch {
        /* diagnostics must never break the panel */
      }
    }

    const ZH = { 'entry.label': '语录库' };
    const EN = { 'entry.label': 'Quote Archive' };
    let runtimeT;
    function setRuntimeTranslate(t) {
      runtimeT = t;
    }
    function tt(key) {
      if (typeof runtimeT === 'function') {
        try {
          const value = runtimeT(key);
          if (value) return value;
        } catch {
          /* fall through */
        }
      }
      const lang = typeof document !== 'undefined' ? String(document.documentElement?.lang || '') : '';
      const dictionary = lang.toLowerCase().startsWith('en') ? EN : ZH;
      return dictionary[key] || key;
    }

    const CSS = `
.dqa_host{position:relative;height:100%;width:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fbf5ed)}
.dqa_frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fbf5ed;color-scheme:light}
`;
    const CSS_TAG_ID = 'dsh-quote-archive/panel.css';

    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-quote-archive';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** Sidebar glyph: a quote mark inside a paper tile. */
    function QuoteArchiveIcon(props) {
      const size = Number(props && props.size) || 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          'data-dsh-panel-entry': PANEL_ID,
          focusable: 'false',
        },
        h('rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M9.2 9.1c1.5.7 2.3 1.8 2.3 3.3 0 2-1.2 3.3-3 3.3-1.4 0-2.4-1-2.4-2.4 0-1.9 1.1-3.5 3.1-4.2Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M15.6 9.1c1.5.7 2.3 1.8 2.3 3.3 0 2-1.2 3.3-3 3.3-1.4 0-2.4-1-2.4-2.4 0-1.9 1.1-3.5 3.1-4.2Z',
          fill: 'currentColor',
        }),
      );
    }

    /** Center page: the ported AstrBot management UI. */
    function QuoteArchivePanel() {
      if (typeof React.useEffect === 'function') {
        React.useEffect(() => {
          diag({ src: 'panel-mount', href: typeof location !== 'undefined' ? location.href : '' });
          try {
            fetch(PAGE_URL, { method: 'GET', credentials: 'same-origin' })
              .then(async (response) => {
                let length = -1;
                let head = '';
                try {
                  const body = await response.text();
                  length = body.length;
                  head = body.slice(0, 60).replace(/\s+/g, ' ');
                } catch {
                  /* ignore */
                }
                diag({
                  src: 'page-fetch',
                  status: response.status,
                  type: String(response.headers.get('content-type') || ''),
                  len: length,
                  head,
                });
              })
              .catch((error) => diag({ src: 'page-fetch-error', msg: String(error) }));
          } catch (error) {
            diag({ src: 'page-fetch-throw', msg: String(error) });
          }
        }, []);
      }
      return h(
        'div',
        { className: 'dqa_host' },
        h('iframe', {
          className: 'dqa_frame',
          src: PAGE_URL,
          title: tt('entry.label'),
          loading: 'lazy',
          onLoad: () => diag({ src: 'iframe-load' }),
          onError: () => diag({ src: 'iframe-error' }),
        }),
      );
    }

    // Services the runtime must provide before this half mounts.
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      injectStyles();
      try {
        diag({ src: 'client-apply', href: typeof location !== 'undefined' ? location.href : '' });
      } catch {
        /* ignore */
      }
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        } catch {
          return () => {};
        }
      }, 'dsh-quote-archive:client-dictionaries');
      try {
        setRuntimeTranslate(ctx.locale.bind(NS));
      } catch {
        // Use the bundled dictionary.
      }
      const disposers = [];
      try {
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 40,
                label: () => tt('entry.label'),
              },
              QuoteArchiveIcon,
            ),
          ),
        );
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, QuoteArchivePanel),
          ),
        );
      } catch (error) {
        console.warn('[quote-archive] panel registration failed:', error);
      }
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose();
        },
        'dsh-quote-archive:client-mounts',
      );
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
