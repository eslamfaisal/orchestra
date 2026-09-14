# Contributing

Use Node 22 and pnpm 10.17.1. Install dependencies with `pnpm install --frozen-lockfile`.

Run `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm depcruise`, and `pnpm format:check` before proposing a change. Work on a branch, preserve unrelated changes, and use conventional commit messages with the step ID. No direct pushes to the default branch.

Every contribution must carry a Developer Certificate of Origin sign-off (`git commit -s`). The sign-off certifies the [DCO 1.1](https://developercertificate.org/). Do not sign on another person's behalf.

Keep the domain independent from frameworks and infrastructure. See the plan's engineering standards and dependency rules. Real provider accounts must never be used in automated tests.

Human acceptance follows the manual cases in each step. Passing automation does not mark a step complete. The CI/release implementation is scheduled in M0-08 and later milestones.
