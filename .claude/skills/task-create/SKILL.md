---
name: task-create
description: Add a new task to the project's Tasks sheet and create an artifact with everything needed to implement it (logic, relevant files and design). Use when the user asks to add or create a task or ticket.
argument-hint: <what the task should do>
---

# Create a task

Task to create: $ARGUMENTS

If no task is described above, ask the user what it should do.

Plan the task only. Do not implement it, change project code or commit.

## 1. Learn the current state

- Read `CLAUDE.md` for the Tasks sheet link, its columns and the ID and status rules.
- Read the `Tasks` tab. The new ID is the highest existing `TN-<index>` plus one.
- Read the code the task touches, and check the real data in `data/` when the task depends on it. Everything the artifact states must match what is there now.

## 2. Create the implementation artifact

Publish one artifact that lets someone implement the task without further research. It must include:

- **Design**: how it looks and feels. For anything visible, include a working or visual mockup that matches the app's existing style, using real data where possible.
- **Behavior**: what happens in each situation, including closing, cancelling and edge cases.
- **Relevant files**: each file to add or edit and what changes in it, plus existing functions and types to reuse.
- **Logic**: the approach, with real code for the non-obvious parts, using the project's actual names.
- **Build order**: the steps, in order.
- **Done when**: specific, checkable results, using real examples from the data.
- **Out of scope**: related work this task does not cover.

Put the new task ID at the top of the artifact.

## 3. Add the row

Append one row to the `Tasks` tab, then read it back to confirm it landed:

| Column | Value |
|---|---|
| Title | Short imperative name, like the existing rows |
| ID | The new `TN-<index>`, as plain text |
| Description | One or two sentences on what the task covers |
| Dependencies | IDs of the tasks this one builds on, e.g. `TN-3, TN-5`. Blank if none |
| Planned artifacts link | The published artifact URL |
| Status | `backlog` |

## 4. Report back

Give the task ID, the artifact link and the sheet link. Mention any decisions you made that the user may want to change, and that the artifact is private until it is shared.
