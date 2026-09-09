import type { Config } from 'jest';

const config: Config = {
  displayName: 'notifications',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/packages/notifications',
  // Calibrated just below current coverage (82.5% stmts / 63.2% branches /
  // 93.3% funcs / 82.1% lines with the suite green) so CI enforces a floor.
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 60,
      functions: 75,
      lines: 75,
    },
  },
};

export default config;
