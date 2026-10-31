/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addScimProvisioning, removeScimProvisioning } from '../../../identity/schemaMigration'

export class AddScimProvisioning1801200000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addScimProvisioning(queryRunner)
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await removeScimProvisioning(queryRunner)
    }
}
