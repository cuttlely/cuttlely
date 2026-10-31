import { MigrationInterface, QueryRunner } from 'typeorm'
import { addOidcProvider, removeOidcProvider } from '../../../identity/schemaMigration'

export class AddOidcProvider1801000000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addOidcProvider(queryRunner)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await removeOidcProvider(queryRunner)
    }
}
