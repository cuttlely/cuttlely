// The versioning core talks to the server through these interfaces.
// The server adapter implements them. This package does not import the server.
import { CredentialRef } from './serialize'
import { GithubCredentialStore } from './github'

// Credential rows for a flow. Names and types only. Encrypted values stay in the server.
export interface CredentialStorage {
    namesForIds(ids: string[], workspaceId?: string): Promise<Map<string, CredentialRef>>
    // Ids with this name and type, oldest first.
    idsByName(ref: CredentialRef, workspaceId?: string): Promise<string[]>
}

// A warning. The server adapter writes it to the server log.
export interface VersionLog {
    warn(message: string): void
}

export interface VersioningDeps {
    storage: CredentialStorage
    log: VersionLog
    githubCredentials: GithubCredentialStore
}
