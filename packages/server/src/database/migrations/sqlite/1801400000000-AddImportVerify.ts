import { MigrationInterface, QueryRunner } from 'typeorm'

// Progress for Import & verify. Existing rows have no record, so Publish is unchanged.
export class AddImportVerify1801400000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flow_version_state" ADD COLUMN "importVerify" text;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flow_version_state" DROP COLUMN "importVerify";`)
    }
}
