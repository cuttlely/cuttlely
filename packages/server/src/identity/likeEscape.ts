/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * LIKE ESCAPE clause. MySQL and MariaDB string literals treat a backslash as an escape,
 * so the escape character is written twice. Other drivers take one backslash as written.
 */
export function likeEscapeClause(dialect: string): string {
    if (dialect === 'mysql' || dialect === 'mariadb') return "ESCAPE '\\\\'"
    return "ESCAPE '\\'"
}
