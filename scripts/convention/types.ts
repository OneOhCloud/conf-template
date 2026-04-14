/**
 * Convention types — intent layer + generator output shape + OneBox contracts.
 *
 * Two layers + one contract:
 *
 *   - Intent (`RegionIntent`): region-specific DATA. Declarative,
 *     version-agnostic. Lives under `scripts/convention/intent/<region>.ts`.
 *     Editing intent changes WHICH DNS servers / rule_sets / domains are
 *     used. Safe to edit.
 *
 *   - Generator (`scripts/convention/generator/*.ts`): version-specific
 *     CODE. Compiles an intent + variant into a sing-box config. Editing
 *     the generator changes HOW the intent is serialised into sing-box
 *     syntax. Touch only when sing-box itself changes.
 *
 *   - Contract (`CONTRACT_*` constants below): OneBox-runtime-facing tag
 *     names and magic strings. OneBox's runtime config merger
 *     (`setTunConfig` / `setMixedConfig` / `updateVPNServerConfigFromDB`
 *     in `OneBox/src/config/merger/main.ts`) finds DNS servers, outbounds,
 *     inbounds, and the user custom-rule injection anchors BY EXACT TAG /
 *     DOMAIN MATCH. Changing any of these strings breaks OneBox's merger.
 *     They live in this file as named constants so:
 *       1. the generator refers to them symbolically (not via literals)
 *       2. the validator asserts every generated config uses them
 *       3. the intent layer never gets to choose them — they're not even
 *          fields on `RegionIntent`, so editing intent can't break OneBox
 *
 * Strict DNS / route consistency, tag anchor priority, DNS/route
 * symmetry, and reserved-tag presence are all enforced by the validator
 * on every generator output.
 */

// ===========================================================================
// OneBox contracts — reserved strings the runtime merger depends on
// ===========================================================================

/**
 * DNS server tags that OneBox's runtime keys off. Changing these breaks
 * the DNS routing. See OneBox `src/config/merger/main.ts` for usages.
 */
export const CONTRACT_DNS_TAGS = {
    /** Direct DNS transport — used for CN-whitelisted queries. */
    SYSTEM: 'system',
    /** Proxy-detoured DNS transport — used as `dns.final` for everything else. */
    DNS_PROXY: 'dns_proxy',
    /** FakeIP transport — used in TUN variants for proxy-destined A/AAAA. */
    FAKEIP: 'remote',
} as const;

/**
 * Outbound tags that OneBox's runtime keys off. `updateVPNServerConfigFromDB`
 * iterates the `outbounds` array, merges subscription nodes, and appends
 * their tags into `ExitGateway.outbounds` and `auto.outbounds`. If any of
 * these tag names are wrong, subscriptions fail to bind.
 */
export const CONTRACT_OUTBOUND_TAGS = {
    /** Direct outbound — terminal, bypass. */
    DIRECT: 'direct',
    /** Proxy selector — user-visible name in the UI, points at `AUTO`. */
    EXIT_GATEWAY: 'ExitGateway',
    /** urltest outbound — OneBox appends subscription node tags here. */
    AUTO: 'auto',
} as const;

/**
 * Inbound tags. `configureTunInbound` / `configureMixedInbound` find the
 * inbound to tweak by tag. Changing these breaks DHCP / allow-lan handling.
 */
export const CONTRACT_INBOUND_TAGS = {
    TUN: 'tun',
    MIXED: 'mixed',
} as const;

/**
 * Tag anchor domains — OneBox's runtime merger finds the route rule that
 * contains one of these in its `domain` array and appends user-supplied
 * custom direct/proxy rules into its `domain` / `domain_suffix` / `ip_cidr`
 * arrays. Changing these breaks user custom-rule injection.
 */
export const CONTRACT_TAG_ANCHORS = {
    DIRECT_DOMAIN: 'direct-tag.oneoh.cloud',
    PROXY_DOMAIN: 'proxy-tag.oneoh.cloud',
} as const;

/**
 * Mixed inbound listen port. OneBox hardcodes this as the `platform.http_proxy`
 * target for TUN variants AND as the system proxy port in mixed mode.
 * Changing it breaks platform HTTP proxy injection.
 */
export const CONTRACT_MIXED_LISTEN_PORT = 6789 as const;

/**
 * Fake IP ranges. These are RFC-reserved ranges that the TUN stack
 * recognises as "fake". Safe to leave as constants because changing them
 * would mean the user's runtime DNS cache (keyed on these ranges) would
 * collide with real traffic.
 */
export const CONTRACT_FAKEIP_RANGES = {
    INET4: '198.18.0.0/15',
    INET6: 'fc00::/18',
} as const;

