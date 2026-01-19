import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private isInitialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase(): void {
    // Try to load from JSON file first (more reliable)
    const jsonPath = path.join(process.cwd(), 'firebase-service-account.json');

    if (fs.existsSync(jsonPath)) {
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        // Debug: Log service account info
        this.logger.log(`Service Account Project ID: ${serviceAccount.project_id}`);
        this.logger.log(`Service Account Client Email: ${serviceAccount.client_email}`);
        this.logger.log(`Service Account Private Key ID: ${serviceAccount.private_key_id}`);

        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        this.isInitialized = true;
        this.logger.log('Firebase Admin SDK initialized from JSON file');
        return;
      } catch (error) {
        this.logger.error(`Failed to initialize Firebase from JSON: ${error.message}`);
      }
    }

    // Fallback to environment variables
    const projectId = this.configService.get<string>('firebase.projectId');
    const clientEmail = this.configService.get<string>('firebase.clientEmail');
    const privateKey = this.configService.get<string>('firebase.privateKey');

    this.logger.debug(`Firebase config - projectId: ${projectId || 'NOT SET'}`);
    this.logger.debug(`Firebase config - clientEmail: ${clientEmail || 'NOT SET'}`);
    this.logger.debug(`Firebase config - privateKey: ${privateKey ? `SET (${privateKey.length} chars)` : 'NOT SET'}`);

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials not configured. Push notifications will be disabled.',
      );
      return;
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      this.isInitialized = true;
      this.logger.log('Firebase Admin SDK initialized from environment variables');
    } catch (error) {
      this.logger.error(`Failed to initialize Firebase: ${error.message}`);
    }
  }

  async sendNotification(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<boolean> {
    if (!this.isInitialized) {
      this.logger.warn('Firebase not initialized. Cannot send notification.');
      return false;
    }

    try {
      const message: admin.messaging.Message = {
        token,
        notification: {
          title,
          body,
        },
        data,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'price_alerts',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      await admin.messaging().send(message);
      this.logger.debug(`Notification sent to token: ${token.substring(0, 20)}...`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send notification: ${error.message}`);
      this.logger.error(`Full error: ${JSON.stringify(error, null, 2)}`);

      // Handle invalid token
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        return false;
      }

      return false;
    }
  }

  async sendMulticastNotification(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ successCount: number; failedTokens: string[] }> {
    if (!this.isInitialized) {
      this.logger.warn('Firebase not initialized. Cannot send notifications.');
      return { successCount: 0, failedTokens: tokens };
    }

    if (tokens.length === 0) {
      return { successCount: 0, failedTokens: [] };
    }

    try {
      const message: admin.messaging.MulticastMessage = {
        tokens,
        notification: {
          title,
          body,
        },
        data,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'price_alerts',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
        }
      });

      this.logger.debug(
        `Multicast notification: ${response.successCount}/${tokens.length} sent`,
      );

      return {
        successCount: response.successCount,
        failedTokens,
      };
    } catch (error) {
      this.logger.error(`Failed to send multicast notification: ${error.message}`);
      return { successCount: 0, failedTokens: tokens };
    }
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Send a silent push notification to trigger background refresh.
   * Silent pushes don't show any UI to the user.
   */
  async sendSilentPush(
    token: string,
    data?: Record<string, string>,
  ): Promise<boolean> {
    if (!this.isInitialized) {
      this.logger.warn('Firebase not initialized. Cannot send silent push.');
      return false;
    }

    try {
      const message: admin.messaging.Message = {
        token,
        data: {
          ...data,
          type: 'background_refresh',
        },
        apns: {
          payload: {
            aps: {
              'content-available': 1,
            },
          },
          headers: {
            'apns-priority': '5', // Low priority for silent pushes (required by Apple)
            'apns-push-type': 'background',
          },
        },
        android: {
          priority: 'normal',
        },
      };

      await admin.messaging().send(message);
      this.logger.debug(`Silent push sent to token: ${token.substring(0, 20)}...`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send silent push: ${error.message}`);
      return false;
    }
  }

  /**
   * Send silent push to multiple tokens.
   */
  async sendSilentPushMulticast(
    tokens: string[],
    data?: Record<string, string>,
  ): Promise<{ successCount: number; failedTokens: string[] }> {
    if (!this.isInitialized) {
      this.logger.warn('Firebase not initialized. Cannot send silent pushes.');
      return { successCount: 0, failedTokens: tokens };
    }

    if (tokens.length === 0) {
      return { successCount: 0, failedTokens: [] };
    }

    try {
      const message: admin.messaging.MulticastMessage = {
        tokens,
        data: {
          ...data,
          type: 'background_refresh',
        },
        apns: {
          payload: {
            aps: {
              'content-available': 1,
            },
          },
          headers: {
            'apns-priority': '5',
            'apns-push-type': 'background',
          },
        },
        android: {
          priority: 'normal',
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
          this.logger.error(
            `Silent push failed for token ${tokens[idx].substring(0, 20)}...: ${resp.error?.code} - ${resp.error?.message}`,
          );
        }
      });

      this.logger.debug(
        `Silent push multicast: ${response.successCount}/${tokens.length} sent`,
      );

      return {
        successCount: response.successCount,
        failedTokens,
      };
    } catch (error) {
      this.logger.error(`Failed to send silent push multicast: ${error.message}`);
      return { successCount: 0, failedTokens: tokens };
    }
  }
}
