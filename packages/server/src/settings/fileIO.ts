import fs from 'fs'
import path from 'path'
import { postgresSettings } from './postgres'
import { readPrivateFile } from './privateFile'

/** Read a managed settings document, using the same missing-file semantics with either backend. */
export function readSettingsText(dir: string, file: string, privateFile = false): string {
    const postgres = postgresSettings(dir, file)
    if (!postgres) {
        const local = path.join(dir, file)
        return privateFile ? readPrivateFile(local) : fs.readFileSync(local, 'utf8')
    }
    const text = postgres.read(file)
    if (text === null) throw Object.assign(new Error('Settings document does not exist.'), { code: 'ENOENT' })
    return text
}

export function savedSettingsExist(dir: string, file: string): boolean {
    const postgres = postgresSettings(dir, file)
    return postgres ? postgres.read(file) !== null : fs.existsSync(path.join(dir, file))
}

export function removeSavedSettings(dir: string, file: string): void {
    const postgres = postgresSettings(dir, file)
    if (postgres) postgres.remove(file)
    else fs.rmSync(path.join(dir, file), { force: true })
}
