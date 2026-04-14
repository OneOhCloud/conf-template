#!/usr/bin/env tsx
/**
 * conf-template generator.
 *
 * Contract:
 *   - `conf/1.13.8/zh-cn/*.jsonc` are the ONLY hand-edited files ("canonical").
 *   - All other `conf/<ver>/zh-cn/*.jsonc` are produced from the canonical files
 *     by version-specific transformations applied here.
 *   - Every canonical file is validated (static checks + optional `sing-box check`)
 *     before being emitted. A failure aborts the run without touching any file.
 *
 * Why the design:
 *   - Single source of truth → editing two files to fix one thing is impossible.
 *   - Transformations are declarative → adding a new version is adding a row.
 *   - Validator is the guard → rule_set / server references, forbidden legacy
 *     fields, required route rules are checked every run. Optional sing-box
 *     check catches anything we miss (run with --strict or SING_BOX_BIN=... env).
 *
 * Usage:
 *   pnpm generate                 # copy canonical → derived versions, static validate
 *   pnpm generate:strict          # also runs `sing-box check` on each file
 *   SING_BOX_BIN=/path tsx scripts/generate.ts --strict
 *   tsx scripts/generate.ts --dry-run    # validate only, no writes
 */

import { parse as parseJsonc } from 'jsonc-parser';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

type Variant = 'tun-rules' | 'tun-global' | 'mixed-rules' | 'mixed-global';
type Version = '1.12' | '1.13' | '1.13.8';

const VARIANTS: readonly Variant[] = [
    'tun-rules',
    'tun-global',
    'mixed-rules',
    'mixed-global',
] as const;

/** The canonical version. Every other version is derived from this one. */
const CANONICAL: Version = '1.13.8';

const DERIVED_VERSIONS: readonly Version[] = ['1.13', '1.12'] as const;

const args = process.argv.slice(2);
const STRICT = args.includes('--strict') || process.env.SING_BOX_BIN !== undefined;
const DRY_RUN = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Canonical loader
// ---------------------------------------------------------------------------

type SingBoxConfig = {
    log?: any;
    dns?: {
        servers?: Array<{ tag: string; type?: string; [k: string]: any }>;
        rules?: Array<any>;
        final?: string;
        strategy?: string;
    };
    inbounds?: Array<{
        tag: string;
        type: string;
        sniff?: boolean;
        sniff_override_destination?: boolean;
        [k: string]: any;
    }>;
    route?: {
        rules?: Array<any>;
        final?: string;
        rule_set?: Array<{ tag: string; [k: string]: any }>;
        auto_detect_interface?: boolean;
    };
    experimental?: any;
    outbounds?: Array<{ tag: string; type: string; [k: string]: any }>;
};

function canonicalPath(variant: Variant): string {
    return resolve(REPO_ROOT, `conf/${CANONICAL}/zh-cn/${variant}.jsonc`);
}

function derivedPath(variant: Variant, version: Version): string {
    return resolve(REPO_ROOT, `conf/${version}/zh-cn/${variant}.jsonc`);
}

function loadCanonical(variant: Variant): SingBoxConfig {
    const path = canonicalPath(variant);
    const text = readFileSync(path, 'utf-8');
    const errors: any[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        const msgs = errors
            .map((e) => `  ${e.error} @ offset ${e.offset} (${e.length} bytes)`)
            .join('\n');
        throw new Error(`jsonc parse errors in ${path}:\n${msgs}`);
    }
    return parsed as SingBoxConfig;
}

// ---------------------------------------------------------------------------
// Version transformations
// ---------------------------------------------------------------------------

/**
 * Produce a version-specific copy of the canonical config.
 *
 * Current transformations:
 *   - 1.13.8 → 1.13: identity. 1.13.0+ accept route-rule sniff, so no change.
 *   - 1.13.8 → 1.12: identity. 1.12 also accepts route-rule sniff (added in 1.11).
 *
 * When adding a version-specific tweak, mutate `out` in the matching branch
 * below and document the reason inline. Never mutate `canonical`.
 */
