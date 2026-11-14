import { existsSync } from 'fs'
import path from 'path'

export function importVerifyPython(
    env: NodeJS.ProcessEnv = process.env,
    bundledPython = path.resolve(__dirname, '../../../../../hermes/.venv/bin/python'),
    fileExists: (file: string) => boolean = existsSync
): string {
    const configured = String(env.HERMES_PYTHON || '').trim()
    if (configured) return configured
    return fileExists(bundledPython) ? bundledPython : 'python3'
}
