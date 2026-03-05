# infuse-connect

Connect a machine to Infuse so approved agent commands can run locally.

## Quick start

```bash
npx infuse-connect connect --code <connector-token>
```

`--code` and `--token` are aliases.

By default, the connector uses `https://infuseos.com`.

For local/staging/self-hosted testing, override with:

```bash
npx infuse-connect connect \
  --server http://localhost:3000 \
  --code <connector-token>
```

You can also set a default override:

```bash
INFUSE_CONNECT_SERVER_URL=http://localhost:3000 npx infuse-connect connect --code <connector-token>
```

## Commands

- `infuse-connect connect --code <token> [--server <url>]`: save config + start connector loop
- `infuse-connect start`: start connector using saved config
- `infuse-connect disconnect`: disconnect machine + clear saved config

## Security defaults

- High-risk commands are blocked unless `--allow-high-risk` is set.
- Output is truncated to prevent unbounded log ingestion.
- Connector token is stored in `~/.infuse-connect/config.json` for reconnects.

## Notes

- The machine must be running while tasks are executed.
- You can run this on laptops, desktops, or VMs.
