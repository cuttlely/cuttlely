module.exports = {
    roots: ['<rootDir>/src'],
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/**/*.test.js'],
    testPathIgnorePatterns: ['/node_modules/', '/build/'],
    moduleNameMapper: {
        '\\.(css|less|scss|sass|svg|png|jpg|jpeg|gif|webp)$': '<rootDir>/src/__mocks__/styleMock.js',
        '^@/(.*)$': '<rootDir>/src/$1',
        // marked's package entry is ESM only; Jest loads its UMD build, which has the same API.
        '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js'
    },
    transform: {
        '^.+\\.jsx?$': 'babel-jest',
        // ArrayRenderer imports the row-id helper, which is TypeScript. Strip types only.
        '^.+\\.tsx?$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'] }],
        // HarnessRunTrace imports the harness trace module, which is ESM. The UI babel preset leaves import syntax alone.
        '^.+\\.mjs$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }]
    },
    transformIgnorePatterns: ['/node_modules/']
}
