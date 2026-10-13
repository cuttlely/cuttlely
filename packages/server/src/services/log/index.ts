import fs from 'fs'
import path from 'path'
import { StatusCodes } from 'http-status-codes'
import { redactSecrets, SECRET_PLACEHOLDER } from '@cuttlely/versioning'
import { AppError } from '../../errors/appError'
import config from '../../utils/config'

/** Newest bytes kept from one log file. A larger file is tailed. */
export const LOG_FILE_BYTES = 256 * 1024
/** Newest bytes kept across the whole response. */
export const LOG_MAX_BYTES = 1024 * 1024
/** Newest matching lines kept after the byte cap. */
export const LOG_MAX_LINES = 2000
/** About three months of hourly files, matching the longest range the page offers. */
export const LOG_MAX_HOURS = 93 * 24

const HOUR_STAMP = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/
const LOG_NAME = /^server\.log\.(\d{4}-\d{2}-\d{2}-\d{2})(?:\.(\d+))?$/

/** Preset windows the log page asks for. Computed here so the hour files follow the server clock. */
export const RELATIVE_RANGES: Record<string, { hours?: number; days?: number; months?: number }> = {
    '1h': { hours: 1 },
    '4h': { hours: 4 },
    '24h': { hours: 24 },
    '2d': { days: 2 },
    '7d': { days: 7 },
    '14d': { days: 14 },
    '1m': { months: 1 },
    '2m': { months: 2 },
    '3m': { months: 3 }
}

/** Last day of the month after moving, so the 31st does not spill into the next month. */
function subtractMonths(from: Date, months: number): Date {
    const day = from.getDate()
    const start = new Date(from.getTime())
    start.setDate(1)
    start.setMonth(start.getMonth() - months)
    const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
    start.setDate(Math.min(day, lastDay))
    start.setHours(from.getHours(), from.getMinutes(), from.getSeconds(), from.getMilliseconds())
    return start
}

export function stampsForRange(range: string, now = new Date()): { start: string; end: string } {
    const spec = RELATIVE_RANGES[range]
    if (!spec) throw badRequest('Error: logService.getLogs - range must be 1h, 4h, 24h, 2d, 7d, 14d, 1m, 2m, or 3m')
    let start = new Date(now.getTime())
    if (spec.months) start = subtractMonths(start, spec.months)
    if (spec.days) start.setDate(start.getDate() - spec.days)
    if (spec.hours) start.setHours(start.getHours() - spec.hours)
    return { start: formatStamp(start), end: formatStamp(now) }
}

const LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug'] as const
export type LogLevel = (typeof LEVELS)[number]

export interface LogRead {
    configured: boolean
    lines: string[]
    truncated: boolean
    message?: string
}

const NOT_CONFIGURED = 'No log file is configured. Set LOG_PATH to the directory where the server writes logs.'

function badRequest(message: string): AppError {
    return new AppError(StatusCodes.BAD_REQUEST, message)
}

function oneLevel(value: string | undefined): LogLevel {
    const level = (value || 'info').trim().toLowerCase()
    if ((LEVELS as readonly string[]).includes(level)) return level as LogLevel
    throw badRequest('Error: logService.getLogs - level must be error, warn, info, http, verbose, or debug')
}

function parseStamp(value: string): Date {
    const match = HOUR_STAMP.exec(value)
    if (!match) throw badRequest('Error: logService.getLogs - startDate and endDate must be YYYY-MM-DD-HH')
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) {
        throw badRequest('Error: logService.getLogs - startDate and endDate must be YYYY-MM-DD-HH')
    }
    const date = new Date(year, month - 1, day, hour, 0, 0, 0)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour) {
        throw badRequest('Error: logService.getLogs - startDate and endDate must be YYYY-MM-DD-HH')
    }
    return date
}

