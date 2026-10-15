import { MigrationInterface, QueryRunner } from 'typeorm'

// Keyset for chat question history: one flow, newest createdDate, then id.
const INDEX = 'IDX_chat_message_flow_created_id'

export class AddChatMessageFlowCreatedIndex1797000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('chat_message')
        if (table?.indices.some((index) => index.name === INDEX)) return
        await queryRunner.query(`CREATE INDEX \`${INDEX}\` ON \`chat_message\` (\`chatflowid\`, \`createdDate\`, \`id\`)`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`${INDEX}\` ON \`chat_message\``)
    }
}
