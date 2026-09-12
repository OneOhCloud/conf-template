import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { build } from './generator/sing-box-v1-14.js';
import { ZH_CN_INTENT } from './intent/zh-cn.js';
import type { SingBoxConfig, Version } from './types.js';
import { ValidationError, validate } from './validator.js';

type MutableRule = Record<string, unknown>;

function mixedRulesConfig(): SingBoxConfig {
    return JSON.parse(JSON.stringify(build(ZH_CN_INTENT, 'mixed-rules')));
}

function dnsRulesOf(config: SingBoxConfig): MutableRule[] {
    return config.dns.rules as MutableRule[];
}

function evaluateIndex(config: SingBoxConfig): number {
    const index = dnsRulesOf(config).findIndex((rule) => rule.action === 'evaluate');
    assert.notEqual(index, -1, 'fixture has an evaluate rule');
    return index;
}

/** Index just past the four-rule probe (evaluate + three respond rules). */
function afterProbeIndex(config: SingBoxConfig): number {
    return evaluateIndex(config) + 4;
}

function assertRejected(config: SingBoxConfig, expectedIssue: RegExp, version: Version = '1.14'): void {
    assert.throws(
        () => validate(config, version, 'mixed-rules', ZH_CN_INTENT, 'test'),
        (error: unknown) => error instanceof ValidationError && expectedIssue.test(error.message),
    );
}

const SATISFIABLE_ON_NIL = /responds but is satisfiable with no evaluated response/;

describe('validator — respond rules must not fire on a nil response', () => {
    it('rejects a bare inverted match_response respond', () => {
        const config = mixedRulesConfig();
        dnsRulesOf(config).splice(afterProbeIndex(config), 0, {
            match_response: true,
            ip_accept_any: true,
            invert: true,
            action: 'respond',
        });
        assertRejected(config, SATISFIABLE_ON_NIL);
    });

    it('rejects a logical rule that inverts itself', () => {
        const config = mixedRulesConfig();
        const index = evaluateIndex(config);
        dnsRulesOf(config)[index + 3].invert = true;
        assertRejected(config, SATISFIABLE_ON_NIL);
    });

    it('rejects a logical AND whose sub-rules are all inverted', () => {
        const config = mixedRulesConfig();
        const index = evaluateIndex(config);
        dnsRulesOf(config)[index + 3].rules = [
            { match_response: true, response_rcode: 'SERVFAIL', invert: true },
            { match_response: true, ip_accept_any: true, invert: true },
        ];
        assertRejected(config, SATISFIABLE_ON_NIL);
    });

    it('rejects a logical OR whose sub-rules are all inverted', () => {
        const config = mixedRulesConfig();
        dnsRulesOf(config).splice(afterProbeIndex(config), 0, {
            type: 'logical',
            mode: 'or',
            rules: [
                { match_response: true, ip_accept_any: true, invert: true },
                { match_response: true, response_rcode: 'REFUSED', invert: true },
            ],
            action: 'respond',
        });
        assertRejected(config, SATISFIABLE_ON_NIL);
    });

    it('rejects a logical AND whose only non-inverted sibling is a query-side matcher', () => {
        const config = mixedRulesConfig();
        const index = evaluateIndex(config);
        dnsRulesOf(config)[index + 3].rules = [
            { domain_suffix: ['.'] },
            { match_response: true, ip_accept_any: true, invert: true },
        ];
        assertRejected(config, SATISFIABLE_ON_NIL);
    });

    it('rejects a respond with no response matcher at all', () => {
        const config = mixedRulesConfig();
        dnsRulesOf(config).splice(afterProbeIndex(config), 0, { action: 'respond' });
        assertRejected(config, SATISFIABLE_ON_NIL);
    });
});

describe('validator — the response probe is exact and closed', () => {
    it('rejects a probe that drops the NXDOMAIN respond', () => {
        const config = mixedRulesConfig();
        dnsRulesOf(config).splice(evaluateIndex(config) + 2, 1);
        assertRejected(config, /\(NXDOMAIN respond\) must be/);
    });

    it('rejects an extra key on the NOERROR clause', () => {
        const config = mixedRulesConfig();
        const index = evaluateIndex(config);
        (dnsRulesOf(config)[index + 3].rules as MutableRule[])[0].ip_is_private = true;
        assertRejected(config, /\(NOERROR-and-no-address respond\) must be/);
    });

    it('rejects a response-matching respond after the probe span', () => {
        const config = mixedRulesConfig();
        dnsRulesOf(config).splice(afterProbeIndex(config), 0, {
            match_response: true,
            response_rcode: 'SERVFAIL',
            action: 'respond',
        });
        assertRejected(config, /after the probe span/);
    });
});

describe('validator — remote rule-set download client', () => {
    it('rejects a 1.14 config without http_clients', () => {
        const config = mixedRulesConfig();
        delete config.http_clients;
        assertRejected(config, /needs an explicit http_clients entry/);
    });

    it('rejects a default_http_client that names no http_clients entry', () => {
        const config = mixedRulesConfig();
        config.route.default_http_client = 'nowhere';
        assertRejected(config, /references missing http_client: nowhere/);
    });

    it('rejects an http_clients detour that names no outbound', () => {
        const config = mixedRulesConfig();
        config.http_clients = [{ tag: 'rule-set-download', detour: 'ghost' }];
        assertRejected(config, /detour references missing outbound: ghost/);
    });

    it('rejects duplicate http_clients tags', () => {
        const config = mixedRulesConfig();
        config.http_clients = [
            { tag: 'rule-set-download', detour: 'ExitGateway' },
            { tag: 'rule-set-download', detour: 'direct' },
        ];
        assertRejected(config, /duplicate http_clients tag: rule-set-download/);
    });

    it('rejects http_clients in a legacy bucket', () => {
        assertRejected(mixedRulesConfig(), /http_clients is an unknown field to sing-box 1.13.8/, '1.13.8');
    });
});
