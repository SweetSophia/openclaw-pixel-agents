import type { ControlErrorCode } from '../../shared/control';

export class ControlError extends Error {
  constructor(public readonly code: ControlErrorCode) { super(code); }
}

const DEVICE_IO_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EIO', 'EMFILE', 'ENFILE', 'EROFS', 'EBUSY', 'EAGAIN']);
export function isDeviceStorageError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && DEVICE_IO_CODES.has(error.code);
}
