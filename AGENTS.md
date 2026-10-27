# APEX Agent Instructions

## Shared branch: GitHub `main` is the source of truth
- `main` is the only permanent development branch for all agents and tools (VS Code, Arena, local agents, and future tools). Do not create permanent agent-, environment-, or routine-validation branches.
- A branch name is not synchronization. Before starting, fetch the remote and inspect both local and remote state. Recommended sequence:
  ```sh
  git status --short --branch
  git fetch origin
  git log -5 --oneline --decorate --all
  git rev-parse HEAD
  git rev-parse origin/main
  ```
- If the working tree has edits or untracked files, preserve and inspect them before switching, merging, or editing. Never use `reset --hard`, `clean`, force-push, or overwrite files to make the workspace look current.
- Work on `main` when the workspace is safe and synchronized. If a separate workspace is technically necessary, use a temporary workspace/patch and reconcile it back onto the latest `main`; do not make a permanent agent branch.
- Keep changes small and focused. Inspect the diff and run relevant tests before publishing.
- Immediately before publishing, fetch again and inspect `origin/main`. If it advanced, reconcile the new commits and rerun affected tests. Never force-push or blindly merge an entire historical/agent branch.
- Push only when the resulting commit is a safe fast-forward from the latest remote `main`. After pushing, fetch again and verify `git rev-parse origin/main` equals the intended published commit SHA. Report the SHA.
- If a tool cannot inspect a local working tree, run tests, or safely push, say so explicitly; do not imply that those steps happened. Use GitHub as the shared source of truth and coordinate sequentially where needed.

## Project boundaries
- `apex_app/` is the runnable APEX application.
- `stark/` contains historical and experimental neural research. Preserve its historical identifiers and do not rename it wholesale.
- APEX Intelligence and APEX Neural Research evolve independently; integrate them only through explicit, validated contracts.
- The Executive Control Plane (ECP) is the sole authorization authority. Model-generated plans are proposals, never permission.
- Resource Fabric, where implemented, owns resource availability and allocation.
- Do not claim a model integration works until genuine inference against an actual configured backend has been run.
- Do not claim the entire APEX vision is complete because a milestone or test suite passes.

## Safety and evidence
- Model output is untrusted input. It may propose plans but cannot grant itself authorization.
- Do not add arbitrary shell/code execution or destructive actions without explicit authorization and tests.
- Preserve research evidence, failed results, provenance, and conflicting records; never silently rewrite inconvenient results.
- Report exact tests run, outcomes, untested environments, and remaining limitations.
