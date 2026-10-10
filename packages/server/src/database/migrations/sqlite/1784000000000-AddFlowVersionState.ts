import { MigrationInterface, QueryRunner } from 'typeorm'

// Draft and publish state per flow. No data is copied: a flow with no row keeps its canvas as Live.
export class AddFlowVersionState1784000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "flow_version_state" (
                "id" varchar PRIMARY KEY NOT NULL,
                "chatflowId" varchar NOT NULL,
                "workspaceId" varchar NOT NULL,
                "draftFlowData" text,
                "draftBaseHash" varchar(64),
                "draftUpdatedDate" datetime,
                "draftUpdatedBy" varchar,
                "publishInstantly" boolean NOT NULL DEFAULT 0,
                "liveSha" varchar(40),
                "publishedDate" datetime,
                "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedDate" datetime NOT NULL DEFAULT (datetime('now'))
            );
        `)
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flow_version_state_chatflowId" ON "flow_version_state" ("chatflowId");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "flow_version_state"`)
    }
}
