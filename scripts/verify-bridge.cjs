/**
 * Verifies the desktop window-control bridge inside a running Electron build.
 *
 * The three buttons in the top panel cannot be tested from a browser: there is no OS
 * window to control there, so they fall back to fullscreen and window.close(). This
 * attaches to the app over the Chrome DevTools Protocol and drives the real bridge, so a
 * broken preload or IPC channel fails here rather than on a user's screen.
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9222
 *   node scripts\verify-bridge.cjs
 *
 * Uses Node's built-in WebSocket, so it needs no packages.
 */
const CDP_PORT = Number(process.argv[2]) || 9222;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
  if (!page) {
    console.error('no page target found - is the app running with --remote-debugging-port?');
    process.exit(1);
  }
  console.log('page:', page.url);

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
    if (reply.result && reply.result.exceptionDetails) {
      return `<error: ${reply.result.exceptionDetails.text}>`;
    }
    return reply.result && reply.result.result ? reply.result.result.value : undefined;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const failures = [];
  const check = (label, actual, expected) => {
    const ok = expected === undefined ? Boolean(actual) : actual === expected;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
    if (!ok) failures.push(label);
  };

  console.log('--- native window chrome ---');
  // A frameless window keeps an invisible resize border, so the outer window stays a few
  // pixels larger than the page. What matters is that no title bar and no menu bar are
  // left: those would add roughly 50 px above the page (31 px of title bar plus a ~20 px
  // menu strip), which is exactly the chrome this check exists to catch.
  const chromeHeight = await evaluate('window.outerHeight - window.innerHeight');
  const chromeWidth = await evaluate('window.outerWidth - window.innerWidth');
  check('no title bar or menu bar above the page', chromeHeight < 24, true);
  check('no native chrome at the sides', chromeWidth < 24, true);
  console.log(`       (${chromeHeight}px above and ${chromeWidth}px at the sides: the invisible resize border)`);

  console.log('--- the top panel doubles as the title bar ---');
  check(
    'top panel is a drag region',
    await evaluate("getComputedStyle(document.querySelector('.app-drag-region')).webkitAppRegion"),
    'drag'
  );
  check(
    'the File menu opts out of dragging',
    await evaluate(
      "getComputedStyle(document.querySelector('.app-drag-region .app-no-drag')).webkitAppRegion"
    ),
    'no-drag'
  );
  check(
    'the window controls opt out of dragging',
    await evaluate(
      "getComputedStyle(document.querySelector('button[aria-label=\"Close\"]').parentElement).webkitAppRegion"
    ),
    'no-drag'
  );
  check(
    'clicking File still opens the menu (drag region did not swallow it)',
    await evaluate(
      "(async () => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'File');" +
        " b.click(); await new Promise(r => setTimeout(r, 150));" +
        " const open = document.body.innerText.includes('Open PDF / Images');" +
        " b.click(); await new Promise(r => setTimeout(r, 150)); return open; })()"
    ),
    true
  );

  console.log('--- bridge ---');
  check('window.pulanDesktop exists', await evaluate('typeof window.pulanDesktop'), 'object');
  console.log('  methods:', await evaluate('Object.keys(window.pulanDesktop || {}).join(", ")'));

  console.log('--- the buttons the user sees ---');
  const buttonQuery = 'button[aria-label="Minimise"], button[aria-label="Maximise"], button[aria-label="Close"]';
  check(
    'minimise button enabled',
    await evaluate('!document.querySelector(\'button[aria-label="Minimise"]\').disabled'),
    true
  );
  check(
    'maximise button enabled',
    await evaluate('!document.querySelector(\'button[aria-label="Maximise"], button[aria-label="Restore"]\').disabled'),
    true
  );
  check(
    'no "needs the packaged build" tooltip left',
    await evaluate(`/packaged desktop build|browser tab has no window/.test(document.querySelector('${buttonQuery}').title)`),
    false
  );

  console.log('--- maximise / restore through the real window ---');
  const before = await evaluate('window.pulanDesktop.isMaximized()');
  await evaluate('document.querySelector(\'button[aria-label="Maximise"]\').click()');
  await wait(1200);
  check('maximising works', await evaluate('window.pulanDesktop.isMaximized()'), !before);
  check('the icon switched to Restore', await evaluate('!!document.querySelector(\'button[aria-label="Restore"]\')'), true);

  await evaluate('document.querySelector(\'button[aria-label="Restore"]\').click()');
  await wait(1200);
  check('restoring works', await evaluate('window.pulanDesktop.isMaximized()'), before);

  console.log('--- minimise ---');
  await evaluate('document.querySelector(\'button[aria-label="Minimise"]\').click()');
  await wait(1200);
  check('minimise is not a no-op', await evaluate('window.pulanDesktop.isMaximized()'), false);

  ws.close();
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nPASS - the top-panel window controls drive the real window');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
