import type { RegionIntent } from '../types';

/**
 * zh-cn intent — Simplified Chinese, mainland-first routing.
 *
 * This file is pure region-variable data. Tag names, anchor domains,
 * port numbers, inbound/outbound/DNS types — all of those are OneBox
 * contracts and live in `types.ts` as `CONTRACT_*` constants. Editing
 * this file cannot break OneBox's runtime merger; you can only change
 * WHICH servers / domains / rule_sets are used for this region.
 *
 * Editing guide:
 *   - Add a domain that needs direct route + system DNS?
 *     → `directSet.domains`
 *   - Add a rule_set category that needs direct route + system DNS?
 *     → `directSet.ruleSets` (and add its URL to `ruleSetDefinitions` if new)
 *   - Same for proxy: `proxySet.ruleSets` / `proxySet.domainSuffixes`
 *   - A new domain_suffix that should always route direct (LAN-style or
 *     ISP captive portal)? → `directSet.domainSuffixes`
 *   - Switch to a different upstream DNS?
 *     → `dnsServers.systemDns.server` (CN direct resolver)
 *     → `dnsServers.dnsProxy.server` (proxy-side resolver for non-CN)
 *
 * After editing, run `pnpm generate` and commit the regenerated jsonc.
 */
export const ZH_CN_INTENT: RegionIntent = {
    region: 'zh-cn',
    label: '简体中文（中国大陆优先）',

    dnsServers: {
        // ZH: DNSPod CN，用于 CN 白名单里所有走 direct 路由的域名。
        // EN: DNSPod CN, resolving everything that route.rules sends to direct.
        systemDns: {
            server: '119.29.29.29',
            serverPort: 53,
            connectTimeout: '5s',
        },
        // ZH: Cloudflare 公共 DNS，强制通过 ExitGateway 出境。作为 dns.final
        //     兜底，非 CN 域名走这里在代理出口端解析。
        // EN: Cloudflare public DNS, forced through the proxy egress. Acts
        //     as `dns.final` so non-CN queries resolve proxy-side and don't
        //     hit the GFW's plaintext DNS injection.
        dnsProxy: {
            server: '1.0.0.1',
            serverPort: 53,
            connectTimeout: '5s',
        },
    },

    // --- DIRECT SET: route direct AND resolve via systemDns ----------------
    directSet: {
        ruleSets: [
            'geoip-cn',
            'geosite-cn',
            'geosite-apple',
            'geosite-microsoft-cn',
            'geosite-samsung',
            'geosite-private',
        ],
        domains: [
            'captive.oneoh.cloud',
            'captive.apple.com',
            'nmcheck.gnome.org',
            'www.msftconnecttest.com',
            'connectivitycheck.gstatic.com',
            'sequoia.apple.com',
            'seed-sequoia.siri.apple.com',
        ],
        domainSuffixes: [
            // LAN-style (mDNS, broadcast, local hostnames)
            'local',
            'lan',
            'localdomain',
            'localhost',
            'bypass.local',
            // ISP captive portal / Wi-Fi auth (Chinese public networks)
            '.oneoh.cloud',
            '.ksjhaoka.com',
            '.mixcapp.com',
        ],
        ipIsPrivate: true,
        processPaths: [
            '/Applications/WeChat.app/Contents/MacOS/WeChat',
        ],
        processPathRegex: [
            '^/System/Applications/.+',
        ],
    },

    // --- PROXY SET: route ExitGateway AND resolve via fakeip / dns_proxy ---
    proxySet: {
        ruleSets: [
            'geosite-tiktok',
            'geosite-linkedin',
            'geosite-linkedin-cn',
        ],
        domainSuffixes: [
            '.tiktok.com',
        ],
    },

    // --- rule_set registry -------------------------------------------------
    // Every tag in directSet.ruleSets / proxySet.ruleSets must have an
    // entry here. Dangling refs are rejected by the validator.
    ruleSetDefinitions: [
        {
            tag: 'geoip-cn',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/MetaCubeX/meta-rules-dat@sing/geo/geoip/cn.srs',
        },
        {
            tag: 'geosite-geolocation-cn',
            type: 'remote',
            format: 'source',
            url: 'https://jsdelivr.oneoh.cloud/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/geolocation-cn.json',
        },
        {
            tag: 'geosite-linkedin',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-linkedin.srs',
        },
        {
            tag: 'geosite-linkedin-cn',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-linkedin@cn.srs',
        },
        {
            tag: 'geosite-geolocation-!cn',
            type: 'remote',
            format: 'source',
            url: 'https://jsdelivr.oneoh.cloud/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/geolocation-!cn.json',
        },
        {
            tag: 'geosite-cn',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/OneOhCloud/one-geosite@rules/geosite-one-cn.srs',
        },
        {
            tag: 'geosite-apple',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-apple.srs',
        },
        {
            tag: 'geosite-microsoft-cn',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-microsoft@cn.srs',
        },
        {
            tag: 'geosite-samsung',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-samsung.srs',
        },
        {
            tag: 'geosite-telegram',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-telegram.srs',
        },
        {
            tag: 'geosite-private',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-private.srs',
        },
        {
            tag: 'geosite-tiktok',
            type: 'remote',
            format: 'binary',
            url: 'https://jsdelivr.oneoh.cloud/gh/SagerNet/sing-geosite@rule-set/geosite-tiktok.srs',
        },
    ],
};
