import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.setup';
import { engineOptionsFromEnv } from './engine/engine-options';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  configureApp(app);

  // Lets AppModule close the MongoDB connection on SIGINT/SIGTERM
  app.enableShutdownHooks();

  // A scheduler or worker process has no HTTP port unless one is asked for, to scrape /metrics
  const { roles } = engineOptionsFromEnv();
  if (!roles.includes('api') && !process.env.ORCHALITE_METRICS_PORT) {
    await app.init();
    console.log(`OrchaLite is running as ${roles.join(', ')}`);
    return;
  }

  const port = Number(roles.includes('api') ? process.env.PORT : process.env.ORCHALITE_METRICS_PORT) || 3000;
  await app.listen(port);
  console.log(`OrchaLite is running on http://localhost:${port} as ${roles.join(', ')}`);
}
bootstrap();
