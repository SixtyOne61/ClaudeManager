// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `claude-manager.exe hook` : appelé par les hooks de Claude Code. Pas de fenêtre,
    // et toujours un code de sortie 0, même si l'écriture de l'état a échoué.
    if claude_manager_lib::run_subcommand() {
        std::process::exit(0);
    }
    claude_manager_lib::run()
}
