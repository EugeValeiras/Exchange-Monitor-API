import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for mobile app
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // WebSocket adapter for Socket.io
  app.useWebSocketAdapter(new IoAdapter(app));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Exchange Monitor API')
    .setDescription(
      'API para consolidar información de exchanges de criptomonedas (Kraken, Binance, Nexo)',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth', 'Autenticación y registro')
    .addTag('credentials', 'Gestión de credenciales de exchanges')
    .addTag('balances', 'Balances consolidados')
    .addTag('transactions', 'Historial de transacciones')
    .addTag('prices', 'Precios en tiempo real')
    .addTag('snapshots', 'Cierres diarios')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                 Exchange Monitor API                       ║
  ╠═══════════════════════════════════════════════════════════╣
  ║  Server running on: http://localhost:${port}                  ║
  ║  Swagger docs:      http://localhost:${port}/api/docs         ║
  ╚═══════════════════════════════════════════════════════════╝
  `);
}

bootstrap();
