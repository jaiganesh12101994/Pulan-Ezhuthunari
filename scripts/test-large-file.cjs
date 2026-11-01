/**
 * Loads a large PDF through the real UI and reports how long the app takes to show it.
 *
 * This is the test for "the app is not opening large files": it drives the actual file
 * input over the Chrome DevTools Protocol, so the upload, the rasterization, the NDJSON
 * progress stream and the page list all have to work.
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9222
 *   node scripts\test-large-file.cjs "E:\path\to\book.pdf"
 *
 * Build a many-page test document first with scripts\make-test-pdf.py.
 */
const fs = require('fs');

const CDP_PORT = 9222;
const pdfPath = process.argv[2];
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('usage: node test-large-file.cjs <path-to-pdf>');
  process.exit(1);
}
const sizeMb = (fs.statSync(pdfPath).size / 1024 / 1024).toFixed(0);
console.log(`file: ${pdfPath} (${sizeMb} MB)`);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
  if (!page) {
    console.error('no page target - is the app running with --remote-debugging-port?');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.result && reply.result.exceptionDetails) return `<error: ${reply.result.exceptionDetails.text}>`;
    return reply.result && reply.result.result ? reply.result.result.value : undefined;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('DOM.enable');
  // The debug port accepts connections before React has mounted, so wait for the file
  // input to actually exist rather than querying once and giving up.
  let inputNodeId = 0;
  for (let i = 0; i < 120 && !inputNodeId; i++) {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const found = await send('DOM.querySelector', {
      nodeId: doc.result.root.nodeId,
      selector: 'input[type=file]',
    });
    inputNodeId = found.result && found.result.nodeId ? found.result.nodeId : 0;
    if (!inputNodeId) await wait(500);
  }
  if (!inputNodeId) {
    console.error('the file input never appeared - is the app showing an error?');
    process.exit(1);
  }

  const started = Date.now();
  console.log('setting the file input...');
  await send('DOM.setFileInputFiles', { files: [pdfPath], nodeId: inputNodeId });

  let lastMessage = '';
  const deadline = started + 45 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) {
      console.error('TIMED OUT waiting for the pages to appear');
      process.exit(1);
    }
    await wait(2000);

    const raw = await evaluate(`(() => {
      const text = document.body.innerText;
      const loaded = text.match(/(\\d+) Pages? Loaded/);
      const progress = text.match(/Progress: Page (\\d+) of (\\d+)/);
      const failure = text.match(/(larger than the \\d+ MB upload limit|Ran out of disk space[^\\n]*|needs roughly [^\\n]*free space)/);
      return JSON.stringify({
        pagesLoaded: loaded ? Number(loaded[1]) : 0,
        progress: progress ? progress[0] : null,
        rendering: /Rendering PDF pages/.test(text),
        failure: failure ? failure[1] : null,
        rows: document.querySelectorAll('input[type=checkbox]').length,
      });
    })()`);

    let state = {};
    try {
      state = JSON.parse(raw);
    } catch {
      continue; // page was busy mid-render
    }

    if (state.failure) {
      console.error(`FAILED - the app reported: ${state.failure}`);
      process.exit(1);
    }

    const line = state.progress || (state.rendering ? 'rendering...' : '');
    if (line && line !== lastMessage) {
      console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s  ${line}`);
      lastMessage = line;
    }

    // Only a count above zero means the document really arrived: the empty state says
    // "0 Pages Loaded" long before anything is rendered.
    if (state.pagesLoaded > 0 && !state.rendering) {
      const total = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\nLOADED in ${total}s: ${state.pagesLoaded} pages in the document tree`);

      // Is the UI still usable, or has it ground to a halt?
      const health = await evaluate(`(() => {
        const t0 = performance.now();
        const el = document.createElement('div');
        document.body.appendChild(el);
        document.body.removeChild(el);
        return JSON.stringify({
          domNodes: document.querySelectorAll('*').length,
          pageRows: document.querySelectorAll('input[type=checkbox]').length,
          thumbnails: document.querySelectorAll('img').length,
          layoutMs: Math.round(performance.now() - t0),
        });
      })()`);
      console.log('UI health:', health);

      // And can it still answer a request at this size?
      const probe = await evaluate(
        "fetch('/api/samples').then(r => r.status).catch(e => 'error: ' + e.message)"
      );
      console.log('the app still answers requests:', probe);

      ws.close();
      return;
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
