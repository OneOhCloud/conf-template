# conf-template — database branch

This branch stores pre-built sing-box rule-set cache databases for all environments.

## Directory structure

```
database/
├── dev/          # Built from the dev branch configs
│   ├── 1.12/
│   │   └── zh-cn/
│   │       ├── mixed-cache-rule-v1.db
│   │       └── tun-cache-rule-v1.db
│   └── 1.13/
│       └── zh-cn/
│           ├── mixed-cache-rule-v1.db
│           └── tun-cache-rule-v1.db
├── beta/         # Built from the beta branch configs
│   └── ...
└── stable/       # Built from the stable branch configs
    └── ...
```

Path pattern: `database/{env}/{version}/{locale}/{db-file}`

- **env**: `dev` | `beta` | `stable`
- **version**: sing-box minor version (e.g. `1.12`, `1.13`)
- **locale**: language/region code (e.g. `zh-cn`)

## How it works

The GitHub Actions workflow (on the `dev` branch) runs daily at 02:00 UTC.
For each environment (`dev`, `beta`, `stable`), it:

1. Checks out the corresponding branch to read `conf/{version}/{locale}/mixed-rules.jsonc`
2. Downloads the matching sing-box binary
3. Runs sing-box to populate the rule-set cache
4. Commits the resulting `.db` files to this `database` branch

## Legacy

The original `database/` directories on `dev`, `beta`, and `stable` branches are retained for backward compatibility.
