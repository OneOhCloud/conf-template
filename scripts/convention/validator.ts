/**
 * Static validator for generator output. Runs before `sing-box check` — the
 * two are complementary: static rules catch structural mistakes that would
 * crash sing-box (or silently misroute), while `sing-box check` catches
 * everything we forgot to encode here.
 *
 * New-in-this-architecture rules (beyond the basics):
 *
 *   1. DNS/route consistency. For every `-rules` variant, every rule_set
 *      routed `direct` in route.rules must also resolve via the `system`
 *      server in dns.rules; every rule_set routed `ExitGateway` must NOT
 *      resolve via `system`. This catches the `www.qq.com → overseas IP`
 *      regression structurally: you can't add a rule_set to
 *      `directSet.ruleSets` (route direct) without the generator also
 *      emitting it in dns.rules (server system).
 *
 *   2. Tag anchor priority. For every `-rules` variant, the tag anchor
 *      rules must appear BEFORE any rule_set-based matching. Otherwise
 *      user-custom-rules (merged at runtime into the anchor rules) lose
 *      priority to the built-in geosite rules.
 *
 *   3. In-region address filter. For every `-rules` variant, dns.rules must
 *      carry the `ip_is_private` + in-region rule_set filter, without a
 *      `query_type`, sitting between the direct set and the fakeip catchall.
 *      That rule is what lets an unlisted domain resolving into the region
 *      route direct while every other domain still reaches the proxy as a
 *      domain rather than an IP.
 */

import type { RegionIntent, SingBoxConfig, Variant } from './types';
import {
    CONTRACT_DNS_TAGS,
    CONTRACT_INBOUND_TAGS,
    CONTRACT_MIXED_LISTEN_PORT,
    CONTRACT_OUTBOUND_TAGS,
    CONTRACT_TAG_ANCHORS,
} from './types';

export class ValidationError extends Error {
    constructor(
        public readonly fileLabel: string,
        public readonly issues: string[],
    ) {
        super(`${fileLabel}: ${issues.length} validation issue(s)\n  ` + issues.join('\n  '));
    }
}

