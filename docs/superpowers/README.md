# Development workflow for this repo

This project uses the [`superpowers`](https://github.com/anthropics/claude-plugins-official) Claude Code plugin for its development process. `.claude/settings.json` (committed) already declares the marketplace and enables the plugin — Claude Code will prompt you to confirm it the first time you open this repo.

The workflow every piece of work in `docs/superpowers/plans/` has followed so far:

1. **Scope it** — `brainstorming` before any new feature, to settle what's being built and why before writing code.
2. **Plan it** — `writing-plans` turns a settled scope into a task-by-task plan (files, signatures, exact test cases) saved to `docs/superpowers/plans/YYYY-MM-DD-<name>.md`. A plan that covers multiple independent pieces gets broken into separate plan files.
3. **Build it** — `test-driven-development` (RED → GREEN, every step) drives each task, executed either inline (`executing-plans`) or via per-task subagents with a reviewer gate (`subagent-driven-development`). Both keep a ledger of rulings — decisions made when the plan and the spec didn't fully agree — so a later reader can see what was decided and why, not just what shipped.
4. **Review it** — a fresh, independent pass (`requesting-code-review`'s `code-reviewer.md` template) over the whole branch before merge, checking the plan's own "Review Focus" items are genuinely tested, not just claimed. Findings are graded Critical/Important/Minor; Critical and Important get fixed in the same pass (with their own failing test first), Minor findings are recorded, not fixed on the spot.
5. **Finish it** — `finishing-a-development-branch` runs the full suite one more time and presents the merge/PR/keep-as-is decision explicitly, rather than assuming.

If you're picking up a branch mid-flight, check for a ledger file (`.superpowers/sdd/<plan-name>/progress.md`, git-ignored — scratch state, not a record meant to outlive the branch) before redoing work a prior session already did; the actual record of decisions lives in the plan files and commit messages once a branch lands.

See `docs/prd-eur-inr-comparison.md` for what this project is and `docs/superpowers/plans/` for the implementation plans executed against it so far.
