mod commands;

use clap::{Parser, Subcommand};

/// TrueRolls CLI, roll dice and verify distribution invariants.
///
/// Local roll uses pure math via kd-core, no server needed.
/// Remote verify can call a running kd-api server. Remote roll is disabled until
/// the CLI implements the drand-backed API flow.
#[derive(Parser)]
#[command(name = "kd", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Roll a die with guarded karma distribution.
    Roll(commands::roll::RollArgs),
    /// Verify distribution caps hold for given parameters or a transcript file.
    Verify(commands::verify::VerifyArgs),
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Roll(args) => commands::roll::execute(args),
        Commands::Verify(args) => commands::verify::execute(args),
    };

    if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
