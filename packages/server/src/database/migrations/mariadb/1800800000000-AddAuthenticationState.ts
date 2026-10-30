/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addAuthenticationState, removeAuthenticationState } from '../../../identity/schemaMigration'
export class AddAuthenticationState1800800000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await addAuthenticationState(queryRunner)
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await removeAuthenticationState(queryRunner)
    }
}