export function validate(
    config: SingBoxConfig,
    variant: Variant,
    intent: RegionIntent,
    fileLabel: string,
): void {
    const issues: string[] = [];

    // -- 1. top-level blocks --------------------------------------------
    if (!config.dns) issues.push('missing dns block');
    if (!config.inbounds || config.inbounds.length === 0) issues.push('missing inbounds');
    if (!config.route) issues.push('missing route block');
    if (!config.outbounds || config.outbounds.length === 0) issues.push('missing outbounds');

    const dns = config.dns ?? ({} as SingBoxConfig['dns']);
    const route = config.route ?? ({} as SingBoxConfig['route']);
    const inbounds = (config.inbounds ?? []) as any[];
    const outbounds = (config.outbounds ?? []) as any[];

    // -- 1a. OneBox contract tags MUST be present, by exact name --------
    // OneBox's runtime merger finds these by string match. The generator
    // uses CONTRACT_* constants so its output always conforms, but the
    // validator asserts here too in case someone hand-edits a generated
    // file or a future generator refactor drops one.
    const dnsServerTagList = (dns.servers ?? []).map((s) => (s as { tag: string }).tag);
    const dnsServerTagSet = new Set(dnsServerTagList);
    const outboundTagList = outbounds.map((o) => o.tag as string);
    const outboundTagSet = new Set(outboundTagList);
    const inboundTagSet = new Set(inbounds.map((i) => i.tag as string));

    const isTunVariant = variant.startsWith('tun-');
    const isRulesVariant = variant.endsWith('-rules');

    // DNS: system + dns_proxy always required; remote only for tun variants
    if (!dnsServerTagSet.has(CONTRACT_DNS_TAGS.SYSTEM)) {
        issues.push(`missing DNS server with contract tag "${CONTRACT_DNS_TAGS.SYSTEM}"`);
    }
    if (!dnsServerTagSet.has(CONTRACT_DNS_TAGS.DNS_PROXY)) {
        issues.push(`missing DNS server with contract tag "${CONTRACT_DNS_TAGS.DNS_PROXY}"`);
    }
    if (isTunVariant && !dnsServerTagSet.has(CONTRACT_DNS_TAGS.FAKEIP)) {
        issues.push(`${variant} requires DNS server with contract tag "${CONTRACT_DNS_TAGS.FAKEIP}"`);
    }
    if (!isTunVariant && dnsServerTagSet.has(CONTRACT_DNS_TAGS.FAKEIP)) {
        issues.push(
            `${variant} has DNS server "${CONTRACT_DNS_TAGS.FAKEIP}" but mixed variants ` +
                `shouldn't use fakeip (proxy-side resolution handles this)`,
        );
    }

    // Outbounds: direct, ExitGateway, auto always required
    for (const tag of [
        CONTRACT_OUTBOUND_TAGS.DIRECT,
        CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY,
        CONTRACT_OUTBOUND_TAGS.AUTO,
    ]) {
        if (!outboundTagSet.has(tag)) {
            issues.push(`missing outbound with contract tag "${tag}"`);
        }
    }

    // Inbounds: tun variants must have tun inbound, mixed variants must have mixed
    if (isTunVariant && !inboundTagSet.has(CONTRACT_INBOUND_TAGS.TUN)) {
        issues.push(`${variant} missing inbound with contract tag "${CONTRACT_INBOUND_TAGS.TUN}"`);
    }
    if (!inboundTagSet.has(CONTRACT_INBOUND_TAGS.MIXED)) {
        issues.push(`missing inbound with contract tag "${CONTRACT_INBOUND_TAGS.MIXED}"`);
    }

    // Mixed inbound listen_port must be the contract value
    const mixedInbound = inbounds.find((i) => i.tag === CONTRACT_INBOUND_TAGS.MIXED);
    if (mixedInbound && mixedInbound.listen_port !== CONTRACT_MIXED_LISTEN_PORT) {
        issues.push(
            `mixed inbound listen_port must be ${CONTRACT_MIXED_LISTEN_PORT} ` +
                `(OneBox's platform.http_proxy and system proxy settings hardcode it); ` +
                `got ${mixedInbound.listen_port}`,
        );
    }

    // Duplicate tag guards
    const dup = (list: string[]): string[] => {
        const seen = new Set<string>();
        const dups = new Set<string>();
        for (const s of list) {
            if (seen.has(s)) dups.add(s);
            seen.add(s);
        }
        return [...dups];
    };
    for (const d of dup(dnsServerTagList)) issues.push(`duplicate dns.servers tag: ${d}`);
    for (const d of dup(outboundTagList)) issues.push(`duplicate outbounds tag: ${d}`);

    // -- 2. DNS server references ---------------------------------------
    const dnsServerTags = new Set((dns.servers ?? []).map((s) => (s as { tag: string }).tag));
    if (dns.final && !dnsServerTags.has(dns.final)) {
        issues.push(`dns.final references missing server: ${dns.final}`);
    }
    for (const rule of (dns.rules ?? []) as any[]) {
        if (rule?.server && !dnsServerTags.has(rule.server)) {
            issues.push(`dns.rules[].server references missing server: ${rule.server}`);
        }
    }

    // -- 3. Rule set references -----------------------------------------
    const ruleSetTags = new Set((route.rule_set ?? []).map((rs) => rs.tag));
    const collectRuleSetRefs = (rules: any[]): string[] => {
        const refs: string[] = [];
        const walk = (r: any) => {
            if (Array.isArray(r?.rule_set)) refs.push(...r.rule_set);
            if (Array.isArray(r?.rules)) r.rules.forEach(walk);
        };
        rules.forEach(walk);
        return refs;
    };
    for (const ref of collectRuleSetRefs((dns.rules ?? []) as any[])) {
        if (!ruleSetTags.has(ref)) {
            issues.push(`dns.rules references missing rule_set: ${ref}`);
        }
    }
    for (const ref of collectRuleSetRefs((route.rules ?? []) as any[])) {
        if (!ruleSetTags.has(ref)) {
            issues.push(`route.rules references missing rule_set: ${ref}`);
        }
    }

    // -- 4. Outbound references -----------------------------------------
    const outboundTags = new Set(outbounds.map((o) => o.tag as string));
    outboundTags.add('direct');
    outboundTags.add('block');
    const walkRouteOutbounds = (r: any): string[] => {
        const refs: string[] = [];
        if (r?.outbound) refs.push(r.outbound);
        if (Array.isArray(r?.rules)) r.rules.forEach((sub: any) => refs.push(...walkRouteOutbounds(sub)));
        return refs;
    };
    for (const rule of (route.rules ?? []) as any[]) {
        for (const ref of walkRouteOutbounds(rule)) {
            if (!outboundTags.has(ref)) {
                issues.push(`route.rules references missing outbound: ${ref}`);
            }
        }
    }
    if (route.final && !outboundTags.has(route.final)) {
        issues.push(`route.final references missing outbound: ${route.final}`);
    }
    for (const ob of outbounds) {
        if (Array.isArray(ob.outbounds)) {
            for (const ref of ob.outbounds as string[]) {
                if (!outboundTags.has(ref)) {
                    issues.push(`outbound[${ob.tag}].outbounds references missing: ${ref}`);
                }
            }
        }
    }

    // -- 5. Version-specific forbidden fields (1.13.8+) -----------------
    for (const inb of inbounds) {
        if (inb.sniff !== undefined || inb.sniff_override_destination !== undefined) {
            issues.push(
                `inbound[${inb.tag}]: legacy sniff / sniff_override_destination is ` +
                    `rejected by sing-box 1.13.8; use a route rule \`{"action":"sniff"}\``,
            );
        }
    }

    // -- 6. Variant structural requirements -----------------------------
    const hasTunInbound = inbounds.some((i) => i.type === 'tun');
    if (isTunVariant && !hasTunInbound) {
        issues.push(`${variant} must have an inbound with type=tun`);
    }
    if (!isTunVariant && hasTunInbound) {
        issues.push(`${variant} must NOT have a tun inbound`);
    }

    // -- 7. Required route rules preamble -------------------------------
    // Every variant must have these four rules in this order:
    //   [0] action=sniff
    //   [1] hijack-dns (any shape)
    //   [2] protocol=quic → reject
    //   [3] ip_is_private=true → direct
    const rules = (route.rules ?? []) as any[];
    if (rules[0]?.action !== 'sniff' || rules[0]?.protocol) {
        issues.push('route.rules[0] must be {"action":"sniff"} (universal sniff)');
    }
    const r1 = rules[1];
    const r1IsHijack = r1?.action === 'hijack-dns';
    if (!r1IsHijack) {
        issues.push('route.rules[1] must have action "hijack-dns"');
    }
    if (rules[2]?.protocol !== 'quic' || rules[2]?.action !== 'reject') {
        issues.push('route.rules[2] must be {"protocol":"quic","action":"reject"}');
    }
    // `-rules` variants resolve at index 3, pushing the LAN guard to 4. That
    // rule is scoped twice, and both scopes are what keep it safe:
    //   - inbound = mixed, so the TUN datapath is untouched (there the client
    //     already resolved through our hijacked DNS, and resolving again would
    //     hand the egress an IP instead of the hostname);
    //   - inverted against the known-overseas set, so those domains keep their
    //     FQDN all the way to the egress.
    const expectsResolve = isRulesVariant;
    if (expectsResolve) {
        const resolveRule = rules[3];
        if (resolveRule?.action !== 'resolve') {
            issues.push(
                `${variant}: route.rules[3] must be a resolve — without it a host arriving on the ` +
                    `mixed inbound stays a domain, so no IP rule can match and an in-region host ` +
                    `nobody listed falls through to route.final and gets proxied`,
            );
        } else {
            const foreignTag = intent.proxySet.foreignDomainRuleSet;
            const clauses: any[] = Array.isArray(resolveRule.rules) ? resolveRule.rules : [];
            const scopedToMixed = clauses.some(
                (c) => Array.isArray(c?.inbound) && c.inbound.includes(CONTRACT_INBOUND_TAGS.MIXED),
            );
            const skipsForeign = clauses.some(
                (c) => c?.invert === true && c?.rule_set?.includes?.(foreignTag),
            );
            if (resolveRule.type !== 'logical' || resolveRule.mode !== 'and' || !scopedToMixed) {
                issues.push(
                    `${variant}: route.rules[3] resolve must be a logical AND scoped to inbound ` +
                        `"${CONTRACT_INBOUND_TAGS.MIXED}" — resolving the TUN datapath would ` +
                        `undo fakeip and hand the egress an IP instead of the hostname`,
                );
            }
            if (!skipsForeign) {
                issues.push(
                    `${variant}: route.rules[3] resolve must carry an inverted "${foreignTag}" ` +
                        `clause — otherwise known-overseas domains get resolved here and the ` +
                        `egress receives an IP instead of the hostname`,
                );
            }
        }
    } else if (rules.some((r) => r?.action === 'resolve')) {
        issues.push(
            `${variant}: must NOT carry a route-level resolve. It would fill ` +
                `DestinationAddresses, and sing-box then dials proxied connections by IP, so the ` +
                `egress never resolves the hostname itself`,
        );
    }
    const lanGuardIdx = expectsResolve ? 4 : 3;
    if (rules[lanGuardIdx]?.ip_is_private !== true || rules[lanGuardIdx]?.outbound !== 'direct') {
        issues.push(
            `route.rules[${lanGuardIdx}] must be {"ip_is_private":true,"outbound":"direct"} — ` +
                `LAN guard, must come before tag anchors`,
        );
    }

    // -- 8. Tag anchor priority (rules variants only) -------------------
    // Tag anchor domains come from the OneBox contract, not from intent.
    if (isRulesVariant) {
        const tagReject = CONTRACT_TAG_ANCHORS.REJECT_DOMAIN;
        const tagDirect = CONTRACT_TAG_ANCHORS.DIRECT_DOMAIN;
        const tagProxy = CONTRACT_TAG_ANCHORS.PROXY_DOMAIN;
        const idxReject = rules.findIndex((r) => Array.isArray(r?.domain) && r.domain.includes(tagReject));
        const idxDirect = rules.findIndex((r) => Array.isArray(r?.domain) && r.domain.includes(tagDirect));
        const idxProxy = rules.findIndex((r) => Array.isArray(r?.domain) && r.domain.includes(tagProxy));
        if (idxReject < 0) issues.push(`${variant}: missing tag anchor rule containing contract domain "${tagReject}"`);
        if (idxDirect < 0) issues.push(`${variant}: missing tag anchor rule containing contract domain "${tagDirect}"`);
        if (idxProxy < 0) issues.push(`${variant}: missing tag anchor rule containing contract domain "${tagProxy}"`);

        if (idxReject >= 0 && rules[idxReject]?.action !== 'reject') {
            issues.push(`${variant}: tag anchor "${tagReject}" must use action "reject"`);
        }
        if (idxDirect >= 0 && rules[idxDirect]?.outbound !== CONTRACT_OUTBOUND_TAGS.DIRECT) {
            issues.push(`${variant}: tag anchor "${tagDirect}" must route to "${CONTRACT_OUTBOUND_TAGS.DIRECT}"`);
        }
        if (idxProxy >= 0 && rules[idxProxy]?.outbound !== CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY) {
            issues.push(`${variant}: tag anchor "${tagProxy}" must route to "${CONTRACT_OUTBOUND_TAGS.EXIT_GATEWAY}"`);
        }
        if (idxReject >= 0 && idxDirect >= 0 && idxReject > idxDirect) {
            issues.push(
                `${variant}: tag anchor "${tagReject}" at index ${idxReject} must come before ` +
                    `"${tagDirect}" at index ${idxDirect}`,
            );
        }
        if (idxDirect >= 0 && idxProxy >= 0 && idxDirect > idxProxy) {
            issues.push(
                `${variant}: tag anchor "${tagDirect}" at index ${idxDirect} must come before ` +
                    `"${tagProxy}" at index ${idxProxy}`,
            );
        }

        // Tag anchors must come before any rule that uses rule_set, so
        // user overrides take priority over built-in geosite matching.
        //
        // Only rules that actually decide routing count: the contract is about
        // which outbound wins. A non-final action (the inverted `resolve`) may
        // reference a rule_set earlier without taking that decision away from
        // a user's custom rule — whatever it resolves or skips, the anchors
        // still match first when the outbound is picked.
        const decidesRoute = (r: any) =>
            typeof r?.outbound === 'string' || r?.action === 'route' || r?.action === 'reject';
        const firstRuleSetIdx = rules.findIndex((r) => Array.isArray(r?.rule_set) && decidesRoute(r));
        if (firstRuleSetIdx >= 0) {
            if (idxReject >= 0 && idxReject > firstRuleSetIdx) {
                issues.push(
                    `${variant}: tag anchor "${tagReject}" at index ${idxReject} must come before ` +
                        `first rule_set rule at index ${firstRuleSetIdx} — user custom rules would lose priority`,
                );
            }
            if (idxDirect >= 0 && idxDirect > firstRuleSetIdx) {
                issues.push(
                    `${variant}: tag anchor "${tagDirect}" at index ${idxDirect} must come before ` +
                        `first rule_set rule at index ${firstRuleSetIdx} — user custom rules would lose priority`,
                );
            }
            if (idxProxy >= 0 && idxProxy > firstRuleSetIdx) {
                issues.push(
                    `${variant}: tag anchor "${tagProxy}" at index ${idxProxy} must come before ` +
                        `first rule_set rule at index ${firstRuleSetIdx} — user custom rules would lose priority`,
                );
            }
        }

        // Also require anchors to come AFTER the LAN guard so private-IP
        // traffic can never be tunneled even via custom proxy rules.
        for (const [tag, idx] of [[tagReject, idxReject], [tagDirect, idxDirect], [tagProxy, idxProxy]] as [string, number][]) {
            if (idx >= 0 && idx <= lanGuardIdx) {
                issues.push(
                    `${variant}: tag anchor "${tag}" at index ${idx} must come after ` +
                        `LAN guard at index ${lanGuardIdx}`,
                );
            }
        }
    }

    // -- 9. DNS / route consistency (rules variants only) ---------------
    // For every rule_set routed "direct" in route.rules, the same tag must
    // resolve via "system" in dns.rules. Symmetrically, rule_sets routed
    // via ExitGateway must NOT resolve via "system" — they should go to
    // fakeip (tun) or fall through to dns.final=dns_proxy (mixed).
    if (isRulesVariant) {
        const routeRuleSetOutbounds = new Map<string, Set<string>>();
        for (const rule of rules) {
            const outbound: string | undefined = rule?.outbound;
            const rs: string[] = Array.isArray(rule?.rule_set) ? rule.rule_set : [];
            if (!outbound || rs.length === 0) continue;
            for (const tag of rs) {
                if (!routeRuleSetOutbounds.has(tag)) routeRuleSetOutbounds.set(tag, new Set());
                routeRuleSetOutbounds.get(tag)!.add(outbound);
            }
        }

        const dnsRuleSetServers = new Map<string, Set<string>>();
        for (const rule of (dns.rules ?? []) as any[]) {
            const server: string | undefined = rule?.server;
            const rs: string[] = Array.isArray(rule?.rule_set) ? rule.rule_set : [];
            if (!server || rs.length === 0) continue;
            for (const tag of rs) {
                if (!dnsRuleSetServers.has(tag)) dnsRuleSetServers.set(tag, new Set());
                dnsRuleSetServers.get(tag)!.add(server);
            }
        }

        // Direct in route ⇒ system in dns
        for (const [tag, obSet] of routeRuleSetOutbounds) {
            if (obSet.has('direct')) {
                const dnsServers = dnsRuleSetServers.get(tag);
                if (!dnsServers || !dnsServers.has('system')) {
                    issues.push(
                        `${variant}: rule_set "${tag}" routed direct but DNS does NOT resolve it ` +
                            `via "system" (${dnsServers ? [...dnsServers].join(',') : 'none'}). ` +
                            `Direct-routed CN traffic must resolve via DNSPod CN or it will get ` +
                            `overseas CDN IPs from dns.final=dns_proxy.`,
                    );
                }
            }
        }

        // ExitGateway in route ⇒ NOT system in dns (it should be fakeip or fall through)
        for (const [tag, obSet] of routeRuleSetOutbounds) {
            if (obSet.has('ExitGateway')) {
                const dnsServers = dnsRuleSetServers.get(tag);
                if (dnsServers && dnsServers.has('system')) {
                    issues.push(
                        `${variant}: rule_set "${tag}" routed via ExitGateway but DNS resolves ` +
                            `it via "system". Proxy-routed traffic should resolve proxy-side ` +
                            `(fakeip or dns_proxy fallthrough), not via direct DNS.`,
                    );
                }
            }
        }
    }

    // -- 10. In-region address filter (rules variants only) -------------
    // The rule that makes "unlisted domain, but it resolves into the region"
    // go direct without a route-level `resolve` action. Two properties are
    // load-bearing and easy to break by accident:
    //   - no `query_type`: DNS rules carrying one are skipped on the
    //     internal-lookup path, which kills the filter silently;
    //   - position: AFTER the direct set (listed domains adopt `system`
    //     unconditionally, filter or not) and BEFORE the fakeip catchall
    //     (which would otherwise answer first and never fall back).
    if (isRulesVariant) {
        const dnsRules = (dns.rules ?? []) as any[];
        const filterIdx = dnsRules.findIndex((r) => r?.ip_is_private === true);
        if (filterIdx < 0) {
            issues.push(
                `${variant}: dns.rules is missing the in-region address filter ` +
                    `({"rule_set":[<ipRuleSet>],"ip_is_private":true,"server":"${CONTRACT_DNS_TAGS.SYSTEM}"}). ` +
                    `Without it a domain that resolves into the region is proxied instead of direct.`,
            );
        } else {
            const filterRule = dnsRules[filterIdx];
            if (filterRule.server !== CONTRACT_DNS_TAGS.SYSTEM) {
                issues.push(
                    `${variant}: address filter must resolve via "${CONTRACT_DNS_TAGS.SYSTEM}", ` +
                        `got "${filterRule.server}"`,
                );
            }
            if (filterRule.query_type !== undefined) {
                issues.push(
                    `${variant}: address filter must NOT carry query_type — sing-box skips such ` +
                        `rules on the internal-lookup path, so the filter would never run`,
                );
            }
            if (!Array.isArray(filterRule.rule_set) || filterRule.rule_set.length === 0) {
                issues.push(`${variant}: address filter must reference the in-region IP rule_set`);
            }
            const directSetIdx = dnsRules.findIndex(
                (r) => Array.isArray(r?.domain) && r?.server === CONTRACT_DNS_TAGS.SYSTEM,
            );
            if (directSetIdx >= 0 && filterIdx < directSetIdx) {
                issues.push(
                    `${variant}: address filter at index ${filterIdx} must come AFTER the direct ` +
                        `set rule at index ${directSetIdx} — listed domains resolve via ` +
                        `"${CONTRACT_DNS_TAGS.SYSTEM}" unconditionally`,
                );
            }
            // The known-overseas short-circuit has to sit BEFORE the filter,
            // or foreign domains still get probed at the in-region resolver —
            // which is the pollution exposure the short-circuit removes.
            const foreignTag = intent.proxySet.foreignDomainRuleSet;
            const foreignIdx = dnsRules.findIndex(
                (r) => Array.isArray(r?.rule_set) && r.rule_set.includes(foreignTag),
            );
            if (foreignIdx < 0) {
                issues.push(
                    `${variant}: dns.rules must short-circuit "${foreignTag}" to the proxy-side ` +
                        `resolver, otherwise every foreign domain is asked at ` +
                        `"${CONTRACT_DNS_TAGS.SYSTEM}" first and a poisoned in-region answer ` +
                        `would be adopted`,
                );
            } else {
                if (dnsRules[foreignIdx]?.server === CONTRACT_DNS_TAGS.SYSTEM) {
                    issues.push(
                        `${variant}: "${foreignTag}" must NOT resolve via ` +
                            `"${CONTRACT_DNS_TAGS.SYSTEM}" — it is the known-overseas set`,
                    );
                }
                if (foreignIdx > filterIdx) {
                    issues.push(
                        `${variant}: "${foreignTag}" short-circuit at index ${foreignIdx} must ` +
                            `come before the address filter at index ${filterIdx}`,
                    );
                }
            }

            const fakeipIdx = dnsRules.findIndex(
                (r) => r?.server === CONTRACT_DNS_TAGS.FAKEIP && r?.query_type !== undefined,
            );
            if (fakeipIdx >= 0 && filterIdx > fakeipIdx) {
                issues.push(
                    `${variant}: address filter at index ${filterIdx} must come BEFORE the fakeip ` +
                        `catchall at index ${fakeipIdx}, or every unlisted domain gets a fake IP ` +
                        `before the filter can adopt a real one`,
                );
            }
        }
    }

    if (issues.length > 0) {
        throw new ValidationError(fileLabel, issues);
    }
}
