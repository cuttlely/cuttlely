import { MigrationInterface, QueryRunner } from 'typeorm'

// The harnesses an API key may run. Null runs none, so existing keys start with no harness access.
export class AddApiKeyHarnesses1800500000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "apikey" ADD COLUMN "harnesses" text;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "apikey" DROP COLUMN "harnesses";`)
    }
}
