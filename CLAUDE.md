# conf-template — Project Notes for Claude

This repo ships `sing-box` configuration templates over CDN. A small
generator compiles region-specific intent data into one `.jsonc` per
variant × version × region, validates the output both structurally and
semantically (via `sing-box check`), and commits the result. Downstream
clients fetch the templates at runtime by URL.

See `CONVENTIONS.md` for the operational manual (how to edit, how to run
the generator, how CI validates). This file documents the **design intent**
— why the layers are the way they are — so any future collaborator can
make the right trade-off when extending the repo.

## Design Philosophy

**1. One source of truth per concept, enforced by structure.**
The whole generator exists because hand-maintaining N variants × M
versions × K regions of nested JSONC led to silent drift — a rule added
to one variant but missed in another, `dns.rules` quietly dropped in one
version, tag anchor rules accidentally reordered. The architecture
eliminates every class of drift by making it structurally impossible:
one list of direct rule_sets drives both route rules and DNS rules in
every variant and every version, so forgetting to mirror one into the
other cannot happen.

**2. Data vs. code vs. contract are three separate layers.**
- **Intent** (`scripts/convention/intent/<region>.ts`) is region-specific
  data — domain lists, rule_set references, upstream DNS server IPs.
  Declarative, version-agnostic, contract-free. Safe to edit.
- **Generator** (`scripts/convention/generator/*.ts`) is version-specific
  code — the compiler that emits valid sing-box syntax for a particular
  kernel version family. Edit only when sing-box itself changes.
- **Contract** (`CONTRACT_*` constants in `scripts/convention/types.ts`)
  are load-bearing strings that runtime consumers depend on by exact
  match — DNS server tags, outbound tags, inbound tags, tag anchor
  domains, reserved ports. Intent files physically can't set these
  wrong because they don't appear as editable fields.

The split means every axis evolves independently: add a region → drop
one file under `intent/`. Add a sing-box version that breaks syntax →
drop one file under `generator/`. Update a CN domain list → edit intent.
None of these touches any other axis.

**3. Validation is enforced at every generator run, not hoped for.**
Static checks (`scripts/convention/validator.ts`) + real-kernel checks
(`sing-box check`) both run before any file is written to disk. A
failure aborts the run and leaves the repo clean. Two consistency
invariants are structurally enforced (see below).

**4. Cleanup is scorched-earth: regenerate, don't patch.**
The generated `.jsonc` files under `conf/**/` are never edited in place.
`pnpm generate` overwrites all of them from the current intent +
generator. CI (`validate-templates.yml`) runs `git diff --exit-code`
after regeneration to reject PRs where committed output drifts from
what the current source produces.

**5. Version-specific code, version-agnostic data.**
Generator files are **1:1 with `conf/<bucket>/` folders** — the bucket's
existence is the signal that some breaking change warranted its own
lineage, so it owns its own generator even if, at fork time, the output
is byte-identical to the previous bucket's. Today that means
`sing-box-v1-12.ts` for `1.12`, `sing-box-v1-13.ts` for `1.13`, and
`sing-box-v1-13-8.ts` for `1.13.8`. Filenames mirror folder names —
`sing-box-v<bucket>.ts`. Never point two buckets at the same generator;
if you're tempted to, you probably don't need the new bucket. Intent
files stay untouched — region data doesn't know or care about sing-box
version.

**6. Trade-off bias: small edge-case loss for structural guarantees.**
The generator unifies variant differences wherever merging is strictly
better (e.g. universal `{"action":"sniff"}` instead of per-inbound
sniff rules, union of LAN suffix lists across tun/mixed). Dead weight
in one variant (an LAN guard rule in TUN where `route_exclude_address`
already filters) is accepted as the price of keeping the generator
variant-agnostic. Inline comments in edited `.jsonc` files are lost on
regeneration — the intent layer is where load-bearing commentary lives.

**One-liner**: *Intent files describe what you want; generator files
describe how to serialise it; contract constants describe what the
runtime forces us to emit verbatim; the validator refuses to produce
anything else.*

## Layer Architecture

```
scripts/convention/
├── types.ts                         # types + CONTRACT_* constants
├── intent/
│   └── zh-cn.ts                     # region data (editable)
├── generator/
│   └── sing-box-v<bucket>.ts        # intent → SingBoxConfig, one file per conf/<bucket>/
└── validator.ts                     # static rules + consistency invariants
         │
         ▼
scripts/generate.ts                  # entry: compose → validate → sing-box check → emit
         │
         ▼
conf/<version>/<region>/<variant>.jsonc  (auto-generated product, committed)
```

A generator is a pure function `(RegionIntent, Variant) → SingBoxConfig`.
Zero I/O, zero globals, zero mutation of inputs. All side effects happen
in `generate.ts` (file writes, network if running `sing-box check`).

## Invariants the Validator Enforces

**(a) DNS / route consistency.** For every `-rules` variant, every
rule_set routed `direct` in `route.rules` MUST also resolve via `system`
in `dns.rules`, and every rule_set routed `ExitGateway` MUST NOT resolve
via `system`. This catches the "CN domain routed direct but DNS resolved
via proxy egress → returns overseas CDN IPs" class structurally. You
cannot add a rule_set to `directSet.ruleSets` without the generator
emitting it in both `route.rules` and `dns.rules` — the data is single-
sourced, and the validator cross-checks the output anyway as a belt.

