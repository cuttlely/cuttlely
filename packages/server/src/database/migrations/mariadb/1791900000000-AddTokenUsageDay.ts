import { MigrationInterface, QueryRunner } from 'typeorm'

// Daily input and output tokens per workspace, flow, model, and UTC day.
// utf8mb4 unique key (workspaceId, flowId, model, day) is 36*4 + 64*4 + 255*4 + 10*4 = 1460 bytes.
// InnoDB refuses a key over 3072 bytes. A prefix on model would merge different long names.
export class AddTokenUsageDay1791900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`token_usage_day\` (
                \`id\` varchar(36) NOT NULL,
                \`workspaceId\` varchar(36) NOT NULL,
                \`flowId\` varchar(64) NOT NULL,
                \`model\` varchar(255) NOT NULL,
                \`day\` varchar(10) NOT NULL,
                \`inputTokens\` int NOT NULL DEFAULT 0,
                \`outputTokens\` int NOT NULL DEFAULT 0,
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`UQ_token_usage_day_bucket\` (\`workspaceId\`, \`flowId\`, \`model\`, \`day\`),
                KEY \`IDX_token_usage_day_workspace_day\` (\`workspaceId\`, \`day\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS \`token_usage_day\``)
    }
}
