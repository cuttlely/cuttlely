/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addWorkosSessionId, removeWorkosSessionId } from '../../../identity/schemaMigration'

export class AddWorkosSessionId1801150000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addWorkosSessionId(queryRunner)
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await removeWorkosSessionId(queryRunner)
    }
}
