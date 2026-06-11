// Role: global crash handler — writes crash report to disk before exit.
import { app } from 'electron';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import log from 'electron-log';

export function installCrashReporter(): void {
  const writeCrashReport = (reason: string, error: unknown): void => {
    try {
      const dir = app.getPath('userData');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = join(dir, `crash-${timestamp}.txt`);

      const errorText = error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack || ''}`
        : String(error);

      // Sanitize: remove anything that looks like a cookie/token/password
      const sanitized = errorText
        .replace(/cookie[^\n]*/gi, 'cookie=[REDACTED]')
        .replace(/password[^\n]*/gi, 'password=[REDACTED]')
        .replace(/token[^\n]*/gi, 'token=[REDACTED]')
        .replace(/authorization[^\n]*/gi, 'authorization=[REDACTED]');

      const report = [
        `StreamDock Crash Report`,
        `Generated: ${new Date().toISOString()}`,
        `App Version: ${app.getVersion()}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Node: ${process.version}`,
        `Reason: ${reason}`,
        ``,
        sanitized,
      ].join('\n');

      writeFileSync(reportPath, report, 'utf-8');
      log.error(`[crash-reporter] Crash report written to: ${reportPath}`);
    } catch {
      // If crash report writing itself fails, nothing we can do
    }
  };

  process.on('uncaughtException', (error: Error) => {
    log.error('[crash-reporter] Uncaught Exception:', error);
    writeCrashReport('uncaughtException', error);
    // Give log time to flush
    setTimeout(() => process.exit(1), 300);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    log.error('[crash-reporter] Unhandled Rejection:', reason);
    writeCrashReport('unhandledRejection', reason);
  });
}
