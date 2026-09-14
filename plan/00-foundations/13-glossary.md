# 13 — Glossary

| Term | Meaning |
|---|---|
| **Agent** | one running vendor CLI process in a tmux pane, bound to a session |
| **Session** | daemon-managed lifecycle of one agent (provider, model, worktree, pane, recording) |
| **Pane** | tmux pane hosting the agent's PTY |
| **Worktree** | git worktree + branch dedicated to one task |
| **Provider** | a vendor CLI integration (claude, codex, agy, kimi, opencode) delivered as a plugin |
| **Adapter** | code implementing `ProviderAdapter` for a provider |
| **Capability Manifest** | versioned JSON describing what a provider/CLI version can do and how to talk to it |
| **Fixture** | recorded real payload from a CLI version, used by contract tests |
| **Lead** | an LLM agent (any provider) that decomposes a mission into tasks via MCP tools |
| **Assignment Engine** | deterministic scorer picking provider/model per task |
| **Mission** | a user intent decomposed into a DAG of typed tasks (from a playbook) |
| **Task** | typed unit of work with a contract (`TaskSpec` → `TaskResult`) |
| **TaskType** | taxonomy entry with capability needs, weights, risk, review rule |
| **Playbook** | YAML template for a mission's task DAG |
| **Skill** | portable, versioned instruction artifact installed into a provider's native skills dir |
| **AgentPrompt** | structured stop-and-ask (permission, question, planApproval, confirm, login, error) |
| **Answer transport** | how an answer reaches the agent: `hook-response` · `permission-tool` · `app-server-rpc` · `elicitation` · `mcp-result` (Lead `ask_user` tool result) · `send-keys-acked` (fallback) · `none` (informational) |
| **Attention Queue** | durable prioritised inbox of AgentPrompts and platform items across all agents |
| **Window** | a vendor quota period (5-h, weekly, daily, tokens) |
| **Forecast** | estimated time-to-limit for a window from burn rate; always labelled *estimate* |
| **Doctor** | boot/hourly/on-change health + drift checks |
| **Drift** | a mismatch between what a CLI version does and what its manifest/fixtures say |
| **Remediation ladder** | ordered fixes: safe auto → registry → repair agent → community |
| **Repair Agent** | sandboxed agent that proposes adapter/manifest patches, never autonomous |
| **RepairCase** | tracked drift/remediation instance |
| **Official-only** | the compliance stance: official binaries, official channels, no tricks |
| **FakeProvider** | scripted adapter used in all automated tests |
| **Quick Delegate** | one task, no plan, minimal ceremony |
| **Scorecard** | per-model evidence view from your own outcomes |
