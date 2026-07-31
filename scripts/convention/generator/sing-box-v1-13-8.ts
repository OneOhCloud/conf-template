/**
 * sing-box config generator pinned to the `1.13.8` version bucket.
 * Verified against sing-box 1.13.8 (`sing-box check`).
 *
 * Naming convention: one generator file per `conf/<bucket>/` folder,
 * name in lockstep with the folder. The existence of this bucket as
 * a sibling of `1.13` marks the fork point of a breaking change —
 * `scripts/sync-templates.ts` in the OneBox repo routes clients on
 * sing-box ≥ 1.13.8 here instead of `1.13`. The current output happens
 * to be identical to `sing-box-v1-13.ts`, but the files stay separate
 * so the next breaking change in either lineage only touches one.
 *
 * Content currently matches `sing-box-v1-13.ts`. When they diverge,
 * record the delta (and the reason) in the comment block below.
 *
 * Diff vs baseline (`sing-box-v1-12.ts`):
 *   + TUN variants emit an `{ network: "icmp", action: "route",
 *     outbound: "direct" }` rule after the LAN guard, so `ping` through
 *     TUN returns real end-to-end RTT instead of the TUN interface's
 *     loopback RTT. See `buildIcmpDirectRule` for the full rationale.
 *     This uses the `network: "icmp"` route rule introduced in
 *     sing-box 1.13.0.
 *
 * Layer contract:
 *   - Takes a `RegionIntent` + `Variant` → produces a valid `SingBoxConfig`.
 *   - OneBox contract strings (DNS tag names, outbound tag names, inbound
 *     tag names, tag anchor domains, ports) come from `CONTRACT_*`
 *     constants in `../types.ts`, NOT from intent. The intent layer can't
 *     rename them even if someone wanted to — the generator hard-wires
 *     the contracts.
 *   - Variant differences that are PURELY structural (tun has tun inbound,
 *     mixed doesn't; rules have tag anchors + proxy set, global doesn't)
 *     are handled here.
 *   - Variant differences that are just formatting (sniff syntax,
 *     hijack-dns syntax, where ip_is_private lives) are MERGED — the
 *     generator emits the most-robust form in every variant.
 *
 * DNS / route consistency is guaranteed by construction: `directSet` is
 * read once by the route builder (→ `outbound: direct`) and once by the
 * dns builder (→ `server: system`). Same for `proxySet`. They cannot drift.
 *
 * Tag anchor priority is guaranteed by construction: the rules variant
 * builder emits tag anchor rules after the LAN guard, before any rule_set
 * matching, with reject before direct before proxy. The validator double-checks.
 */

import type {
    DirectSet,
    ProxySet,
    RegionIntent,
    SingBoxConfig,
    Variant,
} from '../types';
import {
    CONTRACT_DNS_TAGS,
    CONTRACT_FAKEIP_RANGES,
    CONTRACT_INBOUND_TAGS,
    CONTRACT_MIXED_LISTEN_PORT,
    CONTRACT_OUTBOUND_TAGS,
    CONTRACT_TAG_ANCHORS,
} from '../types';

// ---------------------------------------------------------------------------
// Static blocks shared across variants
// ---------------------------------------------------------------------------

const BASE_LOG = {
    disabled: false as const,
    level: 'debug',
    timestamp: false as const,
};

const EMPTY_EXPERIMENTAL = {
    // `clash_api` and `cache_file` are placeholders. OneBox's
    // `updateExperimentalConfig` (in src/config/merger/main.ts) overwrites
    // both at merge time with user-specific values (secret, cache_file path).
    // The generator ships empty objects so the runtime has something to
    // extend in place.
    clash_api: {},
    cache_file: {},
};

/**
 * Outbounds. OneBox's runtime merger appends user subscription nodes into
 * `auto.outbounds` and `ExitGateway.outbounds` — the static config ships
 * these arrays empty on purpose. `sing-box check` rejects empty selectors,
 * so the generator's validator patches in a stub before check.
 *
 * Every tag name here comes from a `CONTRACT_*` constant.
 */
function buildOutbounds(): unknown[] {
    return [
        {
            tag: CONTRACT_OUTBOUND_TAGS.DIRECT,
            type: 'direct',
            // Pin direct outbound's own resolution to the `system` DNS
            // transport. Bypasses dns.rules for the direct-dial path so
            // CN direct traffic resolves via DNSPod CN regardless of
            // dns.rules layout.
            domain_resolver: CONTRACT_DNS_TAGS.SYSTEM,
        },
        {
            tag: CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY,
            type: 'selector',
            outbounds: [CONTRACT_OUTBOUND_TAGS.AUTO],
            interrupt_exist_connections: true,
        },
        {
            tag: CONTRACT_OUTBOUND_TAGS.AUTO,
            type: 'urltest',
            url: 'http://www.gstatic.com/generate_204',
            outbounds: [] as string[],
        },
    ];
}

