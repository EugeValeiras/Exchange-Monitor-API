export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/exchange-reader',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  encryption: {
    masterKey: process.env.ENCRYPTION_MASTER_KEY,
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
  },
  crons: {
    // Global flag to disable all crons (default: true)
    enabled: process.env.CRONS_ENABLED !== 'false',
    // Individual job flags (default: true if global is enabled)
    dailySnapshot: process.env.CRON_DAILY_SNAPSHOT !== 'false',
    hourlySnapshot: process.env.CRON_HOURLY_SNAPSHOT !== 'false',
    syncTransactions: process.env.CRON_SYNC_TRANSACTIONS !== 'false',
    widgetRefresh: process.env.CRON_WIDGET_REFRESH !== 'false',
    priceHistory: process.env.CRON_PRICE_HISTORY !== 'false',
  },
});
