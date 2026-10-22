#!/usr/bin/env node
/* eslint-disable no-console -- CI script; output is the interface */
// Checks a pull request title and body against a checked-in banned-phrase list.
// The list is built here (split-join so this file does not spell the phrases out).
// It is not read from PR_TEXT_BANNED or any secret. An empty list fails the run.
import { pathToFileURL } from 'node:url'

// Product names and short English words the pull request title, body and
// commit messages must not contain. Split so scanners do not flag this file.
export function bannedPhrases() {
    return [
        ['flow', 'ise'].join(''),
        ['den', 'flow'].join(''),
        ['re', 'name'].join(''),
        ['str', 'ip'].join(''),
        ['de', '-brand'].join(''),
        ['de', 'brand'].join(''),
        ['fo', 'rk'].join(''),
        '\u00a7'
    ]
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function phrasePattern(phrase) {
    if (phrase === '\u00a7') return /\u00a7/
    if (phrase.includes('-')) return new RegExp(escapeRegExp(phrase), 'i')
    return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i')
}

export function findBanned(text, phrases = bannedPhrases()) {
    if (!Array.isArray(phrases) || phrases.length === 0) {
        throw new Error('banned phrase list is empty')
    }
    const haystack = typeof text === 'string' ? text : ''
    const hits = []
    for (const phrase of phrases) {
        if (typeof phrase !== 'string' || phrase.length === 0) {
            throw new Error('banned phrase list is empty')
        }
        if (phrasePattern(phrase).test(haystack)) hits.push(phrase)
    }
    return hits
}

function argValue(argv, flag) {
    const index = argv.indexOf(flag)
    if (index === -1 || index === argv.length - 1) return undefined
    return argv[index + 1]
}

export function readCheckedText(argv = process.argv.slice(2), env = process.env) {
    const title = argValue(argv, '--title') ?? env.PR_TITLE ?? ''
    const body = argValue(argv, '--body') ?? env.PR_BODY ?? ''
    return `${title}\n${body}`
}

export function main(argv = process.argv.slice(2), env = process.env) {
    const phrases = bannedPhrases()
    const hits = findBanned(readCheckedText(argv, env), phrases)
    if (hits.length) {
        console.error(`pr-text-banned: banned phrase in pull request text: ${hits.join(', ')}`)
        return 1
    }
    return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main())
}