**(b) Tag anchor priority.** For every `-rules` variant, the two tag
anchor rules (whose exact domain strings are contract constants) must
appear in `route.rules` BEFORE any rule using `rule_set` matching. This
preserves the "user-injected custom rule" priority contract that
downstream consumers rely on — a runtime merger that appends into the
anchor rules' `domain` / `domain_suffix` / `ip_cidr` arrays should win
against the built-in geosite matching.

**(c) Contract tag presence.** Every generated config must contain DNS
server tags / outbound tags / inbound tags / tag anchor domains / mixed
listen port equal to the `CONTRACT_*` constants. Duplicate tags in
`dns.servers` and `outbounds` are rejected. This guards against a future
refactor of the generator accidentally drifting from the runtime
consumer contract.

**(d) Required preamble.** Every variant's `route.rules` must start with
exactly `sniff` / `hijack-dns` / `quic reject` / `ip_is_private LAN
guard` in positions 0–3. Any shift of these is a structural bug.

**(e) Forbidden legacy fields.** No inbound may carry `sniff` or
`sniff_override_destination` — these were deprecated in sing-box 1.11
and rejected at startup in 1.13.8. The validator catches a regression
where someone manually re-introduces them.

**(f) Reference integrity.** Every `rule_set` reference (in `dns.rules`,
`route.rules`, and `outbound[].outbounds`) must resolve to a defined tag.
Every `dns.final` / `route.final` must name an existing server /
outbound. Catches typos before sing-box sees the config.

Failure mode of validation: `ValidationError` is thrown, `generate.ts`
prints the error block, no files are touched. CI surface is a red cross
on the PR with the error inline.

## `sing-box check` (semantic validation)

Static validation catches what we know to look for. `sing-box check`
catches everything else, because it's the same parser + validator that
actual sing-box runtime uses. The generator's strict mode patches a stub
outbound into empty `auto.outbounds` / `ExitGateway.outbounds`
placeholders (downstream runtimes fill these in), writes the patched
copy to a temp file, runs check, and deletes the temp. The real on-disk
file is never modified during check.

`SING_BOX_BIN=/path/to/sing-box pnpm generate:strict` runs this locally.
CI downloads a pinned 1.13.8 Linux binary from the sing-box GitHub
releases and runs the same check on every emitted file.

## When to Edit Which Layer

| Change | Edit |
|---|---|
| Add / remove a domain for CN direct routing | `intent/zh-cn.ts::directSet.domains` |
| Add / remove a CN rule_set category | `intent/zh-cn.ts::directSet.ruleSets` (+ `ruleSetDefinitions` if new tag) |
| Same for proxy rule_sets | `intent/zh-cn.ts::proxySet.*` |
| Switch CN direct DNS resolver | `intent/zh-cn.ts::dnsServers.systemDns.server` |
| Add a new region (e.g. `en-us`) | New file `intent/en-us.ts`, add `'en-us'` to `Region` in `types.ts`, register in `INTENTS` map in `generate.ts` |
| New sing-box kernel warrants a fork (breaking syntax, or a feature older buckets must not emit) | Create `conf/<bucket>/`, copy the latest generator to `generator/sing-box-v<bucket>.ts`, add a `VERSIONS` entry and a `GENERATORS` entry in `generate.ts`. One generator per bucket, never shared. |
| Add a new variant type (e.g. `tun-game`) | Add to `Variant` in `types.ts`, add a builder branch in the generator, add variant-specific validator rule |
| Runtime consumer's contract tag changed | Update `CONTRACT_*` in `types.ts`. **This is a cross-repo change** — coordinate with the consumer before merging |

## Anti-Patterns

- ❌ Hand-editing `conf/**/*.jsonc`. They're generator output. Your
  edits are deleted on next `pnpm generate`.
- ❌ Adding tag names / anchor domains / reserved ports as intent fields.
  Those are contracts, not region data — they go in `CONTRACT_*`.
- ❌ Introducing variant-specific logic via per-variant intent fields.
  The generator owns variant differences (tun vs mixed inbound, rules
  vs global routing). Intent is variant-agnostic.
- ❌ Committing `conf/**/*.jsonc` changes without committing the
  corresponding `intent/` or `generator/` change. CI drift check
  rejects this, but it still wastes a round-trip.
- ❌ Skipping `pnpm generate:strict` locally when touching the
  generator. Silent `sing-box check` regressions become CI red crosses
  much later.

## Pointers

- `CONVENTIONS.md` — operational manual: install, edit cycle, commands,
  detailed intent field reference, CI configuration.
- `scripts/convention/types.ts` — type definitions + `CONTRACT_*`
  constants with per-constant "why this is load-bearing" comments.
- `scripts/convention/intent/zh-cn.ts` — example region intent with
  editing guide comments.
- `scripts/convention/validator.ts` — all validation rules with
  reasoning inline.
- `.github/workflows/validate-templates.yml` — CI contract.
