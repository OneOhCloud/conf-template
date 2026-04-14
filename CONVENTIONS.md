# conf-template conventions

This repo ships `sing-box` config templates to OneBox (and any other client
that pulls them off the CDN). Before you edit anything, read this file.

## The contract

1. **`scripts/convention/intent/<region>.ts` is the only data source that
    humans edit.** Every file under `conf/**/*.jsonc` is auto-generated
    from it. Your hand-edits to the generated files will be wiped by the
    next `pnpm generate` run.

2. **`scripts/convention/generator/*.ts` is the code that compiles intent
    into a sing-box config.** You edit this when sing-box itself gains a
    new required field, changes syntax, or deprecates something. You do
    NOT edit it to change which domains route where — that's intent data.

3. **Every run is validated.** Static checks (reference integrity,
    forbidden legacy fields, required preamble, **DNS/route consistency**,
    **tag anchor priority**) + `sing-box check` (under `--strict` /
    `SING_BOX_BIN`) both run before any file is written. A failure
    aborts the run and touches nothing.

4. **Intent is version-agnostic; generator is version-specific.** Every
    supported sing-box version (`1.12`, `1.13`, `1.13.8`) currently uses
    the same generator because its output is 1.12-compatible. When a
    future sing-box ships breaking syntax, add a new file under
    `generator/` and dispatch by version in `scripts/generate.ts`. The
    intent files stay untouched.

5. **Intent is region-specific; generator is region-agnostic.** A new
    region means dropping a new file under `intent/`, importing it into
    the registry in `generate.ts`, and re-running. The generator is a
    pure function of `(intent, variant)` → `Config`, so no new generator
    code is needed.

## Why this shape

Hand-editing N variants × M versions × K regions of deeply-nested JSONC
was the old way. It produced:

- `tun-rules` and `mixed-rules` drifting apart (different captive domain
  lists, different sniff syntax, different `ip_is_private` placement)
- `conf/1.13/` dropping `dns.rules` at some point without `conf/1.12/`
  noticing, causing `www.qq.com → overseas IP` in production
- Tag anchor rules (`*-tag.oneoh.cloud`) accidentally moving below
  `rule_set` matching, silently demoting user custom rules
- Stray references to undefined rule_sets or DNS servers that sing-box
  accepted at parse time but misrouted at runtime

The intent layer removes all of these by construction:

- One list of direct rule_sets drives both `route.rules` (direct outbound)
  AND `dns.rules` (system transport). Adding one without the other is
  literally impossible.
- Tag anchor rules are emitted at fixed positions 4-5 by the generator.
  Moving them requires editing the generator, which trips the "are you
  sure?" review bar.
- Validator rejects every orphan reference before it reaches disk, so
  "works in one variant but not another" can't happen.

## Directory layout

```
conf-template/
├── scripts/
│   ├── generate.ts                          # entry: compose → validate → emit
│   └── convention/
│       ├── types.ts                         # RegionIntent, Variant, Version, Region
│       ├── intent/
│       │   └── zh-cn.ts                     # zh-cn's direct set, proxy set, tag anchors, rule_set registry
│       ├── generator/
│       │   └── sing-box-v1-13-8.ts          # current sing-box generator (1.12+ compatible)
│       └── validator.ts                     # static rules + DNS/route consistency + tag anchor priority
├── conf/
│   ├── 1.13.8/<region>/*.jsonc              # AUTO-GENERATED — do not edit
│   ├── 1.13/<region>/*.jsonc                # AUTO-GENERATED — do not edit
│   └── 1.12/<region>/*.jsonc                # AUTO-GENERATED — do not edit
└── CONVENTIONS.md                           # this file
```

## Usage

```bash
# install deps (one-time)
pnpm install

# normal edit cycle: modify scripts/convention/intent/<region>.ts, then:
pnpm generate

# full check with sing-box check on every file
SING_BOX_BIN=/path/to/sing-box pnpm generate:strict

# dry run — validate only, don't write
pnpm check
```

After `pnpm generate`, `git diff` shows you exactly what changed across
every generated file. Review, commit, push. CI (`validate-templates.yml`)
will re-run the generator and fail if the committed output drifts from
what the current intent + generator produces.

