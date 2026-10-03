import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

/**
 * Applies the HTTP setup shared by the real app and the tests
 */
export function configureApp(app: NestExpressApplication): void {
  // Serve the web UI from /public
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // Enable validation
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
}
