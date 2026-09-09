import type { Config } from 'jest';

const config: Config = {
  displayName: 'gateway-e2e',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['**/*.e2e-spec.ts'],
  // Pin NODE_ENV=test + a throwaway JWT_SECRET (see file) so the H3
  // config fail-fast hardening doesn't block test runs.
  setupFiles: ['<rootDir>/jest.setup.ts'],
  coverageDirectory: '../../coverage/apps/gateway-e2e',
  // coverageReporters is configured via the nx executor options (global config).
  // Thresholds calibrated slightly below current coverage (2026-09-09:
  // 57.4% stmts / 29.3% branches / 40.9% funcs / 56.7% lines with the full
  // e2e suite green) so CI stays green while enforcing a floor. Ratcheted
  // up from 55/22/35/52 (2026-09-08) after the trace-context scenarios were
  // added. Ratchet up over time as scenarios are added.
  coverageThreshold: {
    global: {
      statements: 56,
      branches: 25,
      functions: 37,
      lines: 53,
    },
  },
};

export default config;
