module.exports = {
    // Use ts-jest preset for testing TypeScript files with Jest
    preset: 'ts-jest',
    // Set the test environment to Node.js
    testEnvironment: 'node',

    // Define the root directory for tests and modules
    roots: ['<rootDir>/src'],

    // Use ts-jest to transform TypeScript files.
    // sanitize-html 2.17 depends on htmlparser2 12, which is ESM-only, along with
    // domelementtype, domhandler, domutils, entities and dom-serializer. Jest's runner
    // cannot load those import statements unless they are compiled. Other node_modules stay ignored.
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
        '^.+\\.js$': [
            'ts-jest',
            {
                tsconfig: {
                    allowJs: true,
                    esModuleInterop: true,
                    isolatedModules: true
                }
            }
        ]
    },
    transformIgnorePatterns: [
        '/node_modules/(?!(?:\\.pnpm/(?:htmlparser2|domelementtype|domhandler|domutils|entities|dom-serializer)@|(?:htmlparser2|domelementtype|domhandler|domutils|entities|dom-serializer)/))'
    ],

    // Regular expression to find test files
    testRegex: '.*\\.test\\.tsx?$',

    // File extensions to recognize in module resolution
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

    // uuid v10+ ships ESM-only; redirect to the CJS dist so Jest can require it.
    // typeorm is not resolvable via pnpm symlinks in the test runner; redirect to
    // the shared manual mock so all test files get the same decorator stubs without
    // needing an inline jest.mock() factory.
    moduleNameMapper: {
        '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js',
        '^typeorm$': '<rootDir>/__mocks__/typeorm.ts'
    },

    // Include the package's own node_modules so that Jest can resolve
    // symlinked pnpm dependencies when tests live inside src/
    modulePaths: ['<rootDir>/node_modules'],

    // Flow history is on by default. Tests that do not set CUTTLELY_VERSIONS keep it
    // off so no test writes a versions repo in the home folder.
    setupFiles: ['<rootDir>/jest.env.js'],

    // Display individual test results with the test suite hierarchy.
    verbose: true
}
