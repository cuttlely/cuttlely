// Thin server adapter. The versioning core lives in @cuttlely/versioning.
// This file implements storage, flow lookup and logging, and keeps the calls the server already makes.
import { In, IsNull } from 'typeorm'
import { Credential } from '../../database/entities/Credential'
import logger from '../../utils/logger'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import {
    actorFromUser,
    configureVersioning,
    diffVersion,
    flushVersions,
    getGithub,
    getStatus,
    getVersion,
    GITHUB_CREDENTIAL,
    hasChanges,
    hiddenInputsDiffer,
    isVersioningEnabled,
    lastErrorFor,
    listVersions,
    liveVersionSha,
    recordFlowDeletion,
    recordFlowVersion,
    restoreTitle,
    startGithubSync,
    versionAuthor,
    versionsDir,
    withPrefix,
    type CredentialRef,
    type CredentialStorage,
    type FlowLookup,
    type GithubCredentialStore
} from '@cuttlely/versioning'

const log = {
    warn(message: string) {
        logger.warn(message)
    }
}

// Only the name and type are read. Encrypted data is never selected.
const storage: CredentialStorage = {
    async namesForIds(ids, workspaceId) {
        const rows = await getRunningExpressApp()
            .AppDataSource.getRepository(Credential)
            .find({ select: ['id', 'name', 'credentialName'], where: { id: In(ids), workspaceId: workspaceId ?? IsNull() } })
        const out = new Map<string, CredentialRef>()
        for (const row of rows || []) out.set(row.id, { name: row.name, credentialName: row.credentialName })
        return out
    },
    async idsByName(ref, workspaceId) {
        const rows = await getRunningExpressApp()
            .AppDataSource.getRepository(Credential)
            .find({
                select: ['id', 'createdDate'],
                where: { name: ref.name, credentialName: ref.credentialName, workspaceId: workspaceId ?? IsNull() },
                order: { createdDate: 'ASC', id: 'ASC' }
            })
        return (rows || []).map((row) => row.id)
    }
}

// Callers pass the saved flow. This lookup answers a caller that has only an id.
const flows: FlowLookup = {
    async get() {
        return null
    }
}

// The GitHub token is a Github API credential in Credentials, read only when copying.
// Only the id, name and type are queried here; the value is decrypted in memory and never logged.
const githubCredentials: GithubCredentialStore = {
    async get(id, workspaceId) {
        const row = await getRunningExpressApp()
            .AppDataSource.getRepository(Credential)
            .findOne({ where: { id, workspaceId, credentialName: GITHUB_CREDENTIAL } })
        if (!row) return null
        const data = await (await import('../../utils')).decryptCredentialData(row.encryptedData)
        return { id: row.id, name: row.name, token: typeof data?.accessToken === 'string' ? data.accessToken.trim() : '' }
    },
    async create({ name, token, workspaceId }) {
        const credentialsService = (await import('../credentials')).default
        const saved = await credentialsService.createCredential({
            name,
            credentialName: GITHUB_CREDENTIAL,
            plainDataObj: { accessToken: token },
            workspaceId
        })
        return { id: saved.id, name: saved.name }
    }
}

configureVersioning({ storage, flows, log, githubCredentials })

export {
    credentialIds,
    diffVersion,
    flushVersions,
    getGithub,
    getStatus,
    getStore,
    getVersion,
    hasChanges,
    hiddenInputsDiffer,
    hiddenSecretNote,
    isVersioningEnabled,
    lastErrorFor,
    listVersions,
    liveVersionSha,
    pickCredential,
    recordFlowDeletion,
    recordFlowVersion,
    resetForTests,
    restoreTitle,
    setGithubForTests,
    startGithubSync,
    versionsDir,
    withPrefix
} from '@cuttlely/versioning'

export type {
    AmbiguousCredential,
    DiffAgainst,
    ReadOptions,
    RecordOptions,
    VersionActor,
    VersionContent,
    VersionDiffResult,
    VersionedFlow,
    VersioningStatus,
    VersionList
} from '@cuttlely/versioning'

export default {
    isVersioningEnabled,
    versionAuthor,
    actorFromUser,
    versionsDir,
    getStatus,
    recordFlowVersion,
    recordFlowDeletion,
    flushVersions,
    listVersions,
    getVersion,
    getGithub,
    startGithubSync,
    diffVersion,
    hasChanges,
    hiddenInputsDiffer,
    lastErrorFor,
    liveVersionSha,
    restoreTitle,
    withPrefix
}
