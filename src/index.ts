import type { AppEnv } from './env'
import { handleAdmin } from './admin'
import { runDailyCron } from './aggregate'
import { handleCollect } from './collect'
import { handlePublicSummary } from './public'
import { handleDelete, handleReport, handleSubmit, handleTop, lbPreflight } from './lb/api'
import { runLeaderboardCron } from './lb/maintain'
import { matchOrigin } from './util'

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url)

    if (pathname === '/e') {
      if (req.method === 'POST') return handleCollect(req, env)
      if (req.method === 'OPTIONS') {
        const origin = matchOrigin(req.headers.get('Origin'), env)
        const headers: Record<string, string> = { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
        if (origin) headers['Access-Control-Allow-Origin'] = origin
        return new Response(null, { status: 204, headers })
      }
      return new Response('Method not allowed', { status: 405 })
    }
    if (pathname === '/public/summary' && (req.method === 'GET' || req.method === 'OPTIONS')) {
      return handlePublicSummary(req, env)
    }
    if (pathname.startsWith('/lb/')) {
      if (req.method === 'OPTIONS') return lbPreflight(req, env)
      if (pathname === '/lb/top' && req.method === 'GET') return handleTop(req, env)
      if (req.method === 'POST') {
        if (pathname === '/lb/submit') return handleSubmit(req, env)
        if (pathname === '/lb/delete') return handleDelete(req, env)
        if (pathname === '/lb/report') return handleReport(req, env)
      }
      return new Response('Not found', { status: 404 })
    }
    if (pathname === '/admin' || pathname.startsWith('/admin/')) return handleAdmin(req, env)
    return new Response('Not found', { status: 404 })
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDailyCron(env.DB, controller.scheduledTime))
    ctx.waitUntil(runLeaderboardCron(env, controller.scheduledTime))
  },
} satisfies ExportedHandler<AppEnv>
