/* DevCol analytics. No cookies, no deps. Source: github.com/devcol-main/devcol-analytics */
(function (w, d) {
  var n = navigator
  var api = (w.devcol = w.devcol || {})
  if (api.track) return
  var noop = function () {}
  api.track = api.page = noop
  // Respect Do Not Track / Global Privacy Control, and skip automated browsers.
  if (n.webdriver || n.doNotTrack == '1' || w.doNotTrack == '1' || n.globalPrivacyControl) return

  var el = d.currentScript
  var EP = (el && el.getAttribute('data-endpoint')) || 'https://a.devcol.net/e'
  var isGame = /^\/games\/[^/]+/.test(location.pathname)
  var ss, sid, entry = 1, cur, t0, maxScroll, left

  try {
    ss = w.sessionStorage
    sid = ss.getItem('dc_sid')
    entry = !ss.getItem('dc_e')
    ss.setItem('dc_e', '1')
  } catch (e) {}
  if (!sid) {
    sid = ''
    var b = crypto.getRandomValues(new Uint8Array(12))
    for (var i = 0; i < b.length; i++) sid += (b[i] + 256).toString(16).slice(1)
    try { ss.setItem('dc_sid', sid) } catch (e) {}
  }

  function send(t, props, path, r) {
    var body = JSON.stringify({ t: t, p: path || location.pathname, r: r || '', s: sid, props: props || {} })
    try { if (n.sendBeacon && n.sendBeacon(EP, body)) return } catch (e) {}
    try { fetch(EP, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }).catch(noop) } catch (e) {}
  }

  function scroll() {
    var max = d.documentElement.scrollHeight - w.innerHeight
    var pct = max > 0 ? Math.round(Math.min(1, w.scrollY / max) * 100) : 100
    if (pct > maxScroll) maxScroll = pct
  }

  // page_leave for the current page, at most once per page view.
  function leave() {
    if (!cur || left) return
    left = 1
    send('page_leave', { duration_ms: Date.now() - t0, scroll_pct: maxScroll }, cur)
  }

  // Page view for the current URL. Safe to call repeatedly (same path is a no-op).
  // Under /games/<slug>/ the first load counts as game_start instead.
  api.page = function () {
    var path = location.pathname
    if (path === cur) return
    leave()
    cur = path
    t0 = Date.now()
    left = 0
    maxScroll = 0
    scroll()
    var props = isGame ? {} : { title: d.title.slice(0, 120) }
    var q = new URLSearchParams(location.search)
    ;['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
      var v = q.get(k)
      if (v) props[k] = v.slice(0, 64)
    })
    var r = ''
    if (entry) {
      props.entry = 1
      r = d.referrer
      entry = 0
    }
    send(isGame ? 'game_start' : 'pageview', props, path, r)
  }

  // devcol.track('stage_clear', { stage: 3, score: 120 })
  api.track = function (type, props) {
    send(type, props)
  }

  w.addEventListener('scroll', scroll, { passive: true })
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'hidden') leave()
  })
  w.addEventListener('pagehide', leave)
  api.page()
})(window, document)
