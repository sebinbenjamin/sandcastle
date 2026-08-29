# Maintaining this personal fork

This repository is a private customization fork. Keep your small, focused
customization commits on `main`; upstream changes are incorporated by rebasing
those commits onto the latest original `main`.

## Remotes

- `origin` is this fork: `sebinbenjamin/sandcastle`
- `upstream` is the original project: `mattpocock/sandcastle`

`upstream` is intentionally configured to fetch only `main`, so `git fetch
upstream` keeps the fetch limited to `upstream/main`.

## Bringing in upstream updates

Start from a clean working tree, then run:

```powershell
git switch main
git fetch upstream
git rebase upstream/main
```

If Git reports a conflict, resolve it, then continue with:

```powershell
git add <resolved-files>
git rebase --continue
```

To abandon the rebase and return to the exact pre-rebase state, use:

```powershell
git rebase --abort
```

After testing the result, update this fork:

```powershell
git push --force-with-lease origin main
```

`--force-with-lease` is needed because rebasing rewrites the local commit
history. It refuses to overwrite new remote commits you have not fetched.

## Adding a customization

Make the change on `main` and commit it separately with a clear message. The
next rebase will replay that commit after the latest `upstream/main`. Keeping
customizations small and independent makes conflicts quick to resolve.
