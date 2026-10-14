import { MigrationInterface, QueryRunner } from 'typeorm'

// The optional passing-test requirement and its last result. No answers are stored. Existing rows stay off.
export class AddPublishGate1792000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flow_version_state" ADD COLUMN "publishGate" boolean NOT NULL DEFAULT 0;`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" ADD COLUMN "publishGateDatasetId" varchar;`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" ADD COLUMN "publishGateEvaluatorIds" text;`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" ADD COLUMN "publishGateThreshold" integer;`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" ADD COLUMN "publishGateResult" text;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flow_version_state" DROP COLUMN "publishGateResult";`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" DROP COLUMN "publishGateThreshold";`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" DROP COLUMN "publishGateEvaluatorIds";`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" DROP COLUMN "publishGateDatasetId";`)
        await queryRunner.query(`ALTER TABLE "flow_version_state" DROP COLUMN "publishGate";`)
    }
}
