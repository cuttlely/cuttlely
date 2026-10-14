import { MigrationInterface, QueryRunner } from 'typeorm'

// Where a dataset row came from. Null on a row typed in or uploaded.
// The unique index stores one chat answer once per dataset. Rows with no source message stay distinct.
export class AddDatasetRowSource1795000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceType'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceType\` varchar(32) NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceMessageId'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceMessageId\` varchar(36) NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceFlowId'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceFlowId\` varchar(36) NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceDate'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceDate\` datetime(6) NULL;`)
        }
        const indexes = await queryRunner.query(`SHOW INDEX FROM \`dataset_row\` WHERE Key_name = 'IDX_dataset_row_source_message'`)
        if (!indexes?.length) {
            await queryRunner.query(
                `CREATE UNIQUE INDEX \`IDX_dataset_row_source_message\` ON \`dataset_row\` (\`datasetId\`, \`sourceMessageId\`)`
            )
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const indexes = await queryRunner.query(`SHOW INDEX FROM \`dataset_row\` WHERE Key_name = 'IDX_dataset_row_source_message'`)
        if (indexes?.length) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP INDEX \`IDX_dataset_row_source_message\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceDate')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceDate\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceFlowId')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceFlowId\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceMessageId')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceMessageId\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceType')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceType\``)
        }
    }
}
