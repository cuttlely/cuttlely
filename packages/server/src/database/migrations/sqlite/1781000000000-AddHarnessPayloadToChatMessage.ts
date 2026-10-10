import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddHarnessPayloadToChatMessage1781000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chat_message" ADD COLUMN "harnessPayload" TEXT;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "harnessPayload";`)
    }
}
