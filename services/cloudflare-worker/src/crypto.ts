const encoder = new TextEncoder();

function base64Url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;

  if (typeof input === 'string') {
    bytes = encoder.encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hex(input: ArrayBuffer): string {
  return Array.from(new Uint8Array(input))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .trim();

  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer;
}

export async function verifyGitHubSignature(secret: string, rawBody: string, signatureHeader?: string | null): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = `sha256=${hex(signatureBuffer)}`;

  return timingSafeEqual(expected, signatureHeader);
}

export async function createGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(privateKeyPem),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(unsignedToken));
  return `${unsignedToken}.${base64Url(signature)}`;
}

export async function shortHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return hex(digest).slice(0, 16);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return hex(digest);
}

export function randomToken(size = 32): string {
  return base64Url(randomBytes(size));
}
