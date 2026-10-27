# APEX Agent Instructions

## Shared branch
- `main` is the canonical shared branch for APEX work.
- Before editing, inspect the current branch, working tree, and latest commits. Pull the latest `main` before starting.
- Do not create or switch to another branch unless the owner explicitly asks.
- Never discard, reset, clean, overwrite, or rebase away existing user work.
- Keep commits focused; run the relevant tests before committing.
- Push only after verifying the commit is based on the latest `main`. If concurrent work moved `main`, fetch and reconcile without force-pushing.

## Project boundaries
- `apex_app/` is the runnable APEX application.
- `stark/` contains historical and experimental neural research. Preserve its historical identifiers and do not rename it wholesale.
- Do not claim a model integration works until genuine inference against an actual configured backend has been run.
- Do not claim the entire APEX vision is complete because a milestone or test suite passes.

## Safety and evidence
- Model output is untrusted input. It may propose plans but cannot grant itself authorization.
- Do not add arbitrary shell/code execution or destructive actions without explicit authorization and tests.
- Preserve research evidence, failed results, provenance, and conflicting records; never silently rewrite inconvenient results.
- Report exact tests run, outcomes, untested environments, and remaining limitations.