function transform(canonical: SingBoxConfig, variant: Variant, version: Version): SingBoxConfig {
    // Deep clone via JSON round-trip — sufficient because configs are pure data.
    const out: SingBoxConfig = JSON.parse(JSON.stringify(canonical));

    switch (version) {
        case '1.13':
            // No structural change needed. 1.13.0–1.13.7 accept the canonical
            // 1.13.8 layout verbatim because:
            //   - route-rule sniff action has been accepted since 1.11
            //   - dns.rules split-routing is pre-existing syntax
            //   - fakeip server type is pre-existing
            break;

        case '1.12':
            // Same story as 1.13. 1.12.x accepts the same syntax. Left identity
            // for now; if a concrete 1.12 incompatibility surfaces, add the fix
            // here rather than in the canonical file.
            break;

        case '1.13.8':
            throw new Error(`transform() called with canonical version`);
    }

    // Reference silence for unused `variant` — kept in signature for future
    // variant-specific tweaks (e.g. forcing fakeip only on TUN variants).
    void variant;
    return out;
}

// ---------------------------------------------------------------------------
// Static validator
// ---------------------------------------------------------------------------

class ValidationError extends Error {
    constructor(public readonly file: string, public readonly issues: string[]) {
        super(`${file}: ${issues.length} validation issue(s)\n  ` + issues.join('\n  '));
    }
}

function validate(config: SingBoxConfig, variant: Variant, version: Version, fileLabel: string): void {
    const issues: string[] = [];

    // 1. Required top-level blocks
    if (!config.dns) issues.push('missing dns block');
    if (!config.inbounds || config.inbounds.length === 0) issues.push('missing inbounds');
    if (!config.route) issues.push('missing route block');
    if (!config.outbounds || config.outbounds.length === 0) issues.push('missing outbounds');

    const dns = config.dns ?? {};
    const route = config.route ?? {};
    const inbounds = config.inbounds ?? [];
    const outbounds = config.outbounds ?? [];

    // 2. DNS server references
    const dnsServerTags = new Set((dns.servers ?? []).map((s) => s.tag));
    if (dns.final && !dnsServerTags.has(dns.final)) {
        issues.push(`dns.final references missing server: ${dns.final}`);
    }
    for (const rule of dns.rules ?? []) {
        if (rule.server && !dnsServerTags.has(rule.server)) {
            issues.push(`dns.rules[].server references missing server: ${rule.server}`);
        }
    }

    // 3. Rule set references (from dns.rules and route.rules)
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
    for (const ref of collectRuleSetRefs(dns.rules ?? [])) {
        if (!ruleSetTags.has(ref)) {
            issues.push(`dns.rules references missing rule_set: ${ref}`);
        }
    }
    for (const ref of collectRuleSetRefs(route.rules ?? [])) {
        if (!ruleSetTags.has(ref)) {
            issues.push(`route.rules references missing rule_set: ${ref}`);
        }
    }

    // 4. Outbound references
    const outboundTags = new Set(outbounds.map((o) => o.tag));
    // Implicit outbounds that sing-box always provides
    outboundTags.add('direct');
    outboundTags.add('block');
    const walkRouteOutbounds = (r: any): string[] => {
        const refs: string[] = [];
        if (r?.outbound) refs.push(r.outbound);
        if (Array.isArray(r?.rules)) r.rules.forEach((sub: any) => refs.push(...walkRouteOutbounds(sub)));
        return refs;
    };
    for (const rule of route.rules ?? []) {
        for (const ref of walkRouteOutbounds(rule)) {
            if (!outboundTags.has(ref)) {
                issues.push(`route.rules references missing outbound: ${ref}`);
            }
        }
    }
    if (route.final && !outboundTags.has(route.final)) {
        issues.push(`route.final references missing outbound: ${route.final}`);
    }
    // Selector outbounds reference other outbounds in their `outbounds` array.
    for (const ob of outbounds) {
        if (Array.isArray(ob.outbounds)) {
            for (const ref of ob.outbounds) {
                if (!outboundTags.has(ref)) {
                    issues.push(`outbound[${ob.tag}].outbounds references missing: ${ref}`);
                }
            }
        }
    }

    // 5. Version-specific forbidden fields
    if (version === '1.13.8') {
        for (const inb of inbounds) {
            if (inb.sniff !== undefined || inb.sniff_override_destination !== undefined) {
                issues.push(
                    `inbound[${inb.tag}]: legacy \`sniff\` / \`sniff_override_destination\` fields are rejected in 1.13.8; use a route rule \`{"action":"sniff"}\` instead`,
                );
            }
        }
    }

    // 6. TUN-variant structural requirements
    const isTunVariant = variant.startsWith('tun-');
    const hasTunInbound = inbounds.some((i) => i.type === 'tun');
    if (isTunVariant && !hasTunInbound) {
        issues.push(`${variant} must have an inbound with type=tun`);
    }
    if (!isTunVariant && hasTunInbound) {
        issues.push(`${variant} must NOT have a tun inbound (mixed variants use only the mixed inbound)`);
    }

    // 7. For 1.13.8 TUN variants, require the first route rule to be the tun sniff action.
    if (version === '1.13.8' && isTunVariant) {
        const first = (route.rules ?? [])[0];
        if (!first || first.inbound !== 'tun' || first.action !== 'sniff') {
            issues.push(
                `${variant} 1.13.8: route.rules[0] must be {"inbound":"tun","action":"sniff"} — required after legacy sniff removal`,
            );
        }
    }

    // 8. DNS split-routing sanity (rules variants only)
    if (variant.endsWith('-rules')) {
        const hasCnRule = (dns.rules ?? []).some(
            (r: any) =>
                Array.isArray(r.rule_set) &&
                r.rule_set.some((rs: string) => rs === 'geoip-cn' || rs === 'geosite-cn'),
        );
        if (!hasCnRule) {
            issues.push(
                `${variant}: dns.rules must route CN domains (rule_set: geoip-cn/geosite-cn) to a direct transport — otherwise CN sites resolve via proxy and return overseas IPs`,
            );
        }
    }

    if (issues.length > 0) {
        throw new ValidationError(fileLabel, issues);
    }
}