// ---------------------------------------------------------------------------
// Inbound builders — contracts for tag names and port
// ---------------------------------------------------------------------------

const TUN_INBOUND = {
    tag: CONTRACT_INBOUND_TAGS.TUN,
    type: 'tun',
    address: [
        '172.19.0.1/30',
        'fdfe:dcba:9876::1/126',
    ],
    // macOS system HTTP proxy auto-injection — apps respecting system
    // proxy settings (Safari, most Cocoa apps) go to the mixed inbound
    // instead of through TUN. See CLAUDE.md for the full story.
    platform: {
        http_proxy: {
            enabled: true,
            server: '127.0.0.1',
            server_port: CONTRACT_MIXED_LISTEN_PORT,
        },
    },
    // TUN 侧 MTU 只决定本机应用与用户态栈之间的分段大小，不是真实链路 MTU，
    // 故 jumbo 值买不到吞吐；而用户态栈的每连接收发环按 MTU 派生，9000 会把
    // 每连接常驻抬到 4 倍，在有硬性内存上限的宿主（iOS NetworkExtension）上
    // 足以致命。取 1500 与真实链路一致。
    mtu: 1500,
    stack: 'gvisor',
    auto_route: true,
    strict_route: true,
    // LAN address ranges excluded at the TUN inbound layer — these packets
    // never enter the route.rules matcher, so the `ip_is_private` LAN guard
    // rule in route.rules is dead code for TUN variants. Kept anyway for
    // generator symmetry (mixed variants do need it).
    route_exclude_address: [
        '10.0.0.0/8',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.0.0.0/24',
        '192.168.0.0/16',
        '224.0.0.0/4',
        '240.0.0.0/4',
        '255.255.255.255/32',
        'fe80::/10',
        'fc00::/7',
        'ff01::/16',
        'ff02::/16',
        'ff03::/16',
        'ff04::/16',
        'ff05::/16',
    ],
};

// Mixed inbound. No `reuse_addr` / `tcp_fast_open` — older systems may
// not support them and they're not strictly necessary, so we default to
// off for broadest compatibility.
const MIXED_INBOUND = {
    tag: CONTRACT_INBOUND_TAGS.MIXED,
    type: 'mixed',
    listen: '127.0.0.1',
    listen_port: CONTRACT_MIXED_LISTEN_PORT,
    set_system_proxy: false,
};

function buildInbounds(opts: { hasTun: boolean }): unknown[] {
    return opts.hasTun ? [TUN_INBOUND, MIXED_INBOUND] : [MIXED_INBOUND];
}

// ---------------------------------------------------------------------------
// DNS block builder
// ---------------------------------------------------------------------------

function buildDnsServers(
    intent: RegionIntent,
    opts: { hasFakeIp: boolean },
): unknown[] {
    const servers: unknown[] = [
        // `system` — direct UDP DNS. Tag pinned by contract.
        {
            tag: CONTRACT_DNS_TAGS.SYSTEM,
            type: 'udp',
            server: intent.dnsServers.systemDns.server,
            server_port: intent.dnsServers.systemDns.serverPort ?? 53,
            connect_timeout: intent.dnsServers.systemDns.connectTimeout ?? '5s',
        },
        // `dns_proxy` — TCP DNS forced through ExitGateway. Tag + detour
        // pinned by contract so OneBox's merger finds it.
        {
            tag: CONTRACT_DNS_TAGS.DNS_PROXY,
            type: 'tcp',
            server: intent.dnsServers.dnsProxy.server,
            server_port: intent.dnsServers.dnsProxy.serverPort ?? 53,
            detour: CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY,
            connect_timeout: intent.dnsServers.dnsProxy.connectTimeout ?? '5s',
        },
    ];
    if (opts.hasFakeIp) {
        // `remote` — fakeip. Only in TUN variants.
        servers.push({
            tag: CONTRACT_DNS_TAGS.FAKEIP,
            type: 'fakeip',
            inet4_range: CONTRACT_FAKEIP_RANGES.INET4,
            inet6_range: CONTRACT_FAKEIP_RANGES.INET6,
        });
    }
    return servers;
}