## OneBox runtime contracts (`CONTRACT_*` in `types.ts`)

Before intent data, there's a layer of **load-bearing strings that OneBox's
runtime merger depends on by exact match**. These live as named constants
in `scripts/convention/types.ts` and never appear as editable intent
fields — intent files physically can't set them wrong.

The contracts:

| Constant | Value | Why it's load-bearing |
|---|---|---|
| `CONTRACT_DNS_TAGS.SYSTEM` | `system` | OneBox routes direct-dial resolution to this server tag |
| `CONTRACT_DNS_TAGS.DNS_PROXY` | `dns_proxy` | `dns.final` fallback; must be TCP-over-proxy |
| `CONTRACT_DNS_TAGS.FAKEIP` | `remote` | TUN variants reverse-map fakeip → domain at connect time |
| `CONTRACT_OUTBOUND_TAGS.DIRECT` | `direct` | terminal bypass outbound — always required |
| `CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY` | `ExitGateway` | user-facing proxy selector; OneBox appends user nodes here |
| `CONTRACT_OUTBOUND_TAGS.AUTO` | `auto` | urltest fallback; OneBox appends user nodes here too |
| `CONTRACT_INBOUND_TAGS.TUN` | `tun` | `configureTunInbound` finds this inbound by tag |
| `CONTRACT_INBOUND_TAGS.MIXED` | `mixed` | `configureMixedInbound` finds this inbound by tag |
| `CONTRACT_TAG_ANCHORS.DIRECT_DOMAIN` | `direct-tag.oneoh.cloud` | user custom direct rules get injected into the route rule containing this domain |
| `CONTRACT_TAG_ANCHORS.PROXY_DOMAIN` | `proxy-tag.oneoh.cloud` | user custom proxy rules ditto |
| `CONTRACT_MIXED_LISTEN_PORT` | `6789` | hardcoded in TUN `platform.http_proxy` AND in OneBox's system-proxy config |
| `CONTRACT_FAKEIP_RANGES` | `198.18.0.0/15` / `fc00::/18` | RFC-reserved, sing-box recognises these as "fake"; changing them would break the DNS cache |

**Editing contracts is a multi-repo break.** You have to change the same
strings in OneBox's runtime merger (`src/config/merger/main.ts`,
`src/config/merger/helper.ts`, `scripts/sync-templates.ts`, etc.) or
OneBox's merger will fail to find the nodes it expects. Don't touch
these without a cross-repo plan.

**Contract enforcement**: the validator asserts that every generated
config contains the expected `tag` / domain / port values. Running
`pnpm generate` on an output with a broken contract fails immediately.

## The intent layer (`scripts/convention/intent/<region>.ts`)

Every `RegionIntent` object holds:

### `dnsServers`

Three named transports that the generator wires into `dns.servers`:

- **`systemDns`**: resolves directly, without proxy. For zh-cn this is
  DNSPod CN (`119.29.29.29`). Direct-routed traffic uses this.
- **`dnsProxy`**: resolves through the proxy egress. `tcp` type with
  `detour: ExitGateway`. For non-CN traffic.
- **`fakeIp`**: synthetic IP pool (`198.18.0.0/15`). Only used in TUN
  variants to avoid leaking proxy-destined hostnames to the system
  resolver.

### `directSet` — routed direct AND resolved via `systemDns`

The single source of truth for "this should go direct". The generator
reads it twice:

- **From the route builder**, to emit `{ outbound: direct, rule_set, domain, domain_suffix, ip_is_private, process_path }` route rules.
- **From the DNS builder**, to emit `{ server: system, rule_set, domain }` DNS rules.

Fields that apply to both (route AND DNS): `ruleSets`, `domains`. Fields
that apply only to route: `domainSuffixes`, `ipIsPrivate`, `processPaths`,
`processPathRegex`.

Editing:
- New CN rule_set (e.g. a new geosite category)? Add to `ruleSets` +
  register the URL in `ruleSetDefinitions`.
- New captive portal / always-direct domain (e.g. `captive.example.com`)?
  Add to `domains`.