function formatStamp(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}-${hour}`
}

function hourStamps(start: Date, end: Date): string[] {
    const stamps: string[] = []
    const cursor = new Date(start.getTime())
    while (cursor.getTime() <= end.getTime()) {
        stamps.push(formatStamp(cursor))
        if (stamps.length > LOG_MAX_HOURS) {
            throw badRequest('Error: logService.getLogs - choose a shorter time range')
        }
        cursor.setHours(cursor.getHours() + 1)
    }
    return stamps
}

/** The directory the server logger writes. Blank LOG_PATH is not a directory. */
export function configuredLogDir(): string | null {
    const raw = process.env.LOG_PATH
    if (raw !== undefined && raw.trim() === '') return null
    const chosen = raw !== undefined && raw.trim() !== '' ? raw.trim() : config.logging.dir
    if (!chosen) return null
    return path.resolve(chosen)
}

function realDirectory(dir: string): string | null {
    let real: string
    try {
        real = fs.realpathSync(dir)
    } catch {
        return null
    }
    let stat: fs.Stats
    try {
        stat = fs.statSync(real)
    } catch {
        return null
    }
    return stat.isDirectory() ? real : null
}

function insideDir(dirReal: string, candidate: string): boolean {
    const rel = path.relative(dirReal, candidate)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

interface LogFile {
    fullPath: string
    hour: string
    index: number
}

function listLogFiles(dirReal: string, hours: Set<string>): LogFile[] {
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(dirReal, { withFileTypes: true })
    } catch {
        return []
    }
    const files: LogFile[] = []
    for (const entry of entries) {
        // A symlink can point outside the log directory. Skip it before opening.
        if (entry.isSymbolicLink() || !entry.isFile()) continue
        const match = LOG_NAME.exec(entry.name)
        if (!match || !hours.has(match[1])) continue
        const joined = path.resolve(dirReal, entry.name)
        if (path.dirname(joined) !== dirReal) continue
        let real: string
        try {
            real = fs.realpathSync(joined)
        } catch {
            continue
        }
        if (!insideDir(dirReal, real)) continue
        files.push({ fullPath: joined, hour: match[1], index: match[2] ? Number(match[2]) : 0 })
    }
    return files
}

/**
 * Read at most maxBytes from the end of one file.
 * The whole file is never pulled into a buffer: a multi-megabyte hour used to be read
 * synchronously, the event loop stalled, and the first client saw the socket close
 * (UND_ERR_SOCKET) before a response existed. The retry then hit a warm cache and succeeded.
 * Async reads stay inside the cap, and a short read does not keep the unread zeros.
 */
async function readTail(filePath: string, maxBytes: number): Promise<{ text: string; capped: boolean }> {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    let handle: fs.promises.FileHandle
    try {
        handle = await fs.promises.open(filePath, flags)
    } catch {
        return { text: '', capped: false }
    }
    try {
        const stat = await handle.stat()
        if (!stat.isFile()) return { text: '', capped: false }
        const size = stat.size
        const length = Math.min(size, maxBytes)
        const capped = size > length
        const start = size - length
        const buf = Buffer.alloc(length)
        let offset = 0
        while (offset < length) {
            const { bytesRead } = await handle.read(buf, offset, length - offset, start + offset)
            if (bytesRead <= 0) break
            offset += bytesRead
        }
        let text = buf.subarray(0, offset).toString('utf8')
        if (capped) {
            const newline = text.indexOf('\n')
            // A window with no newline is one over-long line. Keep that bounded suffix.
            if (newline >= 0) text = text.slice(newline + 1)
        }
        text = trimToBytes(text, maxBytes)
        return { text, capped }
    } catch {
        return { text: '', capped: true }
    } finally {
        await handle.close()
    }
}

/** Keep the end of the text inside a byte budget. Character slice is not a byte slice. */
function trimToBytes(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text) <= maxBytes) return text
    const sliced = Buffer.from(text)
        .subarray(Buffer.byteLength(text) - maxBytes)
        .toString('utf8')
    const newline = sliced.indexOf('\n')
    return newline >= 0 ? sliced.slice(newline + 1) : sliced
}

function stripCr(line: string): string {
    return line.replace(/\r$/, '')
}

function isBeginBanner(line: string): boolean {
    return /^-----BEGIN [A-Z0-9 ]+-----$/.test(line.trim())
}

function isEndBanner(line: string): boolean {
    const value = line.trim()
    if (/^-----END [A-Z0-9 ]+-----$/.test(value)) return true
    // The byte cut can leave the right-hand side of an END line.
    return /PRIVATE KEY-----$/.test(value) && value.length <= 80 && !value.includes('[')
}

function isBase64Body(line: string): boolean {
    const value = line.trim()
    return /^[A-Za-z0-9+/]+=*$/.test(value) && value.length >= 16
}

/** RFC 1421 encapsulation header. A hyphen in the name keeps ordinary "Error:" lines out. */
function isPemHeader(line: string): boolean {
    const value = stripCr(line).trim()
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]/.exec(value)
    if (!match) return false
    return match[1].includes('-')
}

function isHeaderContinuation(line: string): boolean {
    return /^[ \t]+\S/.test(stripCr(line))
}

/**
 * A capped tail can start after BEGIN, inside an RFC 1421 header, on the blank
 * separator, in the body, or in END. Hide that leading run. A base64 line that
 * follows a normal log line stays.
 */
function hideCutPem(text: string, capped: boolean): string {
    if (!capped || !text) return text
    const lines = text.split('\n').map(stripCr)
    let index = 0
    let phase: 'lead' | 'headers' | 'gap' | 'body' = 'lead'
    let hid = false
    let cut = 0

    while (index < lines.length) {
        const line = lines[index]
        const blank = line.trim() === ''
        const begin = isBeginBanner(line)
        const end = isEndBanner(line)
        const header = isPemHeader(line)
        const continuation = isHeaderContinuation(line)
        const body = isBase64Body(line)

        if (phase === 'lead') {
            if (blank) {
                index += 1
                continue
            }
            if (begin) break
            if (header || continuation) {
                phase = 'headers'
                hid = true
                index += 1
                cut = index
                continue
            }
            if (body || end) {
                phase = 'body'
                hid = true
                index += 1
                cut = index
                if (end) break
                continue
            }
            break
        }
        if (phase === 'headers') {
            if (header || continuation) {
                index += 1
                cut = index
                continue
            }
            if (blank) {
                phase = 'gap'
                index += 1
                cut = index
                continue
            }
            if (body) {
                phase = 'body'
                index += 1
                cut = index
                continue
            }
            if (end) {
                index += 1
                cut = index
                break
            }
            break
        }
        if (phase === 'gap') {
            if (blank) {
                index += 1
                cut = index
                continue
            }
            if (body) {
                phase = 'body'
                index += 1
                cut = index
                continue
            }
            if (end) {
                index += 1
                cut = index
                break
            }
            break
        }
        if (body) {
            index += 1
            cut = index
            continue
        }
        if (end) {
            index += 1
            cut = index
            break
        }
        break
    }

    if (!hid || cut === 0) return text
    const rest = lines.slice(cut).join('\n')
    return rest ? `${SECRET_PLACEHOLDER}\n${rest}` : SECRET_PLACEHOLDER
}

function lineLevel(line: string): string | null {
    const match = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[([A-Za-z]+)\]:/.exec(line)
    return match ? match[1].toLowerCase() : null
}

export function filterByLevel(lines: string[], minimum: LogLevel): string[] {
    const min = LEVELS.indexOf(minimum)
    const kept: string[] = []
    let keeping = true
    for (const line of lines) {
        const level = lineLevel(line)
        if (level) {
            const rank = LEVELS.indexOf(level as LogLevel)
            keeping = rank !== -1 && rank <= min
        }
        if (keeping) kept.push(line)
    }
    return kept
}

/** Tests pass a smaller cap. Callers that omit it keep the published limits. */
export interface LogReadLimits {
    fileBytes?: number
    maxBytes?: number
    maxLines?: number
}

export interface LogQuery {
    startDate?: string
    endDate?: string
    level?: string
    /** Server-local window. When set, startDate and endDate are ignored. */
    range?: string
    now?: Date
    limits?: LogReadLimits
}

function takenLimit(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const getLogs = async (query: LogQuery = {}): Promise<LogRead> => {
    const minimum = oneLevel(query.level)
    const fileBytes = takenLimit(query.limits?.fileBytes, LOG_FILE_BYTES)
    const maxBytes = takenLimit(query.limits?.maxBytes, LOG_MAX_BYTES)
    const maxLines = takenLimit(query.limits?.maxLines, LOG_MAX_LINES)
    let startDate = query.startDate
    let endDate = query.endDate
    if (query.range) {
        const window = stampsForRange(query.range, query.now)
        startDate = window.start
        endDate = window.end
    }
    if (!startDate || !endDate) {
        throw badRequest('Error: logService.getLogs - No start date or end date provided')
    }
    const start = parseStamp(startDate)
    const end = parseStamp(endDate)
    if (start.getTime() > end.getTime()) {
        throw badRequest('Error: logService.getLogs - Start date is greater than end date')
    }

    const dir = configuredLogDir()
    const dirReal = dir ? realDirectory(dir) : null
    if (!dirReal) {
        return { configured: false, lines: [], truncated: false, message: NOT_CONFIGURED }
    }

    const hours = new Set(hourStamps(start, end))
    let files: LogFile[]
    try {
        files = listLogFiles(dirReal, hours)
    } catch {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'Error: logService.getLogs - could not read logs')
    }
    // Higher rotation indexes are newer (the writer starts the next file at .1, .2, ...).
    // Read those first so the byte cap keeps the latest records in a busy hour.
    files.sort((a, b) => {
        if (a.hour !== b.hour) return a.hour < b.hour ? 1 : -1
        return b.index - a.index
    })

    const parts: string[] = []
    let used = 0
    let truncated = false
    let readWhole = true
    for (const file of files) {
        // A capped tail is the end of that file. An older segment is not contiguous with it.
        if (!readWhole || used >= maxBytes) {
            truncated = true
            break
        }
        const allowance = Math.min(fileBytes, maxBytes - used)
        const tail = await readTail(file.fullPath, allowance)
        if (tail.capped) {
            truncated = true
            readWhole = false
        }
        const cleaned = hideCutPem(tail.text, tail.capped)
        if (!cleaned) continue
        parts.push(cleaned)
        used += Buffer.byteLength(cleaned)
    }

    // Redact the whole window before splitting. A private key spans lines; per-line redaction
    // would hide only the BEGIN line and leave the body.
    let text = parts.length ? parts.reverse().join('\n') : ''
    if (text.endsWith('\n')) text = text.slice(0, -1)
    text = redactSecrets(text).text
    let lines = text ? text.split('\n') : []
    lines = filterByLevel(lines, minimum)
    if (lines.length > maxLines) {
        lines = lines.slice(-maxLines)
        truncated = true
    }
    return { configured: true, lines, truncated }
}

export default {
    getLogs
}