function buildDnsRules(
    intent: RegionIntent,
    opts: { hasFakeIp: boolean; isRules: boolean },
): unknown[] {
    const rules: unknown[] = [
        // Universal: reject HTTPS / SVCB / PTR queries.
        //
        // Three independent reasons, all still valid in sing-box 1.13.8:
        //   1. FakeIP transport hard-errors on anything that isn't A or
        //      AAAA (`dns/transport/fakeip/fakeip.go:65`: "only IP queries
        //      are supported by fakeip"). Any rule further down that
        //      routes tiktok/linkedin/catchall to `remote` (fakeip) would
        //      crash the lookup for HTTPS/SVCB. Rejecting at the top
        //      closes the hole structurally.
        //   2. HTTPS records carry `SVCB_IPV4HINT` / `SVCB_IPV6HINT` and
        //      enable Encrypted ClientHello (ECH). Clients that use these
        //      hints bypass our SNI-based proxy-set routing; ECH further
        //      encrypts the ClientHello so TUN layer can't sniff the
        //      target domain at all. Our whole split-routing model depends
        //      on SNI being readable, so HTTPS records are hostile.
        //   3. PTR reverse lookups for fakeip addresses are meaningless
        //      (the answer IP is synthetic) and for real IPs they leak
        //      client destination choices. Cheap to drop.
        //
        // Before removing this rule, verify all three reasons have been
        // addressed in whatever sing-box version you're on.
        {
            query_type: ['HTTPS', 'SVCB', 'PTR'],
            action: 'reject',
        },
    ];

    // Rules mode + tun only: proxy set → fakeip.
    if (opts.isRules && opts.hasFakeIp) {
        rules.push({
            domain_suffix: intent.proxySet.domainSuffixes,
            rule_set: intent.proxySet.ruleSets,
            server: CONTRACT_DNS_TAGS.FAKEIP,
        });
    }

    // Direct set → system DNS. Domain-matching rule_sets only: an IP rule_set
    // listed alongside domains is inert. A DNS rule ignores ip_cidr items
    // while matching the question (`rule_dns.go` `Match` sets
    // `IgnoreDestinationIPCIDRMatch`), and the answer check
    // (`MatchAddressLimit`) passes as soon as ANY item matched — the domain
    // hit alone satisfies it, so a non-CN answer is never rejected. The IP set
    // only filters anything as a rule of its own, which is the next one.
    if (opts.isRules) {
        rules.push({
            domain: intent.directSet.domains,
            rule_set: intent.directSet.ruleSets.filter((tag) => tag !== intent.directSet.ipRuleSet),
            strategy: 'prefer_ipv4',
            server: CONTRACT_DNS_TAGS.SYSTEM,
        });
        // Known-overseas domains: straight to the proxy-side resolver, before
        // the address filter below can probe them at `system`. Two reasons:
        // a poisoned answer that happens to land inside the in-region IP set
        // would be adopted and route that domain direct into a blackhole, and
        // even when the poison is caught the probe is a wasted round trip.
        rules.push({
            rule_set: [intent.proxySet.foreignDomainRuleSet],
            server: opts.hasFakeIp ? CONTRACT_DNS_TAGS.FAKEIP : CONTRACT_DNS_TAGS.DNS_PROXY,
        });
        // Everything nobody listed: probe `system`, keep the answer only if
        // it is an in-region or private address. sing-box reads the
        // rule_set's ip_cidr items and `ip_is_private` here as an ADDRESS
        // FILTER — a non-matching response makes this rule skipped and
        // matching continues, so foreign domains fall through to the fakeip
        // catchall (tun) or dns.final (mixed) and reach the proxy as a
        // domain, not an IP.
        //
        // Carries no `query_type` on purpose: a DNS rule with one is skipped
        // on the internal-lookup path (internal lookups have no query type),
        // which would kill this rule silently.
        rules.push({
            rule_set: [intent.directSet.ipRuleSet],
            ip_is_private: true,
            // Domains with no AAAA answer NODATA. An empty address set has
            // nothing for the filter to test, so without this the rule is
            // judged non-matching and the query falls through to fakeip —
            // a China-hosted domain then leaves over the proxy on its v6
            // fake address. Deprecated upstream, removal slated for 1.16.0.
            rule_set_ip_cidr_accept_empty: true,
            strategy: 'prefer_ipv4',
            server: CONTRACT_DNS_TAGS.SYSTEM,
        });
    } else {
        // Global mode: only captive portals resolve via system, everything
        // else falls through to dns.final.
        rules.push({
            domain: intent.directSet.domains,
            strategy: 'prefer_ipv4',
            server: CONTRACT_DNS_TAGS.SYSTEM,
        });
    }

    // Fakeip catchall for A/AAAA/CNAME (tun variants only).
    if (opts.hasFakeIp) {
        rules.push({
            query_type: ['A', 'AAAA', 'CNAME'],
            server: CONTRACT_DNS_TAGS.FAKEIP,
            strategy: 'prefer_ipv4',
        });
    }

    return rules;
}

