#!/usr/bin/env node
/* eslint-disable no-console -- build script; output is the interface */
// Copies the repository docs into the Starlight content folder before `astro build`.
// The repository stays the only place docs are written: everything this script writes is gitignored
// and rebuilt on every run. Pages keep the repository layout (docs/how-to/docker.md is served at
// /docs/how-to/docker/), so relative image paths keep working without changes.
//
//   node scripts/sync-docs.mjs                write src/content/docs and src/generated
//   node scripts/sync-docs.mjs --check-only   write nothing, only check the links (used by pnpm verify)
// Both fail when a page links to a repository file that does not exist.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BRANCH, HOME_ANCHORS, REPO_URL, ROOT_PAGES } from './site-config.mjs'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(SITE, '..')
const OUT = path.join(SITE, 'src', 'content', 'docs')
const GEN = path.join(SITE, 'src', 'generated')

// ---------- pure helpers (tested in scripts/sync-docs.test.mjs) ----------

/** The site route for a Markdown file under docs/, e.g. docs/how-to/docker.md -> /docs/how-to/docker/. */
export function docRoute(repoPath) {
    const rel = repoPath.replace(/^docs\//, '').replace(/\.md$/, '')
    if (rel === 'README') return '/docs/'
    return `/docs/${rel.toLowerCase()}/`
}

/** Where a page is written inside src/content/docs, mirroring the repository layout. */
export function docOutPath(repoPath) {
    return repoPath.replace(/(^|\/)README\.md$/, '$1index.md')
}

/** Doc routes that stay off the generated sidebar (the page still exists). */
export const SIDEBAR_OMIT = new Set(['/docs/langflow-import/'])

const WHITEPAPER_MARK = 'The benchmark whitepaper is on the website at `/whitepaper/`'

/** Drop the 1.3.0 whitepaper line from the changelog page. Does not edit CHANGELOG.md. */
export function filterChangelogForSite(markdown) {
    return markdown
        .split('\n')
        .filter((line) => !line.includes(WHITEPAPER_MARK))
        .join('\n')
}

/** Splits Markdown into lines tagged with whether they sit inside a fenced code block. */
function taggedLines(markdown) {
    let fence = null
    return markdown.split('\n').map((line) => {
        const m = line.match(/^\s*(`{3,}|~{3,})/)
        if (fence) {
            if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
                fence = null
            }
            return { line, code: true }
        }
        if (m) {
            fence = m[1]
            return { line, code: true }
        }
        return { line, code: false }
    })
}

/** Plain text of a Markdown fragment, for descriptions. */
export function plainText(md) {
    let text = md
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]+/g, '')
    let previous
    do {
        previous = text
        text = text.replace(/<[^>]+>/g, '')
    } while (text !== previous)
    return text.replace(/\s+/g, ' ').trim()
}

function shorten(text, max = 160) {
    if (text.length <= max) return text
    const firstSentence = text.match(/^(.{40,}?[.!?])\s/)
    if (firstSentence && firstSentence[1].length <= max) return firstSentence[1]
    const cut = text.slice(0, max - 1)
    return `${cut.slice(0, cut.lastIndexOf(' '))}...`
}

/** Title (first H1), description (first paragraph) and the body without the H1 and any leading HTML banner. */
export function splitPage(markdown) {
    let text = markdown.replace(/\r\n/g, '\n')
    // A centered logo banner (docs/README.md) is not needed: the site header already shows the logo.
    text = text.replace(/^\s*<p align="center">[\s\S]*?<\/p>\s*\n/, '')
    const lines = taggedLines(text)
    let title = ''
    let titleIndex = -1
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].code && /^# /.test(lines[i].line)) {
            title = lines[i].line.replace(/^# /, '').trim()
            titleIndex = i
            break
        }
    }
    const bodyLines = lines.filter((_, i) => i !== titleIndex).map((l) => l.line)
    let description = ''
    const tagged = taggedLines(bodyLines.join('\n'))
    let para = []
    for (const { line, code } of tagged) {
        const t = line.trim()
        const isProse = !code && t && !/^(#|[-*+] |\d+\. |!\[|<|\||>)/.test(t)
        if (isProse) para.push(t)
        else if (para.length) break
    }
    description = shorten(plainText(para.join(' ')))
    return { title, description, body: bodyLines.join('\n').replace(/^\n+/, '') }
}

/**
 * The site URL for a link found in `fromRepoPath`. Returns null to leave the link alone
 * (absolute URLs, mail links, in-page anchors and images).
 */
export function rewriteTarget(target, fromRepoPath, exists = () => true) {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return null
    const [rawPath, anchor = ''] = target.split('#')
    if (!rawPath) return null
    const hash = anchor ? `#${anchor}` : ''
    const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(fromRepoPath), decodeURI(rawPath))).replace(/\/$/, '')
    if (repoPath.startsWith('..')) return { url: `${REPO_URL}/blob/${BRANCH}/${rawPath}`, repoPath, missing: true }
    if (/^docs\/.+\.md$/.test(repoPath)) return { url: docRoute(repoPath) + hash, repoPath, missing: !exists(repoPath) }
    if (repoPath === 'README.md') {
        if (anchor === 'your-first-10-minutes') return { url: '/quickstart/', repoPath }
        if (!anchor) return { url: '/', repoPath }
        if (HOME_ANCHORS.includes(anchor)) return { url: `/${hash}`, repoPath }
        return { url: `${REPO_URL}${hash}`, repoPath }
    }
    if (ROOT_PAGES[repoPath]) {
        const base = ROOT_PAGES[repoPath]
        return { url: base.includes('#') ? base : base + hash, repoPath }
    }
    const kind = exists(repoPath) === 'dir' ? 'tree' : 'blob'
    return { url: `${REPO_URL}/${kind}/${BRANCH}/${repoPath}${hash}`, repoPath, missing: !exists(repoPath) }
}

/** Rewrites Markdown links (not images, not code) from repository paths to site routes. */
export function rewriteLinks(markdown, fromRepoPath, exists = () => true, problems = []) {
    return taggedLines(markdown)
        .map(({ line, code }) => {
            if (code) return line
            // Inline code spans are set aside while rewriting (link text may contain them).
            const spans = []
            const masked = line.replace(/`[^`]*`/g, (span) => {
                spans.push(span)
                return `\u0000${spans.length - 1}\u0000`
            })
            // A poster link is an image inside a link. Mask the image first so its ]
            // is not read as the end of the outer link, and so the image path stays relative.
            const images = []
            const maskedImages = masked.replace(/!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/g, (img) => {
                images.push(img)
                return `\u0001${images.length - 1}\u0001`
            })
            return maskedImages
                .replace(/(!?)\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, bang, text, target, title = '') => {
                    if (bang) return whole
                    const result = rewriteTarget(target, fromRepoPath, exists)
                    if (!result) return whole
                    if (result.missing) problems.push(`${fromRepoPath}: link to missing ${result.repoPath}`)
                    return `[${text}](${result.url}${title})`
                })
                .replace(/\u0001(\d+)\u0001/g, (_, i) => images[Number(i)])
                .replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])
        })
        .join('\n')
}

/** The README section that starts at `## <heading>` and runs to the next `## `. */
export function readmeSection(markdown, heading) {
    const lines = taggedLines(markdown.replace(/\r\n/g, '\n'))
    const start = lines.findIndex((l) => !l.code && l.line.trim() === `## ${heading}`)
    if (start === -1) throw new Error(`README.md has no "## ${heading}" section`)
    let end = lines.findIndex((l, i) => i > start && !l.code && /^## /.test(l.line))
    if (end === -1) end = lines.length
    return lines
        .slice(start + 1, end)
        .map((l) => l.line)
        .join('\n')
        .trim()
}

function yamlString(s) {
    return JSON.stringify(s)
}

export function frontmatter({ title, description, editUrl, extra = {} }) {
    const lines = ['---', `title: ${yamlString(title)}`]
    if (description) lines.push(`description: ${yamlString(description)}`)
    if (editUrl) lines.push(`editUrl: ${yamlString(editUrl)}`)
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${typeof v === 'string' ? yamlString(v) : JSON.stringify(v)}`)
    lines.push('---', '')
    return lines.join('\n')
}

/**
 * The docs sidebar, built from the groups and links in docs/README.md, so the README and the site share one order.
 * Links with an anchor are skipped (the page they point into is listed on its own).
 */
export function sidebarFromIndex(indexMarkdown, titles) {
    const groups = []
    let current = null
    const seen = new Set()
    for (const { line, code } of taggedLines(indexMarkdown)) {
        if (code) continue
        const h = line.match(/^## (.+)$/)
        if (h) {
            current = { label: h[1].trim(), items: [] }
            groups.push(current)
            continue
        }
        if (!current || !/^\s*[-*] /.test(line)) continue
        for (const m of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
            const [, text, target] = m
            if (target.includes('#')) continue
            const result = rewriteTarget(target, 'docs/README.md')
            if (!result || !result.url.startsWith('/') || seen.has(result.url)) continue
            seen.add(result.url)
            current.items.push({ label: text || titles[result.url], link: result.url })
        }
    }
    return groups.filter((g) => g.items.length)
}

// ---------- the sync ----------

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, out)
        else out.push(full)
    }
    return out
}

function repoExists(repoPath) {
    const full = path.join(REPO, repoPath)
    if (!fs.existsSync(full)) return false
    return fs.statSync(full).isDirectory() ? 'dir' : 'file'
}

function writePage(outRel, content, write) {
    if (!write) return
    const full = path.join(OUT, outRel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
}

export function sync({ check = true, write = true } = {}) {
    const started = Date.now()
    if (write) {
        fs.rmSync(OUT, { recursive: true, force: true })
        fs.rmSync(GEN, { recursive: true, force: true })
        fs.mkdirSync(OUT, { recursive: true })
        fs.mkdirSync(GEN, { recursive: true })
    }
    const problems = []
    const titles = {}
    const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')
    const edit = (rel) => `${REPO_URL}/edit/${BRANCH}/${rel}`

    // docs/**/*.md
    const docs = walk(path.join(REPO, 'docs'))
        .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
        .filter((f) => f.endsWith('.md'))
        .sort()
    for (const rel of docs) {
        const { title, description, body } = splitPage(read(rel))
        if (!title) problems.push(`${rel}: no "# " title`)
        const pageTitle = rel === 'docs/README.md' ? 'Docs overview' : title
        titles[docRoute(rel)] = pageTitle
        writePage(
            docOutPath(rel),
            frontmatter({ title: pageTitle, description, editUrl: edit(rel) }) + rewriteLinks(body, rel, repoExists, problems) + '\n',
            write
        )
    }

    // docs/images, next to the pages, so relative image paths resolve.
    if (write) fs.cpSync(path.join(REPO, 'docs', 'images'), path.join(OUT, 'docs', 'images'), { recursive: true })

    // Quickstart: the README section "Your first 10 minutes".
    const readme = read('README.md')
    const quick = readmeSection(readme, 'Your first 10 minutes')
    titles['/quickstart/'] = 'Quickstart'
    writePage(
        'quickstart.md',
        frontmatter({
            title: 'Your first 10 minutes',
            description: 'Start Cuttlely with Docker, add one model key, and watch an agent team answer with a chart.',
            editUrl: edit('README.md'),
            extra: { tableOfContents: false }
        }) +
            rewriteLinks(quick, 'README.md', repoExists, problems) +
            '\n',
        write
    )

    // Changelog, Security, Credits (with the NOTICE text and the license).
    for (const [rel, route, label] of [
        ['CHANGELOG.md', '/changelog/', 'Changelog'],
        ['SECURITY.md', '/security/', 'Security']
    ]) {
        const source = rel === 'CHANGELOG.md' ? filterChangelogForSite(read(rel)) : read(rel)
        const { title, description, body } = splitPage(source)
        titles[route] = label
        writePage(
            route.slice(1, -1) + '.md',
            frontmatter({ title, description, editUrl: edit(rel) }) + rewriteLinks(body, rel, repoExists, problems) + '\n',
            write
        )
    }
    {
        const { title, description, body } = splitPage(read('CREDITS.md'))
        titles['/credits/'] = 'Credits and license'
        const notice = read('NOTICE').trimEnd()
        const license = [
            '## License',
            '',
            `Cuttlely is open source under the Apache License, Version 2.0. The full text is in [LICENSE.md](${REPO_URL}/blob/${BRANCH}/LICENSE.md).`,
            '',
            '## Notice',
            '',
            '```text',
            notice,
            '```'
        ].join('\n')
        writePage(
            'credits.md',
            frontmatter({ title: `${title} and license`, description, editUrl: edit('CREDITS.md') }) +
                rewriteLinks(body, 'CREDITS.md', repoExists, problems) +
                '\n\n' +
                license +
                '\n',
            write
        )
    }

    // Sidebar from docs/README.md, with the start pages first and the project pages last.
    const groups = sidebarFromIndex(read('docs/README.md'), titles)
    const listed = new Set(groups.flatMap((g) => g.items.map((i) => i.link)))
    const start = {
        label: 'Get started',
        items: [
            { label: 'Quickstart', link: '/quickstart/' },
            { label: 'Docs overview', link: '/docs/' },
            { label: titles['/docs/how-to/try-the-demo/'] || 'Try the demo', link: '/docs/how-to/try-the-demo/' }
        ]
    }
    for (const g of groups) g.items = g.items.filter((i) => !start.items.some((s) => s.link === i.link))
    const project = { label: 'Project', items: [] }
    for (const [link, label] of [
        ['/changelog/', 'Changelog'],
        ['/security/', 'Security'],
        ['/credits/', 'Credits and license']
    ]) {
        if (!listed.has(link)) project.items.push({ label, link })
    }
    // Any doc page the index does not link still gets a place in the sidebar.
    const all = new Set([...start.items, ...groups.flatMap((g) => g.items), ...project.items].map((i) => i.link))
    const more = docs.map(docRoute).filter((r) => !all.has(r) && !SIDEBAR_OMIT.has(r))
    if (more.length) project.items.unshift(...more.map((link) => ({ label: titles[link], link })))
    const sidebar = [start, ...groups, project].filter((g) => g.items.length)
    if (write) fs.writeFileSync(path.join(GEN, 'sidebar.json'), JSON.stringify(sidebar, null, 2) + '\n')

    const images = walk(path.join(REPO, 'docs', 'images')).length
    const verb = write ? 'wrote' : 'checked'
    console.log(`sync-docs: ${verb} ${docs.length} docs pages, 4 project pages, ${images} images in ${Date.now() - started}ms`)
    if (problems.length) {
        for (const p of problems) console.error(`sync-docs: ${p}`)
        if (check) {
            console.error(`sync-docs: ${problems.length} problem(s)`)
            process.exitCode = 1
        }
    }
    return { docs, problems, sidebar }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    sync({ check: true, write: !process.argv.includes('--check-only') })
}
