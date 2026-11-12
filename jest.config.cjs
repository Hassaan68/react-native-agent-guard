/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^expo-local-authentication$':
      '<rootDir>/__mocks__/expo-local-authentication.ts',
  },
  watchman: false,
  clearMocks: true,
};
