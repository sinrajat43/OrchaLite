import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { basicAuth, DEMO_PASSWORD_ENV } from './demo/basic-auth';

/**
 * Applies the HTTP setup shared by the real app and the tests
 */
export function configureApp(app: NestExpressApplication): void {
  // First, so the password also covers the web UI
  const demoPassword = process.env[DEMO_PASSWORD_ENV];
  if (demoPassword) app.use(basicAuth(demoPassword));

  // Serve the web UI from /public
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // Enable validation
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
}
