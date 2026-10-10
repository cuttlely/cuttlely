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
import { refactorUp, refactorDown } from '../../identitySchema'

export class RefactorEnterpriseDatabase1737076223692 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await refactorUp(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await refactorDown(queryRunner)
    }
}
