// Version details are Git trailers such as `Version-Flow: <id>` at the end of each version's commit message.
// A trailer is matched by the part after its first dash, so versions saved under an earlier prefix still read.

const TRAILER_PREFIX = 'Version-'

export type TrailerKey = 'Flow' | 'Kind' | 'Name' | 'Hidden' | 'From'

/** A line that is one of the version trailers, whatever its prefix. */
export const TRAILER_LINE = /^[A-Za-z]+-(Flow|Kind|Name|Hidden|From): /

/** The trailer line written for a new version. */
export function trailerLine(key: TrailerKey, value: string | number): string {
    return `${TRAILER_PREFIX}${key}: ${value}`
}

/** The fixed text `git log --grep` looks for. It leaves the prefix out so every prefix matches. */
export function trailerGrep(key: TrailerKey, value: string): string {
    return `-${key}: ${value}`
}

/** The value of one trailer in a commit body, or '' when it is missing. */
export function readTrailer(body: string, key: TrailerKey): string {
    const match = body.match(new RegExp(`^[A-Za-z]+-${key}: (.*)$`, 'm'))
    return match ? match[1].trim() : ''
}
