// Guards the words people see. The GitHub card and the Dev to Prod screens never use Git words such as
// main, branch, commit or push; tests run every message in those sources through `gitWordsIn`.

// Word stems, so every inflection counts: merging, rebased, fetches, cloning, forced and so on.
export const GIT_WORDS = /\b(main|master|branch\w*|commit\w*|push\w*|pull\w*|merg\w*|rebas\w*|HEAD|fetch\w*|clon\w*|forc\w*|refs?)\b/i

// A literal (or a joined concatenation) that can reach the screen: a sentence ("Could not copy X."),
// or a single word written as a label ("Merged", "Pushing…", "done."). Git arguments ("-c", "%H"),
// lower-case codes and refs ("push", "refs/heads/X"), constants ("HEAD", "CHATFLOW") and server log
// lines ("[versions] ...") are left out: they are never on screen.
function looksShown(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed || /^(-|%|\+|\[\w+\])/.test(trimmed)) return false
    if (/[A-Za-z]{2,} [A-Za-z]/.test(trimmed)) return true
    return /^[A-Z][a-z][A-Za-z']*[.!?…]*$/.test(trimmed) || /^[A-Za-z][a-z']+[.!?…]+$/.test(trimmed)
}

// Every message in a source file that could be shown, wherever it is built: thrown errors, status text in
// local variables, ternaries and templates, and strings joined with "+" (read as one message, with "X"
// for anything that is not a literal). Line comments and imports are skipped.
export function messagesInSource(text: string): string[] {
    const source = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*|import )/.test(line))
        .join('\n')
    const literals: string[] = []
    const hold = (value: string) => `\u0000${literals.push(value) - 1}\u0000`
    // Templates first; then single and double quotes, whichever opens first, so an apostrophe inside "..."
    // is not mistaken for a quote.
    const marked = source
        .replace(/`(?:[^`\\]|\\.)*`/g, (literal) => hold(literal.slice(1, -1)))
        .replace(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g, (_all, single, double) => hold(single ?? double))
    const LIT = '\\u0000\\d+\\u0000'
    const EXPR = '[\\w$.]+(?:\\([^()\\n]*\\))?'
    const OPERAND = `(?:${LIT}|${EXPR})`
    const chain = new RegExp(`${OPERAND}(?:\\s*\\+\\s*${OPERAND})+`, 'g')
    const read = (piece: string) => piece.replace(new RegExp(LIT, 'g'), (token) => literals[Number(token.slice(1, -1))])
    const joined: string[] = []
    const used = new Set<number>()
    for (const match of marked.matchAll(chain)) {
        const operands = match[0].split(/\s*\+\s*/)
        if (!operands.some((operand) => new RegExp(`^${LIT}$`).test(operand))) continue
        for (const token of match[0].match(new RegExp(LIT, 'g')) || []) used.add(Number(token.slice(1, -1)))
        joined.push(operands.map((operand) => (new RegExp(`^${LIT}$`).test(operand) ? read(operand) : 'X')).join(''))
    }
    const single = literals.filter((_value, index) => !used.has(index))
    return [...single, ...joined].map((literal) => literal.replace(/\$\{[^}]*\}/g, 'X')).filter(looksShown)
}

// The messages that use a Git word. Empty when the wording is plain.
export function gitWordsIn(text: string): string[] {
    return messagesInSource(text).filter((message) => GIT_WORDS.test(message))
}
