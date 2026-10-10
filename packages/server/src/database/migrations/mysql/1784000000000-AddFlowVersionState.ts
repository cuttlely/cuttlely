import { MigrationInterface, QueryRunner } from 'typeorm'

// Draft and publish state per flow. No data is copied: a flow with no row keeps its canvas as Live.
export class AddFlowVersionState1784000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`flow_version_state\` (
                \`id\` varchar(36) NOT NULL,
                \`chatflowId\` varchar(255) NOT NULL,
                \`workspaceId\` varchar(255) NOT NULL,
                \`draftFlowData\` longtext,
                \`draftBaseHash\` varchar(64),
                \`draftUpdatedDate\` datetime(6),
                \`draftUpdatedBy\` varchar(255),
                \`publishInstantly\` tinyint(1) NOT NULL DEFAULT 0,
                \`liveSha\` varchar(40),
                \`publishedDate\` datetime(6),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`IDX_flow_version_state_chatflowId\` (\`chatflowId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS \`flow_version_state\``)
    }
}
