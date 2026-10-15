// Server settings registry: every setting the Server settings page knows, in one list.
// Each entry is an environment variable the server, the start script or the agent runtime reads.
// A setting marked runtime is read on each use. The others are read at start.
// A valid host value (Docker .env and compose, Render, the shell, packages/server/.env) wins.
// A runtime limit with a bad host value uses the saved value, then the default.
// Variables that must never be changed from a browser are on KEPT_OUT, with the reason.
// READ_ONLY_SETTINGS is the exact env-only list whose status the API may report.
// docs/how-to/server-settings.md is the guide.

export type SettingType = 'switch' | 'select' | 'text' | 'secret' | 'number' | 'list'
export type SettingRisk = 'low' | 'medium' | 'high'
export type SectionId = 'signin' | 'database' | 'runtime' | 'analyst' | 'models' | 'storage' | 'security' | 'integrations' | 'advanced'

export interface SettingOption {
    value: string
    label: string
}

export interface SettingCondition {
    key: string
    /** The setting shows when the other setting's effective value is one of these. '' means not set. */
    equals: string[]
}

export interface SettingDef {
    key: string
    section: SectionId
    /** A heading inside the section, for related fields (for example 'S3'). */
    group?: string
    label: string
    /** One plain-language line under the field. */
    help: string
    type: SettingType
    /** What the server does when the variable is not set, in words. */
    defaultLabel: string
    /** The raw value the server behaves as if it had when the variable is not set. Undefined: nothing. */
    defaultValue?: string
    /** Switch values. on/off are the raw strings written when the switch is flipped. */
    on?: string
    off?: string
    options?: SettingOption[]
    /** A select that also accepts a typed value (for example a file path or URL). */
    custom?: { label: string; placeholder: string }
    /** Number fields: the unit shown, and how the raw value maps to it. */
    unit?: 'seconds' | 'minutes' | 'tokens' | 'bytes' | 'ms-as-seconds' | 'ms' | 'count'
    min?: number
    max?: number
    /** Read on each use: host, then the settings file, then the default. No restart. */
    runtime?: boolean
    placeholder?: string
    risk: SettingRisk
    showWhen?: SettingCondition
    /** Who usually sets this outside Cuttlely, in words, for the Locked hint. */
    hostHint?: string
}

export interface SectionDef {
    id: SectionId
    label: string
    summary: string
    /** What changes for people after a restart, in one or two lines. */
    afterRestart: string
}

export const SECTIONS: SectionDef[] = [
    {
        id: 'signin',
        label: 'Sign-in & identity',
        summary: 'How people sign in: the owner password, local user passwords, or WorkOS AuthKit for a team.',
        afterRestart:
            'The sign-in page shows the methods turned on here. People who are signed in stay signed in unless the session seal changes.'
    },
    {
        id: 'database',
        label: 'Database',
        summary: 'Where Cuttlely keeps flows, credentials, people and chat history.',
        afterRestart: 'Cuttlely opens the database named here. Nothing is copied between databases.'
    },
    {
        id: 'runtime',
        label: 'Agent runtime',
        summary: 'How agent teams run: time limits, prompt sizes and where the work happens.',
        afterRestart: 'New agent team turns use these limits.'
    },
    {
        id: 'analyst',
        label: 'Analyst',
        summary: 'Lets agent teams query data and answer with real numbers and charts.',
        afterRestart: 'Agent teams with a data analyst use the storage and the limits chosen here.'
    },
    {
        id: 'models',
        label: 'Models & keys',
        summary: 'Which models Cuttlely lists, and where the list comes from.',
        afterRestart: 'Model dropdowns use the list source chosen here.'
    },
    {
        id: 'storage',
        label: 'Storage',
        summary: 'Where uploads and generated files are kept.',
        afterRestart: 'New files go to the storage chosen here. Files already stored stay where they are.'
    },
    {
        id: 'security',
        label: 'Security & network',
        summary: 'Which sites may call or frame Cuttlely, proxies, and which building blocks are allowed.',
        afterRestart:
            'Browsers and building blocks follow these rules. Sign-in limits, session lifetimes and the shutdown wait apply without a restart.'
    },
    {
        id: 'integrations',
        label: 'Integrations',
        summary: 'Version history, drafts, tracing, metrics and other services Cuttlely can use.',
        afterRestart: 'Cuttlely connects only to the services turned on here.'
    },
    {
        id: 'advanced',
        label: 'Advanced',
        summary: 'Logging, schedules, ETL and agent runtime health checks.',
        afterRestart: 'Cuttlely uses these values from the next start.'
    }
]

const TRUE_FALSE = { on: 'true', off: 'false' }
const RENDER_DASHBOARD = 'Render (Environment page)'

