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
        '^.+\\.jsx?$': 'babel-jest'
    },
    transformIgnorePatterns: ['/node_modules/']
}
