let's build a Ul which will allow teams to manage their software factory. start with Ul first using react flow. do mock apis for now so we can just refine the Ul. idea is to manage agents within the app. the app will connect to sandboxes. list features we need for the initial mvp. APls will just me mock and no database yet.

An orchestration-graph control plane - agents, sandboxes, triggers and task pipelines - with a simulated backend that keeps running while you watch.

Canvas (React Flow v12). Three node types (agent / sandbox / trigger) and four typed, validated edge kinds distinguished visuallytriggree, handoff(violetsolid,depends-on(amber dashed,

runs-in (cyan dotted). Positions persist through the mock API, plus auto-layout, marquee select, right-click spawn, minimap, and edges that animate while their upstream agent is working.

Agents. Roster with fleet KPls and a deep inspector: model, temperature, concurrency, timeout, retry policy, tools editor, system prompt, live workload, and a task composer.

Sandboxes. Pool of cards with live CPU/mem/disk, lease holder, and start/stop/restart/rebuild/destroy.
Provisioning is simulated so you can watch a sandbox come up.

Runs, logs, events. Bottom dock (resizable) with queue, run history, level-filtered follow-tail logs, and a clickable event