export const SETTINGS: SettingDef[] = [
    // Sign-in & identity
    {
        key: 'CUTTLELY_LOCAL_ADMIN',
        section: 'signin',
        group: 'Owner password',
        label: 'Owner password sign-in',
        help: 'The email and password form for the owner. Keep it on as a way back in until AuthKit works.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'On from source and in Docker, off on Render',
        risk: 'high'
    },
    {
        key: 'CUTTLELY_LOCAL_USERS',
        section: 'signin',
        group: 'Local passwords',
        label: 'Local user passwords',
        help: 'Email and password for every active user who already has a password, when AuthKit is not configured. AuthKit leaves this off, except the owner password. Off unless set to true. A restart applies it.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'high'
    },
    {
        key: 'WORKOS_API_KEY',
        section: 'signin',
        group: 'WorkOS AuthKit',
        label: 'AuthKit API key',
        help: 'The secret key of your WorkOS environment, from API Keys in the WorkOS dashboard.',
        type: 'secret',
        defaultLabel: 'Not set: AuthKit is off',
        placeholder: 'sk_test_... or sk_live_...',
        risk: 'high',
        hostHint: RENDER_DASHBOARD
    },
    {
        key: 'WORKOS_CLIENT_ID',
        section: 'signin',
        group: 'WorkOS AuthKit',
        label: 'AuthKit client ID',
        help: 'The client ID of the same environment, from the application Details tab.',
        type: 'text',
        defaultLabel: 'Not set: AuthKit is off',
        placeholder: 'client_...',
        risk: 'high',
        hostHint: RENDER_DASHBOARD
    },
    {
        key: 'WORKOS_REDIRECT_URI',
        section: 'signin',
        group: 'WorkOS AuthKit',
        label: 'Callback address',
        help: 'Where AuthKit sends people back. It must match a Redirect URI in WorkOS exactly.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'https://your-server/api/v1/auth/callback',
        risk: 'high',
        hostHint: RENDER_DASHBOARD
    },
    {
        key: 'WORKOS_COOKIE_PASSWORD',
        section: 'signin',
        group: 'WorkOS AuthKit',
        label: 'Session seal',
        help: 'Seals the sign-in cookie. At least 32 characters. Changing it signs everyone out.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'high',
        hostHint: RENDER_DASHBOARD
    },
    {
        key: 'CUTTLELY_BOOTSTRAP_EMAIL',
        section: 'signin',
        group: 'WorkOS AuthKit',
        label: 'First owner email',
        help: 'On an empty database, the one verified email allowed to become the owner through AuthKit.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'you@example.com',
        risk: 'medium',
        hostHint: RENDER_DASHBOARD
    },

    // Database
    {
        key: 'DATABASE_TYPE',
        section: 'database',
        label: 'Database type',
        help: 'SQLite is a file on this server. Postgres is a separate database server.',
        type: 'select',
        options: [
            { value: 'sqlite', label: 'SQLite' },
            { value: 'postgres', label: 'Postgres' }
        ],
        defaultLabel: 'SQLite',
        defaultValue: 'sqlite',
        risk: 'high',
        hostHint: 'Render (render.yaml)'
    },
    {
        key: 'DATABASE_HOST',
        section: 'database',
        label: 'Host',
        help: 'The address of the Postgres server.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'db.example.com',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_PORT',
        section: 'database',
        label: 'Port',
        help: 'The Postgres port.',
        type: 'number',
        min: 1,
        max: 65535,
        defaultLabel: '5432',
        defaultValue: '5432',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_NAME',
        section: 'database',
        label: 'Database name',
        help: 'The database Cuttlely uses on that server.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'cuttlely',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_USER',
        section: 'database',
        label: 'User',
        help: 'The login Cuttlely uses. It needs to create and change tables.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_PASSWORD',
        section: 'database',
        label: 'Password',
        help: 'The password for that login.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_SSL',
        section: 'database',
        label: 'Use TLS',
        help: 'Encrypt the connection. Most hosted databases need it.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_REJECT_UNAUTHORIZED',
        section: 'database',
        label: 'Check the server certificate',
        help: 'With TLS on, only talk to a server whose certificate checks out. Recommended.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'DATABASE_SSL_KEY_BASE64',
        section: 'database',
        label: 'Server certificate',
        help: 'A self-signed certificate for the database server, in base64. Leave empty otherwise.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },

    // Agent runtime
    {
        key: 'CUTTLELY_HARNESS_TURN_BUDGET_MS',
        section: 'runtime',
        group: 'Limits',
        label: 'Turn time limit',
        help: 'How long one agent team turn may run before unfinished specialists stop.',
        type: 'number',
        unit: 'ms-as-seconds',
        min: 0,
        max: 3600,
        defaultLabel: '45 seconds',
        defaultValue: '45000',
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_HARNESS_MODEL_FALLBACK_MS',
        section: 'runtime',
        group: 'Limits',
        label: 'Switch to the fallback model after',
        help: 'How long a chat model may take before a connected fallback model answers instead. 0 turns this off.',
        type: 'number',
        unit: 'ms-as-seconds',
        min: 0,
        max: 600,
        defaultLabel: '8 seconds',
        defaultValue: '8000',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HARNESS_SPECIALIST_CONTEXT_TOKENS',
        section: 'runtime',
        group: 'Limits',
        label: 'Specialist prompt cap',
        help: 'The most a specialist prompt may hold: instructions, memory and the task. 0 turns the cap off.',
        type: 'number',
        unit: 'tokens',
        min: 0,
        max: 1000000,
        defaultLabel: '4000 tokens',
        defaultValue: '4000',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS',
        section: 'runtime',
        group: 'Limits',
        label: 'Harness Prime handoff cap',
        help: 'The most Harness Prime reads back from its specialists. 0 turns the cap off.',
        type: 'number',
        unit: 'tokens',
        min: 0,
        max: 1000000,
        defaultLabel: '6000 tokens',
        defaultValue: '6000',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HARNESS_QUEUE',
        section: 'runtime',
        group: 'Where runs happen',
        label: 'Where agent team runs execute',
        help: 'In the server is simplest. Separate workers keep long runs off the web process.',
        type: 'select',
        options: [
            { value: 'inline', label: 'In the server' },
            { value: 'external', label: 'Separate workers' }
        ],
        defaultLabel: 'In the server',
        defaultValue: 'inline',
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_HARNESS_WORKERS',
        section: 'runtime',
        group: 'Where runs happen',
        label: 'Separate workers',
        help: 'How many worker processes start with Cuttlely.',
        type: 'number',
        min: 1,
        max: 16,
        defaultLabel: '1',
        defaultValue: '1',
        risk: 'medium',
        showWhen: { key: 'CUTTLELY_HARNESS_QUEUE', equals: ['external'] }
    },
    {
        key: 'CUTTLELY_HARNESS_WORKER_CONCURRENCY',
        section: 'runtime',
        group: 'Where runs happen',
        label: 'Runs at once in the server',
        help: 'How many agent team turns the server runs at the same time.',
        type: 'number',
        min: 1,
        max: 64,
        defaultLabel: '4',
        defaultValue: '4',
        risk: 'medium',
        showWhen: { key: 'CUTTLELY_HARNESS_QUEUE', equals: ['', 'inline'] }
    },
    {
        key: 'CUTTLELY_WARM_HERMES',
        section: 'runtime',
        group: 'Warm-up',
        label: 'Warm up the agent runtime at start',
        help: 'Makes the first answer faster. Each warm-up is one short model call per specialist.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'On',
        defaultValue: 'true',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HERMES_KEEP_WARM_MINUTES',
        section: 'runtime',
        group: 'Warm-up',
        label: 'Keep warm every',
        help: 'Repeat the warm-up on a timer. Each one costs a few tokens. Empty turns it off.',
        type: 'number',
        unit: 'minutes',
        min: 1,
        max: 1440,
        defaultLabel: 'Off',
        risk: 'low'
    },

    // Analyst
    {
        key: 'CUTTLELY_ANALYST',
        section: 'analyst',
        label: 'Analyst storage',
        help: 'Auto gives each workspace its own private store the analyst can create tables in.',
        type: 'select',
        options: [
            { value: '', label: 'Off' },
            { value: 'auto', label: 'Auto' }
        ],
        defaultLabel: 'Off',
        defaultValue: '',
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_POSTGRES_URL',
        section: 'analyst',
        label: 'Separate Postgres for the analyst',
        help: 'A different database the analyst may read, never this server\u2019s own. Leave empty to use the private store.',
        type: 'secret',
        defaultLabel: 'Not set',
        placeholder: 'postgres://user:password@host:5432/database',
        risk: 'high'
    },
    {
        key: 'CUTTLELY_ANALYST_ROW_CAP',
        section: 'analyst',
        group: 'Limits',
        label: 'Row cap',
        help: 'The most rows one analyst query returns. A lower cap puts less of the table into the prompt. A node can ask for fewer rows, never more. The server never uses more than 1000.',
        type: 'number',
        min: 1,
        max: 1000,
        defaultLabel: '100 rows',
        defaultValue: '100',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS',
        section: 'analyst',
        group: 'Limits',
        label: 'Query timeout',
        help: 'How long one analyst statement may run before it stops. A node can ask for less time, never more. The server never uses more than 120 seconds.',
        type: 'number',
        unit: 'ms-as-seconds',
        min: 1,
        max: 120,
        defaultLabel: '15 seconds',
        defaultValue: '15000',
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_ANALYST_TRACE_PREVIEW',
        section: 'analyst',
        group: 'Run trace',
        label: 'Query previews in the run trace',
        help: 'Saves a short table with each analyst query step. The preview holds rows that query already returned to that chat. Turn this off to leave those values out of saved runs. The row count can still show.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'On',
        defaultValue: 'true',
        risk: 'medium'
    },

    // Models & keys
    {
        key: 'MODEL_LIST_CONFIG_JSON',
        section: 'models',
        label: 'Model list source',
        help: 'Daily fetches the list the Cuttlely maintainers keep, and uses the copy in this build if that fails.',
        type: 'select',
        options: [
            { value: '', label: 'Daily from Cuttlely' },
            { value: 'bundled', label: 'This build only' }
        ],
        custom: { label: 'My own file or URL', placeholder: '/path/to/models.json or https://...' },
        defaultLabel: 'Daily from Cuttlely',
        defaultValue: '',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_MODELS_DEV',
        section: 'models',
        label: 'Model registry lookups',
        help: 'Lets the agent runtime look up model abilities on models.dev. Off means no request leaves the server.',
        type: 'switch',
        on: '1',
        off: '0',
        defaultLabel: 'Off',
        defaultValue: '0',
        risk: 'low'
    },

    // Storage
    {
        key: 'STORAGE_TYPE',
        section: 'storage',
        label: 'File storage',
        help: 'Where uploads and generated files go. Files already stored are not moved.',
        type: 'select',
        options: [
            { value: 'local', label: 'This server' },
            { value: 's3', label: 'S3 or compatible' },
            { value: 'gcs', label: 'Google Cloud Storage' },
            { value: 'azure', label: 'Azure Blob Storage' }
        ],
        defaultLabel: 'This server',
        defaultValue: 'local',
        risk: 'high',
        hostHint: 'Docker compose or Render'
    },
    {
        key: 'S3_STORAGE_BUCKET_NAME',
        section: 'storage',
        group: 'S3',
        label: 'Bucket',
        help: 'The bucket name.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['s3'] }
    },
    {
        key: 'S3_STORAGE_REGION',
        section: 'storage',
        group: 'S3',
        label: 'Region',
        help: 'The bucket region, for example us-west-2.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['s3'] }
    },
    {
        key: 'S3_STORAGE_ACCESS_KEY_ID',
        section: 'storage',
        group: 'S3',
        label: 'Access key ID',
        help: 'Leave empty to use the server\u2019s own cloud role.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'STORAGE_TYPE', equals: ['s3'] }
    },
    {
        key: 'S3_STORAGE_SECRET_ACCESS_KEY',
        section: 'storage',
        group: 'S3',
        label: 'Secret access key',
        help: 'The secret that goes with the access key ID.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'STORAGE_TYPE', equals: ['s3'] }
    },
    {
        key: 'S3_ENDPOINT_URL',
        section: 'storage',
        group: 'S3',
        label: 'Endpoint',
        help: 'Only for S3-compatible services such as MinIO or R2.',
        type: 'text',
        defaultLabel: 'AWS',
        placeholder: 'https://...',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['s3'] }
    },
    {
        key: 'S3_FORCE_PATH_STYLE',
        section: 'storage',
        group: 'S3',
        label: 'Path-style addresses',
        help: 'Some S3-compatible services need it.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'low',
        showWhen: { key: 'STORAGE_TYPE', equals: ['s3'] }
    },
    {
        key: 'GOOGLE_CLOUD_STORAGE_BUCKET_NAME',
        section: 'storage',
        group: 'Google Cloud',
        label: 'Bucket',
        help: 'The bucket name.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['gcs'] }
    },
    {
        key: 'GOOGLE_CLOUD_STORAGE_PROJ_ID',
        section: 'storage',
        group: 'Google Cloud',
        label: 'Project ID',
        help: 'The Google Cloud project that owns the bucket.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['gcs'] }
    },
    {
        key: 'GOOGLE_CLOUD_STORAGE_CREDENTIAL',
        section: 'storage',
        group: 'Google Cloud',
        label: 'Key file path',
        help: 'The path of a service account key file on this server. Leave empty to use the server\u2019s own identity.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['gcs'] }
    },
    {
        key: 'GOOGLE_CLOUD_UNIFORM_BUCKET_ACCESS',
        section: 'storage',
        group: 'Google Cloud',
        label: 'Uniform bucket access',
        help: 'Match the bucket\u2019s access setting in Google Cloud.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'On',
        defaultValue: 'true',
        risk: 'low',
        showWhen: { key: 'STORAGE_TYPE', equals: ['gcs'] }
    },
    {
        key: 'AZURE_BLOB_STORAGE_CONTAINER_NAME',
        section: 'storage',
        group: 'Azure',
        label: 'Container',
        help: 'The blob container name.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['azure'] }
    },
    {
        key: 'AZURE_BLOB_STORAGE_ACCOUNT_NAME',
        section: 'storage',
        group: 'Azure',
        label: 'Account name',
        help: 'The storage account. Use it with the account key, or use a connection string instead.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'STORAGE_TYPE', equals: ['azure'] }
    },
    {
        key: 'AZURE_BLOB_STORAGE_ACCOUNT_KEY',
        section: 'storage',
        group: 'Azure',
        label: 'Account key',
        help: 'The key for that storage account.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'STORAGE_TYPE', equals: ['azure'] }
    },
    {
        key: 'AZURE_BLOB_STORAGE_CONNECTION_STRING',
        section: 'storage',
        group: 'Azure',
        label: 'Connection string',
        help: 'Instead of an account name and key.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'high',
        showWhen: { key: 'STORAGE_TYPE', equals: ['azure'] }
    },
    {
        key: 'FLOWISE_FILE_SIZE_LIMIT',
        section: 'storage',
        group: 'Uploads',
        label: 'Largest upload',
        help: 'The biggest request Cuttlely accepts, for example 50mb. CUTTLELY_FILE_SIZE_LIMIT is the same limit and is used when both are set.',
        type: 'text',
        defaultLabel: '50mb',
        defaultValue: '50mb',
        placeholder: '50mb',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_FILE_SIZE_LIMIT',
        section: 'storage',
        group: 'Uploads',
        label: 'Largest upload (compatibility alias)',
        help: 'Same limit as the existing upload size variable. When both are set, this name is the one Cuttlely uses.',
        type: 'text',
        defaultLabel: '50mb',
        defaultValue: '50mb',
        placeholder: '50mb',
        risk: 'low'
    },

    // Security & network
    {
        key: 'CUTTLELY_LOGIN_FAILURE_LIMIT',
        section: 'security',
        group: 'Sign-in limits',
        label: 'Failed sign-ins before lockout',
        help: 'How many failed sign-ins from one client address or one email are allowed in 15 minutes. Applies on the next sign-in. If this locks people out, set this variable on the host and start Cuttlely again: the host value overrides the saved one.',
        type: 'number',
        unit: 'count',
        min: 3,
        max: 50,
        defaultLabel: '10 failures',
        defaultValue: '10',
        runtime: true,
        risk: 'high'
    },
    {
        key: 'CUTTLELY_SESSION_IDLE_MINUTES',
        section: 'security',
        group: 'Sessions',
        label: 'Idle session lifetime',
        help: 'Minutes a local session can sit unused before it ends. A shorter value ends sessions that are already signed in, on the next request. Idle time cannot be longer than the absolute lifetime. If this locks people out, set this variable on the host and start Cuttlely again.',
        type: 'number',
        unit: 'minutes',
        min: 15,
        max: 1440,
        defaultLabel: '12 hours',
        defaultValue: '720',
        runtime: true,
        risk: 'high'
    },
    {
        key: 'CUTTLELY_SESSION_ABSOLUTE_HOURS',
        section: 'security',
        group: 'Sessions',
        label: 'Absolute session lifetime',
        help: 'Hours a local session can last, even if it stays in use. A shorter value ends sessions that are already older than the new lifetime, on the next request. If this locks people out, set this variable on the host and start Cuttlely again.',
        type: 'number',
        unit: 'count',
        min: 1,
        max: 720,
        defaultLabel: '7 days',
        defaultValue: '168',
        runtime: true,
        risk: 'high'
    },
    {
        key: 'CUTTLELY_DRAIN_TIMEOUT_MS',
        section: 'security',
        group: 'Shutdown',
        label: 'Shutdown wait',
        help: 'Milliseconds a shutdown waits for answers that are already running. The next shutdown uses the saved value. A queue worker picks it up within 5 seconds. If a shutdown cuts answers off too soon, set this variable on the host and start Cuttlely again.',
        type: 'number',
        unit: 'ms',
        min: 5000,
        max: 300000,
        defaultLabel: '25 seconds',
        defaultValue: '25000',
        runtime: true,
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_HISTORY_KEEP',
        section: 'security',
        group: 'History',
        label: 'Settings changes to keep',
        help: 'How many settings changes to keep. The newest stay, and older ones are removed on the next change. Applies on the next change. 100 to 10000.',
        type: 'number',
        unit: 'count',
        min: 100,
        max: 10000,
        defaultLabel: '1000',
        defaultValue: '1000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_UI_PAGE_LIMIT_MAX',
        section: 'security',
        group: 'Pages',
        label: 'Page loads a minute',
        help: 'How many UI page loads one client may make in a minute. Hashed files are not counted. Applies on the next load. 100 to 50000.',
        type: 'number',
        unit: 'count',
        min: 100,
        max: 50000,
        defaultLabel: '3000',
        defaultValue: '3000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CORS_ORIGINS',
        section: 'security',
        group: 'Browsers',
        label: 'Sites that may call the API from a browser',
        help: 'Comma-separated addresses. Empty means only this server. * means any site.',
        type: 'list',
        defaultLabel: 'This server only',
        placeholder: 'https://app.example.com',
        risk: 'medium'
    },
    {
        key: 'CORS_ALLOW_CREDENTIALS',
        section: 'security',
        group: 'Browsers',
        label: 'Send cookies with those calls',
        help: 'Only when your web app signs people in to Cuttlely itself.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'medium'
    },
    {
        key: 'IFRAME_ORIGINS',
        section: 'security',
        group: 'Browsers',
        label: 'Sites that may frame Cuttlely',
        help: 'Comma-separated addresses allowed to show Cuttlely pages inside a frame.',
        type: 'list',
        defaultLabel: 'This server only',
        placeholder: 'https://intranet.example.com',
        risk: 'medium'
    },
    {
        key: 'MCP_CORS_ORIGINS',
        section: 'security',
        group: 'Browsers',
        label: 'Sites that may call the MCP endpoint',
        help: 'Comma-separated addresses for browser clients of the MCP endpoint.',
        type: 'list',
        defaultLabel: 'Built-in rule',
        risk: 'medium'
    },
    {
        key: 'TRUST_PROXY',
        section: 'security',
        group: 'Network',
        label: 'Proxies in front of Cuttlely',
        help: 'The number of proxy hops, for example 1 behind one load balancer. Empty trusts none.',
        type: 'text',
        defaultLabel: 'None',
        placeholder: '1',
        risk: 'high',
        hostHint: 'Render (render.yaml)'
    },
    {
        key: 'APP_URL',
        section: 'security',
        group: 'Network',
        label: 'Public address',
        help: 'The address people use to open Cuttlely, for links in schedules and sign-in.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'https://cuttlely.example.com',
        risk: 'low'
    },
    {
        key: 'GLOBAL_AGENT_HTTP_PROXY',
        section: 'security',
        group: 'Network',
        label: 'Outbound proxy (http)',
        help: 'Send outgoing http requests through this proxy.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'http://proxy.example.com:3128',
        risk: 'medium'
    },
    {
        key: 'GLOBAL_AGENT_HTTPS_PROXY',
        section: 'security',
        group: 'Network',
        label: 'Outbound proxy (https)',
        help: 'Send outgoing https requests through this proxy.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'http://proxy.example.com:3128',
        risk: 'medium'
    },
    {
        key: 'GLOBAL_AGENT_NO_PROXY',
        section: 'security',
        group: 'Network',
        label: 'Skip the proxy for',
        help: 'Comma-separated hosts that connect directly.',
        type: 'list',
        defaultLabel: 'Not set',
        placeholder: 'localhost,127.0.0.1',
        risk: 'medium'
    },
    {
        key: 'HTTP_DENY_LIST',
        section: 'security',
        group: 'Building blocks',
        label: 'Blocked addresses for HTTP building blocks',
        help: 'Comma-separated hosts or ranges that HTTP building blocks may never call.',
        type: 'list',
        defaultLabel: 'Not set',
        risk: 'medium'
    },
    {
        key: 'OAUTH2_ALLOWED_TOKEN_DOMAINS',
        section: 'security',
        group: 'Building blocks',
        label: 'Extra OAuth2 token hosts',
        help: 'Comma-separated sign-in providers, besides the built-in ones, that credentials may get tokens from.',
        type: 'list',
        defaultLabel: 'Not set',
        placeholder: 'auth.example.com',
        risk: 'medium'
    },
    {
        key: 'DISABLED_NODES',
        section: 'security',
        group: 'Building blocks',
        label: 'Turned-off building blocks',
        help: 'Comma-separated building block names that nobody can add to a canvas.',
        type: 'list',
        defaultLabel: 'None',
        placeholder: 'bufferMemory,chatOpenAI',
        risk: 'low'
    },
    {
        key: 'SHOW_COMMUNITY_NODES',
        section: 'security',
        group: 'Building blocks',
        label: 'Show community building blocks',
        help: 'Building blocks contributed by the community. They are not reviewed like the others.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'medium'
    },

    // Integrations
    {
        key: 'CUTTLELY_VERSIONS',
        section: 'integrations',
        group: 'Versions',
        label: 'Version history',
        help: 'Keeps every saved version of each flow so you can compare and restore.',
        type: 'switch',
        on: 'on',
        off: 'off',
        defaultLabel: 'On',
        defaultValue: 'on',
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_DRAFTS',
        section: 'integrations',
        group: 'Versions',
        label: 'Drafts before Publish',
        help: 'Canvas changes save to a draft until someone selects Publish.',
        type: 'switch',
        on: 'on',
        off: 'off',
        defaultLabel: 'On',
        defaultValue: 'on',
        risk: 'medium'
    },
    {
        key: 'CUTTLELY_CHECK_MAX_TOKENS',
        section: 'integrations',
        group: 'Publish check',
        label: 'Publish check token cap',
        help: 'The most tokens one publish check may use, Live and the draft together. Applies on the next check. 1000 to 2000000.',
        type: 'number',
        unit: 'tokens',
        min: 1000,
        max: 2000000,
        defaultLabel: '100000 tokens',
        defaultValue: '100000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_MAX_SECONDS',
        section: 'integrations',
        group: 'Publish check',
        label: 'Publish check time limit',
        help: 'The most seconds one publish check may run. Applies on the next check. 10 to 1800.',
        type: 'number',
        unit: 'seconds',
        min: 10,
        max: 1800,
        defaultLabel: '180 seconds',
        defaultValue: '180',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_CONCURRENCY',
        section: 'integrations',
        group: 'Publish check',
        label: 'Questions at once',
        help: 'How many questions one publish check runs at the same time. Live and the draft for one question still run one after the other. 1 to 8.',
        type: 'number',
        unit: 'count',
        min: 1,
        max: 8,
        defaultLabel: '2',
        defaultValue: '2',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_RUN_TIMEOUT_MS',
        section: 'integrations',
        group: 'Publish check',
        label: 'One run timeout',
        help: 'How long one question run in a publish check may take before it stops, in milliseconds. 10000 to 600000.',
        type: 'number',
        unit: 'ms',
        min: 10000,
        max: 600000,
        defaultLabel: '60000 ms',
        defaultValue: '60000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_KEEP_MINUTES',
        section: 'integrations',
        group: 'Publish check',
        label: 'Keep a finished check',
        help: 'How long a finished publish check stays available to read, in minutes. 5 to 1440.',
        type: 'number',
        unit: 'minutes',
        min: 5,
        max: 1440,
        defaultLabel: '30 minutes',
        defaultValue: '30',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_COUNT_MAX',
        section: 'integrations',
        group: 'Publish check',
        label: 'Question cap',
        help: 'The most past questions one publish check may ask. 1 to 500. The default count cannot be above this.',
        type: 'number',
        unit: 'count',
        min: 1,
        max: 500,
        defaultLabel: '100',
        defaultValue: '100',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_COUNT_DEFAULT',
        section: 'integrations',
        group: 'Publish check',
        label: 'Questions by default',
        help: 'How many past questions a check asks when the caller does not choose. 1 to the question cap.',
        type: 'number',
        unit: 'count',
        min: 1,
        max: 500,
        defaultLabel: '4',
        defaultValue: '4',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_CHECK_SCAN_CAP',
        section: 'integrations',
        group: 'Publish check',
        label: 'Messages scanned',
        help: 'How many stored messages a publish check reads while it looks for distinct questions. 500 to 20000.',
        type: 'number',
        unit: 'count',
        min: 500,
        max: 20000,
        defaultLabel: '2000',
        defaultValue: '2000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HARNESS_TURN_SCAN_CAP',
        section: 'integrations',
        group: 'Publish check',
        label: 'Harness turns scanned',
        help: 'How many saved harness turns a publish check reads while it looks for distinct questions. 500 to 5000.',
        type: 'number',
        unit: 'count',
        min: 500,
        max: 5000,
        defaultLabel: '2000',
        defaultValue: '2000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_RATING_IMPORT_CAP',
        section: 'integrations',
        group: 'Test sets',
        label: 'Rated answers added',
        help: 'The most rated answers one add to a test set may write. 50 to 5000. The rating scan must be at least this.',
        type: 'number',
        unit: 'count',
        min: 50,
        max: 5000,
        defaultLabel: '500',
        defaultValue: '500',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'CUTTLELY_RATING_SCAN_CAP',
        section: 'integrations',
        group: 'Test sets',
        label: 'Ratings scanned',
        help: 'How many ratings one add may read while it fills the import cap. At least the import cap, and at most 20000.',
        type: 'number',
        unit: 'count',
        min: 50,
        max: 20000,
        defaultLabel: '1000',
        defaultValue: '1000',
        runtime: true,
        risk: 'low'
    },
    {
        key: 'POSTHOG_PUBLIC_API_KEY',
        section: 'integrations',
        group: 'Usage events',
        label: 'Your PostHog project key',
        help: 'Sends usage events (flow created, prediction sent, node types, version) to your own PostHog. Empty sends nothing.',
        type: 'secret',
        defaultLabel: 'Off',
        risk: 'medium'
    },
    {
        key: 'DISABLE_CUTTLELY_TELEMETRY',
        section: 'integrations',
        group: 'Usage events',
        label: 'Turn off usage events',
        help: 'Set to true to send nothing, even when a PostHog project key is set. The existing disable variable is still supported. When both are set, this name is used.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'low'
    },
    {
        key: 'LANGCHAIN_TRACING_V2',
        section: 'integrations',
        group: 'LangSmith tracing',
        label: 'Trace runs in LangSmith',
        help: 'Sends prompts and answers to your LangSmith project.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'medium'
    },
    {
        key: 'LANGCHAIN_API_KEY',
        section: 'integrations',
        group: 'LangSmith tracing',
        label: 'LangSmith API key',
        help: 'The key of your LangSmith account.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'medium',
        showWhen: { key: 'LANGCHAIN_TRACING_V2', equals: ['true'] }
    },
    {
        key: 'LANGCHAIN_PROJECT',
        section: 'integrations',
        group: 'LangSmith tracing',
        label: 'LangSmith project',
        help: 'The project runs are recorded under.',
        type: 'text',
        defaultLabel: 'Not set',
        risk: 'low',
        showWhen: { key: 'LANGCHAIN_TRACING_V2', equals: ['true'] }
    },
    {
        key: 'LANGCHAIN_ENDPOINT',
        section: 'integrations',
        group: 'LangSmith tracing',
        label: 'LangSmith address',
        help: 'Only for a self-hosted LangSmith.',
        type: 'text',
        defaultLabel: 'LangSmith cloud',
        risk: 'low',
        showWhen: { key: 'LANGCHAIN_TRACING_V2', equals: ['true'] }
    },
    {
        key: 'LANGSMITH_PROJECT',
        section: 'integrations',
        group: 'LangSmith tracing',
        label: 'LangSmith project name',
        help: 'The project name sent with traces. A restart applies it. The API key stays on the host.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'customer-care',
        risk: 'low'
    },
    {
        key: 'LANGSMITH_ENDPOINT',
        section: 'integrations',
        group: 'LangSmith tracing',
        label: 'LangSmith endpoint',
        help: 'An http or https address for a self-hosted project. No user name or password in the address. A restart applies it.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'https://langsmith.example.com',
        risk: 'low'
    },
    {
        key: 'ENABLE_METRICS',
        section: 'integrations',
        group: 'Metrics',
        label: 'Metrics',
        help: 'Publishes server metrics for Prometheus or an OpenTelemetry collector.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'low'
    },
    {
        key: 'METRICS_PROVIDER',
        section: 'integrations',
        group: 'Metrics',
        label: 'Metrics format',
        help: 'Prometheus serves /api/v1/metrics. OpenTelemetry pushes to a collector.',
        type: 'select',
        options: [
            { value: 'prometheus', label: 'Prometheus' },
            { value: 'open_telemetry', label: 'OpenTelemetry' }
        ],
        defaultLabel: 'Prometheus',
        defaultValue: 'prometheus',
        risk: 'low',
        showWhen: { key: 'ENABLE_METRICS', equals: ['true'] }
    },
    {
        key: 'METRICS_OPEN_TELEMETRY_METRIC_ENDPOINT',
        section: 'integrations',
        group: 'Metrics',
        label: 'Collector address',
        help: 'Where OpenTelemetry metrics are sent.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'http://collector:4318/v1/metrics',
        risk: 'low',
        showWhen: { key: 'METRICS_PROVIDER', equals: ['open_telemetry'] }
    },
    {
        key: 'METRICS_SERVICE_NAME',
        section: 'integrations',
        group: 'Metrics',
        label: 'Service name',
        help: 'The name metrics are reported under.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'cuttlely',
        risk: 'low',
        showWhen: { key: 'ENABLE_METRICS', equals: ['true'] }
    },
    {
        key: 'METRICS_PREFIX',
        section: 'integrations',
        group: 'Metrics',
        label: 'Metrics prefix',
        help: 'Optional prefix for published metric names. Empty keeps the names this server already publishes.',
        type: 'text',
        defaultLabel: 'Existing names',
        placeholder: 'cuttlely_',
        risk: 'low',
        showWhen: { key: 'ENABLE_METRICS', equals: ['true'] }
    },
    {
        key: 'CUTTLELY_OTEL_TRACES',
        section: 'integrations',
        group: 'Traces',
        label: 'Run traces',
        help: 'Sends an OpenTelemetry trace for each chatflow prediction, each agentflow run, and each harness run. Off sends nothing.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_OTEL_TRACES_ENDPOINT',
        section: 'integrations',
        group: 'Traces',
        label: 'Trace collector address',
        help: 'Where run traces are sent. Use the collector traces path.',
        type: 'text',
        defaultLabel: 'Not set',
        placeholder: 'http://localhost:4318/v1/traces',
        risk: 'low',
        showWhen: { key: 'CUTTLELY_OTEL_TRACES', equals: ['true'] }
    },
    {
        key: 'CUTTLELY_OTEL_TRACES_PROTOCOL',
        section: 'integrations',
        group: 'Traces',
        label: 'Trace protocol',
        help: 'How traces are sent to the collector: HTTP, gRPC, or protobuf.',
        type: 'select',
        options: [
            { value: 'http', label: 'HTTP' },
            { value: 'grpc', label: 'gRPC' },
            { value: 'proto', label: 'Protobuf' }
        ],
        defaultLabel: 'HTTP',
        defaultValue: 'http',
        risk: 'low',
        showWhen: { key: 'CUTTLELY_OTEL_TRACES', equals: ['true'] }
    },
    {
        key: 'CUTTLELY_OTEL_TRACES_CONTENT',
        section: 'integrations',
        group: 'Traces',
        label: 'Include prompts and tool text',
        help: "Sensitive. Adds content.input and content.output, cut at 4,000 characters: the question and the answer, the model prompt and reply, tool arguments and results, analyst SQL when the tool detail still has it, and the analyst run-card preview. A specialist span's content.input is the run-card task, at most 200 characters. Leave this off unless you trust the collector with that text.",
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'high',
        showWhen: { key: 'CUTTLELY_OTEL_TRACES', equals: ['true'] }
    },
    {
        key: 'E2B_APIKEY',
        section: 'integrations',
        group: 'Code sandbox',
        label: 'E2B API key',
        help: 'For building blocks that run code in an E2B sandbox.',
        type: 'secret',
        defaultLabel: 'Not set',
        risk: 'medium'
    },

    // Advanced
    {
        key: 'LOG_LEVEL',
        section: 'advanced',
        group: 'Logging',
        label: 'Log detail',
        help: 'How much the server writes to its log.',
        type: 'select',
        options: [
            { value: 'error', label: 'Errors only' },
            { value: 'warn', label: 'Warnings' },
            { value: 'info', label: 'Normal' },
            { value: 'verbose', label: 'Verbose' },
            { value: 'debug', label: 'Debug' }
        ],
        defaultLabel: 'Normal',
        defaultValue: 'info',
        risk: 'low'
    },
    {
        key: 'DEBUG',
        section: 'advanced',
        group: 'Logging',
        label: 'Extra debug lines',
        help: 'Adds step-by-step lines from web loaders and other building blocks.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'low'
    },
    {
        key: 'LOG_SANITIZE_BODY_FIELDS',
        section: 'advanced',
        group: 'Logging',
        label: 'Request fields to hide in logs',
        help: 'Field names, separated by commas, that debug request logs replace. A restart applies the list.',
        type: 'list',
        defaultLabel: 'None',
        placeholder: 'password, token',
        risk: 'low'
    },
    {
        key: 'LOG_SANITIZE_HEADER_FIELDS',
        section: 'advanced',
        group: 'Logging',
        label: 'Request headers to hide in logs',
        help: 'Header names, separated by commas, that debug request logs replace. A restart applies the list.',
        type: 'list',
        defaultLabel: 'None',
        placeholder: 'authorization',
        risk: 'low'
    },
    {
        key: 'CANVAS_CARD_LOOK',
        section: 'advanced',
        group: 'Canvas',
        label: 'Canvas card look for new people',
        help: 'The look for people who have not picked one. Each person can still switch.',
        type: 'select',
        options: [
            { value: 'new', label: 'New (compact, with a side panel)' },
            { value: 'classic', label: 'Classic' }
        ],
        defaultLabel: 'New',
        defaultValue: 'new',
        risk: 'low'
    },
    {
        key: 'MIN_SCHEDULE_INTERVAL_SECONDS',
        section: 'advanced',
        group: 'Schedules and ETL',
        label: 'Shortest schedule interval',
        help: 'The most often a scheduled flow may run.',
        type: 'number',
        unit: 'seconds',
        min: 1,
        max: 86400,
        defaultLabel: '60 seconds',
        defaultValue: '60',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_ETL_CONCURRENCY',
        section: 'advanced',
        group: 'Schedules and ETL',
        label: 'ETL runs at once',
        help: 'How many ETL pipeline runs may execute at the same time.',
        type: 'number',
        min: 1,
        max: 16,
        defaultLabel: '1',
        defaultValue: '1',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_ETL_SCHEDULE_MS',
        section: 'advanced',
        group: 'Schedules and ETL',
        label: 'ETL schedule check',
        help: 'How often Cuttlely looks for a pipeline that is due.',
        type: 'number',
        unit: 'ms-as-seconds',
        min: 1,
        max: 3600,
        defaultLabel: '15 seconds',
        defaultValue: '15000',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HERMES_MAX_RESTARTS',
        section: 'advanced',
        group: 'Agent runtime health',
        label: 'Restarts before it stays down',
        help: 'How many times Cuttlely restarts the agent runtime after it stops or misses health checks.',
        type: 'number',
        min: 0,
        max: 100,
        defaultLabel: '5',
        defaultValue: '5',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HERMES_HEALTH_GRACE',
        section: 'advanced',
        group: 'Agent runtime health',
        label: 'Grace period after a start',
        help: 'Missed health checks in this window do not count.',
        type: 'number',
        unit: 'seconds',
        min: 0,
        max: 3600,
        defaultLabel: '60 seconds',
        defaultValue: '60',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HERMES_HEALTH_FAILS',
        section: 'advanced',
        group: 'Agent runtime health',
        label: 'Misses before a restart',
        help: 'Health checks in a row that must fail before a restart.',
        type: 'number',
        min: 1,
        max: 100,
        defaultLabel: '3',
        defaultValue: '3',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HERMES_HEALTH_WINDOW',
        section: 'advanced',
        group: 'Agent runtime health',
        label: 'Continuous misses before a restart',
        help: 'Seconds of failed checks before a restart. 0 restarts on the miss count alone.',
        type: 'number',
        unit: 'seconds',
        min: 0,
        max: 3600,
        defaultLabel: '15 seconds',
        defaultValue: '15',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_HERMES_START_WAIT_MS',
        section: 'advanced',
        group: 'Agent runtime health',
        label: 'Wait for the agent runtime to start',
        help: 'A question asked while the agent runtime is still starting waits this long before it fails.',
        type: 'number',
        unit: 'ms-as-seconds',
        min: 0,
        max: 600,
        defaultLabel: '60 seconds',
        defaultValue: '60000',
        risk: 'low'
    },
    {
        key: 'CUSTOM_MCP_TOOLS_MAX_BYTES',
        section: 'advanced',
        group: 'MCP limits',
        label: 'Largest MCP tool list',
        help: 'The biggest tool list a custom MCP server may return.',
        type: 'number',
        unit: 'bytes',
        min: 1024,
        max: 104857600,
        defaultLabel: '524288 bytes',
        defaultValue: '524288',
        risk: 'low'
    },
    {
        key: 'CUSTOM_MCP_AUTHORIZE_TIMEOUT_MS',
        section: 'advanced',
        group: 'MCP limits',
        label: 'MCP sign-in wait',
        help: 'How long Cuttlely waits for a custom MCP server to finish signing in.',
        type: 'number',
        unit: 'ms-as-seconds',
        min: 1,
        max: 600,
        defaultLabel: '15 seconds',
        defaultValue: '15000',
        risk: 'low'
    },
    {
        key: 'CUSTOM_MCP_TOOL_NAME_MAX_LENGTH',
        section: 'advanced',
        group: 'MCP limits',
        label: 'Longest MCP tool name',
        help: 'Characters kept from an MCP tool name.',
        type: 'number',
        min: 8,
        max: 1024,
        defaultLabel: '128',
        defaultValue: '128',
        risk: 'low'
    },
    {
        key: 'CUSTOM_MCP_TOOL_DESCRIPTION_MAX_LENGTH',
        section: 'advanced',
        group: 'MCP limits',
        label: 'Longest MCP tool description',
        help: 'Characters of an MCP tool description passed to the model.',
        type: 'number',
        min: 64,
        max: 65536,
        defaultLabel: '1024',
        defaultValue: '1024',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_EAGER_NODES',
        section: 'advanced',
        group: 'Start-up',
        label: 'Load every building block at start',
        help: 'Slower start, but a broken building block shows up at once instead of on first use.',
        type: 'switch',
        ...TRUE_FALSE,
        defaultLabel: 'Off',
        defaultValue: 'false',
        risk: 'low'
    }
]

