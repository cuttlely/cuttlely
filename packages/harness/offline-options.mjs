import { readCredentialRow } from './credential-store.mjs'

export function flowiseNodeOptions() {
    return {
        appDataSource: {
            getRepository() {
                return {
                    findOneBy: async ({ id }) => readCredentialRow(id)
                }
            }
        },
        databaseEntities: { Credential: function Credential() {} }
    }
}
