import { MigrationInterface, QueryRunner } from 'typeorm'
import { addAccessKeys, removeAccessKeys } from '../AccessKeys'

export class AccessKeys1801300000000 implements MigrationInterface {
    async up(runner: QueryRunner): Promise<void> {
        await addAccessKeys(runner)
    }
    async down(runner: QueryRunner): Promise<void> {
        await removeAccessKeys(runner)
    }
}
