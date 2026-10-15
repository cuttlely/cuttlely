# Startup options

Every option the [Server settings API](./server-settings-api.md) exposes, in one list. The list is the settings registry plus the fixed host-only list. `GET /api/v1/server-settings` returns the registry in `settings`. `GET /api/v1/server-settings/read-only` returns the host-only list in `settings`. Both responses are the whole list. They do not take `cursor` or `limit`, and they do not page.

A secret setting and every host-only key are named here and marked **not shown**. The table does not include the value, a default that would be the value, a length, a hash, a token, a key, or a connection string. The API follows the same rule: a secret is omitted from the response, and a host-only row is `key`, `set`, `source`, and `readOnly`.

**Where it can be set** is either the host and then Server settings, or the host only. **Restart** is No for a runtime setting, which applies on the next use. Every other option applies at the next start.

The publish check switch is `CUTTLELY_PUBLISH_CHECK`. The default is `true`. Accepted values are exactly `true` and `false`. How a host value wins, and the error codes, are in the [Server settings API](./server-settings-api.md#publish-check-switch).

| Key                                          | Default                                     | Range             | Unit          | Where it can be set        | Restart |
| -------------------------------------------- | ------------------------------------------- | ----------------- | ------------- | -------------------------- | ------- |
| `CUTTLELY_LOCAL_ADMIN`                       | On from source and in Docker, off on Render | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_LOCAL_USERS`                       | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `WORKOS_API_KEY`                             | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `WORKOS_CLIENT_ID`                           | Not set: AuthKit is off                     | —                 | —             | Host, then Server settings | Yes     |
| `WORKOS_REDIRECT_URI`                        | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `WORKOS_COOKIE_PASSWORD`                     | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_BOOTSTRAP_EMAIL`                   | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_TYPE`                              | sqlite                                      | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_HOST`                              | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_PORT`                              | 5432                                        | 1 to 65535        | —             | Host, then Server settings | Yes     |
| `DATABASE_NAME`                              | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_USER`                              | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_PASSWORD`                          | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_SSL`                               | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_REJECT_UNAUTHORIZED`               | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `DATABASE_SSL_KEY_BASE64`                    | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_TURN_BUDGET_MS`            | 45000                                       | 0 to 3600         | ms-as-seconds | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_MODEL_FALLBACK_MS`         | 8000                                        | 0 to 600          | ms-as-seconds | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_SPECIALIST_CONTEXT_TOKENS` | 4000                                        | 0 to 1000000      | tokens        | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS`      | 6000                                        | 0 to 1000000      | tokens        | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_QUEUE`                     | inline                                      | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_WORKERS`                   | 1                                           | 1 to 16           | —             | Host, then Server settings | Yes     |
| `CUTTLELY_HARNESS_WORKER_CONCURRENCY`        | 4                                           | 1 to 64           | —             | Host, then Server settings | Yes     |
| `CUTTLELY_WARM_HERMES`                       | true                                        | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_HERMES_KEEP_WARM_MINUTES`          | Off                                         | 1 to 1440         | minutes       | Host, then Server settings | Yes     |
| `CUTTLELY_ANALYST`                           | Off                                         | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_POSTGRES_URL`                      | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_ANALYST_ROW_CAP`                   | 100                                         | 1 to 1000         | —             | Host, then Server settings | Yes     |
| `CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS`      | 15000                                       | 1 to 120          | ms-as-seconds | Host, then Server settings | Yes     |
| `CUTTLELY_ANALYST_TRACE_PREVIEW`             | true                                        | —                 | —             | Host, then Server settings | Yes     |
| `MODEL_LIST_CONFIG_JSON`                     | Daily from Cuttlely                         | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_MODELS_DEV`                        | 0                                           | —                 | —             | Host, then Server settings | Yes     |
| `STORAGE_TYPE`                               | local                                       | —                 | —             | Host, then Server settings | Yes     |
| `S3_STORAGE_BUCKET_NAME`                     | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `S3_STORAGE_REGION`                          | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `S3_STORAGE_ACCESS_KEY_ID`                   | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `S3_STORAGE_SECRET_ACCESS_KEY`               | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `S3_ENDPOINT_URL`                            | AWS                                         | —                 | —             | Host, then Server settings | Yes     |
| `S3_FORCE_PATH_STYLE`                        | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `GOOGLE_CLOUD_STORAGE_BUCKET_NAME`           | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `GOOGLE_CLOUD_STORAGE_PROJ_ID`               | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `GOOGLE_CLOUD_STORAGE_CREDENTIAL`            | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `GOOGLE_CLOUD_UNIFORM_BUCKET_ACCESS`         | true                                        | —                 | —             | Host, then Server settings | Yes     |
| `AZURE_BLOB_STORAGE_CONTAINER_NAME`          | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `AZURE_BLOB_STORAGE_ACCOUNT_NAME`            | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `AZURE_BLOB_STORAGE_ACCOUNT_KEY`             | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `AZURE_BLOB_STORAGE_CONNECTION_STRING`       | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `FLOWISE_FILE_SIZE_LIMIT`                    | 50mb                                        | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_FILE_SIZE_LIMIT`                   | 50mb                                        | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_LOGIN_FAILURE_LIMIT`               | 10                                          | 3 to 50           | count         | Host, then Server settings | No      |
| `CUTTLELY_SESSION_IDLE_MINUTES`              | 720                                         | 15 to 1440        | minutes       | Host, then Server settings | No      |
| `CUTTLELY_SESSION_ABSOLUTE_HOURS`            | 168                                         | 1 to 720          | count         | Host, then Server settings | No      |
| `CUTTLELY_DRAIN_TIMEOUT_MS`                  | 25000                                       | 5000 to 300000    | ms            | Host, then Server settings | No      |
| `CUTTLELY_HISTORY_KEEP`                      | 1000                                        | 100 to 10000      | count         | Host, then Server settings | No      |
| `CUTTLELY_UI_PAGE_LIMIT_MAX`                 | 3000                                        | 100 to 50000      | count         | Host, then Server settings | No      |
| `CORS_ORIGINS`                               | This server only                            | —                 | —             | Host, then Server settings | Yes     |
| `CORS_ALLOW_CREDENTIALS`                     | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `IFRAME_ORIGINS`                             | This server only                            | —                 | —             | Host, then Server settings | Yes     |
| `MCP_CORS_ORIGINS`                           | Built-in rule                               | —                 | —             | Host, then Server settings | Yes     |
| `TRUST_PROXY`                                | None                                        | —                 | —             | Host, then Server settings | Yes     |
| `APP_URL`                                    | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `GLOBAL_AGENT_HTTP_PROXY`                    | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `GLOBAL_AGENT_HTTPS_PROXY`                   | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `GLOBAL_AGENT_NO_PROXY`                      | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `HTTP_DENY_LIST`                             | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `OAUTH2_ALLOWED_TOKEN_DOMAINS`               | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `DISABLED_NODES`                             | None                                        | —                 | —             | Host, then Server settings | Yes     |
| `SHOW_COMMUNITY_NODES`                       | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_VERSIONS`                          | on                                          | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_DRAFTS`                            | on                                          | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_PUBLISH_CHECK`                     | true                                        | —                 | boolean       | Host, then Server settings | No      |
| `CUTTLELY_CHECK_MAX_TOKENS`                  | 100000                                      | 1000 to 2000000   | tokens        | Host, then Server settings | No      |
| `CUTTLELY_CHECK_MAX_SECONDS`                 | 180                                         | 10 to 1800        | seconds       | Host, then Server settings | No      |
| `CUTTLELY_CHECK_CONCURRENCY`                 | 2                                           | 1 to 8            | count         | Host, then Server settings | No      |
| `CUTTLELY_CHECK_RUN_TIMEOUT_MS`              | 60000                                       | 10000 to 600000   | ms            | Host, then Server settings | No      |
| `CUTTLELY_CHECK_KEEP_MINUTES`                | 30                                          | 5 to 1440         | minutes       | Host, then Server settings | No      |
| `CUTTLELY_CHECK_COUNT_MAX`                   | 100                                         | 1 to 500          | count         | Host, then Server settings | No      |
| `CUTTLELY_CHECK_COUNT_DEFAULT`               | 4                                           | 1 to 500          | count         | Host, then Server settings | No      |
| `CUTTLELY_CHECK_SCAN_CAP`                    | 2000                                        | 500 to 20000      | count         | Host, then Server settings | No      |
| `CUTTLELY_HARNESS_TURN_SCAN_CAP`             | 2000                                        | 500 to 5000       | count         | Host, then Server settings | No      |
| `CUTTLELY_RATING_IMPORT_CAP`                 | 500                                         | 50 to 5000        | count         | Host, then Server settings | No      |
| `CUTTLELY_RATING_SCAN_CAP`                   | 1000                                        | 50 to 20000       | count         | Host, then Server settings | No      |
| `POSTHOG_PUBLIC_API_KEY`                     | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `DISABLE_CUTTLELY_TELEMETRY`                 | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `LANGCHAIN_TRACING_V2`                       | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `LANGCHAIN_API_KEY`                          | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `LANGCHAIN_PROJECT`                          | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `LANGCHAIN_ENDPOINT`                         | LangSmith cloud                             | —                 | —             | Host, then Server settings | Yes     |
| `LANGSMITH_PROJECT`                          | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `LANGSMITH_ENDPOINT`                         | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `ENABLE_METRICS`                             | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `METRICS_PROVIDER`                           | prometheus                                  | —                 | —             | Host, then Server settings | Yes     |
| `METRICS_OPEN_TELEMETRY_METRIC_ENDPOINT`     | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `METRICS_SERVICE_NAME`                       | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `METRICS_PREFIX`                             | Existing names                              | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_OTEL_TRACES`                       | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_OTEL_TRACES_ENDPOINT`              | Not set                                     | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_OTEL_TRACES_PROTOCOL`              | http                                        | —                 | —             | Host, then Server settings | Yes     |
| `CUTTLELY_OTEL_TRACES_CONTENT`               | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `E2B_APIKEY`                                 | not shown                                   | —                 | —             | Host, then Server settings | Yes     |
| `LOG_LEVEL`                                  | info                                        | —                 | —             | Host, then Server settings | Yes     |
| `DEBUG`                                      | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `LOG_SANITIZE_BODY_FIELDS`                   | None                                        | —                 | —             | Host, then Server settings | Yes     |
| `LOG_SANITIZE_HEADER_FIELDS`                 | None                                        | —                 | —             | Host, then Server settings | Yes     |
| `CANVAS_CARD_LOOK`                           | new                                         | —                 | —             | Host, then Server settings | Yes     |
| `MIN_SCHEDULE_INTERVAL_SECONDS`              | 60                                          | 1 to 86400        | seconds       | Host, then Server settings | Yes     |
| `CUTTLELY_ETL_CONCURRENCY`                   | 1                                           | 1 to 16           | —             | Host, then Server settings | Yes     |
| `CUTTLELY_ETL_SCHEDULE_MS`                   | 15000                                       | 1 to 3600         | ms-as-seconds | Host, then Server settings | Yes     |
| `CUTTLELY_HERMES_MAX_RESTARTS`               | 5                                           | 0 to 100          | —             | Host, then Server settings | Yes     |
| `CUTTLELY_HERMES_HEALTH_GRACE`               | 60                                          | 0 to 3600         | seconds       | Host, then Server settings | Yes     |
| `CUTTLELY_HERMES_HEALTH_FAILS`               | 3                                           | 1 to 100          | —             | Host, then Server settings | Yes     |
| `CUTTLELY_HERMES_HEALTH_WINDOW`              | 15                                          | 0 to 3600         | seconds       | Host, then Server settings | Yes     |
| `CUTTLELY_HERMES_START_WAIT_MS`              | 60000                                       | 0 to 600          | ms-as-seconds | Host, then Server settings | Yes     |
| `CUSTOM_MCP_TOOLS_MAX_BYTES`                 | 524288                                      | 1024 to 104857600 | bytes         | Host, then Server settings | Yes     |
| `CUSTOM_MCP_AUTHORIZE_TIMEOUT_MS`            | 15000                                       | 1 to 600          | ms-as-seconds | Host, then Server settings | Yes     |
| `CUSTOM_MCP_TOOL_NAME_MAX_LENGTH`            | 128                                         | 8 to 1024         | —             | Host, then Server settings | Yes     |
| `CUSTOM_MCP_TOOL_DESCRIPTION_MAX_LENGTH`     | 1024                                        | 64 to 65536       | —             | Host, then Server settings | Yes     |
| `CUTTLELY_EAGER_NODES`                       | false                                       | —                 | —             | Host, then Server settings | Yes     |
| `PORT`                                       | not shown                                   | —                 | —             | Host only                  | Yes     |
| `HOST`                                       | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUTTLELY_DATA_DIR`                          | not shown                                   | —                 | —             | Host only                  | Yes     |
| `MODE`                                       | not shown                                   | —                 | —             | Host only                  | Yes     |
| `LOG_PATH`                                   | not shown                                   | —                 | —             | Host only                  | Yes     |
| `BLOB_STORAGE_PATH`                          | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SECRETKEY_PATH`                             | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SECRETKEY_STORAGE_TYPE`                     | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SECRETKEY_AWS_ACCESS_KEY`                   | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SECRETKEY_AWS_SECRET_KEY`                   | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SECRETKEY_AWS_REGION`                       | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SECRETKEY_AWS_NAME`                         | not shown                                   | —                 | —             | Host only                  | Yes     |
| `FLOWISE_SECRETKEY_OVERWRITE`                | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUTTLELY_SECRETKEY_OVERWRITE`               | not shown                                   | —                 | —             | Host only                  | Yes     |
| `JWT_AUTH_TOKEN_SECRET`                      | not shown                                   | —                 | —             | Host only                  | Yes     |
| `JWT_REFRESH_TOKEN_SECRET`                   | not shown                                   | —                 | —             | Host only                  | Yes     |
| `JWT_ISSUER`                                 | not shown                                   | —                 | —             | Host only                  | Yes     |
| `JWT_AUDIENCE`                               | not shown                                   | —                 | —             | Host only                  | Yes     |
| `EXPRESS_SESSION_SECRET`                     | not shown                                   | —                 | —             | Host only                  | Yes     |
| `TOKEN_HASH_SECRET`                          | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_URL`                                  | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_HOST`                                 | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_PORT`                                 | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_USERNAME`                             | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_PASSWORD`                             | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_TLS`                                  | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_CERT`                                 | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_KEY`                                  | not shown                                   | —                 | —             | Host only                  | Yes     |
| `REDIS_CA`                                   | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUSTOM_MCP_PROTOCOL`                        | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUSTOM_MCP_ALLOWED_COMMANDS`                | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUSTOM_MCP_ALLOWED_ENV_VARS`                | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS`   | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUSTOM_MCP_SECURITY_CHECK`                  | not shown                                   | —                 | —             | Host only                  | Yes     |
| `TOOL_FUNCTION_BUILTIN_DEP`                  | not shown                                   | —                 | —             | Host only                  | Yes     |
| `TOOL_FUNCTION_EXTERNAL_DEP`                 | not shown                                   | —                 | —             | Host only                  | Yes     |
| `ALLOW_BUILTIN_DEP`                          | not shown                                   | —                 | —             | Host only                  | Yes     |
| `HTTP_SECURITY_CHECK`                        | not shown                                   | —                 | —             | Host only                  | Yes     |
| `PATH_TRAVERSAL_SAFETY`                      | not shown                                   | —                 | —             | Host only                  | Yes     |
| `OAUTH2_SECURITY_CHECK`                      | not shown                                   | —                 | —             | Host only                  | Yes     |
| `CUTTLELY_ETL_ROOTS`                         | not shown                                   | —                 | —             | Host only                  | Yes     |
| `PUPPETEER_EXECUTABLE_PATH`                  | not shown                                   | —                 | —             | Host only                  | Yes     |
| `PUPPETEER_EXECUTABLE_FILE_PATH`             | not shown                                   | —                 | —             | Host only                  | Yes     |
| `PLAYWRIGHT_EXECUTABLE_PATH`                 | not shown                                   | —                 | —             | Host only                  | Yes     |
| `PLAYWRIGHT_EXECUTABLE_FILE_PATH`            | not shown                                   | —                 | —             | Host only                  | Yes     |
| `SANDBOX_TIMEOUT`                            | not shown                                   | —                 | —             | Host only                  | Yes     |
| `LANGSMITH_API_KEY`                          | not shown                                   | —                 | —             | Host only                  | Yes     |
| `LANGSMITH_TRACING`                          | not shown                                   | —                 | —             | Host only                  | Yes     |
| `LANGSMITH_TRACING_V2`                       | not shown                                   | —                 | —             | Host only                  | Yes     |
