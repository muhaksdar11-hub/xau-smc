import { getEnv } from "../utils/env";
import { logger } from '../utils/logger';
import Redis from 'ioredis';
import { EventEmitter } from 'events';

export interface QueueMessage {
  id?: string;
  type?: 'MARKET_TICK' | 'SIGNAL_AI_VALIDATION' | 'SIGNAL_NOTIFICATION' | 'STRATEGY_TRANSITION' | 'SIGNAL_PUBLISHED' | 'SIGNAL_ARCHIVED' | string;
  payload?: any;
  timestamp?: string;
  retryCount?: number;
  [key: string]: any;
}

export class QueueManager {
  private connected: boolean = false;
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private client: Redis | null = null;
  private localEmitter = new EventEmitter();
  private useRedis: boolean = false;
  private connectingPromise: Promise<void> | null = null;
  private redisDisabled: boolean = false;

  constructor() {
    // We defer actual Redis instantiation until connect() is called
    // to strictly enforce lazy initialization.
    this.useRedis = !!getEnv("REDIS_URL");
  }

  private shouldFallback(errMessage: string): boolean {
    return /ECONNRESET|max retries per request limit|Connection is closed|Stream isn't writeable/i.test(errMessage);
  }

  private cleanupRedisClients() {
    for (const client of [this.publisher, this.subscriber, this.client]) {
      try {
        client?.removeAllListeners();
        client?.disconnect();
      } catch {
        // Ignore cleanup errors.
      }
    }

    this.publisher = null;
    this.subscriber = null;
    this.client = null;
  }

  private disableRedis(reason: string) {
    if (this.redisDisabled) return;
    this.redisDisabled = true;
    this.useRedis = false;
    this.connected = true; // memory queue is available immediately
    logger.warn(`Redis disabled; switching to in-memory queue. Reason: ${reason}`);
    this.cleanupRedisClients();
  }

  private setupListeners() {
    if (!this.useRedis || !this.client || !this.publisher || !this.subscriber) return;
    const handleError = (type: string) => (err: Error) => {
      logger.error(`Redis ${type} error: ${err.message}`);
      this.connected = false;
    };
    
    this.publisher.on('error', handleError('publisher'));
    this.subscriber.on('error', handleError('subscriber'));
    this.client.on('error', handleError('client'));
    
    this.client.on('connect', () => {
      this.connected = true;
      logger.info('Queue Manager connected to Redis');
    });
  }

  public isConnected() {
    return this.connected;
  }

  public getMode(): 'redis' | 'memory' {
    return this.useRedis && this.connected ? 'redis' : 'memory';
  }

