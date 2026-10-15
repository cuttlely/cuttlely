import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

// A single "$" is never math: replies quote prices ("$10 ... $5.99"), and remark-math would read the text between two
// amounts as an equation. Math uses $$...$$ (inline or on its own lines), \(...\) or \[...\].
export const remarkMathOptions = { singleDollarTextMath: false }

const LATEX_PATTERNS = [
    /\$\$.+?\$\$/s,
    /\\\(.+?\\\)/s,
    /\\\[[\s\S]*?\\\]/,
    /\\begin{(equation|align|gather|math|matrix|bmatrix|pmatrix|vmatrix|cases)}.+?\\end{\1}/s,
    /\\frac/,
    /\\sqrt/,
    /\\pm/,
    /\\cdot/,
    /\\text/,
    /\\sum/,
    /\\prod/,
    /\\int/
]

/**
 * Whether text likely contains LaTeX math.
 * @param {string} text
 * @param {{ regex: RegExp }[]} customPatterns - extra patterns from the mathPatterns prop
 */
export const containsLaTeX = (text, customPatterns = []) => {
    if (!text || typeof text !== 'string') return false
    return [...LATEX_PATTERNS, ...customPatterns.map((pattern) => pattern.regex)].some((regex) => regex.test(text))
}

/**
 * Rewrites \[...\] on its own lines and \(...\) to the $$ forms remark-math reads.
 * @param {string} text
 */
export const preprocessLatex = (text) => {
    if (!text || typeof text !== 'string') return text
    return text
        .replace(/(\n\s*)\\\[([\s\S]*?)\\\](\s*\n|$)/g, (match, before, content, after) => `${before}$$${content}$$${after}`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (match, content) => `$$${content}$$`)
}

export const remarkPluginsFor = (enableMath) => (enableMath ? [remarkGfm, [remarkMath, remarkMathOptions]] : [remarkGfm])
