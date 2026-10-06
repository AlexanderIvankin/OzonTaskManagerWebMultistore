const { S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'ru-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true, // Beget требует path-style
});

// Префикс ключей моделей внутри бакета — по умолчанию ПУСТО:
// файлы лежат в корне бакета, s3://<bucket>{offer_id}.zip (например, ARD000003-N.zip).
// Настройка оставлена на будущее: если захочется перенести модели в подпапку —
// достаточно указать S3_MODELS_PREFIX="subdir/" в .env.
const MODELS_PREFIX = process.env.S3_MODELS_PREFIX || '';

module.exports = { s3, BUCKET: process.env.S3_BUCKET, MODELS_PREFIX };

