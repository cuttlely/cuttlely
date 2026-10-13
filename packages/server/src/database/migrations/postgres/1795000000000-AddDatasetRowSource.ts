import { MigrationInterface, QueryRunner } from 'typeorm'

// Where a dataset row came from. Null on a row typed in or uploaded.
// The unique index stores one chat answer once per dataset. Rows with no source message stay distinct.
export class AddDatasetRowSource1795000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceType" varchar(32);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceMessageId" varchar(36);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceFlowId" varchar(36);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceDate" timestamp;`)
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_dataset_row_source_message" ON "dataset_row" ("datasetId", "sourceMessageId");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dataset_row_source_message";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceDate";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceFlowId";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceMessageId";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceType";`)
    }
}
