# Keep-going hook

Copy this folder to `hooks/keep-going/` beside your selected `raw.json`, or to `~/.config/raw/hooks/keep-going/`. Select `agent/keep-going` or `local/keep-going` in `agents.NAME.hooks.use`. When the model gives a final answer and no file named `DONE` exists in the working directory, the hook asks the run to continue, at most three times (`stop.continuations`). The script needs Node on PATH.

It shows the `Stop` continuation protocol in `docs/hooks.md`. A real package would keep a small state file named after `session_id` (a hook request carries it) to remember its goal and read `stop.usage` (cumulative for the session) to keep a budget. Raw itself has no goal feature.
