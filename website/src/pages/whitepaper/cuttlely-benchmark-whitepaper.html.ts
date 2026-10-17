import path from 'node:path'
import type { APIRoute } from 'astro'
import { whitepaperPage } from '../../../scripts/whitepaper.mjs'

// import.meta.url is the bundled chunk when this runs, so the source folder is found from the build's cwd (website/).
export const GET: APIRoute = () =>
    new Response(whitepaperPage(path.resolve(process.cwd(), '..', 'assets', 'whitepaper')), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