// ---------------------------------------------------------------------------
// sing-box check (optional, strict mode)
// ---------------------------------------------------------------------------

function findSingBoxBin(): string | null {
    if (process.env.SING_BOX_BIN) return process.env.SING_BOX_BIN;
    // Probe PATH
    try {
        const out = execFileSync('which', ['sing-box'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const p = out.trim();
        return p.length > 0 ? p : null;
    } catch {
        return null;
    }
}

/**
 * Run `sing-box check` on a template, working around its requirement that
 * selector/urltest outbounds have non-empty `outbounds` arrays.
 *
 * OneBox's templates intentionally leave `auto.outbounds = []` so that the
 * runtime merger can append subscription nodes. `sing-box check` of the raw
 * template therefore fails with "initialize outbound[X]: missing tags". We
 * inject a stub direct node and wire it into the selector/urltest outbounds
 * just for the check, write the patched JSON to a temp file, run check, and
 * discard the temp. The real on-disk template is never touched.
 */
function singBoxCheck(bin: string, config: SingBoxConfig, label: string): void {
    const patched: SingBoxConfig = JSON.parse(JSON.stringify(config));
    const stubTag = '__onebox_check_stub__';
    (patched.outbounds ?? []).forEach((ob) => {
        if (Array.isArray(ob.outbounds) && ob.outbounds.length === 0) {
            ob.outbounds = [stubTag];
        }
    });
    // Add the stub as a distinct direct outbound so any existing `direct` tag
    // is left alone.
    (patched.outbounds ??= []).push({
        tag: stubTag,
        type: 'direct',
    });

    // Replace every rule_set entry with a local stub — `sing-box check` tries
    // to fetch remote rule_sets at runtime, which is slow and network-dependent.
    // The check only needs the tag present; leave the entries as-is if they're
    // already remote format since check doesn't actually fetch during parse.
    // (If future sing-box starts eagerly fetching, switch to `type: "inline"`.)

    const tmp = mkdtempSync(join(tmpdir(), 'onebox-check-'));
    const tmpFile = join(tmp, 'config.json');
    writeFileSync(tmpFile, JSON.stringify(patched), 'utf-8');
    try {
        execFileSync(bin, ['check', '-c', tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
        const stderr = e?.stderr?.toString() ?? '';
        const stdout = e?.stdout?.toString() ?? '';
        throw new Error(`sing-box check failed for ${label}:\n${stderr || stdout || e?.message}`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function header(variant: Variant, version: Version): string {
    return [
        `// AUTO-GENERATED by scripts/generate.ts — do not edit by hand.`,
        `// Source: conf/${CANONICAL}/zh-cn/${variant}.jsonc (canonical)`,
        `// Regenerate: pnpm generate`,
        `// Variant: ${variant}   Version: ${version}`,
        `// CDN path: https://cdn.jsdelivr.net/gh/OneOhCloud/conf-template@dev/conf/${version}/zh-cn/${variant}.jsonc`,
    ].join('\n');
}

/**
 * Emit a config as stable-formatted JSONC.
 *
 * Key order is preserved from the canonical file (via the deep-clone step in
 * `transform`) because JSON.parse preserves insertion order and our clone is
 * a round-trip through JSON.stringify → JSON.parse which keeps that order.
 */
function emit(variant: Variant, version: Version, config: SingBoxConfig): string {
    const body = JSON.stringify(config, null, 4);
    return `${header(variant, version)}\n${body}\n`;
}

function writeFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
    console.log(`[generate] canonical version: ${CANONICAL}`);
    console.log(`[generate] derived versions: ${DERIVED_VERSIONS.join(', ')}`);
    console.log(`[generate] mode: ${DRY_RUN ? 'DRY RUN' : 'WRITE'}${STRICT ? ' + STRICT (sing-box check)' : ''}`);
    console.log('');

    // Phase 1: load + validate canonical
    const canonicals: Record<Variant, SingBoxConfig> = {} as any;
    for (const variant of VARIANTS) {
        const config = loadCanonical(variant);
        validate(config, variant, CANONICAL, `conf/${CANONICAL}/zh-cn/${variant}.jsonc`);
        canonicals[variant] = config;
        console.log(`  ✓ loaded + validated canonical ${variant}`);
    }

    // Phase 2: transform + validate derived
    type Derived = {
        variant: Variant;
        version: Version;
        path: string;
        content: string;
        config: SingBoxConfig;
    };
    const derived: Derived[] = [];
    for (const version of DERIVED_VERSIONS) {
        for (const variant of VARIANTS) {
            const config = transform(canonicals[variant], variant, version);
            const path = derivedPath(variant, version);
            validate(config, variant, version, `conf/${version}/zh-cn/${variant}.jsonc (derived)`);
            const content = emit(variant, version, config);
            derived.push({ variant, version, path, content, config });
            console.log(`  ✓ derived + validated ${version}/${variant}`);
        }
    }

    // Phase 3: re-emit canonicals too (normalises hand-editing formatting drift).
    // The human-edited jsonc inside conf/1.13.8 stays the source of structural
    // truth, but we still want stable JSON layout on disk after `pnpm generate`.
    // Comments in the canonical source ARE lost during this round-trip — treat
    // the canonical file's inline comments as scratch notes, not load-bearing.
    const canonicalEmits: Derived[] = VARIANTS.map((variant) => ({
        variant,
        version: CANONICAL,
        path: canonicalPath(variant),
        content: emit(variant, CANONICAL, canonicals[variant]),
        config: canonicals[variant],
    }));

    // Phase 4: optionally run sing-box check. Runs against an in-memory patched
    // copy of each config (see singBoxCheck) to work around the empty
    // `auto.outbounds` placeholder that OneBox fills at runtime.
    const all = [...canonicalEmits, ...derived];

    if (STRICT) {
        const bin = findSingBoxBin();
        if (!bin) {
            console.error(
                `\n[generate] --strict requested but no sing-box binary found. Set SING_BOX_BIN=/path/to/sing-box or add it to PATH.`,
            );
            process.exit(2);
        }
        console.log(`\n[generate] running sing-box check via ${bin}`);
        for (const d of all) {
            singBoxCheck(bin, d.config, `${d.version}/${d.variant}`);
            console.log(`  ✓ sing-box check ${d.version}/${d.variant}`);
        }
    }

    // Phase 5: write to disk. Order matters — we only touch files after all
    // validation passes, so a mid-run failure leaves the repo clean.
    if (!DRY_RUN) {
        for (const d of all) {
            writeFile(d.path, d.content);
        }
        console.log(`\n[generate] wrote ${all.length} files`);
    } else {
        console.log(`\n[generate] dry run — ${all.length} files NOT written`);
    }

    console.log('\n[generate] done');
}

try {
    main();
} catch (e: any) {
    if (e instanceof ValidationError) {
        console.error(`\n[generate] VALIDATION FAILED\n${e.message}`);
    } else {
        console.error(`\n[generate] ${e?.message ?? e}`);
        if (e?.stack && !(e instanceof ValidationError)) console.error(e.stack);
    }
    process.exit(1);
}
