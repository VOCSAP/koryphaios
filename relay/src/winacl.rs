//! Access list of the key file on Windows: only the current user, SYSTEM and
//! Administrators, with inheritance cut.

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
    ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, INHERITED_ACE,
    PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const SYSTEM_SID: &str = "S-1-5-18";
const ADMINISTRATORS_SID: &str = "S-1-5-32-544";
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

/// Memory allocated by the security API, released with `LocalFree`.
struct LocalMem(*mut c_void);

impl Drop for LocalMem {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

fn sid_to_string(sid: *mut c_void) -> io::Result<String> {
    let mut text: *mut u16 = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(last_error());
    }
    let guard = LocalMem(text.cast());
    let mut len = 0;
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    let out = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    drop(guard);
    Ok(out)
}

fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error());
    }
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    let token = Token(token);
    let mut needed = 0u32;
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(last_error());
    }
    // u64 elements keep the buffer aligned for TOKEN_USER.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(last_error());
    }
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    sid_to_string(user.User.Sid)
}

/// The protected access list: the current user, SYSTEM and Administrators,
/// full control, nothing inherited.
fn protected_descriptor() -> io::Result<LocalMem> {
    let sddl = wide(&format!(
        "D:PAI(A;;FA;;;{})(A;;FA;;;{SYSTEM_SID})(A;;FA;;;{ADMINISTRATORS_SID})",
        current_user_sid()?
    ));
    let mut descriptor: *mut c_void = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(LocalMem(descriptor))
}

/// Creates `path`, which must not exist, with the protected access list from
/// its first instant: Windows checks access only when a handle is opened, so a
/// file created with inherited rights stays readable to whoever opened it then.
pub fn create_private(path: &Path) -> io::Result<File> {
    let descriptor = protected_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateFileW(
            wide_path(path).as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

/// Replaces the access list of `path` with the protected one.
pub fn protect(path: &Path) -> io::Result<()> {
    let template = protected_descriptor()?;
    let descriptor = template.0;
    let (mut present, mut defaulted) = (0, 0);
    let mut dacl: *mut ACL = null_mut();
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
    {
        return Err(io::Error::other("the access list template has no DACL"));
    }
    let code = unsafe {
        SetNamedSecurityInfoW(
            wide_path(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null(),
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    Ok(())
}

/// `Ok(Ok(()))` when the access list is protected, names the current user and
/// holds only allowed ACEs of the three accounts; `Ok(Err(why))` when it is
/// open; `Err` when it cannot be read.
pub fn audit(path: &Path) -> io::Result<Result<(), String>> {
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: *mut c_void = null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            wide_path(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    let _descriptor = LocalMem(descriptor);
    if dacl.is_null() {
        return Ok(Err(
            "has no access list, so it is open to everyone".to_string()
        ));
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(last_error());
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Ok(Err("inherits access rights from its directory".to_string()));
    }

    let mut allowed = Vec::new();
    for text in [
        current_user_sid()?,
        SYSTEM_SID.to_string(),
        ADMINISTRATORS_SID.to_string(),
    ] {
        let mut sid: *mut c_void = null_mut();
        if unsafe { ConvertStringSidToSidW(wide(&text).as_ptr(), &mut sid) } == 0 {
            return Err(last_error());
        }
        allowed.push(LocalMem(sid));
    }

    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(last_error());
    }
    let mut user_entry = false;
    for index in 0..info.AceCount {
        let mut ace: *mut c_void = null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err(last_error());
        }
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
            return Ok(Err(format!(
                "holds an access entry of type {}",
                header.AceType
            )));
        }
        if u32::from(header.AceFlags) & INHERITED_ACE != 0 {
            return Ok(Err("holds an inherited access entry".to_string()));
        }
        let sid = unsafe { std::ptr::addr_of!((*(ace as *const ACCESS_ALLOWED_ACE)).SidStart) }
            as *mut c_void;
        if !allowed
            .iter()
            .any(|known| unsafe { EqualSid(sid, known.0) } != 0)
        {
            return Ok(Err(format!("grants rights to {}", sid_to_string(sid)?)));
        }
        user_entry |= unsafe { EqualSid(sid, allowed[0].0) } != 0;
    }
    if !user_entry {
        return Ok(Err("has no access entry for the current user".to_string()));
    }
    Ok(Ok(()))
}
