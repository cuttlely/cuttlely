import { MigrationInterface, QueryRunner } from 'typeorm'

// Per-organization input and output prices, US dollars per million tokens.
// utf8mb4 unique key (organizationId, model) is 36*4 + 255*4 = 1164 bytes, under InnoDB's 3072 limit.
export class AddModelPriceOverride1792000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`model_price_override\` (
                \`id\` varchar(36) NOT NULL,
                \`organizationId\` varchar(36) NOT NULL,
                \`model\` varchar(255) NOT NULL,
                \`inputUsdPerMillion\` varchar(32) NOT NULL,
                \`outputUsdPerMillion\` varchar(32) NOT NULL,
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`UQ_model_price_override\` (\`organizationId\`, \`model\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS \`model_price_override\``)
    }
}
