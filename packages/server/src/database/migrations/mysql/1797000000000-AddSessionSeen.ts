import { MigrationInterface, QueryRunner } from 'typeorm'
import { addSessionSeenColumn, dropSessionSeenColumn } from '../../../identity/schemaMigration'

/** Last activity on a local session, so a shorter idle lifetime applies to one that already exists. */
export class AddSessionSeen1797000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await addSessionSeenColumn(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await dropSessionSeenColumn(queryRunner)
    }
}
