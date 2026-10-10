// Guards the words people see. The GitHub card and the Dev to Prod screens never use Git words such as
// main, branch, commit or push; tests run every message in those files through `gitWordsIn`.
// The server has the same scanner in packages/server/src/utils/plainWords.ts.

// Word stems, so every inflection counts: merging, rebased, fetches, cloning, forced and so on.
export const GIT_WORDS = /\b(main|master|branch\w*|commit\w*|push\w*|pull\w*|merg\w*|rebas\w*|HEAD|fetch\w*|clon\w*|forc\w*|refs?)\b/i

// A sentence ("Could not copy X."), or a single word written as a label ("Merged", "Pushing…", "done.").
// Lower-case codes and props ("contained", "push"), constants ("CHATFLOW") and paths are left out.
function looksShown(text) {
    const trimmed = text.trim()
    if (!trimmed || /^(-|%|\+|\[\w+\])/.test(trimmed)) return false
    if (/[A-Za-z]{2,} [A-Za-z]/.test(trimmed)) return true
    return /^[A-Z][a-z][A-Za-z']*[.!?…]*$/.test(trimmed) || /^[A-Za-z][a-z']+[.!?…]+$/.test(trimmed)
}

const LIT = '\\u0000\\d+\\u0000'
const isLit = (operand) => new RegExp(`^${LIT}$`).test(operand)

// Every message in a source file that could be shown: string literals of every quote style, strings
// joined with "+" (one message, "X" for anything that is not a literal), and text between JSX tags.
// Line comments and imports are skipped.
export function messagesInSource(text) {
    const source = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*|import )/.test(line))
        .join('\n')
    const literals = []
    const hold = (value) => `\u0000${literals.push(value) - 1}\u0000`
    const marked = source
        .replace(/`(?:[^`\\]|\\.)*`/g, (literal) => hold(literal.slice(1, -1)))
        .replace(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g, (_all, single, double) => hold(single ?? double))
    const operand = `(?:${LIT}|[\\w$.]+(?:\\([^()\\n]*\\))?)`
    const read = (piece) => piece.replace(new RegExp(LIT, 'g'), (token) => literals[Number(token.slice(1, -1))])
    const joined = []
    const used = new Set()
    for (const match of marked.matchAll(new RegExp(`${operand}(?:\\s*\\+\\s*${operand})+`, 'g'))) {
        const operands = match[0].split(/\s*\+\s*/)
        if (!operands.some(isLit)) continue
        for (const token of match[0].match(new RegExp(LIT, 'g')) || []) used.add(Number(token.slice(1, -1)))
        joined.push(operands.map((piece) => (isLit(piece) ? read(piece) : 'X')).join(''))
    }
    // Text between JSX tags, one word or many.
    const jsxText = []
    for (const match of marked.matchAll(/>\s*([^<>{}=;()\u0000]+?)\s*</g)) jsxText.push(match[1])
    const single = literals.filter((_value, index) => !used.has(index))
    return [...single, ...joined, ...jsxText].map((literal) => literal.replace(/\$\{[^}]*\}/g, 'X')).filter(looksShown)
}

// The messages that use a Git word. Empty when the wording is plain.
export function gitWordsIn(text) {
    return messagesInSource(text).filter((message) => GIT_WORDS.test(message))
}
