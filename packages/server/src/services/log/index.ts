import fs from 'fs'
import path from 'path'
import { StatusCodes } from 'http-status-codes'
import { redactSecrets } from '@cuttlely/versioning'
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

function readTail(filePath: string, maxBytes: number): { text: string; capped: boolean } {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    let fd: number
    try {
        fd = fs.openSync(filePath, flags)
    } catch {
        return { text: '', capped: false }
    }
    try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) return { text: '', capped: false }
        const size = stat.size
        const capped = size > maxBytes
        const start = capped ? size - maxBytes : 0
        const length = Math.max(0, size - start)
        const buf = Buffer.alloc(length)
        fs.readSync(fd, buf, 0, length, start)
        let text = buf.toString('utf8')
        if (capped) {
            const newline = text.indexOf('\n')
            text = newline >= 0 ? text.slice(newline + 1) : ''
        }
        return { text, capped }
    } finally {
        fs.closeSync(fd)
    }
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

const getLogs = async (startDate?: string, endDate?: string, level?: string): Promise<LogRead> => {
    const minimum = oneLevel(level)
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
    files.sort((a, b) => (a.hour === b.hour ? a.index - b.index : a.hour < b.hour ? 1 : -1))

    const parts: string[] = []
    let used = 0
    let truncated = false
    try {
        for (const file of files) {
            if (used >= LOG_MAX_BYTES) {
                truncated = true
                break
            }
            const allowance = Math.min(LOG_FILE_BYTES, LOG_MAX_BYTES - used)
            const tail = readTail(file.fullPath, allowance)
            if (tail.capped) truncated = true
            if (!tail.text) continue
            parts.push(tail.text)
            used += Buffer.byteLength(tail.text)
        }
    } catch {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'Error: logService.getLogs - could not read logs')
    }

    let lines = parts.length ? parts.reverse().join('\n').split('\n') : []
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines = filterByLevel(lines, minimum)
    if (lines.length > LOG_MAX_LINES) {
        lines = lines.slice(-LOG_MAX_LINES)
        truncated = true
    }
    lines = lines.map((line) => redactSecrets(line).text)
    return { configured: true, lines, truncated }
}

export default {
    getLogs
}
