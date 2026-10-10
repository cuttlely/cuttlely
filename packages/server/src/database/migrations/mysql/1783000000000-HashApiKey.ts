import { MigrationInterface, QueryRunner } from 'typeorm'
import { rewritePlaintextApiKeys } from '../../../utils/apiKey'

/**
 * Stores chatflow API keys as sha256 lookups. The scrypt apiSecret is unchanged,
 * so a key the caller already has still verifies. Down cannot restore plaintext.
 */
export class HashApiKey1783000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await rewritePlaintextApiKeys(queryRunner)
    }

    public async down(): Promise<void> {
        // The bearer token is not recoverable from the lookup or the scrypt secret.
    }
}
