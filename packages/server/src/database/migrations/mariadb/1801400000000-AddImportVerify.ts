import { MigrationInterface, QueryRunner } from 'typeorm'

// Progress for Import & verify. Existing rows have no record, so Publish is unchanged.
export class AddImportVerify1801400000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('flow_version_state', 'importVerify'))) {
            await queryRunner.query('ALTER TABLE `flow_version_state` ADD COLUMN `importVerify` longtext;')
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('flow_version_state', 'importVerify')) {
            await queryRunner.query('ALTER TABLE `flow_version_state` DROP COLUMN `importVerify`;')
        }
    }
}
