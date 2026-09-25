# World storage

The factory server saves the world as one JSON file. The server reads the file once when it starts and rewrites the whole file on each save.

The file is `world.json` in a data directory. The default directory is `.factory/` in the repository root. The `FACTORY_DATA_DIR` environment variable sets another directory. `.factory/` is gitignored.

## Decision

Use one JSON file and no database.

The saved world is small. The retention rules keep every running run, the newest 200 finished runs and the tasks they use, every pending task and its flow, and the newest 400 events. Logs are not saved. The server always loads the whole world into memory, and nothing reads history from storage. One file with Node's `fs` module meets that need with no new dependency.

SQLite was the epic's expected choice. It is deferred. It adds a native dependency and a schema, and nothing in the product queries stored history yet.

## How a save works

A save writes the document to `world.json.tmp` in the same directory, then renames it over `world.json`. A rename in one directory replaces the file in one step, so a crash during a save leaves the previous complete world. Saves are throttled to one per second. The server also saves when it receives SIGINT or SIGTERM.

## Bad files

If `world.json` cannot be read or is not a valid world, the server starts from the seed world. It renames the file to `world.json.corrupt`, which replaces an older one, and logs one error line with both paths. A bad file never stops the server from starting.

## Not covered

There are no migrations between file versions. A file whose shape fails validation is treated as a bad file. There are no backups beyond the one `.corrupt` copy.

## When to reopen

Move to SQLite or another database when one of these becomes true:

- A feature needs to query run history, events or logs that are not in memory, such as search across all runs or a history longer than the retention limits.
- Persisted logs for real runs (KAT-3359) make the document too large to rewrite on every save.
- More than one process writes the world.
