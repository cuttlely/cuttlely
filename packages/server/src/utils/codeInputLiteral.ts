import { toPath } from 'lodash'

/**
 * Request values in code inputs of Multi-Agent and Sequential Agent flows.
 *
 * Those flows replace `{{$vars.name}}` with text in every node input before the node runs, code inputs included. A value
 * that came from the request (an allowlisted variable) must never become code, so in a code input it is written with
 * every character escaped except the digits 0-9:
 *
 * - Inside a string literal, a template literal or a regular expression, the escapes read back as exactly the original
 *   text, so `const region = "{{$vars.region}}"` keeps working.
 * - Anywhere else the escapes are not valid code (`\x..` is never allowed outside a string), so the node fails to
 *   compile instead of running the value. A value made only of digits still reads as a number.
 *
 * Code can always read the same value as data: `$vars.name` (no braces) in the node's code.
 */
export const escapeForCodeInput = (value: unknown): string => {
    const text = typeof value === 'string' ? value : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
    let out = ''
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code >= 0x30 && code <= 0x39) out += text[i]
        else if (code < 0x100) out += '\\x' + code.toString(16).padStart(2, '0')
        else out += '\\u' + code.toString(16).padStart(4, '0')
    }
    return out
}

/** The variable name a `$vars.` path starts with: `$vars.cfg.host` and `$vars.cfg[0]` both give `cfg`. */
export const varNameOfPath = (variableFullPath: string): string => toPath(variableFullPath.replace(/^\$vars\./, ''))[0] ?? ''

type ParamLike = { name?: string; type?: string; tabs?: ParamLike[]; array?: ParamLike[] }

/** Names of a node's code inputs (`type: 'code'`), including inputs inside tabs and array rows. */
export const getCodeInputNames = (inputParams: ParamLike[] | undefined): Set<string> => {
    const names = new Set<string>()
    const walk = (params: ParamLike[] | undefined) => {
        for (const param of params ?? []) {
            if (!param || typeof param !== 'object') continue
            if (param.type === 'code' && param.name) names.add(param.name)
            if (Array.isArray(param.tabs)) walk(param.tabs)
            if (Array.isArray(param.array)) walk(param.array)
        }
    }
    walk(inputParams)
    return names
}
