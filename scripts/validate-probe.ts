import { app } from 'electron';
import { probeMediaTracks } from '../electron/media-track-probe';

const url = process.argv[2];

if (!url) {
  console.error('Usage: validate-probe <url>');
  process.exit(1);
}

app.whenReady()
  .then(async () => {
    try {
      const result = await probeMediaTracks({ pageUrl: url });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      app.quit();
    } catch (error) {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    app.exit(1);
  });
