//! OS process facts. A value that cannot be measured is `None`; the caller
//! logs it.

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
        TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

    const STILL_ACTIVE: u32 = 259;

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open(pid: u32, access: u32) -> Option<Handle> {
        let h = unsafe { OpenProcess(access, 0, pid) };
        if h.is_null() {
            None
        } else {
            Some(Handle(h))
        }
    }

    pub fn username() -> Option<String> {
        let mut buf = [0u16; 257];
        let mut len = buf.len() as u32;
        if unsafe { GetUserNameW(buf.as_mut_ptr(), &mut len) } == 0 || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(len as usize - 1)]))
    }

    pub fn parent_pid() -> Option<u32> {
        let me = std::process::id();
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let snap = Handle(snap);
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = unsafe { Process32FirstW(snap.0, &mut entry) } != 0;
        while ok {
            if entry.th32ProcessID == me {
                return Some(entry.th32ParentProcessID);
            }
            ok = unsafe { Process32NextW(snap.0, &mut entry) } != 0;
        }
        None
    }

    pub fn start_time(pid: u32) -> Option<String> {
        let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
        if unsafe { GetProcessTimes(h.0, &mut created, &mut exit, &mut kernel, &mut user) } == 0 {
            return None;
        }
        Some((((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string())
    }

    pub fn image_stem(pid: u32) -> Option<String> {
        let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        if unsafe { QueryFullProcessImageNameW(h.0, 0, buf.as_mut_ptr(), &mut len) } == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = path.rsplit(['\\', '/']).next()?;
        Some(
            name.strip_suffix(".exe")
                .or_else(|| name.strip_suffix(".EXE"))
                .unwrap_or(name)
                .to_lowercase(),
        )
    }

    pub fn is_alive(pid: u32) -> bool {
        let Some(h) = open(pid, PROCESS_QUERY_LIMITED_INFORMATION) else {
            return false;
        };
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(h.0, &mut code) != 0 && code == STILL_ACTIVE }
    }

    pub fn terminate(pid: u32) -> std::io::Result<()> {
        let h = open(pid, PROCESS_TERMINATE).ok_or_else(std::io::Error::last_os_error)?;
        if unsafe { TerminateProcess(h.0, 1) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
mod imp {
    use std::process::Command;

    pub fn username() -> Option<String> {
        let mut buf = vec![0u8; 4096];
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                &mut pwd,
                buf.as_mut_ptr() as *mut libc::c_char,
                buf.len(),
                &mut out,
            )
        };
        if rc != 0 || out.is_null() {
            return None;
        }
        let name = unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) };
        Some(name.to_string_lossy().into_owned())
    }

    pub fn parent_pid() -> Option<u32> {
        Some(unsafe { libc::getppid() } as u32)
    }

    fn ps(pid: u32, field: &str) -> Option<String> {
        let out = Command::new("ps")
            .args(["-o", &format!("{field}="), "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !text.is_empty() {
            Some(text)
        } else {
            None
        }
    }

    pub fn start_time(pid: u32) -> Option<String> {
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            return super::proc_stat_start_time(&stat);
        }
        ps(pid, "lstart")
    }

    pub fn image_stem(pid: u32) -> Option<String> {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|s| s.trim().to_string())
            .or_else(|| ps(pid, "comm"))?;
        name.rsplit('/').next().map(str::to_lowercase)
    }

    pub fn is_alive(pid: u32) -> bool {
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    pub fn terminate(pid: u32) -> std::io::Result<()> {
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

pub use imp::{image_stem, is_alive, parent_pid, start_time, username};

/// Field 22 of a `/proc/<pid>/stat` line (start time in clock ticks since
/// boot). The command name sits in parentheses and may itself contain spaces
/// and parentheses, so the fields are counted after the last `)`.
pub fn proc_stat_start_time(stat: &str) -> Option<String> {
    let after = stat.rsplit_once(')')?.1;
    after.split_whitespace().nth(19).map(str::to_string)
}

/// Pid 0 and any pid above `i32::MAX` are refused: on POSIX `kill(0)` and a
/// negative pid address whole process groups.
pub fn terminate(pid: u32) -> std::io::Result<()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to stop pid {pid}"),
        ));
    }
    imp::terminate(pid)
}
