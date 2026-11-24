import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

/** Preserve the existing Postgres settings format. File names are authenticated as record context. */
export function postgresSettingsCodec(secret: string) {
    const key = Buffer.from(hkdfSync('sha256', secret, '', 'Cuttlely service settings Postgres v1', 32))
    return {
        seal(file: string, text: string): Buffer {
            const iv = randomBytes(12)
            const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(file))
            const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
            return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
        },
        unseal(file: string, value: Buffer): string {
            const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
            cipher.setAAD(Buffer.from(file)).setAuthTag(value.subarray(12, 28))
            return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
        }
    }
}

export const POSTGRES_SETTINGS_MARKER = 'backend-version'
