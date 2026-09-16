//! Hub-owned persistence shared by terminal and desktop clients.
pub mod model;
pub mod paths;
pub mod sources;
pub mod store;

pub use model::{custom, ImportDocument, ImportProvider, Provider};
pub use paths::default_db_path;
pub use sources::{read_cc, read_file};
pub use store::{current_providers, import, list_providers, open, open_readonly, remove, SCHEMA};

#[cfg(test)]
mod tests;
