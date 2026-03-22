# conf-template

sing-box configuration templates and rule-set cache databases.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready configs |
| `dev` | Development configs |
| `beta` | Beta testing configs |
| `stable` | Stable release configs |
| `database` | Centralized rule-set cache databases (orphan branch) |

## Directory structure

```
conf/
├── 1.12/
│   └── zh-cn/
│       ├── mixed-global.jsonc
│       ├── mixed-rules.jsonc
│       ├── tun-global.jsonc
│       └── tun-rules.jsonc
└── 1.13/
    └── zh-cn/
        └── ...

database/           # (legacy, retained for backward compatibility)
├── 1.12/
│   └── zh-cn/
│       ├── mixed-cache-rule-v1.db
│       └── tun-cache-rule-v1.db
└── 1.13/
    └── ...
```

## Rule-set cache databases

Pre-built cache databases are maintained on the **`database`** branch with the following layout:

```
database/{env}/{version}/{locale}/*.db
```

Where `env` is one of `dev`, `beta`, or `stable`.

A daily CI workflow builds these databases automatically at 02:00 UTC by running sing-box against the configs from each environment branch.

See the [`database` branch README](../../tree/database) for more details.
