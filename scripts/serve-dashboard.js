#!/usr/bin/env node

/**
 * Simple HTTP server to serve dashboard HTML files
 * Usage: node scripts/serve-dashboard.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8085;
const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Default to dashboard-with-snap.html
  let filePath = req.url === '/' ? '/dashboard-with-snap.html' : req.url;
  filePath = path.join(EXAMPLES_DIR, filePath);

  // Security check - prevent directory traversal
  if (!filePath.startsWith(EXAMPLES_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    // Get file extension
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Read and serve file
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Server error: ' + err.message);
        return;
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log('🌐 Dashboard HTTP Server started');
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`📁 Serving from: ${EXAMPLES_DIR}`);
  console.log('');
  console.log('Available dashboards:');
  console.log(`  - http://localhost:${PORT}/dashboard-with-snap.html`);
  console.log(`  - http://localhost:${PORT}/dashboard.html`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});
