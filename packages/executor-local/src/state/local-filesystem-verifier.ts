import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { parse, relative } from 'node:path';

export type LocalFilesystemVerification =
  | {
      readonly status: 'local';
      readonly filesystemType: string;
    }
  | {
      readonly status: 'network' | 'unknown';
      readonly filesystemType?: string;
      readonly reason: string;
    };

export interface LocalFilesystemVerifier {
  verify(path: string): Promise<LocalFilesystemVerification>;
}

const WINDOWS_DRIVE_CACHE = new Map<string, Promise<LocalFilesystemVerification>>();

const NETWORK_MOUNT_TYPES = new Set([
  '9p',
  'afs',
  'ceph',
  'cifs',
  'coda',
  'davfs',
  'davfs2',
  'glusterfs',
  'lustre',
  'ncpfs',
  'nfs',
  'nfs4',
  'smb3',
  'smbfs',
]);

const LOCAL_MOUNT_TYPES = new Set([
  'apfs',
  'btrfs',
  'erofs',
  'exfat',
  'ext2',
  'ext3',
  'ext4',
  'f2fs',
  'hfs',
  'hfsplus',
  'jfs',
  'msdos',
  'ntfs',
  'ntfs3',
  'overlay',
  'ramfs',
  'reiserfs',
  'squashfs',
  'tmpfs',
  'ufs',
  'vfat',
  'xfs',
  'zfs',
]);

const NETWORK_FILESYSTEM_MAGIC = new Set([
  0x0000_517b, // SMB
  0x0000_6969, // NFS
  0x0000_564c, // NCP
  0x00c3_6400, // Ceph
  0x0102_1997, // 9P
  0x5346_414f, // AFS
  0x7375_7245, // Coda
  0xff53_4d42, // CIFS
]);

const LOCAL_FILESYSTEM_MAGIC = new Set([
  0x0000_4d44, // FAT
  0x0000_ef53, // ext2/3/4
  0x0102_1994, // tmpfs
  0x2011_bab0, // exFAT
  0x2405_1905, // UBIFS
  0x2fc1_2fc1, // ZFS
  0x3153_464a, // JFS
  0x5265_4973, // ReiserFS
  0x5346_544e, // NTFS
  0x5846_5342, // XFS
  0x7371_7368, // SquashFS
  0x794c_7630, // overlayfs
  0x8584_58f6, // ramfs
  0x9123_683e, // Btrfs
  0xe0f5_e1e2, // EROFS
  0xf2f5_2010, // F2FS
]);

export const defaultLocalFilesystemVerifier: LocalFilesystemVerifier = Object.freeze({
  verify: verifyLocalFilesystem,
});

async function verifyLocalFilesystem(path: string): Promise<LocalFilesystemVerification> {
  if (process.platform === 'win32') return verifyWindowsFilesystem(path);
  if (process.platform === 'linux') return verifyLinuxFilesystem(path);
  return {
    status: 'unknown',
    reason: `No built-in local-filesystem verifier is available for ${process.platform}.`,
  };
}

function verifyWindowsFilesystem(path: string): Promise<LocalFilesystemVerification> {
  const root = parse(path).root;
  const match = /^([a-z]):\\$/iu.exec(root);
  if (match === null) {
    return Promise.resolve({
      status: 'unknown',
      reason: 'The Windows path is not rooted in a drive letter.',
    });
  }
  const deviceId = `${match[1]!.toUpperCase()}:`;
  let verification = WINDOWS_DRIVE_CACHE.get(deviceId);
  if (verification === undefined) {
    verification = queryWindowsDriveType(deviceId);
    WINDOWS_DRIVE_CACHE.set(deviceId, verification);
  }
  return verification;
}

async function queryWindowsDriveType(deviceId: string): Promise<LocalFilesystemVerification> {
  const script = `$drive = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${deviceId}'"; if ($null -eq $drive) { exit 3 }; [Console]::Out.Write($drive.DriveType)`;
  try {
    const stdout = await executeFile('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    const driveType = Number(stdout.trim());
    if (driveType === 4) {
      return {
        status: 'network',
        filesystemType: 'windows-drive-type-4',
        reason: 'The configured root is on a mapped network drive.',
      };
    }
    if ([2, 3, 6].includes(driveType)) {
      return { status: 'local', filesystemType: `windows-drive-type-${driveType}` };
    }
    return {
      status: 'unknown',
      filesystemType: `windows-drive-type-${String(driveType)}`,
      reason: 'Windows did not report a writable local drive type.',
    };
  } catch {
    return {
      status: 'unknown',
      reason: 'Windows drive type could not be verified through Win32_LogicalDisk.',
    };
  }
}

async function verifyLinuxFilesystem(path: string): Promise<LocalFilesystemVerification> {
  let magic: number | undefined;
  try {
    magic = Number((await statfs(path)).type) >>> 0;
  } catch {
    return { status: 'unknown', reason: 'statfs() could not verify the configured root.' };
  }
  const mount = await findLinuxMount(path);
  if (NETWORK_FILESYSTEM_MAGIC.has(magic) || isNetworkMountType(mount?.filesystemType)) {
    return {
      status: 'network',
      ...(mount === undefined ? {} : { filesystemType: mount.filesystemType }),
      reason: 'The configured root is on a network filesystem.',
    };
  }
  if (
    mount !== undefined &&
    LOCAL_MOUNT_TYPES.has(mount.filesystemType) &&
    LOCAL_FILESYSTEM_MAGIC.has(magic)
  ) {
    return { status: 'local', filesystemType: mount.filesystemType };
  }
  return {
    status: 'unknown',
    ...(mount === undefined ? {} : { filesystemType: mount.filesystemType }),
    reason: `The filesystem type or statfs magic (${magic.toString(16)}) is not allowlisted.`,
  };
}

async function findLinuxMount(
  path: string,
): Promise<{ readonly mountPoint: string; readonly filesystemType: string } | undefined> {
  let text: string;
  try {
    text = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return undefined;
  }
  let selected: { readonly mountPoint: string; readonly filesystemType: string } | undefined;
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 5 || right.length < 1) continue;
    const mountPoint = decodeMountInfoField(left[4]!);
    const filesystemType = right[0]!.toLowerCase();
    if (
      isWithinMount(path, mountPoint) &&
      (selected === undefined || mountPoint.length > selected.mountPoint.length)
    ) {
      selected = { mountPoint, filesystemType };
    }
  }
  return selected;
}

function isNetworkMountType(filesystemType: string | undefined): boolean {
  if (filesystemType === undefined) return false;
  return (
    NETWORK_MOUNT_TYPES.has(filesystemType) ||
    /^(?:fuse\.)?(?:gcsfuse|rclone|s3fs|sshfs)$/u.test(filesystemType)
  );
}

function decodeMountInfoField(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function isWithinMount(path: string, mountPoint: string): boolean {
  const child = relative(mountPoint, path);
  return child === '' || (child !== '..' && !child.startsWith('../'));
}

function executeFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: 4_096, timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });
}
