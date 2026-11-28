import http from 'node:http';

const PORT = process.env.HEALTH_PORT || 3000;

function startHealthServer(logger, getParkedReason) {
  const server = http.createServer((_request, response) => {
    const reason = getParkedReason();
    response.writeHead(reason ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        reason,
        status: reason ? 'parked' : 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      }),
    );
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(
        { port: PORT },
        `Health check port ${PORT} is already in use`,
      );
      process.exit(1);
    }
    logger.error(
      { err: error, port: PORT },
      'Health check server error',
    );
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'Health check server started');
  });

  return server;
}

export { startHealthServer };
