/**
 * Standalone launcher.
 *
 * The desktop build has no project directory to read from, so the browser app
 * (HTML, CSS, the bundled JS) is compiled straight into this file as a map of
 * path -> contents. When the map is present the server never touches the disk;
 * running from a checkout still works because the map is simply empty there and
 * `server/index.js` serves `public/` as usual.
 *
 * `scripts/build-exe.js` generates `src/standalone/assets.generated.js` and then
 * esbuild inlines everything into a single script that ships inside the .exe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

/**
 * @param {Function} loader cb that returns the generated module, or undefined
 * @returns {Record<string, string>} virtual path ("/index.html") -> contents.
 * Empty when running from a checkout (assets are then read from public/).
 *
 * The caller supplies the loader so that `src/standalone/assets.generated.js`
 * is referenced with a literal import from the build entry point. A dynamic
 * `import()` of a module that does not exist would otherwise be a bundler error
 * in a plain checkout.
 */
export function loadEmbeddedAssets(loader) {
  try {
    const value = loader?.();
    if (!value) return {};
    // Accept either a module namespace ({ EMBEDDED_ASSETS }) or the bare map.
    if (value.EMBEDDED_ASSETS) return value.EMBEDDED_ASSETS;
    return typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const mimeFor = (file) => EXT_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * A request handler that serves embedded assets, falling back to `publicRoot`
 * on disk. Returns `false` when the request is not a static asset (so the
 * caller can handle API routes and SPA fallback itself).
 */
export function createAssetHandler(embedded, publicRoot) {
  return function serveAsset(req, res, pathname) {
    let name = pathname === '/' ? '/index.html' : pathname;
    let body = embedded[name];

    if (body === undefined) {
      // allow the bundle's own extensionless/relative forms and directory index
      const alt = name.endsWith('/') ? `${name}index.html` : `${name}.html`;
      body = embedded[alt] ?? embedded[name.replace(/\/+/g, '/')];
      if (body !== undefined) name = alt;
    }

    if (body === undefined && publicRoot) {
      const filePath = path.join(publicRoot, name);
      // path traversal guard: resolved path must stay inside public/
      if (!filePath.startsWith(path.resolve(publicRoot))) {
        res.writeHead(403).end('Forbidden');
        return true;
      }
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch { /* missing: fall through to SPA handling */ }
      if (stat && stat.isFile()) {
        res.writeHead(200, { 'content-type': mimeFor(filePath), 'cache-control': cacheFor(name) });
        res.end(fs.readFileSync(filePath));
        return true;
      }
      return false;
    }

    if (body === undefined) return false;

    res.writeHead(200, { 'content-type': mimeFor(name), 'cache-control': cacheFor(name) });
    res.end(body);
    return true;
  };
}

const cacheFor = (name) =>
  name.endsWith('.html') ? 'no-cache' : 'public, max-age=60';

/**
 * Find a port that is free to bind.
 *
 * This probes with a throwaway socket *before* the real server binds, because a
 * failed `listen()` on the HTTP server also makes the attached WebSocketServer
 * emit an unhandled 'error' that kills the process. Probing first keeps retries
 * from ever touching the real listener.
 */
export function findFreePort(host, preferred, maxTries = 25) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port) => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', (err) => {
        probe.close();
        if (err.code === 'EADDRINUSE' && attempt < maxTries) {
          attempt += 1;
          tryPort(port + 1);
          return;
        }
        // A permission error on the preferred port is still worth reporting.
        reject(err);
      });
      probe.listen(port, host, () => {
        const { port: actual } = probe.address();
        probe.close(() => resolve(actual));
      });
    };
    tryPort(preferred);
  });
}

/** Bind an already-configured server to `port`, resolving once it is listening. */
export function listenOn(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Open the default browser, best-effort. Never fatal if it fails.
 *
 * On Windows `cmd /c start "" <url>` is the common recipe but it is fussy about
 * argument quoting: Node re-quotes argv, and `start` treats a quoted first
 * argument as a window title. `rundll32 url.dll,FileProtocolHandler` takes the
 * URL as a plain argument and avoids the shell entirely, so it is tried first
 * with the `start` form as a fallback.
 *
 * If neither works the URL is still printed in the console banner, so the user
 * can open it by hand.
 */
export function openBrowser(url) {
  const attempts = [];
  if (process.platform === 'win32') {
    attempts.push(['rundll32', ['url.dll,FileProtocolHandler', url]]);
    attempts.push(['cmd', ['/c', 'start', '', url]]);
    attempts.push(['explorer.exe', [url]]);
  } else if (process.platform === 'darwin') {
    attempts.push(['open', [url]]);
  } else {
    attempts.push(['xdg-open', [url]]);
    attempts.push(['sensible-browser', [url]]);
    attempts.push(['x-www-browser', [url]]);
  }

  for (const [cmd, args] of attempts) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      // A synchronous spawn failure (ENOENT) surfaces here, not in the handler.
      if (child?.pid) {
        child.unref();
        return true;
      }
    } catch {
      // try the next strategy
    }
  }
  return false;
}