function buildDns(
    intent: RegionIntent,
    opts: { hasFakeIp: boolean; isRules: boolean },
): SingBoxConfig['dns'] {
    return {
        servers: buildDnsServers(intent, opts),
        rules: buildDnsRules(intent, opts),
        final: CONTRACT_DNS_TAGS.DNS_PROXY,
        strategy: 'prefer_ipv4',
    };
}

// ---------------------------------------------------------------------------
// Route block builder — unified shape across all variants
// ---------------------------------------------------------------------------

/**
 * The preamble.
 *   0. Universal sniff — `{ action: "sniff" }`, no inbound filter.
 *   1. hijack-dns via logical OR (protocol=dns OR port=53).
 *   2. QUIC reject.
 *   3. Non-TUN rules variants only: resolve (see below).
 *   4. LAN guard: private IPs → direct, BEFORE user tag anchors.
 */
function buildRoutePreamble(
    intent: RegionIntent,
    opts: { isRules: boolean; hasTun: boolean },
): unknown[] {
    const preamble: unknown[] = [
        { action: 'sniff' },
        {
            type: 'logical',
            mode: 'or',
            rules: [{ protocol: 'dns' }, { port: 53 }],
            action: 'hijack-dns',
        },
        { protocol: 'quic', action: 'reject' },
    ];

    // Non-TUN rules variants only. A proxy-protocol client hands over a
    // hostname, so the destination stays a domain and NO IP rule can ever
    // match: without this, an in-region host nobody listed falls through to
    // route.final and gets proxied, and the LAN guard never fires either.
    // Resolving fills `metadata.DestinationAddresses`, which the IP rules
    // below (and the direct set's IP rule_set) then match on.
    //
    // TUN must NOT have this. There the client resolves through our hijacked
    // DNS first, so in-region hosts already arrive as a real IP and everything
    // else arrives as a fakeip that maps back to its domain — a resolve would
    // undo exactly that and hand the egress an IP instead of the hostname.
    //
    // Scoped to the mixed inbound, and inverted against the known-overseas
    // set. Two conditions, both load-bearing:
    //
    //   inbound = mixed — a proxy-protocol client hands over a hostname, so
    //     the destination stays a domain and no IP rule (LAN guard included)
    //     can ever match. The TUN datapath must NOT be resolved: there the
    //     client already resolved through our hijacked DNS, so in-region
    //     hosts arrive as a real IP and everything else arrives as a fakeip
    //     the router maps back to its domain. Both variants carry a mixed
    //     inbound — in the TUN variants it is what `platform.http_proxy`
    //     points at — so both need this, and neither wants it wider.
    //
    //   NOT in the known-overseas set — those keep their FQDN so the egress
    //     receives the hostname and resolves it itself, matching what fakeip
    //     gives the TUN datapath. The remainder (in-region hosts, LAN names,
    //     anything unlisted) is resolved, which is exactly the set that needs
    //     an IP for the rules below to fire.
    //
    // Cost is confined to that remainder: a lookup before routing, and a
    // failed lookup drops the connection.
    if (opts.isRules) {
        preamble.push({
            type: 'logical',
            mode: 'and',
            rules: [
                { inbound: [CONTRACT_INBOUND_TAGS.MIXED] },
                { rule_set: [intent.proxySet.foreignDomainRuleSet], invert: true },
            ],
            action: 'resolve',
            strategy: 'prefer_ipv4',
        });
    }

    preamble.push({ ip_is_private: true, outbound: CONTRACT_OUTBOUND_TAGS.DIRECT });
    return preamble;
}

/**
 * ICMP echo (ping) → `direct`. TUN variants only.
 *
 * Since sing-box 1.13.0, TUN pre-match lifts ICMP echo to the route layer;
 * matched rules whose outbound implements `DirectRouteOutbound` (direct /
 * wireguard / tailscale) send a real ICMP probe via that outbound's dialer
 * and transparently proxy the reply back, so `ping` sees the real end-to-end
 * RTT instead of the TUN interface's loopback RTT.
 *
 * Pinned to `direct` (not `ExitGateway`) because:
 *   - Without an explicit rule, ICMP falls back to `route.final` (ExitGateway).
 *     ExitGateway is a selector; the underlying proxy protocols OneBox ships
 *     (shadowsocks, vmess, trojan, hysteria, vless, ...) do NOT implement
 *     `DirectRouteOutbound`, so the fallback path errors and ICMP is dropped.
 *   - `direct` + `auto_detect_interface: true` binds the probe socket to
 *     the default non-TUN interface, so the ICMP packet leaves the box
 *     through the real network — not back into TUN — and returns real RTT.
 *
 * Pre-1.13 kernels never lift ICMP to the route layer, so this rule is
 * a harmless no-op there (the v1.12 bucket in `conf/1.12/**` still ships
 * it, but no packet ever matches it).
 *
 * Placed at position 4: after the LAN guard at position 3 (so ICMP to a
 * private IP still follows the LAN guard's `direct` decision, which is the
 * same outcome anyway), and before tag anchors — users who inject custom
 * domain/ip rules via the anchors can't accidentally retarget ICMP at a
 * proxy that can't carry it. Tag anchors shift to positions 5/6; the
 * validator's `idx >= 4` check still holds.
 */
