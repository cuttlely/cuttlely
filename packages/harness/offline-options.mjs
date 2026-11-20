import { readCredentialRowAsync } from './credential-store.mjs'

export function flowiseNodeOptions() {
    return {
        appDataSource: {
            getRepository() {
                return {
                    findOneBy: async ({ id }) => readCredentialRowAsync(id)
                }
            }
        },
        databaseEntities: { Credential: function Credential() {} }
    }
}
