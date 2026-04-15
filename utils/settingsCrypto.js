const crypto = require('crypto');

const ENCRYPTION_PREFIX = 'enc:v1';
const IV_LENGTH = 12;

function getEncryptionKey() {
  const secret = String(process.env.ACCESS_TOKEN_SECRET || '').trim();
  if (!secret) {
    throw new Error('ACCESS_TOKEN_SECRET non configurato: impossibile cifrare le impostazioni sensibili.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(`${ENCRYPTION_PREFIX}:`);
}

function encryptValue(value) {
  const plainText = String(value ?? '').trim();
  if (!plainText) return '';
  if (isEncryptedValue(plainText)) return plainText;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString('base64'),
    encrypted.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

function decryptValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!isEncryptedValue(raw)) return raw;

  const [, , ivRaw, encryptedRaw, tagRaw] = raw.split(':');
  if (!ivRaw || !encryptedRaw || !tagRaw) {
    throw new Error('Formato impostazione cifrata non valido.');
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivRaw, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptValue,
  decryptValue,
  isEncryptedValue,
};
