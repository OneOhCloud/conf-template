/**
 * sing-box config generator pinned to the `1.12` version bucket.
 * Verified against sing-box 1.12.x (`sing-box check`).
 *
 * Naming convention: one generator file per `conf/<bucket>/` folder,
 * name in lockstep with the folder. This file is frozen at the pre-1.13
 * output shape — no syntax only 1.13+ accepts, no rules that would be
 * dead weight on 1.12 kernels. When the 1.13 and 1.13.8 buckets were
 * forked, this file intentionally stayed put: its sole purpose is to
 * keep producing exactly what a 1.12 kernel's `sing-box check` accepts.
 * New features live in the newer buckets' generators; this one only
 * moves if 1.12 kernels themselves change shape, which by definition
 * they no longer do.
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
 * builder emits tag anchor rules at fixed positions 4 and 5 (after LAN
 * guard, before any rule_set matching). The validator double-checks.
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
            url: 'https://www.google.com/generate_204',
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
    mtu: 9000,
    stack: 'gvisor',
    auto_route: true,
    strict_route: true,
    // LAN address ranges excluded at the TUN inbound layer — these packets
    // never enter the route.rules matcher, so the `ip_is_private` LAN guard
    // rule in route.rules is dead code for TUN variants. Kept anyway for
    // generator symmetry (mixed variants do need it).
    route_exclude_address: [
        '10.0.0.0/8',
        '100.64.0.0/10',
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

    // Direct set → system DNS.
    if (opts.isRules) {
        rules.push({
            domain: intent.directSet.domains,
            rule_set: intent.directSet.ruleSets,
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
 * The preamble: rules 0-3, identical in every variant.
 *   0. Universal sniff — `{ action: "sniff" }`, no inbound filter.
 *   1. hijack-dns via logical OR (protocol=dns OR port=53).
 *   2. QUIC reject.
 *   3. LAN guard: private IPs → direct, BEFORE user tag anchors.
 */
function buildRoutePreamble(): unknown[] {
    return [
        { action: 'sniff' },
        {
            type: 'logical',
            mode: 'or',
            rules: [{ protocol: 'dns' }, { port: 53 }],
            action: 'hijack-dns',
        },
        { protocol: 'quic', action: 'reject' },
        { ip_is_private: true, outbound: CONTRACT_OUTBOUND_TAGS.DIRECT },
    ];
}

/** Tag anchor pair — user custom rule injection points. Domains are
 *  contracts, not intent data. */
function buildTagAnchorRules(): unknown[] {
    return [
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
    opts: { isRules: boolean },
): unknown[] {
    const rules: unknown[] = [...buildRoutePreamble()];

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
    opts: { isRules: boolean },
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
        route: buildRoute(intent, { isRules }),
        // Deep-clone so mutations by OneBox's runtime merger don't bleed
        // across multiple builds in the same process.
        experimental: JSON.parse(JSON.stringify(EMPTY_EXPERIMENTAL)),
        outbounds: buildOutbounds(),
    };
}
