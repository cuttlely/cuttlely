// cuttlely.com: the home page plus the repository docs, built with Astro and Starlight.
// scripts/sync-docs.mjs copies ../docs (and the README quickstart, CHANGELOG, SECURITY, CREDITS) into
// src/content/docs before every build, so the repository stays the single source of truth.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { applyScreenshotZoom } from './scripts/apply-screenshot-zoom.mjs'
import { REPO_URL, SITE_URL } from './scripts/site-config.mjs'

const sidebarFile = new URL('./src/generated/sidebar.json', import.meta.url)
const sidebar = fs.existsSync(sidebarFile) ? JSON.parse(fs.readFileSync(sidebarFile, 'utf8')) : []

export default defineConfig({
    site: SITE_URL,
    trailingSlash: 'always',
    // No telemetry, analytics or outside requests from the build or the pages.
    devToolbar: { enabled: false },
    integrations: [
        {
            name: 'screenshot-zoom',
            hooks: {
                'astro:build:done': async ({ dir }) => {
                    applyScreenshotZoom(fileURLToPath(dir))
                }
            }
        },
        starlight({
            title: 'Cuttlely',
            description:
                'Open-source visual agent builder, ready for production: drafts, Compare and rollback, a scoped SQL analyst, and Flowise import. Apache-2.0, self-hosted.',
            logo: {
                light: './src/assets/cuttlely-logo-horizontal.svg',
                dark: './src/assets/cuttlely-logo-horizontal-dark.svg',
                alt: 'Cuttlely',
                replacesTitle: true
            },
            favicon: '/favicon.svg',
            head: [
                { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '48x48' } },
                { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
                { tag: 'link', attrs: { rel: 'manifest', href: '/site.webmanifest' } },
                {
                    tag: 'link',
                    attrs: {
                        rel: 'preload',
                        href: '/fonts/Urbanist-latin-VariableFont_wght.woff2',
                        as: 'font',
                        type: 'font/woff2',
                        crossorigin: ''
                    }
                },
                { tag: 'meta', attrs: { name: 'theme-color', content: '#6A3DF2' } },
                { tag: 'meta', attrs: { property: 'og:image', content: `${SITE_URL}/social/og-light.png` } },
                { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
                { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
                {
                    tag: 'meta',
                    attrs: {
                        property: 'og:image:alt',
                        content:
                            'Cuttlely. The visual agent builder, ready for production. Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.'
                    }
                },
                { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE_URL}/social/og-light.png` } }
            ],
            social: [{ icon: 'github', label: 'Cuttlely on GitHub', href: REPO_URL }],
            editLink: { baseUrl: `${REPO_URL}/edit/main/docs/` },
            sidebar,
            customCss: ['./src/styles/brand.css', './src/styles/site.css'],
            components: {
                SocialIcons: './src/components/HeaderLinks.astro',
                Footer: './src/components/Footer.astro',
                MarkdownContent: './src/components/MarkdownContent.astro',
                Hero: './src/components/Hero.astro'
            },
            disable404Route: true,
            lastUpdated: false,
            credits: false,
            pagination: true,
            tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
            titleDelimiter: '·'
        })
    ]
})
