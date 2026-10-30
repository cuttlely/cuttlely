import { MigrationInterface, QueryRunner } from 'typeorm'
import { addAuthenticationSwitchStage, removeAuthenticationSwitchStage } from '../../../identity/schemaMigration'

export class AddAuthenticationSwitchStage1800900000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addAuthenticationSwitchStage(queryRunner)
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await removeAuthenticationSwitchStage(queryRunner)
    }
}
