import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddHarnessPayloadToChatMessage1781000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const columnExists = await queryRunner.hasColumn('chat_message', 'harnessPayload')
        if (!columnExists) await queryRunner.query(`ALTER TABLE \`chat_message\` ADD COLUMN \`harnessPayload\` LONGTEXT;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`chat_message\` DROP COLUMN \`harnessPayload\`;`)
    }
}
