//! Hub-owned persistence shared by terminal and desktop clients.
pub mod credentials;
pub mod edit;
pub mod commit;
pub mod model;
pub mod native;
pub mod migration;
pub mod paths;
pub mod references;
pub mod plan;
pub mod sources;
pub mod store;
mod snapshot;

pub use model::{custom, ImportDocument, ImportProvider, Provider};
pub use paths::default_db_path;
pub use sources::{read_cc, read_file};
pub use store::{current_providers, import, list_providers, open, open_readonly, remove, SCHEMA};

#[cfg(test)]
mod plan_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod commit_tests;
