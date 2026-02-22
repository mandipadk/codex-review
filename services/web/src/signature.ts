import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(secret: string, rawBody: string, signatureHeader?: string): boolean {
  if (!signatureHeader) {
    return false;
  }

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
