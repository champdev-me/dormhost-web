@AGENTS.md

## Releases

**Every release gets a git tag. No exceptions.** Anything that reaches production counts. Bump `version` in `package.json` in the release commit, patch unless told otherwise, then:

```bash
git tag -a v<version> -m v<version>
git push origin HEAD --follow-tags
```

Never tag without bumping, and never reuse a version.
