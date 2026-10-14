import { MigrationInterface, QueryRunner } from 'typeorm'

// A rating copied into a dataset. The expected answer stays empty when the rating rejected the answer.
export class AddDatasetRowRating1796000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceFeedbackId" varchar(36);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceRating" varchar(16);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceFeedbackText" text;`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "sourceRejectedAnswer" text;`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN IF NOT EXISTS "needsExpectedAnswer" boolean DEFAULT false;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "needsExpectedAnswer";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceRejectedAnswer";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceFeedbackText";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceRating";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN IF EXISTS "sourceFeedbackId";`)
    }
}
