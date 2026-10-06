# Factory pushes the branch and opens the pull request

## Decision

An agent has a delivery setting: `none` or `pull-request`. The default is `none`. The agent inspector sets it, and a world saved before the setting existed loads every agent with `none`.

A run of a delivering agent on a `local` sandbox prepares its worktree differently. The server checks that the sandbox root is the top of a git repository with an `origin` remote. It reads origin's default branch, fetches that branch, and cuts the worktree from it, not from whatever the root has checked out. The branch is the issue's Linear branch name when the task belongs to an issue's flow, and `factory-<run id>` otherwise. When that name already exists locally or on origin, the run takes the first free name of `<name>-2`, `<name>-3` and so on.

When the agent's run succeeds, the server counts the commits on the worktree's `HEAD` since the run started, so commits the agent made on a branch of its own still count. With none, it opens nothing and adds the note artifact "No changes; no pull request opened". Otherwise it pushes `HEAD` to `<branch>` on origin. If `gh pr view <branch>` finds an open pull request the agent opened itself into the default branch, the server uses it. Otherwise it runs `gh pr create` against the default branch, naming origin's repository with `--repo` when origin is on GitHub. The title is the task title. The body is the run summary, followed by the issue URL for an issue task. The pull request becomes a `pr` artifact in the run's output before the run finishes, so a handoff carries it to the next agent. A failed push, a failed `gh pr create`, or a missing origin fails the run with the reason `delivery failed: <reason>`, and the agent's retry policy applies.

When an issue's flow ends finished or failed, write-back queues one attach write for each distinct pull request that the flow's succeeded local runs produced. `ensureAttachment` looks for an attachment with that URL on the issue and creates one only when none exists. Attach writes go out independently of moves, like notes. The completion note lists the run's artifacts, so it names the pull request or the "No changes" note.

Agents with delivery `none` keep the worktree on `factory-<run id>` from the root's HEAD, and Factory pushes nothing for them.

## Reason

Delivery must not depend on the agent remembering to push and open a pull request. A prompt can ask for it, but a run that forgets, runs out of turns or opens the PR against the wrong base still reports success. When Factory delivers, a succeeded run with commits always ends with a pull request, and a run whose delivery fails is a failed run that retries.

Credentials and naming stay with Factory. The agent needs no permission to push or to call `gh`, and the branch name and base branch come from one place instead of from each agent's prompt.

Linear's GitHub integration links a pull request to an issue when the PR's branch is the issue's branch name. Using `branchName` gets that link without Factory writing to GitHub beyond the PR itself. The attachment that write-back adds shows the PR on the issue even when the integration is not installed. Keying it by URL keeps a repeated write from adding a second one.

A retry never overwrites a pushed branch. An attempt that pushed and then failed to open its PR leaves that branch as it was, and the next attempt pushes a suffixed branch. Nothing is force-pushed, and no attempt's commits are lost.

Runs that share a root share its refs. A push to origin also writes the pushed branch's remote-tracking ref, `refs/remotes/origin/<branch>`, and a fetch that writes the same ref while a sibling pushes it fails with `cannot lock ref`, which failed the run and burned a retry. That happened when a Reviewer started on a pull request's branch while the Coder pushed to it. So no fetch of Factory's writes a ref a push writes. Preparation and fresh-branch delivery fetch the branches they need with `git fetch --no-tags --no-write-fetch-head --refmap= origin +refs/heads/<branch>:refs/factory/<run id>/<n>`, read each commit from that run-private ref, and delete the refs at once; `--refmap=` stops git from also updating `refs/remotes/origin/*` on the side, and `--no-write-fetch-head` leaves the shared `FETCH_HEAD` alone. When a fetch ends, it deletes the `refs/factory/*` refs of every run that is not fetching, and so does the start of the next fetch. Factory tracks which runs are fetching across queues, since two roots that are worktrees of one repository share these refs. That tracking is per process, so two Factory servers on one repository are not protected from deleting each other's refs ([KAT-3706](https://linear.app/kata-sh/issue/KAT-3706)). The delete is one transaction: refs deleted by separate processes at once contend for `packed-refs.lock`, and a delete that lost left its ref behind. A run killed between its fetch and its delete, or a delete that failed, therefore leaves refs that the next fetch's delete, in a preparation or fresh-branch delivery in that repository, removes; no run id is reused, so nothing else would. The root's `refs/remotes/origin/*` are no longer refreshed by Factory, only by the pushes it makes. Only one push runs in the queue: a fresh branch's, together with the name it claims, so two runs never claim one name. A held fresh push blocks other runs' preparation in that root until it ends. Every other push, a new branch's in the first round or a pull request's branch that a rework continues, stays outside the queue, so it neither waits for nor holds up another branch's push or another run's start. Serializing those pushes in the queue was tried and rejected, since it made deliveries to different branches take turns and let one slow push fail an unrelated run's timeout before its agent started.

Cutting from the fetched default branch keeps one run's local state from leaking into another's pull request. The sandbox root can have any branch checked out, with local commits, and the pull request still holds only the run's own commits.

## Limits

Delivery covers `local` sandboxes only. Simulated runs ignore the setting, and their demo pull request links are never attached to an issue.

The base is always origin's default branch. Merging, review and CI are out of scope, and a later attempt within one round opens a new pull request rather than pushing to an existing one. A rework round on an open pull request pushes to that pull request's branch instead. When that pull request is merged or closed while the agent works, delivery replays the run's commits onto the default branch and picks the fresh branch's name after the run, the same way and in the same queue. That push only creates the branch, so it never moves a branch someone else created (ADR 0012).

A retry after a failed `gh pr create` leaves the first attempt's branch on origin without a pull request. Nothing cleans it up.

Two delivering agents in one issue's flow each open their own pull request, on the issue's branch name and a suffixed one.

## When to reopen

Reopen this decision when a later attempt within one round must push to the existing pull request, when a base other than the default branch is needed, or when a non-local sandbox kind can deliver. ADR 0012 covers review rounds.
