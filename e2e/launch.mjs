// Starts Chromium with a fake camera. Set CHROME_PATH to use your own Chrome instead of the bundled one.
export async function launch() {
  const puppeteer = (await import('puppeteer-core')).default;
  let executablePath = process.env.CHROME_PATH;
  let args = [];
  if (!executablePath) {
    const chromium = (await import('@sparticuz/chromium')).default;
    executablePath = await chromium.executablePath();
    // The bundled args target AWS Lambda; single-process mode cannot open more than one page.
    args = chromium.args.filter((a) => !['--single-process', '--no-zygote'].includes(a));
  }
  return puppeteer.launch({
    executablePath,
    headless: 'shell',
    args: [
      ...args,
      '--no-sandbox',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}
