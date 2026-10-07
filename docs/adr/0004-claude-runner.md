# Use Claude Code for the first local runner

## Decision

`ClaudeRunner` starts the installed `claude` CLI in the run's working directory. The command uses `--print --verbose --output-format stream-json`. It passes the agent model with `--model` and the system prompt with `--system-prompt`. The installed CLI help confirms these flags.

The command always sets `--permission-mode dontAsk` and `--permission-prompts none`. `--allowedTools` contains only mapped agent tools. File reads map to `Read`, file writes to `Edit` and `Write`, search to `Glob` and `Grep`, and shell tools to their named `Bash` patterns. An unmapped tool produces a warning in the run log and grants no permission. The process never receives a bypass mode or an interactive permission prompt.

Each local sandbox's host field stores its absolute root directory. A run gets a unique `.factory-runs/<run-id>` directory beneath it. If the root is the top of a Git repository, the directory is a Git worktree on a new branch, `factory-<run-id>`, cut from the root's HEAD. ADR 0009 cuts a delivering agent's worktree from origin's default branch instead. The `.factory-runs/` path is ignored by Git. ADR 0009 removes the worktree and its branch when the run ends.

## Reason

Claude's streamed JSON carries assistant text, tool names, token usage, and a final result. The server converts these records to dock log lines and token updates before process exit. A process exit code or result error ends the run.

## Limits

The installed CLI has no timeout flag. KAT-3498 will enforce `agent.timeoutMs` by killing the process. KAT-3499 will turn the final result into run output and persist logs.
