/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addSessionConvergence, removeSessionConvergence } from '../../../identity/schemaMigration'

export class AddSessionConvergence1801100000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addSessionConvergence(queryRunner)
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await removeSessionConvergence(queryRunner)
    }
}
