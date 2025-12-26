import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { WebSocketServer, WebSocket } from "ws";
import { ServerConfig, ReloadMessage } from "./types";

export class LiveServer {
    private httpServer: http.Server | undefined = undefined;
    private wsServer: WebSocketServer | undefined = undefined;
    private port: number = 3000;
    private clients: Set<WebSocket> = new Set();
    private fileWatcher: vscode.Disposable | undefined = undefined;
    private rootPath: string = "";
    private workspacePath: string = "";
    private config: ServerConfig | undefined = undefined;
    private outputChannel: vscode.OutputChannel;

    // Cache for in-memory document content
    private documentCache: Map<string, string> = new Map();

    private readonly MIME_TYPES: { [key: string]: string } = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".eot": "application/vnd.ms-fontobject",
        ".otf": "font/otf",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".xml": "application/xml",
        ".webmanifest": "application/manifest+json",
    };

    private readonly LIVE_RELOAD_SCRIPT = `
    <script>
      (function() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + window.location.host + '/__live_reload');
        
        // Store original console methods
        const originalConsole = {
          log: console.log.bind(console),
          warn: console.warn.bind(console),
          error: console.error.bind(console),
          info: console.info.bind(console)
        };
        
        // Override console to send to server
        ['log', 'warn', 'error', 'info'].forEach(method => {
          console[method] = function(...args) {
            originalConsole[method](...args);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'console',
                method: method,
                args: args.map(arg => {
                  try {
                    return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
                  } catch (e) {
                    return String(arg);
                  }
                })
              }));
            }
          };
        });
        
        // Create error overlay
        function createErrorOverlay(message) {
          let overlay = document.getElementById('__live_server_error_overlay');
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = '__live_server_error_overlay';
            overlay.style.cssText = \`
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              background: #ff4444;
              color: white;
              padding: 15px;
              font-family: monospace;
              font-size: 14px;
              z-index: 999999;
              box-shadow: 0 2px 10px rgba(0,0,0,0.3);
              border-bottom: 3px solid #cc0000;
            \`;
            document.body.appendChild(overlay);
          }
          overlay.innerHTML = \`
            <strong>⚠️ Error:</strong> \${message}
            <button onclick="this.parentElement.remove()" style="float: right; background: rgba(255,255,255,0.2); border: none; color: white; padding: 5px 10px; cursor: pointer; border-radius: 3px;">✕</button>
          \`;
        }
        
        function removeErrorOverlay() {
          const overlay = document.getElementById('__live_server_error_overlay');
          if (overlay) overlay.remove();
        }
        
        // Hot reload CSS without page refresh
        function hotReloadCSS(cssFile) {
          const links = document.querySelectorAll('link[rel="stylesheet"]');
          links.forEach(link => {
            if (cssFile && !link.href.includes(cssFile)) return;
            const href = link.href.split('?')[0];
            link.href = href + '?t=' + Date.now();
          });
        }
        
        ws.onmessage = function(event) {
          try {
            const message = JSON.parse(event.data);
            
            if (message.type === 'reload') {
              removeErrorOverlay();
              window.location.reload();
            } else if (message.type === 'css-update') {
              removeErrorOverlay();
              hotReloadCSS(message.file);
            } else if (message.type === 'error') {
              createErrorOverlay(message.message);
            }
          } catch (e) {
            // Legacy string message
            if (event.data === 'reload') {
              removeErrorOverlay();
              window.location.reload();
            }
          }
        };
        
        ws.onopen = function() {
          removeErrorOverlay();
        };
        
        ws.onclose = function() {
          setTimeout(function() {
            window.location.reload();
          }, 1000);
        };
        
        // Capture unhandled errors
        window.addEventListener('error', function(e) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'console',
              method: 'error',
              args: ['Uncaught Error:', e.message, 'at', e.filename + ':' + e.lineno]
            }));
          }
        });
      })();
    </script>
  `;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("Live Server++");
    }

    async start(config: ServerConfig): Promise<number> {
        this.config = config;
        this.rootPath = config.rootPath;
        this.workspacePath = config.workspacePath;
        this.port = await this.findAvailablePort(config.port);

        // Initialize document cache with currently open documents
        this.initializeDocumentCache();

        return new Promise((resolve, reject) => {
            try {
                // Create HTTP server
                this.httpServer = http.createServer((req, res) =>
                    this.handleRequest(req, res)
                );

                this.httpServer.on("error", (error: NodeJS.ErrnoException) => {
                    if (error.code === "EADDRINUSE") {
                        reject(new Error(`Port ${this.port} is already in use`));
                    } else {
                        reject(error);
                    }
                });

                this.httpServer.listen(this.port, () => {
                    this.outputChannel.appendLine(
                        `✨ Live Server++ started on http://localhost:${this.port}`
                    );
                    this.outputChannel.appendLine(`📂 Serving: ${this.rootPath}`);
                    this.outputChannel.appendLine(
                        `⚡ Live reload enabled (${config.autoReloadDelay}ms delay)`
                    );
                    this.outputChannel.appendLine(
                        `🔥 Serving unsaved changes in real-time\n`
                    );
                    this.outputChannel.appendLine(
                        `📝 Browser console output will appear below:\n`
                    );

                    // Create WebSocket server for live reload
                    if (this.httpServer) {
                        this.wsServer = new WebSocketServer({
                            server: this.httpServer,
                            path: "/__live_reload",
                        });

                        this.wsServer.on("connection", (ws: WebSocket) => {
                            if (config.verboseLogging) {
                                this.outputChannel.appendLine("[Verbose] Browser connected");
                            }
                            this.clients.add(ws);

                            ws.on("message", (data: Buffer) => {
                                if (config.showConsoleLog) {
                                    try {
                                        const message = JSON.parse(data.toString());
                                        if (message.type === "console") {
                                            // Filter out Live Server's own internal logs
                                            const output = message.args.join(" ");
                                            if (!output.includes("[Live Server++]")) {
                                                const prefix = `[${message.method.toUpperCase()}]`;
                                                this.outputChannel.appendLine(`${prefix} ${output}`);
                                            }
                                        }
                                    } catch (e) {
                                        // Ignore parse errors
                                    }
                                }
                            });

                            ws.on("close", () => {
                                if (config.verboseLogging) {
                                    this.outputChannel.appendLine(
                                        "[Verbose] Browser disconnected"
                                    );
                                }
                                this.clients.delete(ws);
                            });
                        });
                    }

                    // Setup file watcher with auto-reload
                    this.setupAutoReload();

                    resolve(this.port);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    private initializeDocumentCache(): void {
        // Cache all currently open text documents
        vscode.workspace.textDocuments.forEach((doc) => {
            if (
                doc.uri.scheme === "file" &&
                doc.uri.fsPath.startsWith(this.workspacePath)
            ) {
                this.documentCache.set(doc.uri.fsPath, doc.getText());
            }
        });
    }

    private async findAvailablePort(startPort: number): Promise<number> {
        let port = startPort;
        const maxAttempts = 100;

        for (let i = 0; i < maxAttempts; i++) {
            if (await this.isPortAvailable(port)) {
                return port;
            }
            port++;
        }

        throw new Error("No available ports found");
    }

    private isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = http.createServer();

            server.once("error", (err: NodeJS.ErrnoException) => {
                if (err.code === "EADDRINUSE") {
                    resolve(false);
                } else {
                    resolve(false);
                }
            });

            server.once("listening", () => {
                server.close();
                resolve(true);
            });

            server.listen(port);
        });
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            // 1. Handle CORS
            if (this.config?.enableCORS) {
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                if (req.method === "OPTIONS") {
                    res.writeHead(204);
                    res.end();
                    return;
                }
            }

            // 2. Clean the URL
            const urlPath = req.url?.split("?")[0] || "/";
            let targetPath = path.join(this.rootPath, urlPath);

            // Security check
            if (!path.normalize(targetPath).startsWith(this.rootPath)) {
                this.sendError(res, 403, "Forbidden", "Access denied");
                return;
            }

            // 3. The "Realistic" Resolution Logic
            let resolvedPath: string | null = null;
            let isDirectory = false;

            if (fs.existsSync(targetPath)) {
                const stats = fs.statSync(targetPath);
                if (stats.isDirectory()) {
                    const indexHtml = path.join(targetPath, "index.html");
                    if (fs.existsSync(indexHtml)) {
                        resolvedPath = indexHtml;
                    } else {
                        isDirectory = true; // Will trigger directory listing later
                    }
                } else {
                    resolvedPath = targetPath;
                }
            }

            // 4. Pretty URL Check (Try adding .html if not found)
            if (!resolvedPath && !isDirectory) {
                const prettyPath = targetPath + ".html";
                if (fs.existsSync(prettyPath)) {
                    resolvedPath = prettyPath;
                }
            }

            // 5. Final Dispatch
            if (resolvedPath) {
                this.serveRealFile(res, resolvedPath, 200);
            } else if (isDirectory) {
                this.sendDirectoryListing(res, targetPath, urlPath);
            } else {
                // 6. Realistic 404/SPA Logic
                if (this.config?.spaMode) {
                    const spaRoot = path.join(this.rootPath, "index.html");
                    this.serveRealFile(res, spaRoot, 200);
                } else {
                    const custom404 = path.join(this.rootPath, "404.html");
                    if (fs.existsSync(custom404)) {
                        this.serveRealFile(res, custom404, 404);
                    } else {
                        this.send404(res, urlPath);
                    }
                }
            }
        } catch (error) {
            this.sendError(res, 500, "Internal Server Error", "Check console for details");
        }
    }

    /**
     * Helper to serve content with script injection and correct status codes
     */
    private serveRealFile(res: http.ServerResponse, filePath: string, statusCode: number): void {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = this.MIME_TYPES[ext] || "application/octet-stream";

        // Check memory cache first (for as-you-type updates)
        let content: Buffer;
        let fromCache = false;

        if (this.documentCache.has(filePath)) {
            content = Buffer.from(this.documentCache.get(filePath)!, "utf-8");
            fromCache = true;
        } else {
            content = fs.readFileSync(filePath);
        }

        let finalBody: Buffer | string = content;

        // Inject Live Reload into HTML
        if (ext === ".html") {
            let html = content.toString("utf-8");
            const script = this.LIVE_RELOAD_SCRIPT;

            if (html.includes("</body>")) {
                html = html.replace("</body>", `${script}</body>`);
            } else {
                html += script;
            }
            finalBody = Buffer.from(html, "utf-8");
        }

        res.writeHead(statusCode, {
            "Content-Type": mimeType,
            "Content-Length": Buffer.byteLength(finalBody),
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Served-By": "Live-Server-Realistic",
            "X-Cache-Hit": fromCache ? "true" : "false"
        });

        res.end(finalBody);
    }
    private sendError(
        res: http.ServerResponse,
        statusCode: number,
        title: string,
        message: string
    ): void {
        res.writeHead(statusCode, { "Content-Type": "text/html" });
        res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${statusCode} - ${title}</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #000;
              color: #fff;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .container {
              max-width: 600px;
              text-align: center;
            }
            .error-code {
              font-size: clamp(64px, 15vw, 120px);
              font-weight: 700;
              letter-spacing: -2px;
              margin-bottom: 20px;
              opacity: 0.9;
            }
            h1 { 
              font-size: clamp(24px, 5vw, 36px);
              font-weight: 600;
              margin-bottom: 16px;
              opacity: 0.95;
            }
            p { 
              font-size: clamp(14px, 3vw, 16px);
              line-height: 1.6;
              opacity: 0.7;
              margin-bottom: 32px;
            }
            .footer {
              font-size: 14px;
              opacity: 0.5;
              margin-top: 48px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error-code">${statusCode}</div>
            <h1>${title}</h1>
            <p>${message}</p>
            <div class="footer">Live Server++</div>
          </div>
        </body>
      </html>
    `);
    }

    private send404(res: http.ServerResponse, requestedPath: string): void {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>404 - Page Not Found</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #000;
              color: #fff;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .container {
              max-width: 600px;
              text-align: center;
            }
            .error-code {
              font-size: clamp(64px, 15vw, 120px);
              font-weight: 700;
              letter-spacing: -2px;
              margin-bottom: 20px;
              opacity: 0.9;
            }
            h1 { 
              font-size: clamp(24px, 5vw, 36px);
              font-weight: 600;
              margin-bottom: 16px;
              opacity: 0.95;
            }
            .path {
              background: #111;
              padding: 12px 16px;
              border-radius: 6px;
              font-family: 'Courier New', monospace;
              font-size: clamp(12px, 2.5vw, 14px);
              margin: 24px 0;
              word-break: break-all;
              opacity: 0.8;
              border: 1px solid #222;
            }
            p { 
              font-size: clamp(14px, 3vw, 16px);
              line-height: 1.6;
              opacity: 0.7;
              margin-bottom: 24px;
            }
            a {
              color: #fff;
              text-decoration: none;
              opacity: 0.7;
              transition: opacity 0.2s;
              display: inline-block;
              margin-top: 16px;
              font-size: clamp(13px, 2.5vw, 14px);
            }
            a:hover {
              opacity: 1;
            }
            .footer {
              font-size: 14px;
              opacity: 0.5;
              margin-top: 48px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error-code">404</div>
            <h1>Page Not Found</h1>
            <div class="path">${requestedPath}</div>
            <p>The requested file does not exist.<br>Please check the directory.</p>
            <div class="footer">Live Server++</div>
          </div>
        </body>
      </html>
    `);
    }

    private findSimilarFiles(requestedPath: string): string[] {
        try {
            const dir = path.dirname(path.join(this.rootPath, requestedPath));
            if (!fs.existsSync(dir)) return [];

            const files = fs.readdirSync(dir);
            const requestedFile = path.basename(requestedPath).toLowerCase();

            // Find files with similar names
            const similar = files
                .filter((file) => {
                    const fileLower = file.toLowerCase();
                    return (
                        fileLower.includes(requestedFile.slice(0, 3)) ||
                        requestedFile.includes(fileLower.slice(0, 3))
                    );
                })
                .slice(0, 5)
                .map((file) =>
                    path.join(path.dirname(requestedPath), file).replace(/\\/g, "/")
                );

            return similar;
        } catch (error) {
            return [];
        }
    }

    private sendDirectoryListing(
        res: http.ServerResponse,
        dirPath: string,
        urlPath: string
    ): void {
        try {
            const files = fs.readdirSync(dirPath);

            let html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <title>Directory: ${urlPath}</title>
            <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                background: #f5f5f5;
                padding: 20px;
              }
              .container {
                max-width: 900px;
                margin: 0 auto;
                background: white;
                border-radius: 10px;
                padding: 30px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              }
              h1 { 
                color: #333;
                margin-bottom: 10px;
                font-size: 28px;
              }
              .path {
                color: #666;
                margin-bottom: 30px;
                font-family: monospace;
                font-size: 14px;
              }
              ul { 
                list-style: none;
              }
              li { 
                padding: 12px;
                border-bottom: 1px solid #eee;
                transition: background 0.2s;
              }
              li:hover {
                background: #f9f9f9;
              }
              a { 
                text-decoration: none;
                color: #667eea;
                display: flex;
                align-items: center;
              }
              a:hover { 
                color: #764ba2;
              }
              .icon {
                margin-right: 10px;
                font-size: 20px;
              }
              .folder { color: #ffa502; }
              .file { color: #667eea; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>📁 Directory Browser</h1>
              <div class="path">${urlPath}</div>
              <ul>
      `;

            // Add parent directory link
            if (urlPath !== "/") {
                const parentPath = path.dirname(urlPath);
                html += `
          <li>
            <a href="${parentPath}">
              <span class="icon">📁</span>
              <span>..</span>
            </a>
          </li>
        `;
            }

            // Sort: folders first, then files
            const sorted = files.sort((a, b) => {
                const aPath = path.join(dirPath, a);
                const bPath = path.join(dirPath, b);
                const aIsDir = fs.statSync(aPath).isDirectory();
                const bIsDir = fs.statSync(bPath).isDirectory();

                if (aIsDir && !bIsDir) return -1;
                if (!aIsDir && bIsDir) return 1;
                return a.localeCompare(b);
            });

            sorted.forEach((file) => {
                const fullPath = path.join(dirPath, file);
                const stat = fs.statSync(fullPath);
                const isDir = stat.isDirectory();
                const href = path.join(urlPath, file).replace(/\\/g, "/");
                const icon = isDir ? "📁" : "📄";
                const className = isDir ? "folder" : "file";

                html += `
          <li>
            <a href="${href}">
              <span class="icon ${className}">${icon}</span>
              <span>${file}</span>
            </a>
          </li>
        `;
            });

            html += `
              </ul>
            </div>
          </body>
        </html>
      `;

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
        } catch (error) {
            this.sendError(
                res,
                500,
                "Internal Server Error",
                "Error reading directory"
            );
        }
    }

    private setupAutoReload(): void {
        if (!this.config) return;

        const debounceTimers = new Map<string, NodeJS.Timeout>();

        // Listen to text document changes (as you type)
        const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
            const doc = event.document;

            // Only watch files in workspace
            if (!doc.uri.fsPath.startsWith(this.workspacePath)) return;

            const ext = path.extname(doc.fileName).toLowerCase();

            // Only watch relevant files
            if (![".html", ".css", ".js", ".json"].includes(ext)) return;

            // Update document cache with latest content
            this.documentCache.set(doc.uri.fsPath, doc.getText());

            // Clear existing timer for this file
            const existingTimer = debounceTimers.get(doc.uri.fsPath);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // Set new debounced timer
            const timer = setTimeout(() => {
                if (this.config!.verboseLogging) {
                    this.outputChannel.appendLine(
                        `[Verbose] File changed: ${path.basename(doc.fileName)}`
                    );
                }

                // CSS gets hot-reloaded, others trigger full reload
                if (ext === ".css") {
                    this.sendToClients({
                        type: "css-update",
                        file: path.basename(doc.fileName),
                    });
                } else {
                    this.sendToClients({ type: "reload" });
                }

                debounceTimers.delete(doc.uri.fsPath);
            }, this.config!.autoReloadDelay);

            debounceTimers.set(doc.uri.fsPath, timer);
        });

        // Listen when documents are saved
        const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (
                doc.uri.fsPath.startsWith(this.workspacePath) &&
                this.config!.verboseLogging
            ) {
                this.outputChannel.appendLine(
                    `[Verbose] File saved: ${path.basename(doc.fileName)}`
                );
            }
        });

        // Listen when documents are closed (remove from cache)
        const closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.uri.fsPath.startsWith(this.workspacePath)) {
                this.documentCache.delete(doc.uri.fsPath);
                if (this.config!.verboseLogging) {
                    this.outputChannel.appendLine(
                        `[Verbose] Document closed: ${path.basename(doc.fileName)}`
                    );
                }
            }
        });

        // Also watch for file system changes (for images, etc.)
        const pattern = new vscode.RelativePattern(
            this.workspacePath,
            "**/*.{png,jpg,jpeg,gif,svg,webp,ico}"
        );
        const fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const handleFSChange = (uri: vscode.Uri) => {
            if (this.config!.verboseLogging) {
                this.outputChannel.appendLine(
                    `[Verbose] Asset changed: ${path.basename(uri.fsPath)}`
                );
            }
            this.sendToClients({ type: "reload" });
        };

        fsWatcher.onDidChange(handleFSChange);
        fsWatcher.onDidCreate(handleFSChange);
        fsWatcher.onDidDelete(handleFSChange);

        // Store disposables
        this.fileWatcher = vscode.Disposable.from(
            changeListener,
            saveListener,
            closeListener,
            fsWatcher
        );
    }

    private sendToClients(message: ReloadMessage): void {
        const messageStr = JSON.stringify(message);
        this.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    }

    stop(): void {
        // Close all WebSocket connections
        this.clients.forEach((client) => {
            client.close();
        });
        this.clients.clear();

        // Close WebSocket server
        if (this.wsServer) {
            this.wsServer.close();
            this.wsServer = undefined;
        }

        // Close HTTP server
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = undefined;
        }

        // Dispose file watcher
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = undefined;
        }

        // Clear document cache
        this.documentCache.clear();

        this.outputChannel.appendLine("\n🛑 Live Server++ stopped");
    }

    getPort(): number {
        return this.port;
    }

    isRunning(): boolean {
        return this.httpServer !== undefined;
    }

    getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }
}
