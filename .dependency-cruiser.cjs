/** Workspace boundaries apply to production sources; test runners are tooling. */
module.exports = {
  forbidden: [
    {
      name: 'core-allowed-deps', severity: 'error',
      from: { path: '^packages/core/src/' },
      to: { pathNot: ['^packages/core/src/', '(^|/)node_modules/(?:\\.pnpm/[^/]+/node_modules/)?(?:neverthrow|zod)(?:/|$)'] },
    },
    {
      name: 'sdk-only-core', severity: 'error',
      from: { path: '^packages/sdk/src/' },
      to: { path: '^(?:apps/|tools/|packages/(?!core/|sdk/))' },
    },
    {
      name: 'sdk-core-types-only', severity: 'error',
      from: { path: '^packages/sdk/src/' },
      to: { path: '^packages/core/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'providers-only-sdk', severity: 'error',
      from: { path: '^packages/providers/([^/]+)/src/' },
      to: { path: '^(?:apps/|tools/|packages/(?!sdk/|providers/$1/))' },
    },
    {
      name: 'daemon-layering', severity: 'error',
      from: { path: '^apps/daemon/src/(?:core|application)/' },
      to: { path: '^apps/daemon/src/(?:infrastructure|interface)/' },
    },
    {
      name: 'web-no-daemon', severity: 'error',
      from: { path: '^apps/web/' }, to: { path: '^apps/daemon/' },
    },
    {
      name: 'no-child-process-outside-infra', severity: 'error',
      from: { pathNot: '^(?:apps/daemon/src/infrastructure/|packages/sdk/src/fake/|apps/cli/)' },
      to: { dependencyTypes: ['core'], path: '^(?:node:)?child_process$' },
    },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(?:node_modules|dist|tests|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types', 'default'] },
  },
};
