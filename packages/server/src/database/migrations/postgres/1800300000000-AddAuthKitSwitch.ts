/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { addAuthKitSwitchTable, removeAuthKitSwitchTable } from '../../../identity/schemaMigration'

/** Records the AuthKit switch so existing local sessions end once, not on every restart. */
export class AddAuthKitSwitch1800300000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await addAuthKitSwitchTable(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await removeAuthKitSwitchTable(queryRunner)
    }
}
