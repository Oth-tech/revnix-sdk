# Releasing

Releases are automated. Every merge to revnix-app's `main` dispatches this
repo's `Release` workflow (`.github/workflows/release.yml`), which:

1. runs typecheck + tests on `main`;
2. on an automatic (`bump: auto`) run, checks whether the code moved since
   the last release — no code changes means the run stops here: no bump, no
   PR, no publish, no tag, no release, and the job still succeeds. A forced
   bump (`major`/`minor`/`patch`) always releases, changes or not;
3. otherwise reads `## Unreleased` in `CHANGELOG.md` to pick the bump —
   `### Breaking` → major, `### Added` → minor, anything else → patch;
4. bumps `package.json`, `package-lock.json`, `src/version.ts`, dates the
   changelog entry, and lands it through a pull request merged with a merge
   commit (the org ruleset allows nothing else on `main`);
5. publishes the merge commit to npm via trusted publishing (OIDC);
6. tags it `vX.Y.Z` and cuts a GitHub release with the changelog entry.

So the only thing a change needs is a bullet under the right `###` heading in
`## Unreleased`. Run it by hand from the Actions tab (`bump` can force a level
and release even with nothing new).

One-time setup (an npm owner and an org admin): on npmjs.com, package
`react-native-revnix` → Settings → Trusted Publisher → GitHub Actions, organisation
`Oth-tech`, repository `revnix-sdk`, workflow `release.yml`. Nothing else is
needed here; the dispatching token lives in revnix-app.
