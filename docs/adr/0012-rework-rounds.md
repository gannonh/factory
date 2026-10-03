# A return to the pickup state starts a new round

## Decision

The intake record stays keyed by issue. Its flat fields describe the current round. It also holds the round number, starting at 1, the round's result once its flow ends, how the round reworks an earlier pull request, whether the issue has left the round's pickup state, and the earlier rounds. Each earlier round keeps its trigger, flow id, start time and result. A result holds the outcome, the last pull request the flow delivered, and the output of the flow's last succeeded run. A record saved before rounds loads as round 1 with no earlier rounds, and its pull request is the newest one its attach writes name.

An issue leaves its round's pickup state when one of these happens after the round ended: a poll that began after the end does not list it in the pickup state, or Factory's finished or failed move lands on another state. A cancel from Linear also counts, since the issue was outside the round's states. A poll that began while the flow was open proves nothing. Once an ended round's issue has left, Factory no longer moves it out of the pickup state, so a finished or failed move still waiting to retry is dropped rather than land after a person moves the issue back.

A poll that lists an issue whose round has ended starts round N+1 when the issue has left, or when the round belonged to a different pickup state. A return while the flow is open changes nothing. An issue that never left, such as one that failed with no failed state set, does not run again. Pure functions in `server/rounds.ts` decide this and build the new record. The new round runs on the trigger's agent as a new flow. Every move in the write-back queue that has not landed is dropped, because the person who moved the issue back chose where it sits. The queue stays one list for the whole issue.

Before it starts the round, the poll reads the issue's comments from Linear and, if any round delivered a pull request, the newest one with `gh` (`server/github.ts`). `gh pr view <url>` gives the state and the head and base branches. `gh api` gives the review summaries, the inline comments and the conversation comments. Review feedback counts when it was made after the ended round started, since that round's prompt was built then. A Linear comment counts when it was made after Factory's latest note on the issue, or after the ended round started if no note is there. Factory's own notes never count. Each source gives at most its 50 newest comments, and each body is cut to 2000 characters. A trigger that feeds no agent reads nothing.

The task title gets the suffix `(round N)`. The prompt is the issue's title, description and URL, then a `Rework round N` section: how the round continues, then the review comments and the Linear comments, each list left out when it is empty. The task input is the newest output any round produced, so it holds the previous summary and artifacts.

When the pull request is open, the round continues on it. A delivering run fetches the PR's branch and starts its worktree at the tip, on a local branch `factory-<run id>`, since an earlier round's worktree may still have the PR's branch checked out. The prompt tells the agent to commit on top of `HEAD` without rebasing, amending or pushing. Delivery pushes `HEAD` to the PR's branch as a fast-forward, and `gh pr view` finds the open PR, so no second PR opens. The completion note links the same PR, and the attach write finds the URL already in the queue, so no second attachment lands. When the PR is merged or closed, the round cuts a fresh branch from the default branch and opens a new PR, as round 1 did (ADR 0009). A round after a flow that delivered no pull request starts fresh.

A round after the first names itself in its note's heading, such as "Factory finished this issue (round 2).", followed by "Continued on pull request #41." or "Pull request #41 was merged, so this round opened a new pull request." Round 1's note is unchanged.

The task inspector shows the round of an issue task's flow. The trigger card and the trigger inspector list each open round after the first, such as "ENG-1 round 2".

## Reason

ADR 0008 makes every entry into a handled state a new round. Keying the round to the record's trigger and to the pickup state it entered lets Gate 4 add a trigger per stage without changing the record.

Requiring the issue to have left the pickup state keeps a failed or finished issue that Factory could not move from running in a loop. Taking the decision only from polls begun after the round ended keeps a poll that started during the flow from mistaking the issue's place before the end for a return.

Linear and the pull request already hold the reviewer's feedback, so the round reads it there instead of keeping a copy. Continuing on the open pull request keeps one review thread for the whole issue. A reviewer reads new commits on the PR they already commented on.

The new round, its task and its record are written to disk in the same step, before any run starts, so a restart neither repeats the round nor loses it. Notes keep the comment ids of ADR 0007, so a restart never posts a round's note twice.

## Limits

Rework covers `local` sandboxes with delivery set to Pull request. Another agent continues nothing. A failure while the issue's Linear comments or the round's pull request are read logs a warning and that issue waits for the next poll, so a broken `gh` holds the issue in the pickup state without a round. A round reads only the newest pull request. Feedback is not marked as handled, so a reviewer's comment made before the previous note but never acted on is not passed again. Review threads are not resolved. Factory does not react to review events without a Linear state change. In a round that continues a pull request, every delivering agent in the flow pushes to that pull request's branch. An agent that makes no commits in a round on an open PR gets the note "No changes; no pull request opened", although the PR stays open. The choice to continue or start fresh is made when the round is taken, so a pull request merged before the run starts fails the round's delivery or opens a new pull request. Pull request and Linear comments are quoted into the prompt from any author, as the issue description already is, so the repository's and the workspace's access control is the trust boundary.

## When to reopen

Reopen this decision when a review event must start a round without a state change, when a round must read more than one pull request, or when a non-local sandbox kind can deliver.
