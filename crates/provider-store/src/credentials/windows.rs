//! Credential Manager adapter. Native Windows acceptance gates product writes.
use super::{valid_reference, CredentialError, SecretStore, SERVICE};
use std::ffi::c_void;

#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}
#[repr(C)]
struct Credential {
    flags: u32,
    kind: u32,
    target: *mut u16,
    comment: *mut u16,
    written: FileTime,
    size: u32,
    blob: *mut u8,
    persist: u32,
    attribute_count: u32,
    attributes: *mut c_void,
    alias: *mut u16,
    username: *mut u16,
}
#[link(name = "Advapi32")]
unsafe extern "system" {
    fn CredReadW(target: *const u16, kind: u32, flags: u32, result: *mut *mut Credential) -> i32;
    fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
    fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
    fn CredFree(buffer: *mut c_void);
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn GetLastError() -> u32;
}

fn last_error() -> CredentialError {
    match unsafe { GetLastError() } {
        1168 => CredentialError::NotFound,
        5 => CredentialError::Denied,
        1312 => CredentialError::Locked,
        _ => CredentialError::Unavailable,
    }
}
fn target(reference: &str) -> Result<Vec<u16>, CredentialError> {
    if !valid_reference(reference) {
        return Err(CredentialError::Corrupt);
    }
    Ok(format!("{SERVICE}:{reference}")
        .encode_utf16()
        .chain(Some(0))
        .collect())
}

pub struct WindowsStore;
impl SecretStore for WindowsStore {
    fn read(&self, reference: &str) -> Result<Vec<u8>, CredentialError> {
        let target = target(reference)?;
        let mut pointer = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), 1, 0, &mut pointer) } == 0 {
            return Err(last_error());
        }
        if pointer.is_null() {
            return Err(CredentialError::Corrupt);
        }
        let result = unsafe {
            let item = &*pointer;
            if item.size == 0 || item.size > 2560 || item.blob.is_null() {
                Err(CredentialError::Corrupt)
            } else {
                Ok(std::slice::from_raw_parts(item.blob, item.size as usize).to_vec())
            }
        };
        unsafe { CredFree(pointer.cast()) };
        result
    }
    fn create(&self, reference: &str, payload: &[u8]) -> Result<(), CredentialError> {
        let mut target = target(reference)?;
        if payload.len() > 2560 {
            return Err(CredentialError::TooLarge);
        }
        if payload.is_empty() {
            return Err(CredentialError::Corrupt);
        }
        // The store coordinator owns the cross-process write lock. Never update
        // a prior immutable account even though CredWrite itself allows it.
        match self.read(reference) {
            Err(CredentialError::NotFound) => (),
            Ok(_) => return Err(CredentialError::Corrupt),
            Err(error) => return Err(error),
        }
        let credential = Credential {
            flags: 0,
            kind: 1,
            target: target.as_mut_ptr(),
            comment: std::ptr::null_mut(),
            written: FileTime { low: 0, high: 0 },
            size: payload.len() as u32,
            blob: payload.as_ptr().cast_mut(),
            persist: 2,
            attribute_count: 0,
            attributes: std::ptr::null_mut(),
            alias: std::ptr::null_mut(),
            username: std::ptr::null_mut(),
        };
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(last_error());
        }
        if self.read(reference)? != payload {
            return Err(CredentialError::Corrupt);
        }
        Ok(())
    }
    fn delete(&self, reference: &str) -> Result<(), CredentialError> {
        let target = target(reference)?;
        if unsafe { CredDeleteW(target.as_ptr(), 1, 0) } != 0 {
            return Ok(());
        }
        match last_error() {
            CredentialError::NotFound => Ok(()),
            error => Err(error),
        }
    }
}
