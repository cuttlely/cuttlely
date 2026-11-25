// Same loader as the server settings module. Components cannot import the server.
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

interface SettingAliasModule {
    encryptionKeyOverwrite(env?: NodeJS.ProcessEnv): string | undefined
}

const nodeRequire = createRequire(__filename)

export function loadRepositoryScript<T>(script: 'setting-alias.cjs' | 'credential-envelope.cjs'): T {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'scripts', script)
        if (fs.existsSync(candidate)) return nodeRequire(candidate) as T
        dir = path.dirname(dir)
    }
    throw new Error('Required repository script was not found in this checkout.')
}

export const encryptionKeyOverwrite = loadRepositoryScript<SettingAliasModule>('setting-alias.cjs').encryptionKeyOverwrite
