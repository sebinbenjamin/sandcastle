# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-ff --no-edit` — the `--no-ff` flag is required so an interrupted run can identify branches Git already merged
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. If a branch cannot be merged, stop and report the blocker without emitting the completion signal
4. After resolving conflicts, run `npm run typecheck` and `npm run test` to verify everything works
5. If tests fail, fix the issues before proceeding to the next branch

If git reports that a branch is already up to date (it was merged by an earlier run), skip the merge for that branch but still close its issue below.

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`{{CLOSE_TASK_COMMAND}}`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
