import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ZH_CN_INTENT } from '../intent/zh-cn.js';
import { VARIANTS } from '../types.js';
import { build } from './sing-box-v1-14.js';

function dnsRules(variant: (typeof VARIANTS)[number]): Record<string, unknown>[] {
    return build(ZH_CN_INTENT, variant).dns.rules as Record<string, unknown>[];
}

function containsKey(value: unknown, key: string): boolean {
    if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return Object.hasOwn(record, key) || Object.values(record).some((item) => containsKey(item, key));
}

describe('sing-box 1.14 generator', () => {
    it('removes legacy DNS rule fields from every variant', () => {
        for (const variant of VARIANTS) {
            const config = build(ZH_CN_INTENT, variant);
            assert.equal(containsKey(config.dns.rules, 'strategy'), false, variant);
            assert.equal(containsKey(config.dns.rules, 'rule_set_ip_cidr_accept_empty'), false, variant);
            assert.equal(config.dns.strategy, 'prefer_ipv4', variant);
        }
    });

    it('uses evaluate and response matching for unlisted domains in rules variants', () => {
        for (const variant of ['tun-rules', 'mixed-rules'] as const) {
            const rules = dnsRules(variant);
            const evaluateIndex = rules.findIndex(
                (rule) => rule.action === 'evaluate' && rule.server === 'system',
            );
            assert.notEqual(evaluateIndex, -1, `${variant}: evaluate rule`);

            assert.deepEqual(rules[evaluateIndex + 1], {
                match_response: true,
                rule_set: [ZH_CN_INTENT.directSet.ipRuleSet],
                ip_is_private: true,
                action: 'respond',
            });
            assert.deepEqual(rules[evaluateIndex + 2], {
                match_response: true,
                ip_accept_any: true,
                invert: true,
                action: 'respond',
            });

            const foreignIndex = rules.findIndex(
                (rule) => Array.isArray(rule.rule_set) &&
                    rule.rule_set.includes(ZH_CN_INTENT.proxySet.foreignDomainRuleSet),
            );
            assert.ok(foreignIndex < evaluateIndex, `${variant}: foreign domains short-circuit first`);
        }
    });
});
