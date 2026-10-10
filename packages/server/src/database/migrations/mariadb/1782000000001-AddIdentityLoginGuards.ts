/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Follow-up so a database that already ran AddIdentitySignIn
 * still gets identity_bootstrap and identity_login_failure.
 */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addIdentityLoginGuards, removeIdentityLoginGuards } from '../../../identity/schemaMigration'

export class AddIdentityLoginGuards1782000000001 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await addIdentityLoginGuards(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await removeIdentityLoginGuards(queryRunner)
    }
}
