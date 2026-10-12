import { MigrationInterface, QueryRunner } from 'typeorm'

// Daily input and output tokens per workspace, flow, model, and UTC day.
export class AddTokenUsageDay1791900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "token_usage_day" (
                "id" varchar PRIMARY KEY NOT NULL,
                "workspaceId" varchar(36) NOT NULL,
                "flowId" varchar(64) NOT NULL,
                "model" varchar(255) NOT NULL,
                "day" varchar(10) NOT NULL,
                "inputTokens" integer NOT NULL DEFAULT 0,
                "outputTokens" integer NOT NULL DEFAULT 0,
                CONSTRAINT "UQ_token_usage_day_bucket" UNIQUE ("workspaceId", "flowId", "model", "day")
            );
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_token_usage_day_workspace_day" ON "token_usage_day" ("workspaceId", "day");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "token_usage_day"`)
    }
}