// ===========================================================================
// Variant / Version / Region enums
// ===========================================================================

export type Variant = 'tun-rules' | 'tun-global' | 'mixed-rules' | 'mixed-global';
export type Version = '1.12' | '1.13' | '1.13.8';
export type Region = 'zh-cn';

export const VARIANTS: readonly Variant[] = [
    'tun-rules',
    'tun-global',
    'mixed-rules',
    'mixed-global',
] as const;

export const VERSIONS: readonly Version[] = ['1.13.8', '1.13', '1.12'] as const;

export const REGIONS: readonly Region[] = ['zh-cn'] as const;

// ===========================================================================
// rule_set registry entry
// ===========================================================================

export interface RuleSetRemote {
    tag: string;
    type: 'remote';
    format: 'binary' | 'source';
    url: string;
}

// ===========================================================================
// Intent — pure region-variable data. Tag names, anchors, ports, types
// are all owned by the contract constants above and don't appear here.
// ===========================================================================

/**
 * Minimal DNS transport description. The generator decides tag / type /
 * detour / inet ranges based on the contracts — intent only supplies the
 * server address and connection hints.
 */
export interface IntentUdpDns {
    /** Server address. */
    server: string;
    /** Port. Defaults to 53 if omitted. */
    serverPort?: number;
    /** Dial timeout, e.g. `'5s'`. */
    connectTimeout?: string;
}

export interface IntentTcpDns {
    server: string;
    serverPort?: number;
    connectTimeout?: string;
}

/**
 * The set of things that should route *direct* AND resolve via the
 * `system` DNS transport. The generator reads this block twice: once for
 * `route.rules` (as an `outbound: direct` rule) and once for `dns.rules`
 * (as a `server: system` rule). DNS/route consistency is guaranteed by
 * construction — they share this single source of truth.
 */
export interface DirectSet {
    /** rule_set tags routed direct AND resolved via `system` DNS. */
    ruleSets: string[];
    /** Explicit domains routed direct AND resolved via `system`. */
    domains: string[];
    /**
     * Domain suffixes routed direct. Union of LAN-style (`local`, `lan`)
     * and ISP captive portal (`.oneoh.cloud`) suffixes. Applied uniformly
     * in all variants — see `DirectSet.domainSuffixes` in the old types
     * for the full justification of why the union is strictly better
     * than the old per-variant split.
     */
    domainSuffixes: string[];
    /**
     * Whether private-IP traffic routes direct. Emitted as a SEPARATE early
     * route rule (before tag anchors) so user-custom proxy rules can never
     * accidentally tunnel LAN traffic. In TUN variants the rule is dead
     * weight (TUN inbound `route_exclude_address` already filters LAN
     * before route.rules runs), but costs nothing and keeps the generator
     * variant-agnostic.
     */
    ipIsPrivate: boolean;
    /** Process-based direct bypass — exact paths. */
    processPaths: string[];
    /** Process-based direct bypass — regex. */
    processPathRegex: string[];
}

/**
 * The set of things that should route *proxy* (ExitGateway) AND resolve
 * via fakeip (rules mode) or fall through to dns_proxy (no fakeip).
 * Mirror semantics to DirectSet.
 */
export interface ProxySet {
    ruleSets: string[];
    domainSuffixes: string[];
}

/** Intent for one region. Tag names, anchors, and ports are contracts,
 *  not intent — see CONTRACT_* constants. */
export interface RegionIntent {
    region: Region;
    label: string;
    dnsServers: {
        /** "Direct DNS" — used for CN whitelist resolution. */
        systemDns: IntentUdpDns;
        /** "Proxy DNS" — used as `dns.final`. The generator pins its
         *  outbound detour to `CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY`. */
        dnsProxy: IntentTcpDns;
    };
    directSet: DirectSet;
    proxySet: ProxySet;
    /** rule_set URL registry, union of references by directSet / proxySet. */
    ruleSetDefinitions: RuleSetRemote[];
}

// ===========================================================================
// Generator output type — shape of a valid sing-box config
// ===========================================================================

export interface SingBoxConfig {
    log: { disabled: false; level: string; timestamp: false };
    dns: {
        servers: unknown[];
        rules: unknown[];
        final: string;
        strategy?: string;
    };
    inbounds: unknown[];
    route: {
        rules: unknown[];
        final: string;
        default_domain_resolver?: string;
        auto_detect_interface?: boolean;
        rule_set: RuleSetRemote[];
    };
    experimental: {
        clash_api: Record<string, unknown>;
        cache_file: Record<string, unknown>;
    };
    outbounds: unknown[];
}
