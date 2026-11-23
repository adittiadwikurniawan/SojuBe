import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_IMAGE_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;

export type AllowedImageMime = keyof typeof ALLOWED_IMAGE_MIME_TO_EXT;

export interface ParsedImage {
  data: Buffer;
  mime: AllowedImageMime;
}

export interface S3StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  forcePathStyle: boolean;
}

export interface UploadProductImageInput {
  productId: number | string;
  data: Buffer;
  mime: string;
  timestamp?: number;
}

export interface UploadProductImageResult {
  key: string;
  url: string;
  mime: AllowedImageMime;
  size: number;
}

export interface S3ClientLike {
  send(command: PutObjectCommand): Promise<unknown>;
}

export class StorageValidationError extends Error {
  public readonly status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = 'StorageValidationError';
    this.status = status;
  }
}

let hasLoggedFallbackWarning = false;

export const isAllowedImageMime = (mime: string): mime is AllowedImageMime => {
  return Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_MIME_TO_EXT, mime);
};

export const validateImageBuffer = (data: Buffer, mime: string): ParsedImage => {
  const normalizedMime = mime.trim().toLowerCase();
  if (!isAllowedImageMime(normalizedMime)) {
    throw new StorageValidationError('Format gambar tidak valid. Gunakan JPEG, PNG, WEBP, atau GIF', 400);
  }
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new StorageValidationError('File gambar kosong atau tidak valid', 400);
  }
  if (data.length > MAX_IMAGE_SIZE_BYTES) {
    throw new StorageValidationError('Ukuran gambar maksimal 5 MB', 400);
  }
  return { data, mime: normalizedMime };
};

export const parseImageDataUri = (value: unknown): ParsedImage | null => {
  if (typeof value !== 'string' || !/^data:/i.test(value)) {
    return null;
  }
  const match = value.match(/^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new StorageValidationError('Format gambar tidak valid', 400);
  }
  const mime = match[1].toLowerCase();
  const base64Payload = match[2].replace(/\s+/g, '');
  const data = Buffer.from(base64Payload, 'base64');
  return validateImageBuffer(data, mime);
};

export const getS3Config = (env: NodeJS.ProcessEnv = process.env): S3StorageConfig | null => {
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const region = env.S3_REGION?.trim() || 'us-east-1';
  const publicBaseUrl = env.S3_PUBLIC_BASE_URL?.trim() || undefined;
  const forcePathStyle =
    env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() === 'true' ||
    env.S3_FORCE_PATH_STYLE?.trim() === '1';

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    forcePathStyle,
  };
};

export const isS3Configured = (env: NodeJS.ProcessEnv = process.env): boolean => {
  return getS3Config(env) !== null;
};

export const warnS3FallbackOnce = (): void => {
  if (!hasLoggedFallbackWarning) {
    hasLoggedFallbackWarning = true;
    console.warn(
      '[storageService] S3 environment variables are not configured; falling back to legacy MySQL BLOB product image storage.'
    );
  }
};

export const resetS3FallbackWarning = (): void => {
  hasLoggedFallbackWarning = false;
};

export const createS3Client = (config: S3StorageConfig): S3Client => {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
};

export const buildPublicObjectUrl = (config: S3StorageConfig, key: string): string => {
  const cleanKey = key.replace(/^\/+/, '');
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl.replace(/\/+$/, '')}/${cleanKey}`;
  }
  if (config.endpoint) {
    const cleanEndpoint = config.endpoint.replace(/\/+$/, '');
    if (config.forcePathStyle) {
      return `${cleanEndpoint}/${config.bucket}/${cleanKey}`;
    }
    try {
      const parsed = new URL(cleanEndpoint);
      return `${parsed.protocol}//${config.bucket}.${parsed.host}/${cleanKey}`;
    } catch {
      return `${cleanEndpoint}/${config.bucket}/${cleanKey}`;
    }
  }
  return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${cleanKey}`;
};

export const uploadProductImage = async (
  input: UploadProductImageInput,
  options?: {
    env?: NodeJS.ProcessEnv;
    client?: S3ClientLike;
  }
): Promise<UploadProductImageResult> => {
  const config = getS3Config(options?.env);
  if (!config) {
    throw new StorageValidationError('Konfigurasi S3 storage belum lengkap', 500);
  }

  const validated = validateImageBuffer(input.data, input.mime);
  const ext = ALLOWED_IMAGE_MIME_TO_EXT[validated.mime];
  const timestamp = input.timestamp ?? Date.now();
  const key = `products/${input.productId}-${timestamp}.${ext}`;

  const client = options?.client ?? createS3Client(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: validated.data,
      ContentType: validated.mime,
    })
  );

  const url = buildPublicObjectUrl(config, key);
  return {
    key,
    url,
    mime: validated.mime,
    size: validated.data.length,
  };
};
