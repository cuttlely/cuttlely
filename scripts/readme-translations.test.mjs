// README.ja.md and README.ko.md translate README.md. The prose may differ, but the code blocks,
// link targets, and image paths must stay the same, in the same order, so a README edit that is
// not carried into the translations fails here. Every README in LANGUAGES also carries the same
// language switcher.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRANSLATIONS = ['README.ja.md', 'README.ko.md']
const LANGUAGES = [
    ['English', 'README.md'],
    ['日本語', 'README.ja.md'],
    ['한국어', 'README.ko.md'],
    ['繁體中文', 'i18n/README-TW.md'],
    ['简体中文', 'i18n/README-ZH.md']
]

const switcherFor = (file) =>
    LANGUAGES.map(([name, target]) => {
        if (target === file) return name
        const relative = path.posix.relative(path.posix.dirname(file), target)
        return `[${name}](${relative.startsWith('.') ? relative : `./${relative}`})`
    }).join(' | ')

// The first line is the language switcher, which links each file to the others.
const body = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').slice(1).join('\n')
const codeBlocks = (text) => text.match(/^ *```[\s\S]*?^ *```/gm) ?? []
const prose = (text) => text.replace(/^ *```[\s\S]*?^ *```/gm, '')
const targets = (text) => [...prose(text).matchAll(/\]\(([^)\s]+)\)|\b(?:src|srcset|href)="([^"]+)"/g)].map((match) => match[1] ?? match[2])
const spanIds = (text) => new Set([...text.matchAll(/<span id="([^"]+)"><\/span>/g)].map((match) => match[1]))

const english = body('README.md')

for (const [, file] of LANGUAGES) {
    test(`${file} has the five-language switcher`, () => {
        const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
        const switchers = lines.filter((line) => /^\[?English\]?(\(|\s\|)/.test(line))
        assert.deepEqual(switchers, [switcherFor(file)])
    })
}

for (const file of TRANSLATIONS) {
    test(`${file} keeps the code blocks of README.md`, () => {
        assert.deepEqual(codeBlocks(body(file)), codeBlocks(english))
    })

    test(`${file} keeps the link targets and image paths of README.md`, () => {
        assert.deepEqual(targets(body(file)), targets(english))
    })

    test(`${file} has an anchor for every in-page link`, () => {
        const text = body(file)
        const ids = spanIds(text)
        const missing = targets(text).filter((target) => target.startsWith('#') && !ids.has(target.slice(1)))
        assert.deepEqual(missing, [])
    })
}
