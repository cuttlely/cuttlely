module.exports = {
    extends: [
        'eslint:recommended',
        'plugin:markdown/recommended',
        'plugin:react/recommended',
        'plugin:react/jsx-runtime',
        'plugin:react-hooks/recommended',
        'plugin:jsx-a11y/recommended',
        'plugin:prettier/recommended'
    ],
    settings: {
        react: {
            version: 'detect'
        }
    },
    parser: '@typescript-eslint/parser',
    ignorePatterns: [
        '**/node_modules',
        '**/dist',
        '**/build',
        '**/coverage',
        '**/package-lock.json',
        // Vendored NousResearch Hermes. It has its own Prettier config and is not Cuttlely application code.
        'hermes/**',
        // Written by website/scripts/sync-docs.mjs and Astro at build time (copies of docs/).
        'website/src/content/**',
        'website/src/generated/**',
        'website/.astro/**',
        // Vendored A2A v0.3.0 JSON Schema. Keep the upstream bytes.
        'packages/server/src/services/a2a/__fixtures__/a2a-v0.3.0.json'
    ],
    plugins: ['unused-imports'],
    rules: {
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        'no-unused-vars': 'off',
        'unused-imports/no-unused-imports': 'warn',
        'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' }],
        'no-undef': 'off',
        'no-console': [process.env.CI ? 'error' : 'warn', { allow: ['warn', 'error', 'info'] }],
        'prettier/prettier': 'error',
        'no-control-regex': 0 // Used to match control regex's in user input
    }
}
