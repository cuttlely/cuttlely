import { MigrationInterface, QueryRunner } from 'typeorm'

// A rating copied into a dataset. The expected answer stays empty when the rating rejected the answer.
export class AddDatasetRowRating1796000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceFeedbackId'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceFeedbackId\` varchar(36) NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceRating'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceRating\` varchar(16) NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceFeedbackText'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceFeedbackText\` text NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'sourceRejectedAnswer'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`sourceRejectedAnswer\` text NULL;`)
        }
        if (!(await queryRunner.hasColumn('dataset_row', 'needsExpectedAnswer'))) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` ADD COLUMN \`needsExpectedAnswer\` boolean NULL DEFAULT 0;`)
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('dataset_row', 'needsExpectedAnswer')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`needsExpectedAnswer\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceRejectedAnswer')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceRejectedAnswer\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceFeedbackText')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceFeedbackText\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceRating')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceRating\``)
        }
        if (await queryRunner.hasColumn('dataset_row', 'sourceFeedbackId')) {
            await queryRunner.query(`ALTER TABLE \`dataset_row\` DROP COLUMN \`sourceFeedbackId\``)
        }
    }
}
