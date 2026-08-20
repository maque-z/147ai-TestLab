// Mirrors backend/app/schemas/user.py. The byte count is the part that matters:
// bcrypt truncates at 72 *bytes*, and one Chinese character is 3 of them, so a
// character-based check would let a 30-character Chinese passphrase through with
// its tail silently discarded.
export const PASSWORD_MIN_CHARS = 8
export const PASSWORD_MAX_BYTES = 72

const encoder = new TextEncoder()

/** The problem with this password, or an empty string when it is acceptable. */
export function checkPassword(password: string): string {
  if (password.length < PASSWORD_MIN_CHARS) {
    return `密码至少 ${PASSWORD_MIN_CHARS} 位`
  }
  if (encoder.encode(password).length > PASSWORD_MAX_BYTES) {
    return `密码不能超过 ${PASSWORD_MAX_BYTES} 字节（约 24 个汉字）`
  }
  return ''
}
