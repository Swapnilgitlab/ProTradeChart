## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How I tested it

<!-- Unit tests added or changed? What did you try in the running app (`npm run tauri:dev`)? -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] `cargo fmt --check`, `cargo clippy -- -D warnings` and `cargo test --lib` pass (if Rust changed)
- [ ] New behaviour in parsers / request planning / resampling / the store has tests
- [ ] No new network destinations (or the README's *Data sources* section is updated)
- [ ] Vela's attribution is untouched
- [ ] Every commit is signed off (`git commit -s`; see CONTRIBUTING)
- [ ] Any new dependency is AGPL-3.0-compatible, and `npm run licenses` was re-run
