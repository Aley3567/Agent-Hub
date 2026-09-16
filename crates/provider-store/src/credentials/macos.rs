//! security owns the Keychain ACL for both Rust and Python callers.
use super::{valid_reference, CredentialError, SecretStore, SERVICE};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub struct MacOsStore;

fn invoke(command: &str) -> Result<Vec<u8>, CredentialError> {
    // security's interactive parser has a 4096-byte line buffer. Never let it
    // split a secret into another command or silently truncate a payload.
    if command.len() > 4094 {
        return Err(CredentialError::TooLarge);
    }
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| CredentialError::Unavailable)?;
    let mut input = child.stdin.take().ok_or(CredentialError::Unavailable)?;
    if input.write_all(command.as_bytes()).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(CredentialError::Unavailable);
    }
    // Close stdin after exactly one command. An extra `exit` masks its status.
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = Vec::new();
                let mut error = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_end(&mut output);
                }
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut error);
                }
                if status.success() {
                    if output.last() == Some(&b'\n') {
                        output.pop();
                    }
                    // security prints non-ASCII/control-containing passwords as
                    // bare hex. Provider payloads are JSON objects, never hex.
                    if !output.is_empty()
                        && output.len() % 2 == 0
                        && output.iter().all(u8::is_ascii_hexdigit)
                    {
                        output = output
                            .chunks_exact(2)
                            .map(|pair| {
                                u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
                            })
                            .collect();
                    }
                    return Ok(output);
                }
                let code = error
                    .lines()
                    .rev()
                    .find_map(|line| line.rsplit_once(": returned ")?.1.parse::<i32>().ok());
                return Err(match code {
                    Some(-25300) => CredentialError::NotFound,
                    Some(-128 | -25293) => CredentialError::Denied,
                    Some(-25308) => CredentialError::Locked,
                    Some(-26275) => CredentialError::Corrupt,
                    _ => CredentialError::Unavailable,
                });
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            other => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if other.is_ok() {
                    CredentialError::Timeout
                } else {
                    CredentialError::Unavailable
                });
            }
        }
    }
}

impl SecretStore for MacOsStore {
    fn read(&self, reference: &str) -> Result<Vec<u8>, CredentialError> {
        if !valid_reference(reference) {
            return Err(CredentialError::Corrupt);
        }
        invoke(&format!(
            "find-generic-password -s {SERVICE} -a {reference} -w\n"
        ))
    }
    fn create(&self, reference: &str, payload: &[u8]) -> Result<(), CredentialError> {
        if !valid_reference(reference) || payload.is_empty() {
            return Err(CredentialError::Corrupt);
        }
        let hex: String = payload.iter().map(|byte| format!("{byte:02x}")).collect();
        invoke(&format!(
            "add-generic-password -s {SERVICE} -a {reference} -X {hex}\n"
        ))?;
        if self.read(reference)? != payload {
            return Err(CredentialError::Corrupt);
        }
        Ok(())
    }
    fn delete(&self, reference: &str) -> Result<(), CredentialError> {
        if !valid_reference(reference) {
            return Err(CredentialError::Corrupt);
        }
        match invoke(&format!(
            "delete-generic-password -s {SERVICE} -a {reference}\n"
        )) {
            Ok(_) | Err(CredentialError::NotFound) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_reference_and_oversize_are_rejected_before_spawn() {
        assert_eq!(MacOsStore.read("--help"), Err(CredentialError::Corrupt));
        assert_eq!(
            MacOsStore.create(
                "provider/v1/00000000-0000-4000-8000-000000000001",
                &[b'a'; 2048]
            ),
            Err(CredentialError::TooLarge)
        );
    }
    #[test]
    #[ignore = "explicit synthetic Keychain probe; never part of unattended unit tests"]
    fn keychain_roundtrip() {
        let reference = format!(
            "provider/v1/00000000-0000-4000-8000-{:012x}",
            std::process::id()
        );
        let payload = include_bytes!("../../../../tests/fixtures/provider-credential-v1.json");
        let result = MacOsStore.create(&reference, payload);
        let read = MacOsStore.read(&reference);
        let cleanup = MacOsStore.delete(&reference);
        assert_eq!(result, Ok(()));
        assert_eq!(read.unwrap(), payload);
        assert_eq!(cleanup, Ok(()));
        assert_eq!(MacOsStore.read(&reference), Err(CredentialError::NotFound));
    }
}
