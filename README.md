# conf-template

sing-box configuration templates, generated from a single region-intent
source of truth and served over CDN. Rule-set cache databases are
maintained on a separate orphan branch.

## Quickstart

```bash
pnpm install
pnpm generate          # build + validate, write conf/**
pnpm generate:strict   # also run `sing-box check` on each output
pnpm check             # dry-run: validate only, no writes
```

See [`CONVENTIONS.md`](./CONVENTIONS.md) for the operational manual and
[`CLAUDE.md`](./CLAUDE.md) for the design philosophy.

## Architecture

```
scripts/
├── generate.ts                           # pipeline entry
└── convention/
    ├── intent/<region>.ts                # region data — the only file humans edit
    ├── generator/sing-box-v1-13-8.ts     # version-specific compiler
    ├── validator.ts                      # ref integrity, DNS/route consistency, tag anchors
    └── types.ts                          # load-bearing contract constants

conf/<version>/<region>/<variant>.jsonc   # generated output — do NOT hand-edit
```

Every file under `conf/**` is auto-generated. Hand-edits are wiped by
the next `pnpm generate` run — edit intent instead.

## Matrix

- **Versions**: `1.12`, `1.13`, `1.13.8`
- **Regions**: `zh-cn`
- **Variants**: `tun-rules`, `tun-global`, `mixed-rules`, `mixed-global`

Adding a region means dropping a new `intent/<region>.ts` and
registering it in `scripts/generate.ts`. Adding a sing-box version with
breaking syntax means dropping a new `generator/*.ts` and dispatching by
version. The intent files stay untouched.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready configs |
| `stable` | Stable release configs |
| `beta` | Beta testing configs |
| `dev` | Development configs |
| `database` | Pre-built rule-set cache databases (orphan branch) |

## Rule-set cache databases

Pre-built cache databases live on the **`database`** branch at
`database/{env}/{version}/{locale}/*.db`, where `env` is one of `dev`,
`beta`, or `stable`. A daily CI workflow at 02:00 UTC rebuilds them by
running sing-box against the configs from each environment branch.

See the [`database` branch README](../../tree/database) for details.

## CDN

Templates are served via jsDelivr:

```
https://cdn.jsdelivr.net/gh/OneOhCloud/conf-template@<branch>/conf/<version>/<region>/<variant>.jsonc
```