- New suffix that should always route direct (LAN or ISP Wi-Fi portal)?
  Add to `domainSuffixes`. The same list applies to every variant; see
  `types.ts::DirectSet.domainSuffixes` for why unioning is strictly better
  than the old per-variant split.

### `proxySet` — routed `ExitGateway` AND resolved via `fakeIp` / `dnsProxy`

Same single-source principle in reverse. Route rules that force traffic
through the proxy get their DNS resolved either via fakeip (tun variants)
or via fallthrough to `dns.final = dns_proxy` (mixed variants).

### `tagAnchors`

Two magic domain names that OneBox's runtime merger uses as injection
points for user-supplied custom direct / proxy rules. The generator emits
them at **route.rules positions 4 and 5** — after the LAN guard, before
any rule_set matching. The validator double-checks this.

Do NOT move these unless you're willing to break the user-custom-rule
priority contract. OneBox finds these anchors by exact domain match at
runtime (`setTunConfig` / `setMixedConfig` in `merger/main.ts`), so the
domain strings are load-bearing.

### `ruleSetDefinitions`

URL registry for every `rule_set` referenced by `directSet` or `proxySet`.
The generator emits this verbatim into every variant's `route.rule_set`
block. Adding a new entry without a corresponding reference, or
referencing a tag without an entry here, trips the validator.

## The generator layer (`scripts/convention/generator/*.ts`)

Currently a single file, `sing-box-v1-13-8.ts`, targeting sing-box 1.12+
syntax. It exports `build(intent, variant) → SingBoxConfig`.

### What it knows (variant-specific logic)

- **tun-* have a tun inbound, mixed-* don't.** Only difference at the
  inbound level. TUN inbound carries the `route_exclude_address` list
  and the `platform.http_proxy` macOS system proxy hint.
- **tun-* include a `fakeIp` DNS server, mixed-* don't.** Mixed mode
  doesn't need fakeip because HTTP CONNECT delivers real hostnames to
  the mixed inbound.
- **rules variants emit tag anchors + proxy set + rule_set-based
  direct set. Global variants only emit the captive direct set and fall
  everything else to `route.final = ExitGateway`.**

### What it UNIFIES (variant-agnostic logic)

- **Sniff action**: `{ "action": "sniff" }` at `route.rules[0]`, no
  `inbound` filter. Matches every inbound's traffic. Tun variants used
  to have per-inbound sniff rules; merged to one because `action: sniff`
  with no filter has identical behaviour.
- **hijack-dns**: logical OR `(protocol=dns | port=53)` at `route.rules[1]`.
  Mixed variants used this already; tun variants historically used the
  simpler `protocol: dns` form. Merged to the OR form because it's
  strictly more permissive (catches port-53 traffic that sniffing hasn't
  classified yet).
- **LAN guard**: `{ ip_is_private: true, outbound: direct }` at
  `route.rules[3]`, BEFORE tag anchors. In TUN variants this is dead
  weight (LAN is already filtered by `route_exclude_address`), but cost
  is zero and it makes the generator variant-agnostic.
- **Direct domain suffixes**: the union of LAN-style (`.local`, `.lan`)
  and ISP captive portal suffixes (`.ksjhaoka.com`) applied in every
  variant. Neither list hurts the other variant (LAN suffixes in mixed
  mode are dead, captive portal suffixes in TUN mode actually fix Wi-Fi
  login on captive networks).

## Validator (`scripts/convention/validator.ts`)

Runs on every generator output before write. Checks:

1. **Required top-level blocks** (dns, inbounds, route, outbounds)
2. **DNS server references**: every `dns.rules[].server` and `dns.final`
   must exist in `dns.servers`
3. **Rule set references**: every `rule_set` in `dns.rules` and
   `route.rules` must exist in `route.rule_set`
4. **Outbound references**: every `route.rules[].outbound`, `route.final`,
   and `outbound[].outbounds[]` must exist (including implicit `direct` /
   `block`)
5. **Forbidden legacy fields**: no `sniff` / `sniff_override_destination`
   on any inbound (rejected by 1.13.8)
6. **Variant structural requirements**: `tun-*` must have a `tun` inbound;
   `mixed-*` must not
