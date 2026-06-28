# kd-cli

Cross-platform CLI for the TrueRolls verifiable dice system.

## Commands

- **`kd roll`** - Roll a die with guarded karma distribution
- **`kd verify`** - Verify distribution caps or verify a transcript file

## Quick Start

```bash
cargo build -p kd-cli

# Roll a d20 with κ=0.5
./target/debug/kd roll --kappa 0.5

# Verify caps hold
./target/debug/kd verify --kappa 0.5

# Roll, save transcript, then verify it
./target/debug/kd roll --kappa 0.6 --seed 42 --output t.json
./target/debug/kd verify --input t.json
```

## Full Documentation

See [`docs/reference/kd-cli-guide.md`](../../docs/reference/kd-cli-guide.md) for complete usage
guide with all options, examples, and CI integration instructions.

## Tests

```bash
cargo test -p kd-cli
```

22 integration tests covering:
- Roll: basic, JSON, determinism, all die sizes, lambda override, file output, error cases
- Verify: parameter mode (single, sweep, all dice), transcript mode (OK + tampered detection)
- Help output

