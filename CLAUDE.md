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

**(b) Tag anchor priority.** For every `-rules` variant, the three tag
anchor rules — reject, then direct, then proxy, whose exact domain strings
are contract constants — must appear in `route.rules` BEFORE any
**routing** rule that uses `rule_set` matching. This preserves the
"user-injected custom rule" priority contract that downstream consumers
rely on — a runtime merger that appends into the anchor rules' `domain` /
`domain_suffix` / `ip_cidr` arrays should win against the built-in geosite
matching.

Only rules that decide an outbound count. A non-final action — the scoped
`resolve` in (d) — may reference a rule_set earlier without taking the
decision away from a user's custom rule: whatever it resolves or skips,
the anchors still match first when the outbound is picked.

**(c) Contract tag presence.** Every generated config must contain DNS
server tags / outbound tags / inbound tags / tag anchor domains / mixed
listen port equal to the `CONTRACT_*` constants. Duplicate tags in
`dns.servers` and `outbounds` are rejected. This guards against a future
refactor of the generator accidentally drifting from the runtime
consumer contract.

**(d) Required preamble.** Every variant's `route.rules` must start with
`sniff` / `hijack-dns` / `quic reject` in positions 0–2. `-rules` variants
then carry a `resolve` at position 3, moving the `ip_is_private` LAN guard
to 4; `-global` variants carry no route-level resolve and keep the LAN
guard at 3. Any other shift is a structural bug.

That resolve is scoped twice, and both scopes are load-bearing:

- **`inbound: ["mixed"]`** — a proxy-protocol client hands over a
  hostname, so on that path the destination stays a domain and no IP rule
  (LAN guard included) can ever match. The TUN datapath must NOT be
  resolved: there the client already resolved through our hijacked DNS, so
  in-region hosts arrive as a real IP and everything else arrives as a
  fakeip the router maps back to its domain. Both TUN and mixed variants
  ship a mixed inbound — in the TUN variants it is what
  `platform.http_proxy` points at — so both need the rule and neither
  wants it wider.
- **inverted against `proxySet.foreignDomainRuleSet`** — known-overseas
  domains keep their FQDN, so the egress receives the hostname and
  resolves it itself, matching what fakeip gives the TUN datapath. The
  remainder (in-region hosts, LAN names, anything unlisted) is resolved,
  which is exactly the set that needs an IP for the rules below to fire.

**(e) Forbidden legacy fields.** No inbound may carry `sniff` or
`sniff_override_destination` — these were deprecated in sing-box 1.11
and rejected at startup in 1.13.8. The validator catches a regression
where someone manually re-introduces them.

**(f) Reference integrity.** Every `rule_set` reference (in `dns.rules`,
`route.rules`, and `outbound[].outbounds`) must resolve to a defined tag.
Every `dns.final` / `route.final` must name an existing server /
outbound. Catches typos before sing-box sees the config.

**(g) In-region address filter.** Every `-rules` variant's `dns.rules`
must carry `{rule_set: [<ipRuleSet>], ip_is_private: true, server:
system}` between the direct set rule and the fakeip catchall, and that
rule must NOT carry `query_type`. It is what makes an *unlisted* domain
that resolves into the region route direct: sing-box asks `system` first
and adopts the answer only if it lands in the region or on a private
address, otherwise the rule is skipped and the query falls through to
fakeip / `dns.final`. A `query_type` on it would make sing-box skip it on
the internal-lookup path, killing the filter silently.

The known-overseas short-circuit (`proxySet.foreignDomainRuleSet` →
proxy-side resolver) must come before it, or a poisoned CN answer for a
foreign domain gets adopted and routed direct — verified poison addresses
that land inside `geoip-cn`: `202.106.199.34`, `159.106.121.75`.

An *unconditional* route-level resolve would be the wrong tool for the
same job: it fills `metadata.DestinationAddresses` for every destination,
and sing-box then dials each outbound from that list, so proxied
connections reach the egress as an IP. That is why the resolve in (d) is
scoped to the mixed inbound and skips the known-overseas set.

Failure mode of validation: `ValidationError` is thrown, `generate.ts`
prints the error block, no files are touched. CI surface is a red cross
on the PR with the error inline.

## Deployment prerequisite: the client's DNS must flow through the tunnel

The whole split-routing model assumes the client asks *our* resolver. If it
doesn't, the client gets a poisoned answer, connects straight to that IP,
and the router can only hand that dead address to the egress — no config
rule recovers it (sing-box 1.13.8's `sniff` action has no
`override_destination`, so a sniffed hostname cannot replace an IP
destination).

This is not hypothetical: on macOS, `mDNSResponder` sends interface-scoped
queries to the ISP-provided resolver and never enters TUN, so a CLI-only
`sing-box run` of the TUN template leaves foreign sites broken while CN
sites work. Verified — only explicitly-targeted `dig` traffic hit
`hijack-dns`; the system resolver's did not.

The host is responsible for pointing system DNS into the tunnel (OneBox
does it through its NetworkExtension; a CLI reproduction needs
`networksetup -setdnsservers <service> <public ip>`). With that in place the
same config resolves foreign domains to fakeip and the egress receives
hostnames.

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
| Change which rule_set defines "in-region IPs" | `intent/zh-cn.ts::directSet.ipRuleSet` — drives the DNS address filter; must also be listed in `ruleSets` |
| Change which rule_set defines "known-overseas domains" | `intent/zh-cn.ts::proxySet.foreignDomainRuleSet` — gates the address filter and the route-level resolve; DNS side only |
| Same for proxy rule_sets | `intent/zh-cn.ts::proxySet.*` |
| Switch CN direct DNS resolver | `intent/zh-cn.ts::dnsServers.systemDns.server` |
| Add a new region (e.g. `en-us`) | New file `intent/en-us.ts`, add `'en-us'` to `Region` in `types.ts`, register in `INTENTS` map in `generate.ts` |
| New sing-box kernel warrants a fork (breaking syntax, or a feature older buckets must not emit) | Create `conf/<bucket>/`, copy the latest generator to `generator/sing-box-v<bucket>.ts`, add a `VERSIONS` entry and a `GENERATORS` entry in `generate.ts`. One generator per bucket, never shared. |
| Add a new variant type (e.g. `tun-game`) | Add to `Variant` in `types.ts`, add a builder branch in the generator, add variant-specific validator rule |
| Runtime consumer's contract tag changed | Update `CONTRACT_*` in `types.ts`. **This is a cross-repo change** — coordinate with the consumer before merging |

## Anti-Patterns

- ❌ Hand-editing `conf/**/*.jsonc`. They're generator output. Your
  edits are deleted on next `pnpm generate`.
- ❌ Changing a `ruleSetDefinitions` entry's `format` under the same tag.
  Rule-sets are cached by tag and parsed with the currently declared
  format, so every deployed client with a warm cache fails to start
  (`restore cached rule-set: invalid sing-box rule-set file`). Add a new
  tag instead and retire the old entry later.
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
