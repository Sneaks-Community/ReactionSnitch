import http from 'node:http';
import pino from 'pino';

const PORT = process.env.HEALTH_PORT || 3000;

const logger = pino({
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }),
  );
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error({ port: PORT }, `Health check port ${PORT} is already in use`);
    process.exit(1);
  }
  logger.error({ err: error.message, port: PORT }, 'Health check server error');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  logger.info({ port: PORT }, 'Health check server started');
});

export { server };
