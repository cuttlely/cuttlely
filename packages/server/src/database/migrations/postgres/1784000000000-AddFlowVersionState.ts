import { MigrationInterface, QueryRunner } from 'typeorm'

// Draft and publish state per flow. No data is copied: a flow with no row keeps its canvas as Live.
export class AddFlowVersionState1784000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS flow_version_state (
                id uuid NOT NULL DEFAULT uuid_generate_v4(),
                "chatflowId" varchar NOT NULL,
                "workspaceId" varchar NOT NULL,
                "draftFlowData" text,
                "draftBaseHash" varchar(64),
                "draftUpdatedDate" timestamp,
                "draftUpdatedBy" varchar,
                "publishInstantly" boolean NOT NULL DEFAULT false,
                "liveSha" varchar(40),
                "publishedDate" timestamp,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_flow_version_state" PRIMARY KEY (id)
            );
        `)
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flow_version_state_chatflowId" ON flow_version_state ("chatflowId");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS flow_version_state`)
    }
}