export interface KeptOutGroup {
    group: string
    /** Exact names, or a prefix ending in * */
    keys: string[]
    why: string
}

export const KEPT_OUT: KeptOutGroup[] = [
    {
        group: 'Encryption and sign-in secrets',
        keys: [
            'FLOWISE_SECRETKEY_OVERWRITE',
            'CUTTLELY_SECRETKEY_OVERWRITE',
            'SECRETKEY_PATH',
            'SECRETKEY_STORAGE_TYPE',
            'SECRETKEY_AWS_*',
            'JWT_AUTH_TOKEN_SECRET',
            'JWT_REFRESH_TOKEN_SECRET',
            'JWT_ISSUER',
            'JWT_AUDIENCE',
            'EXPRESS_SESSION_SECRET',
            'TOKEN_HASH_SECRET'
        ],
        why: 'Settings and credentials are encrypted with this key. Changing it from a browser would make them unreadable.'
    },
    {
        group: 'Paths, ports and image',
        keys: [
            'PORT',
            'HOST',
            'CUTTLELY_DATA_DIR',
            'DATABASE_PATH',
            'BLOB_STORAGE_PATH',
            'LOG_PATH',
            'CUTTLELY_HERMES_HOME',
            'HERMES_HOME',
            'CUTTLELY_ETL_DIR',
            'CUTTLELY_VERSIONS_DIR',
            'HERMES_API_PORT',
            'CUTTLELY_HARNESS_GATEWAY_PORT',
            'NODE_OPTIONS',
            'CUTTLELY_IMAGE',
            'INCLUDE_BROWSER',
            'INCLUDE_NODE_PACKS',
            'CUTTLELY_OMIT_GEOIP',
            'CUTTLELY_INSTALL',
            'CUTTLELY_NODE_PACKS'
        ],
        why: 'The settings file lives in the data folder, and the host or volume decides these.'
    },
    {
        group: 'Code execution and safety checks',
        keys: [
            'CUSTOM_MCP_PROTOCOL',
            'CUSTOM_MCP_ALLOWED_COMMANDS',
            'CUSTOM_MCP_ALLOWED_ENV_VARS',
            'CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS',
            'CUSTOM_MCP_SECURITY_CHECK',
            'TOOL_FUNCTION_BUILTIN_DEP',
            'TOOL_FUNCTION_EXTERNAL_DEP',
            'ALLOW_BUILTIN_DEP',
            'HTTP_SECURITY_CHECK',
            'PATH_TRAVERSAL_SAFETY',
            'OAUTH2_SECURITY_CHECK',
            'CUTTLELY_ETL_ROOTS',
            'PUPPETEER_EXECUTABLE_PATH',
            'PUPPETEER_EXECUTABLE_FILE_PATH',
            'PLAYWRIGHT_EXECUTABLE_PATH',
            'PLAYWRIGHT_EXECUTABLE_FILE_PATH',
            'SANDBOX_TIMEOUT'
        ],
        why: 'A stolen owner session must never become a shell or a file reader on the server.'
    },
    {
        group: 'Queue topology',
        keys: [
            'MODE',
            'QUEUE_NAME',
            'QUEUE_REDIS_EVENT_STREAM_MAX_LEN',
            'REDIS_*',
            'WORKER_CONCURRENCY',
            'REMOVE_ON_AGE',
            'REMOVE_ON_COUNT',
            'ENABLE_BULLMQ_DASHBOARD'
        ],
        why: 'Workers in other containers do not read this server\u2019s settings file.'
    },
    {
        group: 'Start script plumbing',
        keys: [
            'CUTTLELY_HARNESS_GATEWAY_TOKEN',
            'HERMES_API_URL',
            'HERMES_PYTHON',
            'CUTTLELY_FLOWISE_DB',
            'CUTTLELY_BASE_URL',
            'CUTTLELY_HARNESS_LOCK_MS',
            'CUTTLELY_PRELOAD_HERMES',
            'CUTTLELY_HERMES_RESTART_DELAY',
            'CUTTLELY_GATEWAY_WAIT_SECONDS',
            'CUTTLELY_SUPERVISED',
            'CUTTLELY_START_INNER',
            'CUTTLELY_SETTINGS_*',
            'CUTTLELY_IGNORE_ADMIN_SETTINGS',
            'API_SERVER_*',
            'RENDER'
        ],
        why: 'Set by the start script or the platform for the processes it starts.'
    },
    {
        group: 'Tests and maintainers',
        keys: [
            'E2E_*',
            'CUTTLELY_E2E_*',
            'CUTTLELY_VERIFY_*',
            'CUTTLELY_SKIP_*',
            'CUTTLELY_GITHUB_TEST_*',
            'CUTTLELY_GITHUB_ALLOW_FILE_REMOTES',
            'CUTTLELY_HARNESS_OFFLINE_MODEL',
            'CUTTLELY_VENDOR*',
            'METRICS_INCLUDE_NODE_METRICS',
            'METRICS_OPEN_TELEMETRY_PROTOCOL',
            'METRICS_OPEN_TELEMETRY_DEBUG',
            'NUMBER_OF_PROXIES'
        ],
        why: 'Not for running servers, or tuned only by maintainers.'
    },
    {
        group: 'LangSmith host secrets',
        keys: ['LANGSMITH_API_KEY', 'LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2'],
        why: 'The API key and the tracing switches stay on the host. Project name and endpoint are ordinary settings.'
    }
]

