// Drives the real PAKT app over the Chrome DevTools Protocol.
// Zero dependencies — Node 22+ ships a global WebSocket.
const fs = require('fs');
const OUT = process.env.OUT;
const PORT = 9222;

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise(res => {
    const n = ++id; pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const send = cdp(ws);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const shots = JSON.parse(fs.readFileSync(process.env.PLAN, 'utf8'));
  for (const shot of shots) {
    await send('Page.navigate', { url: shot.url });
    await wait(shot.settle || 2200);
    if (shot.js) {
      const r = await send('Runtime.evaluate', { expression: shot.js, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) console.log('   ! js error in', shot.name, r.exceptionDetails.text);
    }
    await wait(shot.after || 1400);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT}/${shot.name}.png`, Buffer.from(data, 'base64'));
    console.log('   captured', shot.name);
  }
  ws.close();
  process.exit(0);
})();

/* ---------------------------------------------------------------
   Re-capture after a UI change:

   1) node server.js                      # serve the app
   2) "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --headless=new --remote-debugging-port=9222 \
        --user-data-dir=/tmp/pakt-shots about:blank &
   3) OUT=demo/screens PLAN=demo/capture-plan.json node demo/capture-screens.js

   Edit capture-plan.json to change which screens are shot. Each entry runs
   `js` in the page before the screenshot, so show('pulse') etc. works.

   CDP hands back PNG, which is what this writes. The copies committed to the
   repo are resized to 1440px and converted to JPEG — 22 MB of 2880px PNGs is
   not something to put in a git history:

     sips -Z 1440 demo/screens/*.png
     sips -s format jpeg -s formatOptions 82 demo/screens/x.png --out x.jpg
   --------------------------------------------------------------- */
