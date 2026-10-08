<!--
Thanks for the pull request. Security fixes: please report privately to security@cipherline.chat first (see SECURITY.md).
This repo holds the current stable release, so accepted changes are applied in our development repo and ship in a
later release; see CONTRIBUTING.md.
-->

## What this changes

<!-- What does it fix or add, and why? Link the issue if there is one. -->

## How you tested it

<!-- Commands you ran, what you checked by hand, and on which OS. -->

## Checklist

- [ ] `npm test`, `npm run lint` and `npm run typecheck` pass in `apps/desktop`
- [ ] Tests added or updated for changed behaviour
- [ ] No new or hand-rolled cryptography, and nothing persisted in plaintext
- [ ] Any new dependency is permissively licensed and listed in `apps/desktop/LICENSES.md` if Apache/BSD
