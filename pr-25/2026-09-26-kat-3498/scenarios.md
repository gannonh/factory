# KAT-3498 browser verification

Branch: `feature/kat-3498-cancel-and-timeout-kill-the-process-and-fail-the-run`. Final implementation and test commit: `c5e44548e684ce9f11ec20abad68fc60213aadc7`. The browser session started before the KAT-3497 review-fix merge; those fixes changed workdir setup, undo history, and the Task Inspector clock. The same running server hot reloaded the merge, and the post-merge test, lint, and build gates passed.

A local fake `claude` executable emitted streamed JSON and spawned a waiting child process. No paid Claude Code call was made. The branch app used an isolated local root and world file. The main baseline used `origin/main` at `8d3171b` with its own world file. Screenshots show the Factory UI at 1280×800. [The 50-second MP4](cancel-timeout-demo.mp4) records a timeout at 1× and while simulation is paused.

| # | Browser scenario | Observed result |
| --- | --- | --- |
| 1 | Queue the same Reviewer task on a Docker sandbox on main and branch. | Both leased builder-a and succeeded. Main: [running](01-main-running.png), [succeeded](01-main-succeeded.png). Branch: [running](01-branch-running.png), [succeeded](01-branch-succeeded.png). |
| 2 | Cancel a running local task from Queue. | Its row left Queue; Runs and the inspector showed cancelled with “cancelled by operator.” [Before](02-cancel-before.png), [after](02-cancelled-reason.png). |
| 3 | Check the fake parent and child after cancellation. | PIDs 2340117 and 2340124 were absent from `ps` after the UI showed cancelled. |
| 4 | Let a waiting local task exceed a 5-second agent timeout at 1×. | Run failed after 5.0 wall-clock seconds and the inspector showed “timeout.” [Screenshot](04-timeout-reason.png). |
| 5 | Pause simulation during a waiting local run. | Run still failed after 5.0 wall-clock seconds while the top bar showed Resume. [Screenshot](05-paused-timeout.png). |
| 6 | Set simulation to 4× during a waiting local run. | Run failed after 5.0 wall-clock seconds, rather than accelerated simulated time. |
| 7 | Fill Planner's capacity, then cancel a queued task. | Task inspector showed cancelled, attempts 0, runs 0. |
| 8 | Start Coder and Planner on a local sandbox with capacity 2, then cancel Planner. | Leases changed from 2/2 to 1/2; Coder's process stayed running. [Before](08-two-local-leases.png). |
| 9 | Queue a second Planner task behind a waiting local run on capacity 1. | First run failed with timeout at 5.0 seconds; the queued successor acquired the lease and succeeded in 1.2 seconds. |
| 10 | Stop a simulated Docker sandbox with Coder and Reviewer leased. | Both runs failed with “sandbox stop,” leases changed from 2/2 to 0/2, and the existing retry reason appeared. [Before](10-stop-before.png), [after](10-stop-after.png). |

The fake process tests in the PR also check child termination on timeout, pause and 4× timing, cancellation during asynchronous workdir setup, and a late completion event.
