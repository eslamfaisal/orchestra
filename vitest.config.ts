import { defineConfig } from 'vitest/config';

export default defineConfig({
  "test": {
    "projects": [
      {
        "test": {
          "name": "@orchestra/core",
          "root": "packages/core",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/sdk",
          "root": "packages/sdk",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/catalog",
          "root": "packages/catalog",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/ui",
          "root": "packages/ui",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/provider-claude",
          "root": "packages/providers/claude",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/provider-codex",
          "root": "packages/providers/codex",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/provider-agy",
          "root": "packages/providers/agy",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/provider-kimi",
          "root": "packages/providers/kimi",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/provider-opencode",
          "root": "packages/providers/opencode",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "orchestrad",
          "root": "apps/daemon",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/web",
          "root": "apps/web",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "@orchestra/desktop",
          "root": "apps/desktop",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      },
      {
        "test": {
          "name": "orch",
          "root": "apps/cli",
          "include": [
            "tests/**/*.test.ts"
          ],
          "environment": "node"
        }
      }
    ]
  }
});
