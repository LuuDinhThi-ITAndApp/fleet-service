import * as Minio from 'minio';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Readable } from 'stream';

class MinIOClient {
  private client: Minio.Client;
  private bucket: string;

  constructor() {
    this.bucket = config.minio.bucket;

    this.client = new Minio.Client({
      endPoint: config.minio.endpoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
    });

    logger.info(`MinIO client initialized: ${config.minio.endpoint}:${config.minio.port}`);
    logger.info(`MinIO credentials: accessKey=${config.minio.accessKey}, secretKey=${config.minio.secretKey.substring(0, 3)}***`);
    // Helpful diagnostic: if the secret contains a '#' and wasn't quoted in .env it may have been truncated by dotenv.
    if (config.minio.secretKey && config.minio.secretKey.indexOf('#') === -1) {
      logger.debug('MinIO secret does not contain the # character (ok).');
    } else if (config.minio.secretKey) {
      logger.debug('MinIO secret contains a # character — ensure it is quoted in your .env (e.g. MINIO_SECRET_KEY="pa#ssword").');
    }
  }

  /**
   * Initialize MinIO - skip bucket check, assume bucket exists
   * Bucket fleet-snapshots should be pre-created with correct permissions
   */
  async initialize(): Promise<void> {
    try {
      logger.info(`MinIO configured for bucket: ${this.bucket}`);
      logger.info('Skipping bucket verification - assuming bucket exists with correct permissions');
      logger.info('Images will be uploaded to MinIO when DMS events are received');
    } catch (error) {
      logger.error('Error initializing MinIO:', error);
      throw error;
    }
  }

  /**
   * Upload image from base64 string
   * @param base64Data - Base64 encoded image data (with or without data:image prefix)
   * @param fileName - Filename for the upload
   * @param contentType - MIME type (default: image/png)
   * @returns Public URL of uploaded file
   */
  async uploadImageFromBase64(
    base64Data: string,
    fileName: string,
    contentType: string = 'image/png'
  ): Promise<string> {
    try {
      // Remove data URL prefix if present (e.g., "data:image/png;base64,")
      const base64WithoutPrefix = base64Data.replace(/^data:image\/\w+;base64,/, '');

      // Convert base64 to buffer
      const imageBuffer = Buffer.from(base64WithoutPrefix, 'base64');

      logger.info(`Uploading to MinIO: bucket=${this.bucket}, file=${fileName}, size=${imageBuffer.length} bytes`);

      // Convert buffer to stream
      const stream = Readable.from(imageBuffer);

      // Upload to MinIO
      await this.client.putObject(this.bucket, fileName, stream, imageBuffer.length, {
        'Content-Type': contentType,
      });

      // Generate public URL
      const publicUrl = this.getPublicUrl(fileName);

      logger.info(`Image uploaded to MinIO: ${fileName}`);
      return publicUrl;
    } catch (error) {
      logger.error('Error uploading image to MinIO:', error);
      logger.error(`Failed upload details: bucket=${this.bucket}, file=${fileName}`);
      throw error;
    }
  }

  /**
   * Upload buffer to MinIO
   * @param buffer - Image buffer
   * @param fileName - Filename for the upload
   * @param contentType - MIME type
   * @returns Public URL of uploaded file
   */
  async uploadBuffer(
    buffer: Buffer,
    fileName: string,
    contentType: string = 'image/png'
  ): Promise<string> {
    try {
      const stream = Readable.from(buffer);

      await this.client.putObject(this.bucket, fileName, stream, buffer.length, {
        'Content-Type': contentType,
      });

      const publicUrl = this.getPublicUrl(fileName);

      logger.info(`Buffer uploaded to MinIO: ${fileName}`);
      return publicUrl;
    } catch (error) {
      logger.error('Error uploading buffer to MinIO:', error);
      throw error;
    }
  }

  /**
   * Get public URL for a file
   * @param fileName - Filename in the bucket
   * @returns Public URL
   */
  getPublicUrl(fileName: string): string {
    const protocol = config.minio.useSSL ? 'https' : 'http';
    return `${protocol}://${config.minio.endpoint}:${config.minio.port}/${this.bucket}/${fileName}`;
  }

  /**
   * Delete a file from MinIO
   * @param fileName - Filename to delete
   */
  async deleteFile(fileName: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, fileName);
      logger.info(`File deleted from MinIO: ${fileName}`);
    } catch (error) {
      logger.error('Error deleting file from MinIO:', error);
      throw error;
    }
  }

  /**
   * Get presigned URL for temporary access
   * @param fileName - Filename
   * @param expiry - Expiry time in seconds (default: 24 hours)
   * @returns Presigned URL
   */
  async getPresignedUrl(fileName: string, expiry: number = 86400): Promise<string> {
    try {
      const url = await this.client.presignedGetObject(this.bucket, fileName, expiry);
      return url;
    } catch (error) {
      logger.error('Error getting presigned URL:', error);
      throw error;
    }
  }
}

export const minioClient = new MinIOClient();
