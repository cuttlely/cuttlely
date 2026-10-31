/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addScimGroups, removeScimGroups } from '../../../identity/schemaMigration'

export class AddScimGroups1801200000001 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addScimGroups(queryRunner)
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await removeScimGroups(queryRunner)
    }
}
