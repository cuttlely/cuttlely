module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: [
        '<rootDir>/nodes',
        '<rootDir>/src',
        '<rootDir>/../node-pack-vector-stores',
        '<rootDir>/../node-pack-tools-mcp',
        '<rootDir>/../node-pack-caches-memory',
        '<rootDir>/../node-pack-legacy-chains'
    ],
    transform: {
        // Same compiler as ts-jest. The wrapper records compile time for the node load budget.
        '^.+\\.tsx?$': '<rootDir>/load-coverage-transformer.cjs'
    },
    testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    verbose: true,
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
        ...(process.env.CUTTLELY_PINNED_NODE_TESTS === '1' ? [] : ['PostgreSQLMCP.pinned.test.ts'])
    ],
    moduleNameMapper: {
        '^../../../src/(.*)$': '<rootDir>/src/$1',
        '^@cuttlely/components/interface$': '<rootDir>/src/Interface.ts',
        '^@cuttlely/components/utils$': '<rootDir>/src/utils.ts',
        '^@cuttlely/components/indexing$': '<rootDir>/src/indexing.ts',
        '^@cuttlely/components/validator$': '<rootDir>/src/validator.ts',
        '^@cuttlely/components/sanitizeDataSourceOptions$': '<rootDir>/src/sanitizeDataSourceOptions.ts',
        '^@cuttlely/components/awsToolsUtils$': '<rootDir>/src/awsToolsUtils.ts',
        '^@cuttlely/components/agents$': '<rootDir>/src/agents.ts',
        '^@cuttlely/components/storageUtils$': '<rootDir>/src/storageUtils.ts',
        '^@cuttlely/components/nodes$': '<rootDir>/nodes/index.ts',
        '^@cuttlely/components/modelLoader$': '<rootDir>/src/modelLoader.ts',
        '^@cuttlely/components/etl-engine$': '<rootDir>/nodes/etl/engine.ts',
        '^@cuttlely/components/handler$': '<rootDir>/src/handler.ts',
        '^@cuttlely/components/google-utils$': '<rootDir>/src/google-utils.ts',
        '^@cuttlely/components/openApiSpec$': '<rootDir>/src/openApiSpec.ts',
        '^@cuttlely/components/httpSecurity$': '<rootDir>/src/httpSecurity.ts',
        '^@cuttlely/components/moderation$': '<rootDir>/nodes/moderation/Moderation.ts',
        '^@cuttlely/components/outputParserHelpers$': '<rootDir>/nodes/outputparsers/OutputParserHelpers.ts',
        '^@cuttlely/components$': '<rootDir>/src/index.ts',
        // @modelcontextprotocol/sdk is ESM-only (type:module, no exports map, no CJS builds).
        // It cannot be require()'d in Jest's CJS environment and crashes the worker.
        // The MCP core tests only exercise pure validation functions that don't
        // use these imports, so stubbing them out is safe.
        // Note: @langchain/core is NOT stubbed here because it ships CJS builds
        // (e.g. tools.cjs) that Jest can require() normally.
        '^@modelcontextprotocol/sdk/(.*)$': '<rootDir>/__mocks__/esm-stub.js',
        // @tootallnate/once@3+ ships ESM-only; it is pulled in transitively by
        // http-proxy-agent → jsdom. Jest cannot parse its `export default` syntax
        // in the default CJS environment, so stub it out.
        '^@tootallnate/once$': '<rootDir>/__mocks__/esm-stub.js'
    }
}
