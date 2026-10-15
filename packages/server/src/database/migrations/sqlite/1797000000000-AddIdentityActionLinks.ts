import { MigrationInterface, QueryRunner } from 'typeorm'
import { addIdentityActionLinks, removeIdentityActionLinks } from '../../../identity/schemaMigration'

export class AddIdentityActionLinks1797000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await addIdentityActionLinks(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await removeIdentityActionLinks(queryRunner)
    }
}
