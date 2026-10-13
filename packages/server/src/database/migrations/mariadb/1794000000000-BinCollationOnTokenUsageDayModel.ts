import { MigrationInterface, QueryRunner } from 'typeorm'

// token_usage_day.model inherited the table's case-insensitive collation, so two names
// that differ only by case landed in one row. model_price_override.model is already utf8mb4_bin.
// The unique key stays the same width: utf8mb4 is 4 bytes per character either way.
export class BinCollationOnTokenUsageDayModel1794000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`token_usage_day\` DROP INDEX \`UQ_token_usage_day_bucket\``)
        await queryRunner.query(
            `ALTER TABLE \`token_usage_day\` MODIFY \`model\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`
        )
        await queryRunner.query(
            `ALTER TABLE \`token_usage_day\` ADD UNIQUE KEY \`UQ_token_usage_day_bucket\` (\`workspaceId\`, \`flowId\`, \`model\`, \`day\`)`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`token_usage_day\` DROP INDEX \`UQ_token_usage_day_bucket\``)
        await queryRunner.query(
            `ALTER TABLE \`token_usage_day\` MODIFY \`model\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci NOT NULL`
        )
        await queryRunner.query(
            `ALTER TABLE \`token_usage_day\` ADD UNIQUE KEY \`UQ_token_usage_day_bucket\` (\`workspaceId\`, \`flowId\`, \`model\`, \`day\`)`
        )
    }
}