7. **Required route rules preamble**: `route.rules[0-3]` must be exactly
   sniff / hijack-dns / quic reject / LAN guard in that order
8. **Tag anchor priority** (rules variants only): both anchors must appear
   AFTER the LAN guard at position 3 and BEFORE any rule_set-based
   matching. Catches the "user custom rules silently demoted" class
   structurally.
9. **DNS / route consistency** (rules variants only): every rule_set
   routed `direct` in route.rules must resolve via `system` in dns.rules,
   and every rule_set routed `ExitGateway` must NOT resolve via `system`.
   Catches the `www.qq.com → overseas IP` class structurally.

A failure throws `ValidationError` and aborts the run. The validator
runs BEFORE any file write, so failed runs leave the repo clean.

## `sing-box check` (optional, `--strict`)

Runs the real sing-box parser against an in-memory patched copy of each
config. The patch injects a stub direct outbound into empty `auto.outbounds` /
`ExitGateway.outbounds` placeholders (OneBox fills these at runtime from
user subscriptions) so the check doesn't fail on "missing tags". The real
on-disk file is never modified.

This catches everything the static validator forgot to encode.

## Output format

Every generated `.jsonc` starts with a 5-line header:

```jsonc
// AUTO-GENERATED by scripts/generate.ts — do not edit by hand.
// Source: scripts/convention/intent/<region>.ts + scripts/convention/generator/*
// Regenerate: pnpm generate
// Variant: <variant>   Version: <version>   Region: <region>
// CDN path: https://cdn.jsdelivr.net/gh/OneOhCloud/conf-template@dev/conf/<version>/<region>/<variant>.jsonc
```

Followed by stable-formatted JSON (4-space indent). No inline comments in
the body — the intent layer is where the comments live.

## Adding things

- **New domain / rule_set / process rule** for an existing region →
  edit `intent/<region>.ts`. One file, one field, done.
- **New region** (e.g. `en-us`) → create `intent/en-us.ts`, add `'en-us'`
  to `Region` in `types.ts`, register it in the `INTENTS` map in
  `scripts/generate.ts`.
- **New sing-box version that breaks syntax** → create
  `generator/sing-box-vX-Y-Z.ts`, add a dispatch branch in the
  `GENERATORS` map in `scripts/generate.ts`. Old generator stays for
  older versions.
- **New variant type** (e.g. `tun-game-mode`) → add to `Variant` in
  `types.ts`, add a builder in the generator, add variant-specific
  validator rules if needed.

## CI

`.github/workflows/validate-templates.yml` runs on every push to
stable/beta/dev or PR touching `conf/`, `scripts/`, or the workflow
itself. It:

1. Installs deps with `pnpm install --frozen-lockfile`
2. Downloads sing-box v1.13.8 linux-amd64 binary from GitHub releases
3. Runs `pnpm generate:strict` (with `SING_BOX_BIN` set)
4. Runs `git diff --exit-code` to verify no drift between committed and
   generated files

Drift detection catches three failure modes:
- Someone edited a generated `.jsonc` file directly (their changes are
  overwritten by regeneration, diff non-empty)
- Someone edited `intent/<region>.ts` but forgot to run `pnpm generate`
  locally (derived output stale, diff non-empty)
- Someone modified `generator/*.ts` without committing the regenerated
  output (same)

## Known limitation: version-specific sing-box check

CI downloads a single sing-box binary (1.13.8) and runs it against every
generated file. This proves every output is accepted by the 1.13.8
parser, but NOT that `conf/1.12/` outputs are accepted by a real 1.12
parser.

For us this is fine because:
- Our generator's output uses features that have been stable since
  1.11 (route-rule sniff, `dns.rules` split routing, fakeip server type,
  `default_domain_resolver`).
- OneBox ships exactly one sing-box binary per release, and the
  `conf/1.12/` / `conf/1.13/` dirs exist only for backward compat with
  older OneBox builds stuck on those kernels — those builds already
  have their own validated binaries.

If the risk ever materializes (some 1.12 regression surfaces), add a
second `SING_BOX_BIN_1_12=...` env var and run `generate:strict` a
second time with it pointing at the 1.12 binary.