function buildIcmpDirectRule(): unknown {
    return {
        network: 'icmp',
        action: 'route',
        outbound: CONTRACT_OUTBOUND_TAGS.DIRECT,
    };
}

/** Tag anchors — user custom rule injection points. Domains are
 *  contracts, not intent data. */
function buildTagAnchorRules(): unknown[] {
    return [
        {
            domain: [CONTRACT_TAG_ANCHORS.REJECT_DOMAIN],
            domain_suffix: [],
            ip_cidr: [],
            action: 'reject',
        },
        {
            domain: [CONTRACT_TAG_ANCHORS.DIRECT_DOMAIN],
            domain_suffix: [],
            ip_cidr: [],
            outbound: CONTRACT_OUTBOUND_TAGS.DIRECT,
        },
        {
            domain: [CONTRACT_TAG_ANCHORS.PROXY_DOMAIN],
            domain_suffix: [],
            ip_cidr: [],
            outbound: CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY,
        },
    ];
}

function buildProxyRouteRule(proxySet: ProxySet): unknown {
    return {
        domain_suffix: proxySet.domainSuffixes,
        rule_set: proxySet.ruleSets,
        outbound: CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY,
    };
}

function buildDirectRouteRule(
    directSet: DirectSet,
    opts: { isRules: boolean },
): unknown {
    const rule: Record<string, unknown> = {
        domain: directSet.domains,
        domain_suffix: directSet.domainSuffixes,
        outbound: CONTRACT_OUTBOUND_TAGS.DIRECT,
    };
    if (opts.isRules) {
        rule.rule_set = directSet.ruleSets;
    }
    return rule;
}

function buildProcessDirectRule(directSet: DirectSet): unknown {
    return {
        process_path: directSet.processPaths,
        process_path_regex: directSet.processPathRegex,
        outbound: CONTRACT_OUTBOUND_TAGS.DIRECT,
    };
}

function buildRouteRules(
    intent: RegionIntent,
    opts: { isRules: boolean; hasTun: boolean },
): unknown[] {
    const rules: unknown[] = [...buildRoutePreamble(intent, opts)];

    if (opts.hasTun) {
        rules.push(buildIcmpDirectRule());
    }

    if (opts.isRules) {
        rules.push(...buildTagAnchorRules());
        rules.push(buildProxyRouteRule(intent.proxySet));
        rules.push(buildDirectRouteRule(intent.directSet, { isRules: true }));
        rules.push(buildProcessDirectRule(intent.directSet));
    } else {
        rules.push(buildDirectRouteRule(intent.directSet, { isRules: false }));
    }

    return rules;
}

function buildRoute(
    intent: RegionIntent,
    opts: { isRules: boolean; hasTun: boolean },
): SingBoxConfig['route'] {
    return {
        rules: buildRouteRules(intent, opts),
        final: CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY,
        default_domain_resolver: CONTRACT_DNS_TAGS.SYSTEM,
        auto_detect_interface: true,
        rule_set: intent.ruleSetDefinitions,
    };
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Compile a region intent + variant into a fully-formed sing-box config.
 * Pure function — no file I/O, no network, no side effects.
 */
export function build(intent: RegionIntent, variant: Variant): SingBoxConfig {
    const hasTun = variant.startsWith('tun-');
    const isRules = variant.endsWith('-rules');

    return {
        log: BASE_LOG,
        dns: buildDns(intent, { hasFakeIp: hasTun, isRules }),
        inbounds: buildInbounds({ hasTun }),
        route: buildRoute(intent, { isRules, hasTun }),
        // Deep-clone so mutations by OneBox's runtime merger don't bleed
        // across multiple builds in the same process.
        experimental: JSON.parse(JSON.stringify(EMPTY_EXPERIMENTAL)),
        outbounds: buildOutbounds(),
    };
}