/** How a read-only environment value counts as configured. Invalid or blank never counts. */
export type ReadOnlyCheck = 'nonblank' | 'port' | 'directory' | 'redis-url' | 'base64' | 'bool' | 'mode' | 'storage-type' | 'secret-file'

export interface ReadOnlyDef {
    key: string
    readOnly: true
    check: ReadOnlyCheck
    /** When the variable is missing or blank. `default` means a built-in applies and is not returned. */
    whenUnset: 'default' | 'unset'
    /** File name under a valid SECRETKEY_PATH, used only when the environment value is blank. */
    secretFile?: string
}

/**
 * Env-only values. The list is exact: nothing here is a prefix, and process env is not scanned.
 * The status API returns key, set, source, and readOnly. It does not return a value, length, or hash.
 */
export const READ_ONLY_SETTINGS: ReadOnlyDef[] = [
    { key: 'PORT', readOnly: true, check: 'port', whenUnset: 'unset' },
    { key: 'HOST', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'CUTTLELY_DATA_DIR', readOnly: true, check: 'nonblank', whenUnset: 'default' },
    { key: 'MODE', readOnly: true, check: 'mode', whenUnset: 'default' },
    { key: 'LOG_PATH', readOnly: true, check: 'nonblank', whenUnset: 'default' },
    { key: 'BLOB_STORAGE_PATH', readOnly: true, check: 'nonblank', whenUnset: 'default' },
    { key: 'SECRETKEY_PATH', readOnly: true, check: 'directory', whenUnset: 'unset' },
    { key: 'SECRETKEY_STORAGE_TYPE', readOnly: true, check: 'storage-type', whenUnset: 'default' },
    { key: 'SECRETKEY_AWS_ACCESS_KEY', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'SECRETKEY_AWS_SECRET_KEY', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'SECRETKEY_AWS_REGION', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'SECRETKEY_AWS_NAME', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'FLOWISE_SECRETKEY_OVERWRITE', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'CUTTLELY_SECRETKEY_OVERWRITE', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'JWT_AUTH_TOKEN_SECRET', readOnly: true, check: 'secret-file', whenUnset: 'unset', secretFile: 'jwt-auth-token.secret' },
    { key: 'JWT_REFRESH_TOKEN_SECRET', readOnly: true, check: 'secret-file', whenUnset: 'unset', secretFile: 'jwt-refresh-token.secret' },
    { key: 'JWT_ISSUER', readOnly: true, check: 'secret-file', whenUnset: 'unset', secretFile: 'jwt-issuer' },
    { key: 'JWT_AUDIENCE', readOnly: true, check: 'secret-file', whenUnset: 'unset', secretFile: 'jwt-audience' },
    { key: 'EXPRESS_SESSION_SECRET', readOnly: true, check: 'secret-file', whenUnset: 'unset', secretFile: 'express-session.secret' },
    { key: 'TOKEN_HASH_SECRET', readOnly: true, check: 'secret-file', whenUnset: 'unset', secretFile: 'token-hash.secret' },
    { key: 'REDIS_URL', readOnly: true, check: 'redis-url', whenUnset: 'unset' },
    { key: 'REDIS_HOST', readOnly: true, check: 'nonblank', whenUnset: 'default' },
    { key: 'REDIS_PORT', readOnly: true, check: 'port', whenUnset: 'default' },
    { key: 'REDIS_USERNAME', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'REDIS_PASSWORD', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'REDIS_TLS', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'REDIS_CERT', readOnly: true, check: 'base64', whenUnset: 'unset' },
    { key: 'REDIS_KEY', readOnly: true, check: 'base64', whenUnset: 'unset' },
    { key: 'REDIS_CA', readOnly: true, check: 'base64', whenUnset: 'unset' },
    { key: 'CUSTOM_MCP_PROTOCOL', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'CUSTOM_MCP_ALLOWED_COMMANDS', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'CUSTOM_MCP_ALLOWED_ENV_VARS', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'CUSTOM_MCP_SECURITY_CHECK', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'TOOL_FUNCTION_BUILTIN_DEP', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'TOOL_FUNCTION_EXTERNAL_DEP', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'ALLOW_BUILTIN_DEP', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'HTTP_SECURITY_CHECK', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'PATH_TRAVERSAL_SAFETY', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'OAUTH2_SECURITY_CHECK', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'CUTTLELY_ETL_ROOTS', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'PUPPETEER_EXECUTABLE_PATH', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'PUPPETEER_EXECUTABLE_FILE_PATH', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'PLAYWRIGHT_EXECUTABLE_PATH', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'PLAYWRIGHT_EXECUTABLE_FILE_PATH', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'SANDBOX_TIMEOUT', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'LANGSMITH_API_KEY', readOnly: true, check: 'nonblank', whenUnset: 'unset' },
    { key: 'LANGSMITH_TRACING', readOnly: true, check: 'bool', whenUnset: 'default' },
    { key: 'LANGSMITH_TRACING_V2', readOnly: true, check: 'bool', whenUnset: 'default' }
]

const READ_ONLY_BY_KEY = new Map(READ_ONLY_SETTINGS.map((setting) => [setting.key, setting]))

export function readOnlyDef(key: string): ReadOnlyDef | undefined {
    return READ_ONLY_BY_KEY.get(key)
}

export function isReadOnly(key: string): boolean {
    return READ_ONLY_BY_KEY.has(key)
}

const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]))

export function settingFor(key: string): SettingDef | undefined {
    return BY_KEY.get(key)
}

export function isKeptOut(key: string): boolean {
    return KEPT_OUT.some((group) =>
        group.keys.some((pattern) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern))
    )
}

export function sectionFor(id: string): SectionDef | undefined {
    return SECTIONS.find((section) => section.id === id)
}