  async connect() {
    if (this.connected || this.redisDisabled) return;
    if (this.connectingPromise) return this.connectingPromise;

    const connectTask = async () => {
      const redisUrl = getEnv("REDIS_URL");
      if (redisUrl) {
        this.useRedis = true;
        if (!this.publisher) {
          const redisOpts = {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            retryStrategy: (times: number) => Math.min(times * 1000, 5000)
          };
          this.publisher = new Redis(redisUrl, redisOpts);
          this.subscriber = new Redis(redisUrl, redisOpts);
          this.client = new Redis(redisUrl, redisOpts);
          this.setupListeners();
        }
      } else {
        logger.info('REDIS_URL not provided, falling back to in-memory queue.');
        this.connected = true;
        return;
      }

      try {
        await Promise.all([
          this.publisher!.connect(),
          this.subscriber!.connect(),
          this.client!.connect()
        ]);
        if (!this.redisDisabled) {
          this.connected = true;
        }
      } catch (err: any) {
        logger.warn(`Queue Manager cannot connect to Redis: ${err.message}`);
        this.disableRedis(err.message);
      }
    };

    this.connectingPromise = connectTask().finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  async publish(topic: string, message: QueueMessage): Promise<boolean> {
    if (this.useRedis && !this.connected) {
      await this.connect();
    }
    
    logger.debug(`Publishing message to ${topic}`, { messageId: message.id });
    
    if (!this.useRedis || !this.connected) {
      if (this.useRedis && !this.connected) {
         logger.warn('Not connected to Redis Queue, falling back to local emitter');
      }
      this.localEmitter.emit(`queue:${topic}`, message);
      return true;
    }

    try {
      await this.publisher!.publish(`queue:${topic}`, JSON.stringify(message));
      return true;
    } catch (err: any) {
      logger.error(`Failed to publish message: ${err.message}`);
      if (this.shouldFallback(err.message)) {
        this.disableRedis(err.message);
        this.localEmitter.emit(`queue:${topic}`, message);
        return true;
      }
      return false;
    }
  }

  async subscribe(topic: string, handler: (message: QueueMessage) => Promise<void>) {
    if (this.useRedis && !this.connected) {
      await this.connect();
    }
    
    logger.info(`Subscribed to ${topic}`);
    
    if (!this.useRedis || !this.connected) {
      if (this.useRedis && !this.connected) {
         logger.warn('Not connected to Redis Queue, falling back to local emitter');
      }
      const listener = async (message: QueueMessage) => {
        try {
          await handler(message);
        } catch (err: any) {
          logger.error(`Error processing message from ${topic}: ${err.message}`);
        }
      };
      (handler as any)._localListener = listener;
      this.localEmitter.on(`queue:${topic}`, listener);
      return;
    }

    try {
      await this.subscriber!.subscribe(`queue:${topic}`);
      
      const listener = async (channel: string, messageStr: string) => {
        if (channel === `queue:${topic}`) {
          try {
            const message = JSON.parse(messageStr) as QueueMessage;
            await handler(message);
          } catch (err: any) {
            logger.error(`Error processing message from ${topic}: ${err.message}`);
          }
        }
      };
      
      (handler as any)._redisListener = listener;
      this.subscriber!.on('message', listener);
    } catch (err: any) {
      logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
      if (this.shouldFallback(err.message)) {
        this.disableRedis(err.message);
        const listener = async (message: QueueMessage) => {
          try {
            await handler(message);
          } catch (handlerErr: any) {
            logger.error(`Error processing message from ${topic}: ${handlerErr.message}`);
          }
        };
        (handler as any)._localListener = listener;
        this.localEmitter.on(`queue:${topic}`, listener);
      }
    }
  }

  async unsubscribe(topic: string, handler: (message: QueueMessage) => Promise<void>) {
    const localListener = (handler as any)._localListener;
    if (localListener) {
      this.localEmitter.off(`queue:${topic}`, localListener);
      delete (handler as any)._localListener;
    }

    if (!this.useRedis || !this.connected) return;

    const listener = (handler as any)._redisListener;
    if (listener) {
      logger.debug(`Unsubscribing from ${topic}`);
      this.subscriber!.off('message', listener);
      delete (handler as any)._redisListener;
    }
  }

  
  // Distributed Lock Implementation
  async acquireLock(key: string, ttlSeconds: number = 30): Promise<boolean> {
    if (!this.useRedis || !this.connected) return true; // Fallback allow if no redis
    try {
      const result = await this.client!.set(`lock:${key}`, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err: any) {
      logger.error(`Failed to acquire lock for ${key}: ${err.message}`);
      if (this.shouldFallback(err.message)) {
        this.disableRedis(err.message);
      }
      return true; // fail-open
    }
  }

  async releaseLock(key: string): Promise<void> {
    if (!this.useRedis || !this.connected) return;
    try {
      await this.client!.del(`lock:${key}`);
    } catch (err: any) {
      logger.error(`Failed to release lock for ${key}: ${err.message}`);
      if (this.shouldFallback(err.message)) {
        this.disableRedis(err.message);
      }
    }
  }
}

let _queueManager: QueueManager | null = null;
export function getQueueManager(): QueueManager {
  if (!_queueManager) _queueManager = new QueueManager();
  return _queueManager;
}

