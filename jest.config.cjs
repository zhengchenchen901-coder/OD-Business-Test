module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/testing/testflow-local/**/*.test.cjs'],
  transform: {'^.+\\.js$':'<rootDir>/scripts/jest-transform.cjs'},
  cache: false
};
