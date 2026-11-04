// dsh-plugins 客户端半边：侧栏「插件管理」入口 + 主面板（iframe → /dsh-plugins）
;(function () {
  const PANEL_ID = 'plugins-manager'
  const SLOT_PANEL_LIST = 'sidebar.panellist'
  const SLOT_MAIN = 'main'
  const LABEL = '插件管理'
  const PAGE_URL = '/dsh-plugins'

  function makeIcon(React) {
    return function PuzzleIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      const active = props.active === true
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: {
            display: 'block',
            color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        },
        React.createElement('rect', { key: 'a', x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.6 }),
        React.createElement('rect', { key: 'b', x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.6 }),
        React.createElement('rect', { key: 'c', x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.6 }),
        React.createElement('rect', { key: 'd', x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.6 }),
      )
    }
  }

  function makePanel(React) {
    return function PluginsPanel() {
      return React.createElement(
        'div',
        { style: { position: 'relative', height: '100%', minHeight: 0, background: 'transparent' } },
        React.createElement('iframe', {
          src: PAGE_URL,
          title: '插件管理',
          style: { border: '0', width: '100%', height: '100%', display: 'block', background: 'transparent', minHeight: '60vh' },
        }),
      )
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-plugins',
    factory: (require) => {
      const React = require('react')
      const Icon = makeIcon(React)
      const Panel = makePanel(React)
      return {
        name: 'plugins-client',
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject(SLOT_PANEL_LIST, () =>
            ctx.slots.register({ name: SLOT_PANEL_LIST, id: PANEL_ID, order: 6, label: () => LABEL }, Icon),
          )
          ctx.slots.inject(SLOT_MAIN, () => ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, Panel))
        },
      }
    },
  })
})()
