import crypto from 'crypto';
import jwt from 'jsonwebtoken'
import { logger } from '../utils/logger';
import { EnrollBiometricData, IEncryptBase } from '../types';

class SecurityService {
  private aesKey: Buffer | null = null;
  private readonly AES_ALGORITHM = 'aes-256-gcm';
  private readonly JWT_SECRET = '515aec2bbc0555da5099c3f01090640462c80c6837cb1aa1b8ea3ede47640a81';

  /**
   * Initialize security configuration from certificate files and environment
   */
  initialize(): void {
    try {
      // const certsPath = path.resolve(__dirname, '../certs');
      // const aesKeyPath = path.join(certsPath, 'aes.key');
     

        //const keyData = fs.readFileSync(aesKeyPath, 'utf8');
        // Parse base64 encoded key
        this.aesKey = Buffer.from('515aec2bbc0555da5099c3f01090640462c80c6837cb1aa1b8ea3ede47640a81', 'hex');
        
        if (this.aesKey.length !== 32) {
          logger.warn(`Security Service: AES key length is ${this.aesKey.length}, expected 32 bytes`);
        }
        logger.info('Security Service: AES Key loaded successfully.');
    
    
    } catch (error) {
      logger.error('Failed to initialize security service:', error);
    }
  }

  generateToken(deviceId: string): string {
    return jwt.sign({ deviceId }, this.JWT_SECRET, { expiresIn: '3h' });
  }

  verifyToken(token: string): any {
    try {
      return jwt.verify(token, this.JWT_SECRET);
    } catch (error) {
      logger.error('Token verification failed:', error);
      return null;
    }
  }

  /**
   * Encrypt payload using AES-256-GCM
   */
  encrypt(payload: any): IEncryptBase {
    try {
      if (!this.aesKey) {
        throw new Error('Security service not initialized');
      }

      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const iv = crypto.randomBytes(12);
      const algorithm = this.AES_ALGORITHM;

      const cipher = crypto.createCipheriv(algorithm, this.aesKey, iv);
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const tag = cipher.getAuthTag();

       return {
        data: encrypted,
        IV: iv.toString('hex'),
        TAG: tag.toString('hex'),
      };
    } catch (error) {
      logger.error('Encryption error:', error);
      throw new Error(`Failed to encrypt payload: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  /**
   * Encrypt payload with DER format public key
   */
  encryptPayload(payload: any, messageId: string, vehicleId: string): any {
    try {
      const encryptedData = this.encrypt(payload);
      console.info("aesKey:", this.aesKey);
      console.info("Encrypted data:", {
        time_stamp: Date.now(),
        message_id: messageId,
        check_in_data: {
          v: 1,
          mid: messageId,
          ts: Date.now(),
          did: vehicleId,
          d: encryptedData,
        },
      });
      return {
        time_stamp: Date.now(),
        message_id: messageId,
        check_in_data: {
          v: 1,
          mid: messageId,
          ts: Date.now(),
          did: vehicleId,
          d: encryptedData,
        },
      };
    } catch (error) {
      logger.error('Error in encryptPayload:', error);
      throw error;
    }
  }

  /**
   * Decrypt payload using AES-256-GCM
   */
  decrypt<T>(encrypted: IEncryptBase): T {
    try {
      if (!this.aesKey) {
        throw new Error('Server security not initialized');
      }
      
      // Extract IV, auth tag, and ciphertext
      const iv = Buffer.from(encrypted?.IV, 'hex');
      const tag = Buffer.from(encrypted?.TAG, 'hex');
      const ciphertext = Buffer.from(encrypted?.data, 'hex');

      // Decrypt payload using AES-256-GCM
      const decipher = crypto.createDecipheriv(
        this.AES_ALGORITHM,
        this.aesKey,
        iv
      );

      decipher.setAuthTag(tag);

      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      logger.debug('✅ AES decryption completed successfully');

      // Parse result as JSON
      const decryptedStr = decrypted.toString('utf8');
      const result: T = JSON.parse(decryptedStr);

      logger.info('✅ Payload parsed as JSON');

      return result;
    } catch (error: any) {
      logger.error('❌ Decryption failed:', {
        message: error.message,
        code: error.code,
        opensslCode: error.opensslErrorStack,
      });
      throw new Error(`Security Decrypt Error: ${error.message}`);
    }
  }
}

export const securityService = new SecurityService();