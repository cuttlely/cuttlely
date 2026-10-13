import { MigrationInterface, QueryRunner } from 'typeorm'

// Per-organization input and output prices, US dollars per million tokens.
export class AddModelPriceOverride1792000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "model_price_override" (
                "id" varchar PRIMARY KEY NOT NULL,
                "organizationId" varchar(36) NOT NULL,
                "model" varchar(255) NOT NULL,
                "inputUsdPerMillion" varchar(32) NOT NULL,
                "outputUsdPerMillion" varchar(32) NOT NULL,
                CONSTRAINT "UQ_model_price_override" UNIQUE ("organizationId", "model")
            );
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "model_price_override"`)
    }
}
