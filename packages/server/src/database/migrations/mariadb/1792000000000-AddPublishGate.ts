import { MigrationInterface, QueryRunner } from 'typeorm'

// The optional passing-test requirement and its last result. No answers are stored. Existing rows stay off.
export class AddPublishGate1792000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const add = async (column: string, sql: string) => {
            if (!(await queryRunner.hasColumn('flow_version_state', column))) await queryRunner.query(sql)
        }
        await add('publishGate', 'ALTER TABLE `flow_version_state` ADD COLUMN `publishGate` tinyint(1) NOT NULL DEFAULT 0;')
        await add('publishGateDatasetId', 'ALTER TABLE `flow_version_state` ADD COLUMN `publishGateDatasetId` varchar(255);')
        await add('publishGateEvaluatorIds', 'ALTER TABLE `flow_version_state` ADD COLUMN `publishGateEvaluatorIds` longtext;')
        await add('publishGateThreshold', 'ALTER TABLE `flow_version_state` ADD COLUMN `publishGateThreshold` int;')
        await add('publishGateResult', 'ALTER TABLE `flow_version_state` ADD COLUMN `publishGateResult` longtext;')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const column of [
            'publishGateResult',
            'publishGateThreshold',
            'publishGateEvaluatorIds',
            'publishGateDatasetId',
            'publishGate'
        ]) {
            if (await queryRunner.hasColumn('flow_version_state', column)) {
                await queryRunner.query(`ALTER TABLE \`flow_version_state\` DROP COLUMN \`${column}\`;`)
            }
        }
    }
}
