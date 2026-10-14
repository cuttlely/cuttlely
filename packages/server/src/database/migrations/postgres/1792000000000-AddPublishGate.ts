import { MigrationInterface, QueryRunner } from 'typeorm'

// The optional passing-test requirement and its last result. No answers are stored. Existing rows stay off.
export class AddPublishGate1792000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE flow_version_state ADD COLUMN IF NOT EXISTS "publishGate" boolean NOT NULL DEFAULT false;`)
        await queryRunner.query(`ALTER TABLE flow_version_state ADD COLUMN IF NOT EXISTS "publishGateDatasetId" varchar;`)
        await queryRunner.query(`ALTER TABLE flow_version_state ADD COLUMN IF NOT EXISTS "publishGateEvaluatorIds" text;`)
        await queryRunner.query(`ALTER TABLE flow_version_state ADD COLUMN IF NOT EXISTS "publishGateThreshold" integer;`)
        await queryRunner.query(`ALTER TABLE flow_version_state ADD COLUMN IF NOT EXISTS "publishGateResult" text;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE flow_version_state DROP COLUMN IF EXISTS "publishGateResult";`)
        await queryRunner.query(`ALTER TABLE flow_version_state DROP COLUMN IF EXISTS "publishGateThreshold";`)
        await queryRunner.query(`ALTER TABLE flow_version_state DROP COLUMN IF EXISTS "publishGateEvaluatorIds";`)
        await queryRunner.query(`ALTER TABLE flow_version_state DROP COLUMN IF EXISTS "publishGateDatasetId";`)
        await queryRunner.query(`ALTER TABLE flow_version_state DROP COLUMN IF EXISTS "publishGate";`)
    }
}
