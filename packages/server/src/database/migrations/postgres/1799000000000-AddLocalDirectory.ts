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
import { addLocalDirectory, removeLocalDirectory } from '../../../identity/schemaMigration'

export class AddLocalDirectory1799000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await addLocalDirectory(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await removeLocalDirectory(queryRunner)
    }
}
