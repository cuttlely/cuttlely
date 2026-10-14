import { MigrationInterface, QueryRunner } from 'typeorm'

// A rating copied into a dataset. The expected answer stays empty when the rating rejected the answer.
export class AddDatasetRowRating1796000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN "sourceFeedbackId" varchar(36);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN "sourceRating" varchar(16);`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN "sourceFeedbackText" text;`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN "sourceRejectedAnswer" text;`)
        await queryRunner.query(`ALTER TABLE "dataset_row" ADD COLUMN "needsExpectedAnswer" boolean DEFAULT 0;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN "needsExpectedAnswer";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN "sourceRejectedAnswer";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN "sourceFeedbackText";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN "sourceRating";`)
        await queryRunner.query(`ALTER TABLE "dataset_row" DROP COLUMN "sourceFeedbackId";`)
    }
}
