import { createHmac, randomBytes, randomUUID } from 'crypto'
import { DataSource, EntityManager } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyCredential } from '../../database/entities/ApiKeyCredential'
import { AppError } from '../../errors/appError'

async function digest(secret: string): Promise<string> {
    // Domain-separated HMAC using the installation's existing durable secret. Never a process-random pepper.
    const { getEncryptionKey } = await import('../../utils')
    return createHmac('sha256', await getEncryptionKey())
        .update('cuttlely-inbound-key-v1\0')
        .update(secret)
        .digest('hex')
}
export function principalActive(key: ApiKey, now = Date.now()): boolean {
    return !key.disabledAt && (!key.expiresAt || new Date(key.expiresAt).getTime() > now)
}
export function credentialActive(row: ApiKeyCredential, now = Date.now()): boolean {
    return !row.revokedAt && (!row.expiresAt || new Date(row.expiresAt).getTime() > now)
}
export async function mintCredential(manager: EntityManager, key: ApiKey): Promise<{ credential: ApiKeyCredential; secret: string }> {
    const tokenId = randomBytes(8).toString('hex')
    const prefix = `ctu_${key.accessPolicy?.environment || 'live'}_${tokenId}`
    const secret = `${prefix}_${randomBytes(32).toString('base64url')}`
    const credential = manager.getRepository(ApiKeyCredential).create({
        id: randomUUID(),
        principalId: key.id,
        digest: await digest(secret),
        displayPrefix: prefix,
        lastFour: secret.slice(-4),
        createdAt: new Date(),
        expiresAt: key.expiresAt || null,
        revokedAt: null
    })
    await manager.getRepository(ApiKeyCredential).save(credential)
    return { credential, secret }
}
export async function findCredential(data: DataSource, secret: string): Promise<{ key: ApiKey; credential: ApiKeyCredential } | undefined> {
    if (!/^ctu_(live|test)_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(secret)) return undefined
    const credential = await data.getRepository(ApiKeyCredential).findOneBy({ digest: await digest(secret) })
    if (!credential || !credentialActive(credential)) return undefined
    const key = await data.getRepository(ApiKey).findOneBy({ id: credential.principalId })
    return key && principalActive(key) ? { key, credential } : undefined
}
export async function rotateCredential(manager: EntityManager, key: ApiKey, graceSeconds: unknown = 3600) {
    if (typeof graceSeconds !== 'number' || !Number.isInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 86400)
        throw new AppError(400, 'Rotation grace must be 0 to 86400 seconds.')
    if (!principalActive(key)) throw new AppError(409, 'A revoked or expired access key cannot rotate.')
    const cutoff = new Date(Date.now() + graceSeconds * 1000)
    const repo = manager.getRepository(ApiKeyCredential)
    // Read current credential ids, mint the replacement, then retire only those prior ids so a
    // concurrent rotate cannot revoke or shorten the secret this call just issued.
    const prior = await repo.find({ where: { principalId: key.id }, select: { id: true } })
    const priorIds = prior.map((row) => row.id)
    const minted = await mintCredential(manager, key)
    // Conditional partial updates make retirement monotonic even across processes. Never save a stale revokedAt.
    if (priorIds.length) {
        await repo
            .createQueryBuilder()
            .update()
            .set({ expiresAt: cutoff })
            .where('principalId = :id', { id: key.id })
            .andWhere('id IN (:...priorIds)', { priorIds })
            .andWhere('(expiresAt IS NULL OR expiresAt > :cutoff)', { cutoff })
            .execute()
        if (!graceSeconds)
            await repo
                .createQueryBuilder()
                .update()
                .set({ revokedAt: new Date() })
                .where('principalId = :id', { id: key.id })
                .andWhere('id IN (:...priorIds)', { priorIds })
                .andWhere('revokedAt IS NULL')
                .execute()
    }
    await manager
        .getRepository(ApiKey)
        .createQueryBuilder()
        .update()
        .set({ legacyRevokedAt: cutoff })
        .where('id = :id', { id: key.id })
        .andWhere('(legacyRevokedAt IS NULL OR legacyRevokedAt > :cutoff)', { cutoff })
        .execute()
    return minted
}
